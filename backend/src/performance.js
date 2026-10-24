/**
 * Contrôle de performance pendant le scénario : chaque NOUVELLE page rencontrée est mesurée dans le navigateur
 * avec les API standard (Navigation Timing, Paint Timing, Largest Contentful Paint, Layout Shift, Resource Timing).
 *
 * Indicateurs et seuils (ceux de Google pour les « Core Web Vitals ») :
 *   - TTFB : délai avant le premier octet reçu          bon <= 800 ms,  mauvais > 1800 ms
 *   - FCP  : premier affichage de contenu                bon <= 1800 ms, mauvais > 3000 ms
 *   - LCP  : affichage du plus gros élément visible      bon <= 2500 ms, mauvais > 4000 ms
 *   - CLS  : décalages de mise en page (sans unité)      bon <= 0,1,     mauvais > 0,25
 *   - poids transféré et nombre de requêtes (alertes à 3 Mo et 100 requêtes).
 *
 * C'est une mesure de laboratoire : UN chargement, depuis la machine qui fait tourner l'outil, avec son réseau.
 * Elle varie d'un run à l'autre et ne remplace pas une mesure sur de vrais utilisateurs. LCP et CLS n'existent que
 * dans Chromium : sur Firefox / WebKit ils sont « non mesurés ». Le contrôle ne change JAMAIS le statut du run.
 *
 * Page atteinte SANS rechargement (application monopage) : les chronométrages du navigateur décrivent le premier
 * document chargé, pas cette page. On le dit et on ne note pas la page, plutôt que d'attribuer de fausses mesures.
 */

import { maskSecretsDeep } from "./secrets.js";
import { redactUrl, waitForRendered } from "./page-utils.js";
import { pageKey } from "./accessibility.js";

export const MAX_PERFORMANCE_PAGES = 4;
export const HEAVY_PAGE_BYTES = 3 * 1024 * 1024;
export const MANY_REQUESTS = 100;

// [seuil « bon », seuil « mauvais »]
export const THRESHOLDS = {
  ttfb: [800, 1800],
  fcp: [1800, 3000],
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
};
const METRIC_LABELS = { ttfb: "TTFB (premier octet)", fcp: "FCP (premier contenu)", lcp: "LCP (plus gros élément)", cls: "CLS (décalages de mise en page)" };

/**
 * Mesure la page courante. Exécutée DANS le navigateur (page.evaluate) : doit rester autonome.
 * Renvoie des données brutes, interprétées par summarizePerformance.
 */
export async function measurePerformance() {
  const nav = performance.getEntriesByType("navigation")[0] ?? null;
  const fcpEntry = performance.getEntriesByType("paint").find((entry) => entry.name === "first-contentful-paint");

  // LCP et CLS : les entrées déjà produites sont relues (buffered) puis on laisse un court instant aux observateurs.
  let lcp = null;
  let cls = null;
  const observers = [];
  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) lcp = entries[entries.length - 1].startTime;
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
    observers.push(lcpObserver);
  } catch {
    // Navigateur sans LCP (Firefox, WebKit) : lcp reste null.
  }
  try {
    cls = 0;
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) cls += entry.value;
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });
    observers.push(clsObserver);
  } catch {
    cls = null;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const observer of observers) observer.disconnect();

  const trim = (value) => {
    try {
      const url = new URL(value);
      return `${url.host}${url.pathname}`.slice(0, 100);
    } catch {
      return String(value).slice(0, 100);
    }
  };
  const resources = performance.getEntriesByType("resource");
  const slowest = resources
    .filter((entry) => entry.duration > 0)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3)
    .map((entry) => ({ url: trim(entry.name), durationMs: Math.round(entry.duration) }));

  return {
    url: location.href,
    title: document.title,
    navigationUrl: nav ? nav.name : null,
    ttfb: nav ? nav.responseStart : null,
    domContentLoaded: nav && nav.domContentLoadedEventEnd > 0 ? nav.domContentLoadedEventEnd : null,
    load: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : null,
    fcp: fcpEntry ? fcpEntry.startTime : null,
    lcp,
    cls,
    requests: resources.length + (nav ? 1 : 0),
    // Les ressources d'un autre domaine sans en-tête Timing-Allow-Origin ont une taille inconnue (0) : approximation par défaut.
    transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0) + (nav ? nav.transferSize || 0 : 0),
    slowest,
  };
}

/** Note une valeur : "good" | "needs-improvement" | "poor", ou null si non mesurée. */
export function rate(metric, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const [good, poor] = THRESHOLDS[metric];
  if (value <= good) return "good";
  return value <= poor ? "needs-improvement" : "poor";
}

