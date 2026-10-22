import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pickExplorationClicks, attachNextPage, summarizeNextPage, MAX_EXPLORE_CLICKS } from "../src/exploration.js";
import { generateScenario, validateScenario } from "../src/planner.js";
import { startRun } from "../src/run-executor.js";
import { readRun } from "../src/run-store.js";

let workDir;
const originalCwd = process.cwd();
before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "exploration-test-"));
  process.chdir(workDir);
});
after(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

const click = (selector, extra = {}) => ({ type: "click", selector, selectorValid: true, description: `clic ${selector}`, ...extra });

test("pickExplorationClicks : les clics du début, jusqu'à la première saisie", () => {
  const steps = [
    { type: "navigate", selector: null },
    click("#a"),
    { type: "assert_visible", selector: "#t", selectorValid: true },
    click("#b", { fallbackSelector: "text=B" }),
    { type: "fill", selector: "#email", value: "x" },
    click("#c"),
  ];
  const clicks = pickExplorationClicks(steps);
  assert.deepEqual(clicks.map((c) => c.selector), ["#a", "#b"]);
  assert.equal(clicks[1].fallbackSelector, "text=B");
});

test("pickExplorationClicks : plafonné, et jamais un sélecteur refusé en premier ni un retour arrière", () => {
  const many = ["#1", "#2", "#3", "#4", "#5"].map((s) => click(s));
  assert.equal(pickExplorationClicks(many).length, MAX_EXPLORE_CLICKS);
  // Un clic refusé n'est jamais tenté en premier ; après un clic réussi il l'est (le bouton peut n'apparaître qu'après).
  assert.deepEqual(pickExplorationClicks([click("#x", { selectorValid: false }), click("#b")]), []);
  assert.deepEqual(pickExplorationClicks([click("#a"), click("#x", { selectorValid: false }), click("#b")]).map((c) => c.selector), ["#a", "#x", "#b"]);
  assert.deepEqual(pickExplorationClicks([click("#a"), { type: "go_back" }, click("#b")]).map((c) => c.selector), ["#a"]);
  assert.deepEqual(pickExplorationClicks([{ type: "navigate" }, { type: "assert_url", value: "/x" }]), []);
  assert.deepEqual(pickExplorationClicks(undefined), []);
});

const crawl = {
  url: "https://x.test/auth/login",
  elements: [{ selector: "#assoc" }, { selector: "#cont" }],
  textElements: [{ selector: 'role=heading[name="Bienvenue"]', text: "Bienvenue" }],
};
const next = {
  via: ["Choisir", "Continuer"],
  url: "https://x.test/auth/login/association",
  title: "Helpify",
  elements: [{ selector: "#cont" }, { selector: "#email", tag: "input", accessibleName: "Email", fallbackSelector: "input[type=email]" }],
  textElements: [{ selector: 'role=heading[name="Connexion"]', kind: "titre", text: "Connexion" }],
};

test("attachNextPage : ne garde que ce que la page suivante apporte de nouveau", () => {
  const enriched = attachNextPage(crawl, next);
  assert.deepEqual(enriched.nextPage.elements.map((e) => e.selector), ["#email"]);
  assert.equal(enriched.nextPage.textElements.length, 1);
  assert.equal(crawl.nextPage, undefined, "le crawl d'origine n'est pas modifié");
  assert.deepEqual(summarizeNextPage(enriched), { via: next.via, url: next.url, title: "Helpify", elementCount: 1, textCount: 1 });
  assert.equal(summarizeNextPage(crawl), null);
});

test("attachNextPage : rien de nouveau (ou pas de clic fait) -> null", () => {
  assert.equal(attachNextPage(crawl, { ...next, elements: [{ selector: "#cont" }], textElements: [] }), null);
  assert.equal(attachNextPage(crawl, { ...next, via: [] }), null);
  assert.equal(attachNextPage(crawl, null), null);
});

test("validateScenario : un fill sur un élément de la page suivante est accepté, avec son sélecteur de secours", () => {
  const enriched = attachNextPage(crawl, next);
  const { steps, warnings } = validateScenario(
    { steps: [{ type: "fill", selector: "#email", value: "a@b.tn", description: "email" }, { type: "fill", selector: "#inconnu", value: "x", description: "faux" }] },
    enriched
  );
  const email = steps.find((s) => s.selector === "#email");
  assert.equal(email.selectorValid, true);
  assert.equal(email.fallbackSelector, "input[type=email]");
  assert.equal(steps.find((s) => s.selector === "#inconnu").selectorValid, false, "un sélecteur absent des deux pages reste halluciné");
  assert.equal(warnings.filter((w) => w.includes("halluciné")).length, 1);
  // Sans exploration, le même sélecteur est refusé.
  const without = validateScenario({ steps: [{ type: "fill", selector: "#email", value: "x", description: "e" }] }, crawl).steps;
  assert.equal(without.find((s) => s.selector === "#email").selectorValid, false);
});

test("le prompt décrit la page atteinte après les clics, et seulement s'il y en a une", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "fake-key";
  const prompts = [];
  global.fetch = async (url, opts) => {
    prompts.push(JSON.parse(opts.body).messages[1].content);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ choices: [{ message: { content: JSON.stringify({ ticketSummary: "s", warnings: [], steps: [] }) } }] }) };
  };
  try {
    await generateScenario("ticket", crawl);
    await generateScenario("ticket", attachNextPage(crawl, next));
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
  assert.doesNotMatch(prompts[0], /PAGE ATTEINTE/);
  assert.match(prompts[1], /PAGE ATTEINTE APRÈS LES CLICS « Choisir » puis « Continuer »/);
  assert.match(prompts[1], /#email/);
  assert.match(prompts[1], /Connexion/);
});

