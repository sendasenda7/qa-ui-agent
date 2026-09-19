import { crawlPage } from "./crawler.js";
import { generateScenario } from "./planner.js";
import { runScenario } from "./runner.js";
import { saveRun } from "./run-store.js";

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

/**
 * Crée le run, le sauvegarde, puis lance l'exécution sans l'attendre.
 * Renvoie { runId, done } : `done` se résout quand le run est terminé (utile pour les tests).
 *
 * `deps` permet d'injecter de fausses implémentations (crawl, plan, run) dans les tests.
 */
export async function startRun({ url, ticketText }, deps = {}) {
  const { crawl = crawlPage, plan = generateScenario, run = runScenario } = deps;

  const runId = nextRunId();
  const state = {
    ticketText,
    // Provisoire : remplacé par le vrai scénario une fois généré par l'IA.
    scenario: { ticketSummary: truncate(ticketText), warnings: [], steps: [] },
    runResult: {
      runId,
      url,
      startedAt: new Date(runId).toISOString(),
      finishedAt: null,
      status: "running",
      phase: "crawling",
      stepsTotal: 0,
      stepsRun: 0,
      stepsPassed: 0,
      currentStep: null,
      results: [],
      crawl: null,
      error: null,
    },
  };

  // Le premier enregistrement doit réussir AVANT de répondre au frontend :
  // sinon il irait lire un run qui n'existe pas encore.
  await saveRun(runId, state);
  activeRunIds.add(runId);

  // Les écritures suivantes sont mises en file : elles partent dans l'ordre,
  // jamais en parallèle sur le même fichier.
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

  async function execute() {
    try {
      const crawlResult = await crawl(url);
      runResult.crawl = {
        title: crawlResult.title,
        elementCount: crawlResult.elementCount,
        durationMs: crawlResult.durationMs,
        screenshotPath: crawlResult.screenshotPath,
      };
      runResult.phase = "planning";
      await persist();

      const scenario = await plan(ticketText, crawlResult);
      if (!scenario.steps || scenario.steps.length === 0) {
        const reasons = (scenario.warnings || []).join(" ");
        throw new Error(
          `L'IA n'a généré aucune étape exécutable pour ce ticket. ${reasons}`.trim()
        );
      }
      state.scenario = scenario;
      runResult.stepsTotal = scenario.steps.length;
      runResult.phase = "running";
      await persist();

      const finalResult = await run(url, scenario, { runId, onProgress: handleProgress });
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

  return { runId, done: execute() };
}
