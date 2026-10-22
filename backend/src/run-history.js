/**
 * Historique et tendances : logique pure (sans disque ni réseau), à partir des runs déjà enregistrés.
 *
 * Deux regroupements :
 *  - global : taux de réussite, durée moyenne, tests instables, erreurs les plus fréquentes ;
 *  - par ticket : les runs de la même URL + même texte de ticket + même navigateur (la même règle
 *    que la comparaison visuelle), pour voir si CE test devient plus lent, instable ou cassé.
 */

import { CATEGORY_LABELS, ERROR_CODES } from "./step-errors.js";

export const MAX_RUNS_PER_TICKET = 20;
export const MAX_RECENT_RUNS = 30;
const FINISHED = ["passed", "failed", "error"];
/** Un test est « plus lent » quand ses derniers runs durent 30 % de plus que les précédents. */
const SLOWER_RATIO = 1.3;

/** Même règle que run-analysis.js : espaces, retours à la ligne et casse ne comptent pas. */
export function normalizeTicketKey(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function groupKey(entry) {
  return `${entry.url}|${entry.browserEngine ?? ""}|${normalizeTicketKey(entry.ticketText)}`;
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length) : null;
}

/**
 * Tendance d'un test d'après ses derniers runs terminés (du plus ancien au plus récent).
 * Renvoie { code, label } ; `code` sert à choisir la couleur dans l'interface.
 */
export function computeTrend(runs) {
  if (runs.length === 0) return { code: "none", label: "Aucun run" };
  const statuses = runs.map((r) => r.status);
  const last = statuses[statuses.length - 1];
  const previous = statuses[statuses.length - 2];
  if (runs.length === 1) {
    return last === "passed" ? { code: "new_ok", label: "Premier run : réussi" } : { code: "new_ko", label: "Premier run : échoué" };
  }
  if (last !== "passed" && previous === "passed") return { code: "regression", label: "Régression : vient de casser" };
  if (last !== "passed" && previous !== "passed") return { code: "failing", label: "Échoue de façon répétée" };
  // dernier run réussi : instable s'il alterne souvent ou n'a réussi qu'après une relance d'étape
  const recent = runs.slice(-5);
  const changes = recent.slice(1).filter((r, i) => r.status !== recent[i].status).length;
  if (changes >= 2 || runs[runs.length - 1].flakySteps > 0) return { code: "unstable", label: "Instable : résultats qui alternent" };
  if (previous !== "passed") return { code: "recovered", label: "Rétabli : réussi après un échec" };
  return { code: "stable", label: "Stable : réussit régulièrement" };
}

/** Les 3 derniers runs durent-ils nettement plus longtemps que les 3 d'avant ? */
export function isGettingSlower(durations) {
  const values = durations.filter((d) => typeof d === "number" && d > 0);
  if (values.length < 4) return false;
  const recent = values.slice(-3);
  const before = values.slice(-6, -3);
  if (before.length === 0) return false;
  return average(recent) > average(before) * SLOWER_RATIO;
}

/** « E-ELM-001 » -> « Élément introuvable ». */
export function failureLabel(code) {
  const category = Object.keys(ERROR_CODES).find((key) => ERROR_CODES[key] === code);
  return category ? (CATEGORY_LABELS[category] ?? null) : null;
}

/**
 * `entries` : un élément par run, tel que lu par run-store.listHistoryEntries :
 * { runId, url, ticketText, ticketSummary, browserEngine, status, durationMs, stepsPassed, stepsTotal,
 *   flakySteps, confidence, failureCode, failureMessage, failureStep }
 */
export function buildHistory(entries) {
  const finished = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && FINISHED.includes(e.status))
    .sort((a, b) => a.runId - b.runId);

  const passed = finished.filter((e) => e.status === "passed").length;
  const durations = finished.map((e) => e.durationMs).filter((d) => typeof d === "number" && d > 0);

  const codeCounts = new Map();
  for (const run of finished) {
    if (run.status === "passed" || !run.failureCode) continue;
    const item = codeCounts.get(run.failureCode) ?? { code: run.failureCode, count: 0, example: run.failureMessage ?? null, lastRunId: run.runId };
    item.count += 1;
    item.example = run.failureMessage ?? item.example;
    item.lastRunId = run.runId;
    codeCounts.set(run.failureCode, item);
  }

  const groups = new Map();
  for (const run of finished) {
    const key = groupKey(run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }

  const tickets = [...groups.values()].map((all) => {
    const runs = all.slice(-MAX_RUNS_PER_TICKET);
    const last = runs[runs.length - 1];
    const okCount = all.filter((r) => r.status === "passed").length;
    return {
      ticketSummary: last.ticketSummary || last.ticketText || "(ticket sans titre)",
      url: last.url,
      browserEngine: last.browserEngine ?? null,
      total: all.length,
      passRate: Math.round((okCount / all.length) * 100),
      avgDurationMs: average(all.map((r) => r.durationMs).filter((d) => typeof d === "number" && d > 0)),
      trend: computeTrend(all),
      slower: isGettingSlower(all.map((r) => r.durationMs)),
      lastRunId: last.runId,
      lastStatus: last.status,
      lastFailureCode: last.status === "passed" ? null : (last.failureCode ?? null),
      runs: runs.map((r) => ({
        runId: r.runId,
        status: r.status,
        durationMs: r.durationMs ?? null,
        stepsPassed: r.stepsPassed ?? 0,
        stepsTotal: r.stepsTotal ?? 0,
        flakySteps: r.flakySteps ?? 0,
        confidence: r.confidence ?? null,
        failureCode: r.status === "passed" ? null : (r.failureCode ?? null),
      })),
    };
  });

  // Les tests à regarder d'abord : ceux qui viennent de casser ou échouent, puis les instables, puis le reste.
  const priority = { regression: 0, failing: 1, new_ko: 2, unstable: 3, recovered: 4, stable: 5, new_ok: 5, none: 6 };
  tickets.sort((a, b) => (priority[a.trend.code] ?? 9) - (priority[b.trend.code] ?? 9) || b.lastRunId - a.lastRunId);

  return {
    overall: {
      total: finished.length,
      passed,
      failed: finished.filter((e) => e.status === "failed").length,
      errored: finished.filter((e) => e.status === "error").length,
      passRate: finished.length ? Math.round((passed / finished.length) * 100) : null,
      avgDurationMs: average(durations),
      flakyRuns: finished.filter((e) => (e.flakySteps ?? 0) > 0).length,
      distinctTickets: tickets.length,
    },
    recent: finished.slice(-MAX_RECENT_RUNS).map((r) => ({ runId: r.runId, status: r.status, durationMs: r.durationMs ?? null })),
    tickets,
    topErrors: [...codeCounts.values()]
      .sort((a, b) => b.count - a.count || b.lastRunId - a.lastRunId)
      .slice(0, 5)
      .map((item) => ({ ...item, label: failureLabel(item.code) })),
  };
}
