import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRun, startReplay } from "../src/run-executor.js";
import { readRun } from "../src/run-store.js";
import { buildJsonReport } from "../src/report-export.js";
import { VIEWPORTS, evaluateIssues, summarizeResponsive, createResponsiveRecorder, measureLayout } from "../src/responsive.js";

let workDir;
const originalCwd = process.cwd();
before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "responsive-test-"));
  process.chdir(workDir);
});
after(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

const [MOBILE, TABLET, DESKTOP] = VIEWPORTS;
const clean = (over = {}) => ({
  viewportWidth: 375, scrollWidth: 375, hasViewportMeta: true, overflowing: [],
  interactiveCount: 10, smallTargets: { count: 0, examples: [] }, ...over,
});

/** Faux page Playwright : enregistre les redimensionnements et les captures. */
function fakePage(url = "https://x.tn/a", { size = { width: 1280, height: 720 } } = {}) {
  const page = {
    currentUrl: url,
    sizes: [],
    shots: [],
    url: () => page.currentUrl,
    viewportSize: () => size,
    setViewportSize: async (value) => { page.sizes.push(value); },
    title: async () => "  Ma   page ",
    screenshot: async ({ path: p }) => { page.shots.push(p); },
  };
  return page;
}

test("VIEWPORTS : mobile, tablette, bureau", () => {
  assert.deepEqual(VIEWPORTS.map((v) => [v.name, v.width]), [["mobile", 375], ["tablet", 768], ["desktop", 1440]]);
});

test("evaluateIssues : une page propre n'a aucun défaut", () => {
  assert.deepEqual(evaluateIssues(clean(), MOBILE), []);
  assert.deepEqual(evaluateIssues(null, MOBILE), []);
});

test("evaluateIssues : défilement horizontal (tolérance de 1 px, gravité selon l'écran)", () => {
  assert.deepEqual(evaluateIssues(clean({ scrollWidth: 376 }), MOBILE), [], "1 px d'écart est toléré");
  const overflow = evaluateIssues(
    clean({ scrollWidth: 620, overflowing: [{ target: "table.prix", right: 620, width: 600 }] }),
    MOBILE
  );
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].code, "R-OVERFLOW");
  assert.equal(overflow[0].severity, "high");
  assert.match(overflow[0].message, /620 px de large pour un écran de 375 px/);
  assert.deepEqual(overflow[0].examples, ["table.prix (dépasse jusqu'à 620 px)"]);
  const desktop = evaluateIssues(clean({ viewportWidth: 1440, scrollWidth: 1600 }), DESKTOP);
  assert.equal(desktop[0].severity, "medium");
  assert.equal(desktop[0].count, 1, "au moins 1 même sans élément identifié");
});

test("evaluateIssues : balise viewport manquante, seulement signalée sur mobile", () => {
  const issues = evaluateIssues(clean({ hasViewportMeta: false }), MOBILE);
  assert.deepEqual(issues.map((i) => i.code), ["R-NO-VIEWPORT-META"]);
  assert.deepEqual(evaluateIssues(clean({ hasViewportMeta: false, viewportWidth: 768, scrollWidth: 768 }), TABLET), []);
});

test("evaluateIssues : cibles tactiles trop petites (mobile et tablette, pas bureau)", () => {
  const small = { count: 2, examples: [{ target: "a.close", width: 16, height: 16 }] };
  const mobile = evaluateIssues(clean({ smallTargets: small }), MOBILE);
  assert.equal(mobile[0].code, "R-SMALL-TARGET");
  assert.equal(mobile[0].severity, "low");
  assert.deepEqual(mobile[0].examples, ["a.close (16 x 16 px)"]);
  assert.equal(evaluateIssues(clean({ smallTargets: { ...small, count: 6 } }), TABLET)[0].severity, "medium");
  assert.deepEqual(evaluateIssues(clean({ viewportWidth: 1440, scrollWidth: 1440, smallTargets: small }), DESKTOP), []);
});

test("summarizeResponsive : compte les défauts par gravité, ignore les tailles en erreur", () => {
  const summary = summarizeResponsive([
    {
      url: "https://x.tn/a", title: "A",
      viewports: [
        { name: "mobile", issues: [{ severity: "high" }, { severity: "low" }] },
        { name: "tablet", issues: [] },
        { name: "desktop", error: "boom", issues: [] },
      ],
    },
  ]);
  assert.deepEqual(summary.totals, { pages: 1, issues: 2, high: 1, medium: 0, low: 1, viewportsWithIssues: 1, viewportsChecked: 2 });
});

