import { crawlPage } from "./crawler.js";
import { generateScenario } from "./planner.js";
import { runScenario } from "./runner.js";
import { saveRun, readRun } from "./run-store.js";
import { needsAnalysis, runAnalysis } from "./run-analysis.js";
import { DEFAULT_BROWSER_ENGINE, resolveBrowserEngine } from "./browser.js";
import { HttpError } from "./http-error.js";
import { stripAnsi } from "./page-utils.js";

const DEFAULT_STEP_TIMEOUT_MS = 10000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;

/**
 * Orchestre un run complet EN ARRIÈRE-PLAN : crawl → scénario IA → exécution.
 *
 * Le run est écrit sur disque dès sa création puis après chaque changement de phase
 * et chaque étape. Le frontend n'a qu'à relire GET /api/runs/:id pour suivre la progression.
 *
 * Phases (runResult.phase) : "crawling" → "planning" → "running" → ("analyzing") → "done" | "error".
 *   "analyzing" n'existe que si l'utilisateur a activé l'analyse RTL et/ou le diff visuel
 *   (state.options) : voir run-analysis.js.
 * Statuts (runResult.status) : "running" → "passed" | "failed" | "error".
 *   - "failed" = une étape du scénario a échoué (résultat de test normal) ;
 *   - "error"  = le pipeline lui-même a planté (site injoignable, clé Groq manquante...).
 */

const activeRunIds = new Set();
let lastRunId = 0;

/** Timestamp unique : deux runs lancés dans la même milliseconde n'ont jamais le même id. */
function nextRunId() {
  lastRunId = Math.max(Date.now(), lastRunId + 1);
  return lastRunId;
}

// Places réservées par des requêtes dont le run n'est pas encore enregistré comme actif.
const pendingReservations = new Set();

export function getActiveRunCount() {
  return activeRunIds.size + pendingReservations.size;
}

/**
 * Réserve de façon SYNCHRONE une place de run. Vérifier getActiveRunCount() puis démarrer
 * plus tard laissait passer plusieurs requêtes simultanées : toutes voyaient "une place libre"
 * avant que la première n'ait eu le temps de s'enregistrer.
 *
 * Renvoie une réservation { release() } (ou null si la limite est atteinte). On la passe à
 * startRun / startReplay, qui la libèrent EUX-MÊMES à l'instant où le run devient actif : la
 * place n'est ainsi jamais comptée deux fois. `release()` est idempotent : l'appeler aussi dans
 * un `finally` côté serveur libère la place si le démarrage échoue avant d'en arriver là.
 */
export function reserveRunSlot(maxConcurrentRuns) {
  if (getActiveRunCount() >= maxConcurrentRuns) return null;
  const reservation = { release: () => pendingReservations.delete(reservation) };
  pendingReservations.add(reservation);
  return reservation;
}

function truncate(text, maxLength = 120) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function makeRunResult(runId, url, phase, browserEngine = DEFAULT_BROWSER_ENGINE) {
  return {
    runId,
    url,
    browserEngine,
    startedAt: new Date(runId).toISOString(),
    finishedAt: null,
    status: "running",
    phase,
    stepsTotal: 0,
    stepsRun: 0,
    stepsPassed: 0,
    currentStep: null,
    results: [],
    crawl: null,
    error: null,
  };
}

/**
 * Sauvegarde périodiquement `state` sous `runId`, exécute `scenario` (via `run`, en
 * général `runScenario`) en suivant sa progression, puis marque le run terminé.
 * Partagé par startRun (scénario généré par l'IA) et startReplay (scénario réutilisé).
 */
