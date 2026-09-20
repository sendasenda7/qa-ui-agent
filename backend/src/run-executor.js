import { crawlPage } from "./crawler.js";
import { generateScenario } from "./planner.js";
import { runScenario } from "./runner.js";
import { saveRun, readRun } from "./run-store.js";

/**
 * Orchestre un run complet EN ARRIÈRE-PLAN : crawl → scénario IA → exécution.
 *
 * Le run est écrit sur disque dès sa création puis après chaque changement de phase
 * et chaque étape. Le frontend n'a qu'à relire GET /api/runs/:id pour suivre la progression.
 *
 * Phases (runResult.phase) : "crawling" → "planning" → "running" → "done" | "error".
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

export function getActiveRunCount() {
  return activeRunIds.size;
}

function truncate(text, maxLength = 120) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function makeRunResult(runId, url, phase) {
  return {
    runId,
    url,
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
async function executeAndTrack(runId, state, url, scenario, run, timeoutMs) {
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
      stepTimeoutMs: timeoutMs,
    });
    runResult.status = finalResult.status;
    runResult.stepsTotal = finalResult.stepsTotal;
    runResult.stepsRun = finalResult.stepsRun;
    runResult.stepsPassed = finalResult.stepsPassed;
    runResult.results = finalResult.results;
    runResult.phase = "done";
  } catch (err) {
    console.error(`[run ${runId}] erreur :`, err.message);
    runResult.status = "error";
    runResult.phase = "error";
    runResult.error = err.message;
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
export async function startRun({ url, ticketText, timeoutMs }, deps = {}) {
  const { crawl = crawlPage, plan = generateScenario, run = runScenario } = deps;

  const runId = nextRunId();
  const state = {
    ticketText,
    // Provisoire : remplacé par le vrai scénario une fois généré par l'IA.
    scenario: { ticketSummary: truncate(ticketText), warnings: [], steps: [] },
    runResult: makeRunResult(runId, url, "crawling"),
  };

  // Le premier enregistrement doit réussir AVANT de répondre au frontend :
  // sinon il irait lire un run qui n'existe pas encore.
  await saveRun(runId, state);
  activeRunIds.add(runId);

  const { runResult } = state;

  async function execute() {
    try {
      const crawlResult = await crawl(url, { navigationTimeoutMs: timeoutMs });
      runResult.crawl = {
        title: crawlResult.title,
        elementCount: crawlResult.elementCount,
        durationMs: crawlResult.durationMs,
        screenshotPath: crawlResult.screenshotPath,
      };
      runResult.phase = "planning";
      await saveRun(runId, state);

      const scenario = await plan(ticketText, crawlResult);
      if (!scenario.steps || scenario.steps.length === 0) {
        const reasons = (scenario.warnings || []).join(" ");
        throw new Error(
          `L'IA n'a généré aucune étape exécutable pour ce ticket. ${reasons}`.trim()
        );
      }
      state.scenario = scenario;
      activeRunIds.delete(runId); // executeAndTrack le rajoute ; évite un double comptage.
      await executeAndTrack(runId, state, url, scenario, run, timeoutMs);
    } catch (err) {
      console.error(`[run ${runId}] erreur :`, err.message);
      runResult.status = "error";
      runResult.phase = "error";
      runResult.error = err.message;
      runResult.finishedAt = new Date().toISOString();
      await saveRun(runId, state);
      activeRunIds.delete(runId);
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
export async function startReplay(sourceRunId, deps = {}) {
  const { run = runScenario } = deps;

  const source = await readRun(sourceRunId);
  if (!source) {
    throw new Error(`Run introuvable : ${sourceRunId}`);
  }
  const { scenario, runResult: sourceRunResult } = source;
  if (!scenario?.steps || scenario.steps.length === 0) {
    throw new Error(`Le run ${sourceRunId} n'a pas de scénario exécutable à rejouer.`);
  }

  const runId = nextRunId();
  const state = {
    ticketText: source.ticketText,
    scenario,
    runResult: { ...makeRunResult(runId, sourceRunResult.url, "running"), replayOf: sourceRunId },
  };

  await saveRun(runId, state);

  return { runId, done: executeAndTrack(runId, state, sourceRunResult.url, scenario, run) };
}