test("recorder : 3 tailles par page, taille d'origine rétablie, captures nommées par page et taille", async () => {
  const measures = [clean({ scrollWidth: 500 }), clean({ viewportWidth: 768, scrollWidth: 768 }), clean({ viewportWidth: 1440, scrollWidth: 1440 })];
  const rec = createResponsiveRecorder({ runId: 7, measure: async () => measures.shift(), settle: async () => {} });
  const page = fakePage();
  await rec.afterStep(page);
  assert.deepEqual(page.sizes, [
    { width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]);
  assert.deepEqual(page.shots, [
    "run-screenshots/7-responsive-p0-mobile.png", "run-screenshots/7-responsive-p0-tablet.png", "run-screenshots/7-responsive-p0-desktop.png",
  ]);
  const result = rec.result();
  assert.equal(result.status, "done");
  assert.equal(result.pages[0].title, "Ma page");
  assert.equal(result.pages[0].viewports[0].issues[0].code, "R-OVERFLOW");
  assert.equal(result.totals.high, 1);
});

test("recorder : une page déjà vue (même adresse sans ?requête) n'est pas recontrôlée ; limite de 4 pages", async () => {
  const rec = createResponsiveRecorder({ measure: async () => clean(), settle: async () => {} });
  const page = fakePage("https://x.tn/a?x=1");
  await rec.afterStep(page);
  page.currentUrl = "https://x.tn/a?x=2#haut";
  await rec.afterStep(page);
  assert.equal(rec.result().pages.length, 1);
  for (let i = 1; i <= 7; i++) {
    page.currentUrl = `https://x.tn/p${i}`;
    await rec.afterStep(page);
  }
  assert.equal(rec.result().pages.length, 4);
});

test("recorder : une erreur de mesure n'empêche pas de rétablir la taille, ni les autres tailles", async () => {
  let calls = 0;
  const rec = createResponsiveRecorder({
    measure: async () => { calls += 1; if (calls === 1) throw new Error("évaluation impossible"); return clean({ viewportWidth: 768, scrollWidth: 768 }); },
    settle: async () => {},
  });
  const page = fakePage();
  await rec.afterStep(page);
  assert.deepEqual(page.sizes.at(-1), { width: 1280, height: 720 });
  const result = rec.result();
  assert.equal(result.status, "done");
  assert.equal(result.pages[0].viewports[0].error, "évaluation impossible");
  assert.equal(result.totals.viewportsChecked, 2);
});

test("recorder : page fermée -> on s'arrête, résultat en erreur, jamais d'exception", async () => {
  const rec = createResponsiveRecorder({ measure: async () => { throw new Error("Target page, context or browser has been closed"); }, settle: async () => {} });
  const page = fakePage();
  page.setViewportSize = async () => { throw new Error("closed"); };
  await rec.afterStep(page);
  await rec.afterStep(fakePage("https://x.tn/b"));
  assert.equal(rec.result().status, "error");
  assert.match(rec.result().error, /closed/);

  const none = createResponsiveRecorder();
  await none.afterStep({ url() { throw new Error("closed"); } });
  assert.equal(none.result().status, "empty");
  await none.afterStep(fakePage("about:blank"));
  assert.equal(none.result().status, "empty");
});

test("recorder : une valeur secrète dans l'adresse ne sort pas dans le résultat", async () => {
  const rec = createResponsiveRecorder({ measure: async () => clean(), settle: async () => {} });
  await rec.afterStep(fakePage("https://x.tn/p?token=SECRET123&a=1"));
  assert.doesNotMatch(JSON.stringify(rec.result()), /SECRET123/);
});

test("measureLayout : fonction autonome (sérialisable pour page.evaluate)", () => {
  const source = measureLayout.toString();
  assert.match(source, /^function measureLayout/);
  assert.doesNotMatch(source, /\b(VIEWPORTS|evaluateIssues|MIN_TARGET_SIZE_PX)\b/);
});

const plan = async () => ({ ticketSummary: "s", warnings: [], steps: [{ type: "navigate", selector: null, value: null, description: "Ouvrir", selectorValid: true }] });
const crawl = async () => ({ title: "Login", elementCount: 1, textElements: [], elements: [{ selector: "#a" }], durationMs: 1, screenshotPath: "x.png" });

test("startRun : checkResponsive est transmis au runner, stocké, exporté, sans changer le statut", async () => {
  let seen = null;
  const run = async (url, scenario, options) => {
    seen = options;
    const measures = [clean({ scrollWidth: 500 }), clean({ viewportWidth: 768, scrollWidth: 768 }), clean({ viewportWidth: 1440, scrollWidth: 1440 })];
    const rec = createResponsiveRecorder({ runId: options.runId, measure: async () => measures.shift(), settle: async () => {} });
    await rec.afterStep(fakePage("https://exemple.test/"));
    return {
      runId: options.runId, url, status: "passed", stepsTotal: 1, stepsRun: 1, stepsPassed: 1, responsive: rec.result(),
      results: [{ index: 0, type: "navigate", description: "Ouvrir", status: "passed", screenshot: null, durationMs: 1 }],
    };
  };
  const { runId, done } = await startRun({ url: "https://exemple.test/", ticketText: "Vérifier le responsive", checkResponsive: true }, { crawl, plan, run });
  await done;
  assert.equal(seen.checkResponsive, true);
  const content = await readRun(runId);
  assert.equal(content.options.checkResponsive, true);
  assert.equal(content.runResult.status, "passed", "le contrôle ne change jamais le statut");
  assert.equal(content.runResult.responsive.totals.high, 1);

  const json = buildJsonReport(content);
  assert.equal(json.analyses.responsive.totals.issues, 1);
  assert.equal(json.analyses.responsive.pages[0].viewports[0].issues[0].code, "R-OVERFLOW");
  assert.equal(json.analyses.responsive.pages[0].viewports[0].screenshot, `run-screenshots/${runId}-responsive-p0-mobile.png`);
});

test("rejeu : le contrôle responsive suit le choix du run d'origine", async () => {
  const run = async (url, scenario, options) => ({
    runId: options.runId, url, status: "passed", stepsTotal: 1, stepsRun: 1, stepsPassed: 1,
    results: [{ index: 0, type: "navigate", description: "Ouvrir", status: "passed", screenshot: null, durationMs: 1 }],
  });
  const first = await startRun({ url: "https://exemple.test/", ticketText: "Ticket rejoué responsive", checkResponsive: true }, { crawl, plan, run });
  await first.done;
  const replay = await startReplay(first.runId, { run, compare: async () => ({ regressionCount: 0, comparedStepCount: 0, maxDiffPercent: 0, steps: [] }) });
  await replay.done;
  assert.equal((await readRun(replay.runId)).options.checkResponsive, true);
});
