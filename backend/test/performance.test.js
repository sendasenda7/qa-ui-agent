import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRun } from "../src/run-executor.js";
import { readRun } from "../src/run-store.js";
import { buildJsonReport } from "../src/report-export.js";
import { rate, summarizePerformance, summarizePerformanceRun, createPerformanceRecorder, measurePerformance, THRESHOLDS } from "../src/performance.js";

let workDir;
const originalCwd = process.cwd();
before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "performance-test-"));
  process.chdir(workDir);
});
after(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

const raw = (over = {}) => ({
  url: "https://x.tn/a", title: "  Ma   page ", navigationUrl: "https://x.tn/a",
  ttfb: 200, domContentLoaded: 900, load: 1500, fcp: 900, lcp: 1200, cls: 0.01,
  requests: 20, transferBytes: 500 * 1024, slowest: [{ url: "x.tn/app.js", durationMs: 400 }], ...over,
});

test("rate : seuils de Google (bon / à améliorer / mauvais), bornes incluses dans « bon »", () => {
  assert.equal(rate("lcp", 2500), "good");
  assert.equal(rate("lcp", 2501), "needs-improvement");
  assert.equal(rate("lcp", 4000), "needs-improvement");
  assert.equal(rate("lcp", 4001), "poor");
  assert.equal(rate("cls", 0.1), "good");
  assert.equal(rate("cls", 0.26), "poor");
  assert.equal(rate("ttfb", 800), "good");
  assert.equal(rate("fcp", 3001), "poor");
  assert.equal(rate("lcp", null), null);
  assert.equal(rate("cls", undefined), null);
  assert.deepEqual(THRESHOLDS.lcp, [2500, 4000]);
});

test("summarizePerformance : page rapide -> aucune alerte, valeurs arrondies, titre nettoyé", () => {
  const s = summarizePerformance(raw({ ttfb: 200.6, cls: 0.01234 }));
  assert.deepEqual(s.issues, []);
  assert.equal(s.title, "Ma page");
  assert.equal(s.metrics.ttfbMs, 201);
  assert.equal(s.metrics.cls, 0.012);
  assert.deepEqual(s.ratings, { ttfb: "good", fcp: "good", lcp: "good", cls: "good" });
  assert.equal(s.notMeasured, false);
});

test("summarizePerformance : LCP mauvais = important, LCP à améliorer = moyen, avec la valeur dans le message", () => {
  const poor = summarizePerformance(raw({ lcp: 5200 }));
  assert.equal(poor.issues[0].code, "P-LCP");
  assert.equal(poor.issues[0].severity, "high");
  assert.match(poor.issues[0].message, /5200 ms.*4000 ms.*mauvais/);
  const mid = summarizePerformance(raw({ lcp: 3000 }));
  assert.equal(mid.issues[0].severity, "medium");
  assert.match(mid.issues[0].message, /2500 ms.*à améliorer/);
  const cls = summarizePerformance(raw({ cls: 0.4 }));
  assert.match(cls.issues[0].message, /0,4.*0,25/);
});

test("summarizePerformance : poids et nombre de requêtes", () => {
  const s = summarizePerformance(raw({ transferBytes: 4.5 * 1024 * 1024, requests: 130 }));
  assert.deepEqual(s.issues.map((i) => i.code), ["P-WEIGHT", "P-REQUESTS"]);
  assert.match(s.issues[0].message, /4,5 Mo/);
});

test("summarizePerformance : LCP/CLS absents (Firefox) -> non mesurés, pas d'alerte", () => {
  const s = summarizePerformance(raw({ lcp: null, cls: null }));
  assert.equal(s.ratings.lcp, null);
  assert.equal(s.ratings.cls, null);
  assert.deepEqual(s.issues, []);
});

test("summarizePerformance : page atteinte sans rechargement -> non notée plutôt que de fausses mesures", () => {
  const s = summarizePerformance(raw({ url: "https://x.tn/dashboard", navigationUrl: "https://x.tn/login", lcp: 9000 }));
  assert.equal(s.notMeasured, true);
  assert.deepEqual(s.issues, []);
  assert.deepEqual(s.ratings, { ttfb: null, fcp: null, lcp: null, cls: null });
});

test("summarizePerformance : un secret dans l'adresse n'est pas conservé", () => {
  assert.doesNotMatch(JSON.stringify(summarizePerformance(raw({ url: "https://x.tn/a?token=SECRET123" }))), /SECRET123/);
});

test("summarizePerformanceRun : totaux par gravité, pages non notées comptées à part", () => {
  const pages = [summarizePerformance(raw({ lcp: 5000, transferBytes: 4 * 1024 * 1024 })), summarizePerformance(raw({ url: "https://x.tn/b", navigationUrl: "https://x.tn/a" }))];
  assert.deepEqual(summarizePerformanceRun(pages).totals, { pages: 2, measured: 1, issues: 2, high: 1, medium: 1, low: 0 });
});

const fakePage = (url = "https://x.tn/a") => ({ currentUrl: url, url() { return this.currentUrl; } });

test("recorder : une mesure par adresse (sans ?requête), 4 pages au plus, aucune exception", async () => {
  let calls = 0;
  const rec = createPerformanceRecorder({ measure: async () => { calls += 1; return raw({ url: `https://x.tn/${calls}`, navigationUrl: `https://x.tn/${calls}` }); }, settle: async () => {} });
  const page = fakePage("https://x.tn/a?x=1");
  await rec.afterStep(page);
  page.currentUrl = "https://x.tn/a?x=2#haut";
  await rec.afterStep(page);
  assert.equal(calls, 1);
  for (let i = 0; i < 6; i++) { page.currentUrl = `https://x.tn/p${i}`; await rec.afterStep(page); }
  assert.equal(rec.result().pages.length, 4);
});

test("recorder : mesure qui échoue ou page fermée -> résultat « error » sans lever d'exception", async () => {
  const rec = createPerformanceRecorder({ measure: async () => { throw new Error("Target closed"); }, settle: async () => {} });
  await rec.afterStep(fakePage());
  assert.equal(rec.result().status, "error");
  assert.match(rec.result().error, /Target closed/);
  const none = createPerformanceRecorder();
  await none.afterStep({ url() { throw new Error("closed"); } });
  assert.equal(none.result().status, "empty");
});

test("recorder : une mesure trop longue est abandonnée", async () => {
  const rec = createPerformanceRecorder({ measure: () => new Promise(() => {}), settle: async () => {}, timeoutMs: 30 });
  await rec.afterStep(fakePage());
  assert.match(rec.result().error, /trop longue/);
});

test("measurePerformance : fonction autonome (sérialisable pour page.evaluate)", () => {
  const source = measurePerformance.toString();
  assert.match(source, /^async function measurePerformance/);
  assert.doesNotMatch(source, /\b(THRESHOLDS|rate|summarizePerformance)\b/);
});

const plan = async () => ({ ticketSummary: "s", warnings: [], steps: [{ type: "navigate", selector: null, value: null, description: "Ouvrir", selectorValid: true }] });
const crawl = async () => ({ title: "Login", elementCount: 1, textElements: [], elements: [{ selector: "#a" }], durationMs: 1, screenshotPath: "x.png" });

test("startRun : checkPerformance transmis, stocké, exporté, sans changer le statut", async () => {
  let seen = null;
  const run = async (url, scenario, options) => {
    seen = options;
    const rec = createPerformanceRecorder({ measure: async () => raw({ lcp: 5000 }), settle: async () => {} });
    await rec.afterStep(fakePage("https://exemple.test/"));
    return { runId: options.runId, url, status: "passed", stepsTotal: 1, stepsRun: 1, stepsPassed: 1, performance: rec.result(),
      results: [{ index: 0, type: "navigate", description: "Ouvrir", status: "passed", screenshot: null, durationMs: 1 }] };
  };
  const { runId, done } = await startRun({ url: "https://exemple.test/", ticketText: "Vérifier la performance", checkPerformance: true }, { crawl, plan, run });
  await done;
  assert.equal(seen.checkPerformance, true);
  assert.equal(seen.checkLinks, false);
  const content = await readRun(runId);
  assert.equal(content.options.checkPerformance, true);
  assert.equal(content.runResult.status, "passed");
  assert.equal(content.runResult.performance.totals.high, 1);
  const json = buildJsonReport(content);
  assert.equal(json.analyses.performance.pages[0].issues[0].code, "P-LCP");
  assert.equal(json.analyses.performance.pages[0].metrics.lcpMs, 5000);
});
