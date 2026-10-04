import { checkLocalization } from "./localization-check.js";
import { compareRuns } from "./visual-diff.js";
import { listRuns, readRun } from "./run-store.js";
import { resolveBrowserEngine } from "./browser.js";

/**
 * Analyses optionnelles exécutées APRÈS le scénario d'un run, selon les interrupteurs
 * de l'écran "New Run" :
 *  - checkRtl        → vérification FR/AR + RTL de la page (checkLocalization) ;
 *  - checkVisualDiff → diff pixel des captures contre un run de référence (compareRuns).
 *
 * Règle importante : une analyse qui échoue (site injoignable, pas de bouton de langue...)
 * ne fait JAMAIS échouer le run. Son erreur est enregistrée dans le résultat de l'analyse
 * concernée, et le statut du run continue de ne refléter que les étapes du scénario.
 *
 * Résultats écrits dans runResult :
 *   rtl        : { status: "done", report } | { status: "error", error }
 *   visualDiff : { status: "done", baselineRunId, report }
 *              | { status: "no_baseline", reason }
 *              | { status: "error", error }
 */

// Nombre maximum de runs anciens relus pour trouver une référence (évite de lire tout runs/).
const MAX_BASELINE_CANDIDATES = 30;

export function needsAnalysis(options) {
  return Boolean(options?.checkRtl || options?.checkVisualDiff);
}

/** Compare deux tickets sans tenir compte des espaces, retours à la ligne et de la casse. */
function normalizeTicket(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Un run n'est utilisable comme référence que s'il a au moins une capture. */
function hasScreenshots(run) {
  return Boolean(run?.runResult?.results?.some((step) => step?.screenshot));
}

/**
 * Trouve le run de référence pour le diff visuel :
 *  1. un rejeu (replayOf) se compare TOUJOURS au run d'origine : c'est le même scénario,
 *     donc la comparaison est fiable ;
 *  2. sinon, le run terminé le plus récent, plus ancien que celui-ci, sur la même URL,
 *     avec le même texte de ticket et le même moteur de navigateur (Chromium, Firefox et
 *     WebKit ne rendent pas les pages au pixel près : les comparer n'aurait pas de sens). Le scénario a pu être régénéré différemment par l'IA :
 *     compareRuns le signale alors dans ses avertissements.
 * Renvoie null s'il n'y a aucune référence exploitable.
 */
export async function findBaselineRun(state, deps = {}) {
  const { list = listRuns, read = readRun } = deps;
  const { runResult, ticketText } = state;
  const engine = resolveBrowserEngine(state.options?.browserEngine);

  if (runResult.replayOf) {
    const source = await read(runResult.replayOf);
    return hasScreenshots(source) ? source : null;
  }

  const candidates = (await list())
    .filter(
      (run) =>
        run.runId < runResult.runId &&
        run.url === runResult.url &&
        (run.status === "passed" || run.status === "failed")
    )
    .slice(0, MAX_BASELINE_CANDIDATES);

  for (const candidate of candidates) {
    const run = await read(candidate.runId);
    if (
      run &&
      normalizeTicket(run.ticketText) === normalizeTicket(ticketText) &&
      resolveBrowserEngine(run.options?.browserEngine) === engine &&
      hasScreenshots(run)
    ) {
      return run;
    }
  }
  return null;
}

/**
 * Exécute les analyses demandées et écrit leurs résultats dans state.runResult.
 * `persist` est appelé après chaque analyse pour que la page de suivi voie l'avancement.
 * Ne lève jamais d'exception.
 */
export async function runAnalysis(state, persist, deps = {}) {
  const { localize = checkLocalization, compare = compareRuns, navigationTimeoutMs } = deps;
  const { options, runResult } = state;

  if (options?.checkRtl) {
    try {
      runResult.rtl = {
        status: "done",
        report: await localize(runResult.url, {
          navigationTimeoutMs,
          browserEngine: options.browserEngine,
        }),
      };
    } catch (err) {
      console.error(`[run ${runResult.runId}] analyse RTL impossible :`, err.message);
      runResult.rtl = { status: "error", error: err.message };
    }
    await persist();
  }

  if (options?.checkVisualDiff) {
    try {
      const baseline = await findBaselineRun(state, deps);
      if (!baseline) {
        runResult.visualDiff = {
          status: "no_baseline",
          reason: runResult.replayOf
            ? "Le run d'origine n'a pas de capture d'écran à comparer."
            : "Aucun run précédent avec la même URL, le même ticket et le même navigateur : ce run servira de référence pour les prochains.",
        };
      } else {
        const report = await compare(baseline, state);
        runResult.visualDiff = {
          status: "done",
          baselineRunId: baseline.runResult.runId,
          report,
        };
      }
    } catch (err) {
      console.error(`[run ${runResult.runId}] diff visuel impossible :`, err.message);
      runResult.visualDiff = { status: "error", error: err.message };
    }
    await persist();
  }
}