async function executeAndTrack(runId, state, url, scenario, run, timeouts, analysisDeps = {}) {
  const { stepTimeoutMs, navigationTimeoutMs } = timeouts;
  activeRunIds.add(runId);

  let writeQueue = Promise.resolve();
  function persist() {
    const snapshot = structuredClone(state);
    writeQueue = writeQueue
      .then(() => saveRun(runId, snapshot))
      .catch((err) => {
        console.error(`[run ${runId}] sauvegarde impossible :`, err.message);
      });
    return writeQueue;
  }

  const { runResult } = state;

  async function handleProgress(event) {
    if (event.type === "step_start") {
      runResult.currentStep = {
        index: event.index,
        type: event.step.type,
        description: event.step.description,
      };
    } else if (event.type === "step_end") {
      runResult.results[event.index] = event.result;
      runResult.stepsRun = runResult.results.length;
      runResult.stepsPassed = runResult.results.filter((r) => r?.status === "passed").length;
      runResult.currentStep = null;
    }
    await persist();
  }

  try {
    runResult.stepsTotal = scenario.steps.length;
    runResult.phase = "running";
    await persist();

    const finalResult = await run(url, scenario, {
      runId,
      onProgress: handleProgress,
      stepTimeoutMs,
      navigationTimeoutMs,
      browserEngine: state.options?.browserEngine,
    });
    runResult.stepsTotal = finalResult.stepsTotal;
    runResult.stepsRun = finalResult.stepsRun;
    runResult.stepsPassed = finalResult.stepsPassed;
    runResult.results = finalResult.results;

    // Analyses optionnelles (RTL, diff visuel). Le statut reste "running" pendant toute
    // l'analyse : le frontend arrête de relire un run dès qu'il n'est plus "running", il
    // afficherait donc "terminé" avant l'arrivée des résultats. Les analyses, elles, ne
    // changent jamais le statut final (voir run-analysis.js).
    if (needsAnalysis(state.options)) {
      runResult.phase = "analyzing";
      runResult.currentStep = null;
      await persist();
      await runAnalysis(state, persist, { ...analysisDeps, navigationTimeoutMs });
    }
    runResult.status = finalResult.status;
    runResult.phase = "done";
  } catch (err) {
    console.error(`[run ${runId}] erreur :`, err.message);
    runResult.status = "error";
    runResult.phase = "error";
    runResult.error = stripAnsi(err.message);
  } finally {
    runResult.currentStep = null;
    runResult.finishedAt = new Date().toISOString();
    await persist();
    activeRunIds.delete(runId);
  }
}

/**
 * Crée le run, le sauvegarde, puis lance l'exécution sans l'attendre.
 * Renvoie { runId, done } : `done` se résout quand le run est terminé (utile pour les tests).
 *
 * `deps` permet d'injecter de fausses implémentations (crawl, plan, run) dans les tests.
 */
export async function startRun(
  {
    url,
    ticketText,
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS, // délai max par ÉTAPE (clic, saisie...)
    navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS, // délai max par chargement de page
    ticketUrl = null,
    deepReview = false,
    checkRtl = false,
    checkVisualDiff = false,
    browserEngine,
  },
  deps = {},
  reservation = null
) {
  const { crawl = crawlPage, plan = generateScenario, run = runScenario } = deps;
  // Lève une erreur AVANT de créer le run si le moteur est inconnu.
  const engine = resolveBrowserEngine(browserEngine);

  const runId = nextRunId();
  const state = {
    ticketText,
    ticketUrl,
    // Analyses demandées sur l'écran "New Run" (voir run-analysis.js).
    // Les timeouts sont mémorisés pour qu'un rejeu (startReplay) utilise les mêmes.
    options: {
      checkRtl,
      checkVisualDiff,
      stepTimeoutMs: timeoutMs,
      navigationTimeoutMs,
      browserEngine: engine,
    },
    // Provisoire : remplacé par le vrai scénario une fois généré par l'IA.
    scenario: { ticketSummary: truncate(ticketText), warnings: [], steps: [] },
    runResult: makeRunResult(runId, url, "crawling", engine),
  };

  // Le premier enregistrement doit réussir AVANT de répondre au frontend :
  // sinon il irait lire un run qui n'existe pas encore.
  // Enregistré comme actif AVANT le premier await, et la réservation libérée dans le même
  // instant synchrone : aucune fenêtre où le run n'est compté nulle part, ni compté deux fois.
  activeRunIds.add(runId);
  reservation?.release();
  try {
    await saveRun(runId, state);
  } catch (err) {
    activeRunIds.delete(runId);
    throw err;
  }

  const { runResult } = state;

  async function execute() {
    try {
      const crawlResult = await crawl(url, { navigationTimeoutMs, browserEngine: engine });
      runResult.crawl = {
        title: crawlResult.title,
        elementCount: crawlResult.elementCount,
        durationMs: crawlResult.durationMs,
        screenshotPath: crawlResult.screenshotPath,
      };
      runResult.phase = "planning";
      await saveRun(runId, state);

      const scenario = await plan(ticketText, crawlResult, { deepReview });
      if (!scenario.steps || scenario.steps.length === 0) {
        const reasons = (scenario.warnings || []).join(" ");
        throw new Error(
          `L'IA n'a généré aucune étape exécutable pour ce ticket. ${reasons}`.trim()
        );
      }
      state.scenario = scenario;
      activeRunIds.delete(runId); // executeAndTrack le rajoute ; évite un double comptage.
      await executeAndTrack(
        runId,
        state,
        url,
        scenario,
        run,
        { stepTimeoutMs: timeoutMs, navigationTimeoutMs },
        deps
      );
    } catch (err) {
      console.error(`[run ${runId}] erreur :`, err.message);
      runResult.status = "error";
      runResult.phase = "error";
      runResult.error = stripAnsi(err.message);
      runResult.finishedAt = new Date().toISOString();
      try {
        await saveRun(runId, state);
      } catch (saveErr) {
        // Un rejet ici n'est attendu par personne (le serveur n'attend pas `done`) : il ferait
        // tomber tout le processus Node (unhandledRejection). On journalise et on continue.
        console.error(`[run ${runId}] sauvegarde de l'erreur impossible :`, saveErr.message);
      } finally {
        activeRunIds.delete(runId);
      }
    }
  }

  return { runId, done: execute() };
}

