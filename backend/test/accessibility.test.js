import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRun } from "../src/run-executor.js";
import { readRun } from "../src/run-store.js";
import { buildJsonReport } from "../src/report-export.js";
import { pageKey, summarizeAudit, summarizeAccessibility, createAccessibilityRecorder, auditPage } from "../src/accessibility.js";

let workDir;
const originalCwd = process.cwd();
before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "a11y-test-"));
  process.chdir(workDir);
});
after(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

const rule = (id, impact, count = 1, extra = {}) => ({
  id,
  impact,
  help: `aide ${id}`,
  description: `description ${id}`,
  helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${id}`,
  nodes: Array.from({ length: count }, (_, i) => ({ target: [`#el${i}`], html: `<div id="el${i}">`, failureSummary: "Corrige ceci" })),
  ...extra,
});

test("pageKey : sans ?requête, #ancre ni / final ; about:blank et file: ignorés", () => {
  assert.equal(pageKey("https://x.tn/auth/login?next=/a#top"), "https://x.tn/auth/login");
  assert.equal(pageKey("https://x.tn/auth/login/"), "https://x.tn/auth/login");
  assert.equal(pageKey("https://x.tn"), "https://x.tn/");
  assert.equal(pageKey("about:blank"), null);
  assert.equal(pageKey("file:///tmp/a.html"), null);
  assert.equal(pageKey("n'importe quoi"), null);
});

test("summarizeAudit : tri par gravité puis par nombre d'éléments, comptes, url sans secret, textes raccourcis", () => {
  const audit = summarizeAudit({
    url: "https://x.tn/p?token=SECRET123&a=1",
    title: "Profil",
    violations: [rule("minor-1", "minor", 9), rule("serious-1", "serious", 2), rule("critical-1", "critical", 1), rule("serious-2", "serious", 5, { totalNodes: 40 })],
    incomplete: ["color-contrast", "x"],
  });
  assert.deepEqual(audit.violations.map((v) => v.id), ["critical-1", "serious-2", "serious-1", "minor-1"]);
  assert.deepEqual(audit.counts, { critical: 1, serious: 2, moderate: 0, minor: 1, total: 4 });
  assert.equal(audit.violations[1].nodesCount, 40, "le vrai total d'éléments, pas les 5 détaillés");
  assert.ok(!audit.url.includes("SECRET123"));
  assert.equal(audit.needsReview, 2);
  const long = summarizeAudit({ url: "https://x.tn/", violations: [rule("r", "minor", 9, { nodes: Array.from({ length: 9 }, () => ({ target: ["a", "b"], html: "<p>" + "x".repeat(500), failureSummary: "y".repeat(900) })) })] });
  assert.equal(long.violations[0].nodes.length, 5, "5 éléments détaillés au plus par règle");
  assert.ok(long.violations[0].nodes[0].html.length <= 200);
  assert.ok(long.violations[0].nodes[0].summary.length <= 300);
  assert.equal(long.violations[0].nodes[0].target, "a b");
  assert.equal(summarizeAudit({ url: "https://x.tn/", violations: [{ id: "z", impact: null, nodes: [] }] }).violations[0].impact, "minor");
});

test("summarizeAccessibility : additionne les pages", () => {
  const a = summarizeAudit({ url: "https://x.tn/a", violations: [rule("r1", "serious", 1)] });
  const b = summarizeAudit({ url: "https://x.tn/b", violations: [rule("r2", "serious", 1), rule("r3", "minor", 1)] });
  const result = summarizeAccessibility([a, b]);
  assert.equal(result.status, "done");
  assert.deepEqual(result.totals, { critical: 0, serious: 2, moderate: 0, minor: 1, total: 3 });
});

/** Fausse page : son adresse change quand le test appelle goto(). */
const fakePage = (url) => ({ currentUrl: url, url() { return this.currentUrl; } });

test("recorder : une nouvelle adresse = un audit ; la même adresse ou about:blank = aucun", async () => {
  const audited = [];
  const rec = createAccessibilityRecorder({
    audit: async (page) => { audited.push(page.url()); return summarizeAudit({ url: page.url(), violations: [] }); },
    settle: async () => {},
  });
  const page = fakePage("about:blank");
  await rec.afterStep(page);
  page.currentUrl = "https://x.tn/auth/login";
  await rec.afterStep(page);
  await rec.afterStep(page);
  page.currentUrl = "https://x.tn/auth/login?x=1#a";
  await rec.afterStep(page);
  page.currentUrl = "https://x.tn/workspace/profile";
  await rec.afterStep(page);
  assert.deepEqual(audited, ["https://x.tn/auth/login", "https://x.tn/workspace/profile"]);
  assert.equal(rec.result().pages.length, 2);
  assert.equal(rec.result().status, "done");
});

test("recorder : au plus 4 pages ; un audit qui échoue est noté sans jamais lever d'erreur", async () => {
  const rec = createAccessibilityRecorder({ audit: async (p) => summarizeAudit({ url: p.url(), violations: [] }), settle: async () => {} });
  const page = fakePage("https://x.tn/1");
  for (let i = 1; i <= 7; i++) {
    page.currentUrl = `https://x.tn/${i}`;
    await rec.afterStep(page);
  }
  assert.equal(rec.result().pages.length, 4);

  const broken = createAccessibilityRecorder({ audit: async () => { throw new Error("audit trop long\nsuite"); }, settle: async () => {} });
  await broken.afterStep(fakePage("https://x.tn/a"));
  await broken.afterStep(fakePage("https://x.tn/b"));
  assert.deepEqual(broken.result(), { status: "error", error: "audit trop long" });

  let calls = 0;
  const partial = createAccessibilityRecorder({
    audit: async (p) => { calls += 1; if (calls === 2) throw new Error("page fermée"); return summarizeAudit({ url: p.url(), violations: [] }); },
    settle: async () => {},
  });
  const pg = fakePage("https://x.tn/a");
  await partial.afterStep(pg);
  pg.currentUrl = "https://x.tn/b";
  await partial.afterStep(pg);
  assert.equal(partial.result().status, "done");
  assert.equal(partial.result().pages.length, 1);
  assert.equal(partial.result().partialError, "page fermée");

  // une page dont url() lève (page fermée) est ignorée en silence
  const closed = createAccessibilityRecorder({ audit: async () => { throw new Error("jamais appelé"); }, settle: async () => {} });
  await closed.afterStep({ url() { throw new Error("closed"); } });
  assert.equal(closed.result().status, "empty");
});

test("auditPage : injecte axe, lance l'audit, résume et garde le vrai total", async () => {
  const calls = [];
  const page = {
    evaluate: async (arg, param) => {
      calls.push(typeof arg === "string" ? "source" : "run");
      if (typeof arg === "string") return undefined;
      assert.deepEqual(param.tags, ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
      assert.equal(param.locale, "FR");
      return { url: "https://x.tn/p", title: "Profil", violations: [{ ...rule("label", "critical", 1), totalNodes: 12 }], incomplete: [] };
    },
  };
  const out = await auditPage(page, { loadAxeSource: async () => ({ source: "window.axe = {}", locale: "FR" }), timeoutMs: 2000 });
  assert.deepEqual(calls, ["source", "run"]);
  assert.equal(out.violations[0].nodesCount, 12);
  assert.equal(out.counts.critical, 1);
  await assert.rejects(auditPage({ evaluate: () => new Promise(() => {}) }, { loadAxeSource: async () => ({ source: "x", locale: null }), timeoutMs: 20 }), /audit trop long/);
});

test("startRun : checkA11y est transmis au runner et le résultat est stocké sans changer le statut", async () => {
  let seenOptions = null;
  const plan = async () => ({ ticketSummary: "s", warnings: [], steps: [{ type: "navigate", selector: null, value: null, description: "Ouvrir", selectorValid: true }] });
  const run = async (url, scenario, options) => {
    seenOptions = options;
    return {
      runId: options.runId, url, status: "passed", stepsTotal: 1, stepsRun: 1, stepsPassed: 1,
      accessibility: summarizeAccessibility([summarizeAudit({ url, violations: [rule("label", "critical", 2)] })]),
      results: [{ index: 0, type: "navigate", description: "Ouvrir", status: "passed", screenshot: null, durationMs: 1 }],
    };
  };
  const crawl = async () => ({ title: "Login", elementCount: 1, textElements: [], elements: [{ selector: "#a" }], durationMs: 1, screenshotPath: "x.png" });
  const { runId, done } = await startRun({ url: "https://exemple.test/", ticketText: "Vérifier l'accessibilité", checkA11y: true }, { crawl, plan, run });
  await done;
  assert.equal(seenOptions.checkA11y, true);
  const content = await readRun(runId);
  assert.equal(content.options.checkA11y, true);
  assert.equal(content.runResult.status, "passed", "l'audit ne change jamais le statut");
  assert.equal(content.runResult.accessibility.totals.critical, 1);

  const json = buildJsonReport(content);
  assert.equal(json.analyses.accessibility.totals.total, 1);
  assert.deepEqual(json.analyses.accessibility.pages[0].violations[0].targets, ["#el0", "#el1"]);
});

test("rejeu : l'audit d'accessibilité suit le choix du run d'origine", async () => {
  const { startReplay } = await import("../src/run-executor.js");
  const plan = async () => ({ ticketSummary: "s", warnings: [], steps: [{ type: "navigate", selector: null, value: null, description: "Ouvrir", selectorValid: true }] });
  const run = async (url, scenario, options) => ({
    runId: options.runId, url, status: "passed", stepsTotal: 1, stepsRun: 1, stepsPassed: 1,
    results: [{ index: 0, type: "navigate", description: "Ouvrir", status: "passed", screenshot: null, durationMs: 1 }],
  });
  const crawl = async () => ({ title: "Login", elementCount: 1, textElements: [], elements: [{ selector: "#a" }], durationMs: 1, screenshotPath: "x.png" });
  const first = await startRun({ url: "https://exemple.test/", ticketText: "Ticket rejoué", checkA11y: true }, { crawl, plan, run });
  await first.done;
  const replay = await startReplay(first.runId, { run, compare: async () => ({ regressionCount: 0, comparedStepCount: 0, maxDiffPercent: 0, steps: [] }) });
  await replay.done;
  assert.equal((await readRun(replay.runId)).options.checkA11y, true);
});