const round = (value, digits = 0) => (value === null || value === undefined ? null : Number(Number(value).toFixed(digits)));

function formatValue(metric, value) {
  return metric === "cls" ? String(round(value, 3)).replace(".", ",") : `${Math.round(value)} ms`;
}

/** Mesure brute -> résumé stocké dans le run (pur, testé sans navigateur). */
export function summarizePerformance(raw) {
  const sameDocument = !raw.navigationUrl || pageKey(raw.navigationUrl) === pageKey(raw.url);
  const metrics = {
    ttfbMs: round(raw.ttfb),
    fcpMs: round(raw.fcp),
    lcpMs: round(raw.lcp),
    cls: round(raw.cls, 3),
    domContentLoadedMs: round(raw.domContentLoaded),
    loadMs: round(raw.load),
    requests: raw.requests ?? 0,
    transferBytes: Math.round(raw.transferBytes ?? 0),
  };
  const summary = {
    url: redactUrl(raw.url ?? ""),
    title: String(raw.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    notMeasured: !sameDocument,
    metrics,
    ratings: { ttfb: null, fcp: null, lcp: null, cls: null },
    issues: [],
    slowest: Array.isArray(raw.slowest) ? raw.slowest.slice(0, 3) : [],
  };
  if (!sameDocument) return summary;

  const values = { ttfb: metrics.ttfbMs, fcp: metrics.fcpMs, lcp: metrics.lcpMs, cls: metrics.cls };
  for (const metric of Object.keys(values)) {
    const rating = rate(metric, values[metric]);
    summary.ratings[metric] = rating;
    if (rating === "good" || rating === null) continue;
    const [good, poor] = THRESHOLDS[metric];
    const limit = rating === "poor" ? poor : good;
    summary.issues.push({
      code: `P-${metric.toUpperCase()}`,
      severity: rating === "poor" ? "high" : "medium",
      message: `${METRIC_LABELS[metric]} : ${formatValue(metric, values[metric])}, au-dessus de ${metric === "cls" ? String(limit).replace(".", ",") : `${limit} ms`} (${rating === "poor" ? "mauvais" : "à améliorer"}).`,
    });
  }
  if (metrics.transferBytes > HEAVY_PAGE_BYTES) {
    summary.issues.push({
      code: "P-WEIGHT",
      severity: "medium",
      message: `Page lourde : ${(metrics.transferBytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo transférés (alerte au-delà de 3 Mo).`,
    });
  }
  if (metrics.requests > MANY_REQUESTS) {
    summary.issues.push({
      code: "P-REQUESTS",
      severity: "low",
      message: `${metrics.requests} requêtes pour afficher la page (alerte au-delà de ${MANY_REQUESTS}).`,
    });
  }
  return summary;
}

export function summarizePerformanceRun(pages) {
  const totals = { pages: pages.length, measured: 0, issues: 0, high: 0, medium: 0, low: 0 };
  for (const page of pages) {
    if (!page.notMeasured) totals.measured += 1;
    for (const issue of page.issues) {
      totals.issues += 1;
      totals[issue.severity] += 1;
    }
  }
  return { status: "done", pages, totals };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`mesure trop longue (plus de ${Math.round(ms / 1000)} s)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Suivi pendant un scénario : `afterStep(page)` mesure la page courante si c'est une nouvelle adresse. Ne lève jamais d'erreur. */
export function createPerformanceRecorder({ measure = (page) => page.evaluate(measurePerformance), settle = waitForRendered, maxPages = MAX_PERFORMANCE_PAGES, timeoutMs = 10000 } = {}) {
  const pages = [];
  const seen = new Set();
  let error = null;

  return {
    async afterStep(page) {
      if (error || pages.length >= maxPages) return;
      let key = null;
      try {
        key = pageKey(page.url());
      } catch {
        return;
      }
      if (!key || seen.has(key)) return;
      seen.add(key);
      try {
        await settle(page, 3000);
        pages.push(summarizePerformance(await withTimeout(measure(page), timeoutMs)));
      } catch (err) {
        error = String(err?.message ?? err).split("\n")[0].slice(0, 200);
      }
    },
    result() {
      if (pages.length === 0 && error) return { status: "error", error };
      if (pages.length === 0) return { status: "empty", pages: [], totals: summarizePerformanceRun([]).totals };
      return maskSecretsDeep({ ...summarizePerformanceRun(pages), ...(error ? { partialError: error } : {}) });
    },
  };
}