/**
 * Rejoue EXACTEMENT le scénario d'un run existant (`sourceRunId`), sans repasser par le
 * crawl ni par l'IA — donc sans risque de scénario différent d'un run à l'autre. C'est
 * ce qui permet un diff visuel comparable entre deux runs du même ticket (voir
 * visual-diff.js / compareRuns).
 *
 * Crée un NOUVEAU run (nouvel id, nouveau fichier) qui référence le run d'origine via
 * `replayOf`, pour garder l'historique de chaque run intact.
 */
export async function startReplay(sourceRunId, deps = {}, reservation = null) {
  const { run = runScenario } = deps;

  const source = await readRun(sourceRunId);
  if (!source) {
    throw new HttpError(404, `Run introuvable : ${sourceRunId}`);
  }
  const { scenario, runResult: sourceRunResult } = source;
  if (!scenario?.steps || scenario.steps.length === 0) {
    throw new HttpError(409, `Le run ${sourceRunId} n'a pas de scénario exécutable à rejouer.`);
  }

  const engine = resolveBrowserEngine(source.options?.browserEngine);
  const runId = nextRunId();
  const state = {
    ticketText: source.ticketText,
    ticketUrl: source.ticketUrl ?? null,
    // Un rejeu existe pour être comparé au run d'origine : le diff visuel est donc toujours
    // activé (même scénario = comparaison fiable). L'analyse RTL suit le choix du run d'origine.
    // Le moteur est aussi hérité du run d'origine (Chromium pour les anciens runs qui n'en ont pas) :
    // comparer un rejeu Firefox à une référence Chromium ne montrerait que des différences de rendu.
    options: {
      checkRtl: Boolean(source.options?.checkRtl),
      checkVisualDiff: true,
      browserEngine: engine,
      // Mêmes timeouts que le run d'origine (un staging lent le reste au rejeu).
      stepTimeoutMs: source.options?.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      navigationTimeoutMs: source.options?.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    },
    scenario,
    runResult: {
      ...makeRunResult(runId, sourceRunResult.url, "running", engine),
      replayOf: sourceRunId,
    },
  };

  activeRunIds.add(runId);
  reservation?.release();
  try {
    await saveRun(runId, state);
  } catch (err) {
    activeRunIds.delete(runId);
    throw err;
  }

  return {
    runId,
    done: executeAndTrack(
      runId,
      state,
      sourceRunResult.url,
      scenario,
      run,
      {
        stepTimeoutMs: state.options.stepTimeoutMs,
        navigationTimeoutMs: state.options.navigationTimeoutMs,
      },
      deps
    ),
  };
}