// ---- exécuteur : le scénario est redemandé avec la page suivante ----
const input = { url: "https://x.test/auth/login", ticketText: "Choisir puis Continuer et remplir" };
const baseCrawl = { ...crawl, title: "Login", elementCount: 2, durationMs: 5, screenshotPath: "debug-screenshots/a.png" };
const firstPlan = { ticketSummary: "s", warnings: [], steps: [{ type: "navigate", selector: null, description: "Ouvrir", selectorValid: true }, click("#assoc"), click("#cont")] };
const secondPlan = { ticketSummary: "s2", warnings: [], steps: [...firstPlan.steps, { type: "fill", selector: "#email", value: "x", description: "email", selectorValid: true }] };
const okRun = async (url, scenario, { runId }) => ({ runId, url, status: "passed", stepsTotal: scenario.steps.length, stepsRun: scenario.steps.length, stepsPassed: scenario.steps.length, results: [] });
function spyPlan(plans) {
  const calls = [];
  const fn = async (ticket, c) => { calls.push(c); return plans[Math.min(calls.length - 1, plans.length - 1)]; };
  fn.calls = calls;
  return fn;
}

test("exécuteur : après des clics, redemande un scénario avec la page suivante et le garde", async () => {
  const plan = spyPlan([firstPlan, secondPlan]);
  let explored;
  const explore = async (url, clicks) => { explored = clicks; return next; };
  const { runId, done } = await startRun(input, { crawl: async () => baseCrawl, plan, run: okRun, explore });
  await done;
  assert.deepEqual(explored.map((c) => c.selector), ["#assoc", "#cont"]);
  assert.equal(plan.calls.length, 2);
  assert.equal(plan.calls[0].nextPage, undefined);
  assert.equal(plan.calls[1].nextPage.elements[0].selector, "#email");
  const { runResult, scenario } = await readRun(runId);
  assert.equal(scenario.steps.length, 4);
  assert.equal(runResult.crawl.nextPage.elementCount, 1);
  assert.equal(runResult.status, "passed");
});

test("exécuteur : rien de nouveau sur la page suivante -> pas de 2e appel à l'IA", async () => {
  const plan = spyPlan([firstPlan, secondPlan]);
  const { runId, done } = await startRun(input, { crawl: async () => baseCrawl, plan, run: okRun, explore: async () => ({ ...next, elements: [], textElements: [] }) });
  await done;
  assert.equal(plan.calls.length, 1);
  assert.equal((await readRun(runId)).runResult.crawl.nextPage, undefined);
});

test("exécuteur : une exploration qui échoue n'arrête pas le run (avertissement, 1er scénario gardé)", async () => {
  const plan = spyPlan([firstPlan, secondPlan]);
  const { runId, done } = await startRun(input, { crawl: async () => baseCrawl, plan, run: okRun, explore: async () => { throw new Error("page.goto: Timeout\nCall log: ..."); } });
  await done;
  const { runResult, scenario } = await readRun(runId);
  assert.equal(plan.calls.length, 1);
  assert.equal(runResult.status, "passed");
  assert.equal(scenario.steps.length, 3);
  assert.match(scenario.warnings.join(" "), /Exploration après clic impossible \(page\.goto: Timeout\)/);
});

test("exécuteur : un scénario sans clic n'explore pas, et sans `explore` injecté (faux crawl) rien n'est lancé", async () => {
  let called = 0;
  const noClick = { ...firstPlan, steps: [firstPlan.steps[0]] };
  await (await startRun(input, { crawl: async () => baseCrawl, plan: spyPlan([noClick]), run: okRun, explore: async () => { called++; return next; } })).done;
  assert.equal(called, 0);
  const plan = spyPlan([firstPlan]);
  await (await startRun(input, { crawl: async () => baseCrawl, plan, run: okRun })).done;
  assert.equal(plan.calls.length, 1);
});

// ---- bilan de l'exploration : toujours visible dans le run ----
test("bilan : exploration utilisée, sans nouveauté, clic raté, erreur — chacun laisse une trace", async () => {
  const run = (explore) => startRun(input, { crawl: async () => baseCrawl, plan: spyPlan([firstPlan, secondPlan]), run: okRun, explore });

  let r = await run(async () => next);
  await r.done;
  let ex = (await readRun(r.runId)).runResult.crawl.exploration;
  assert.equal(ex.usedForPlan, true);
  assert.equal(ex.newElementCount, 1);
  assert.deepEqual(ex.clicksPlanned, ["clic #assoc", "clic #cont"]);

  r = await run(async () => ({ ...next, elements: [], textElements: [], clicksDone: 2 }));
  await r.done;
  ex = (await readRun(r.runId)).runResult.crawl.exploration;
  assert.equal(ex.usedForPlan, false);
  assert.equal(ex.clicksDone, 2);
  assert.equal(ex.newElementCount, 0);

  r = await run(async () => ({ via: ["clic #assoc"], clicksDone: 1, failedClick: { description: "clic #cont", selector: "#cont", reason: "élément introuvable sur la page" }, elements: [], textElements: [], url: "https://x.test/" }));
  await r.done;
  ex = (await readRun(r.runId)).runResult.crawl.exploration;
  assert.equal(ex.clicksDone, 1);
  assert.equal(ex.failedClick.description, "clic #cont");

  r = await run(async () => { throw new Error("page.goto: Timeout\nCall log"); });
  await r.done;
  ex = (await readRun(r.runId)).runResult.crawl.exploration;
  assert.equal(ex.error, "page.goto: Timeout");
  assert.equal(ex.usedForPlan, false);
});
