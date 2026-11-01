import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pickExplorationActions, pickExplorationClicks, attachNextPage, attachLoggedPage, summarizeExploration, MAX_EXPLORE_ACTIONS } from "../src/exploration.js";
import { generateScenario, validateScenario } from "../src/planner.js";
import { startRun } from "../src/run-executor.js";
import { readRun } from "../src/run-store.js";

let workDir;
const originalCwd = process.cwd();
before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "exploration-fill-test-"));
  process.chdir(workDir);
});
after(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});
afterEach(() => { delete process.env.EXPLORE_AFTER_FILL; });

const click = (selector, extra = {}) => ({ type: "click", selector, selectorValid: true, description: `clic ${selector}`, ...extra });
const fill = (selector, value, extra = {}) => ({ type: "fill", selector, selectorValid: true, description: `saisie ${selector}`, value, ...extra });
const nav = { type: "navigate", selector: null, description: "Ouvrir" };

const loginSteps = [nav, fill("#email", "{{QA_SECRET_EMAIL}}"), fill("#pwd", "{{QA_SECRET_PASSWORD}}"), click("#go"), { type: "assert_visible", selector: "h1", selectorValid: true }];

test("connexion (variables secrètes) : saisies puis clic de validation sont rejoués", () => {
  const actions = pickExplorationActions(loginSteps);
  assert.deepEqual(actions.map((a) => `${a.type}:${a.selector}`), ["fill:#email", "fill:#pwd", "click:#go"]);
  assert.equal(actions[0].value, "{{QA_SECRET_EMAIL}}");
  assert.equal(actions[2].value, undefined, "un clic n'a pas de valeur");
});

test("connexion avec un mot de passe écrit en clair : reconnue aussi (champ de mot de passe)", () => {
  const steps = [nav, fill("#email", "a@b.fr"), fill("input[type=password]", "monmotdepasse", { description: "Saisir le mot de passe" }), click("#go")];
  assert.equal(pickExplorationActions(steps).length, 3);
});

test("clics avant la connexion (choix d'un rôle) gardés dans l'ordre", () => {
  const steps = [nav, click("#role"), fill("#email", "{{QA_SECRET_EMAIL}}"), fill("#pwd", "{{QA_SECRET_PASSWORD}}"), click("#go"), click("#apres")];
  assert.deepEqual(pickExplorationActions(steps).map((a) => a.selector), ["#role", "#email", "#pwd", "#go"]);
});

test("un formulaire qui n'est PAS une connexion n'est jamais validé pendant l'exploration (pas de données créées)", () => {
  const steps = [nav, click("#a"), fill("#titre", "Mon ticket"), fill("#desc", "Texte"), click("#envoyer")];
  assert.deepEqual(pickExplorationActions(steps), pickExplorationClicks(steps));
  assert.deepEqual(pickExplorationActions(steps).map((a) => a.selector), ["#a"]);
});

test("saisies sans clic de validation : retombe sur les clics seuls", () => {
  const steps = [nav, click("#a"), fill("#pwd", "{{QA_SECRET_PASSWORD}}", { description: "mot de passe" }), { type: "assert_visible", selector: "#x", selectorValid: true }];
  assert.deepEqual(pickExplorationActions(steps).map((a) => a.selector), ["#a"]);
});

test("limites : retour arrière, sélecteur manquant, sélecteur refusé en premier, plafond d'actions", () => {
  assert.deepEqual(pickExplorationActions([nav, fill("#pwd", "{{QA_SECRET_P}}"), { type: "go_back" }, click("#go")]), []);
  assert.deepEqual(pickExplorationActions([nav, { type: "fill", selector: null, value: "x" }, click("#go")]), []);
  assert.deepEqual(pickExplorationActions([fill("#e", "{{QA_SECRET_E}}", { selectorValid: false }), click("#go")]), []);
  const many = [...Array.from({ length: MAX_EXPLORE_ACTIONS + 2 }, (_, i) => fill(`#f${i}`, "{{QA_SECRET_E}}")), click("#go")];
  assert.equal(pickExplorationActions(many).length, 0, "le clic de validation est au-delà du plafond : pas d'exploration de formulaire");
  assert.deepEqual(pickExplorationActions(undefined), []);
});

test("une liste `select` est rejouée comme une saisie", () => {
  const steps = [nav, { type: "select", selector: "#langue", selectorValid: true, value: "fr", description: "Langue" }, fill("#pwd", "{{QA_SECRET_PASSWORD}}"), click("#go")];
  assert.deepEqual(pickExplorationActions(steps).map((a) => a.type), ["select", "fill", "click"]);
});

test("attachNextPage / summarizeExploration : l'après-saisie est signalé", () => {
  const crawl = { elements: [{ selector: "#email" }], textElements: [] };
  const next = { via: ["Saisir", "Cliquer"], url: "https://x.test/dashboard", title: "Accueil", elements: [{ selector: "#nouveau" }], textElements: [], afterFill: true, clicksDone: 2 };
  const enriched = attachNextPage(crawl, next);
  assert.equal(enriched.nextPage.afterFill, true);
  const summary = summarizeExploration({ clicks: [{ description: "Saisir" }, { description: "Cliquer" }], next, enriched, used: true });
  assert.equal(summary.afterFill, true);
  assert.equal(attachNextPage(crawl, { ...next, afterFill: false }).nextPage.afterFill, undefined);
});

test("le prompt dit « étapes » (et non « clics ») pour une page atteinte après une connexion", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "fake-key";
  const prompts = [];
  global.fetch = async (url, opts) => {
    prompts.push(JSON.parse(opts.body).messages[1].content);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ choices: [{ message: { content: JSON.stringify({ ticketSummary: "s", warnings: [], steps: [] }) } }] }) };
  };
  const crawl = { url: "https://x.test", title: "Login", elements: [], textElements: [], elementCount: 0 };
  const next = { via: ["Saisir l'email", "Se connecter"], url: "https://x.test/dashboard", title: "Accueil", elements: [{ selector: "#nouveau", tag: "button", accessibleName: "Créer" }], textElements: [], afterFill: true };
  try {
    await generateScenario("ticket", attachNextPage(crawl, next));
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
  assert.match(prompts[0], /PAGE ATTEINTE APRÈS LES ÉTAPES « Saisir l'email » puis « Se connecter »/);
  assert.doesNotMatch(prompts[0], /APRÈS LES CLICS/);
});

// ---- exécuteur ----
const input = { url: "https://x.test/auth/login", ticketText: "Se connecter puis vérifier le tableau de bord" };
const baseCrawl = { url: input.url, title: "Login", elements: [{ selector: "#email" }], textElements: [{ selector: "h1" }], elementCount: 1, durationMs: 5, screenshotPath: "debug-screenshots/a.png" };
const plan1 = { ticketSummary: "s", warnings: [], steps: loginSteps };
const plan2 = { ticketSummary: "s2", warnings: [], steps: [...loginSteps, { type: "assert_text", selector: "h1", expected: "Tableau de bord", selectorValid: true, description: "Titre" }] };
const nextPage = { via: ["a", "b", "c"], url: "https://x.test/dashboard", title: "Tableau", elements: [{ selector: "#nouveau-ticket" }], textElements: [], afterFill: true, clicksDone: 3, failedClick: null };
const okRun = async (url, scenario, { runId }) => ({ runId, url, status: "passed", stepsTotal: scenario.steps.length, stepsRun: scenario.steps.length, stepsPassed: scenario.steps.length, results: [] });
function spyPlan(plans) {
  const calls = [];
  const fn = async (ticket, c) => { calls.push(c); return plans[Math.min(calls.length - 1, plans.length - 1)]; };
  fn.calls = calls;
  return fn;
}

test("exécuteur : un scénario de connexion explore après la saisie et redemande un scénario", async () => {
  const plan = spyPlan([plan1, plan2]);
  let explored;
  const explore = async (url, actions) => { explored = actions; return nextPage; };
  const { runId, done } = await startRun(input, { crawl: async () => baseCrawl, plan, run: okRun, explore });
  await done;
  assert.deepEqual(explored.map((a) => a.type), ["fill", "fill", "click"]);
  assert.equal(plan.calls.length, 2);
  assert.equal(plan.calls[1].nextPage.afterFill, true);
  const { runResult, scenario } = await readRun(runId);
  assert.equal(runResult.crawl.exploration.afterFill, true);
  assert.equal(runResult.crawl.exploration.usedForPlan, true);
  assert.equal(scenario.steps.length, plan2.steps.length);
  assert.doesNotMatch(JSON.stringify(runResult.crawl), /Secret-123/);
});

test("exécuteur : EXPLORE_AFTER_FILL=false revient aux clics seuls (donc rien à explorer ici)", async () => {
  process.env.EXPLORE_AFTER_FILL = "false";
  let called = 0;
  const { done } = await startRun(input, { crawl: async () => baseCrawl, plan: spyPlan([plan1]), run: okRun, explore: async () => { called++; return nextPage; } });
  await done;
  assert.equal(called, 0);
});

// ---- 2e temps : formulaire de connexion qui n'apparaît qu'après des clics (ex. choix d'un profil) ----
const clickOnlyPlan = { ticketSummary: "s", warnings: [], steps: [nav, click("#role"), click("#cont")] };
const formPage = { via: ["clic #role", "clic #cont"], url: "https://x.test/auth/login", title: "Login", elements: [{ selector: "#email" }, { selector: "#pwd" }, { selector: "#go" }], textElements: [], clicksDone: 2, failedClick: null };
const loggedPage = { via: ["a", "b", "c", "d", "e"], url: "https://x.test/workspace", title: "Espace", elements: [{ selector: "#nouveau" }, { selector: "#go" }], textElements: [{ selector: "h1", kind: "heading", text: "Mon espace" }], afterFill: true, clicksDone: 5, failedClick: null };

test("attachLoggedPage : garde la page du formulaire et n'ajoute que le nouveau", () => {
  const withForm = attachNextPage(baseCrawl, formPage);
  const enriched = attachLoggedPage(withForm, loggedPage);
  assert.deepEqual(enriched.nextPage.elements.map((e) => e.selector), ["#pwd", "#go"], "#email était déjà sur la page d'ouverture");
  assert.deepEqual(enriched.afterLogin.elements.map((e) => e.selector), ["#nouveau"]);
  assert.equal(enriched.afterLogin.textElements[0].text, "Mon espace");
  assert.equal(attachLoggedPage(withForm, { ...loggedPage, elements: [{ selector: "#go" }], textElements: [] }), null);
  assert.equal(attachLoggedPage(withForm, null), null);
  assert.equal(attachLoggedPage(withForm, { via: [], elements: [], textElements: [] }), null);
});

test("planner : un élément de la page connectée est accepté, un élément inventé refusé", () => {
  const enriched = attachLoggedPage(attachNextPage(baseCrawl, formPage), loggedPage);
  const scenario = { ticketSummary: "s", warnings: [], steps: [nav, { type: "assert_visible", selector: "#nouveau", description: "Bouton" }, { type: "click", selector: "#invente", description: "Inconnu" }] };
  const result = validateScenario(scenario, enriched);
  const by = Object.fromEntries(result.steps.map((s) => [s.description, s]));
  assert.equal(by["Bouton"].selectorValid, true);
  assert.equal(by["Inconnu"].selectorValid, false);
});

test("le prompt décrit la page atteinte après la connexion", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "fake-key";
  const prompts = [];
  global.fetch = async (url, opts) => {
    prompts.push(JSON.parse(opts.body).messages[1].content);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ choices: [{ message: { content: JSON.stringify({ ticketSummary: "s", warnings: [], steps: [] }) } }] }) };
  };
  try {
    await generateScenario("ticket", attachLoggedPage(attachNextPage(baseCrawl, formPage), loggedPage));
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
  assert.match(prompts[0], /PAGE ATTEINTE APRÈS LA CONNEXION/);
  assert.match(prompts[0], /https:\/\/x\.test\/workspace/);
  assert.match(prompts[0], /Mon espace/);
});

test("exécuteur : formulaire révélé par des clics -> 2 explorations, 3 appels à l'IA", async () => {
  const plan = spyPlan([clickOnlyPlan, plan1, plan2]);
  const explored = [];
  const explore = async (url, actions) => { explored.push(actions.map((a) => a.type ?? "click")); return explored.length === 1 ? formPage : loggedPage; };
  const { runId, done } = await startRun(input, { crawl: async () => baseCrawl, plan, run: okRun, explore });
  await done;
  assert.deepEqual(explored, [["click", "click"], ["fill", "fill", "click"]]);
  assert.equal(plan.calls.length, 3);
  assert.equal(plan.calls[1].nextPage.elements[0].selector, "#pwd");
  assert.equal(plan.calls[2].afterLogin.elements[0].selector, "#nouveau");
  assert.equal(plan.calls[2].nextPage.elements.length, 2);
  const { runResult, scenario } = await readRun(runId);
  assert.ok(!runResult.crawl.exploration.afterFill);
  assert.equal(runResult.crawl.loginExploration.afterFill, true);
  assert.equal(runResult.crawl.loginExploration.usedForPlan, true);
  assert.equal(scenario.steps.length, plan2.steps.length);
});

test("exécuteur : connexion déjà explorée au 1er temps -> pas de 2e exploration", async () => {
  const plan = spyPlan([plan1, plan2]);
  let calls = 0;
  const explore = async () => { calls++; return nextPage; };
  const { runId, done } = await startRun(input, { crawl: async () => baseCrawl, plan, run: okRun, explore });
  await done;
  assert.equal(calls, 1);
  assert.equal((await readRun(runId)).runResult.crawl.loginExploration, undefined);
});

test("exécuteur : EXPLORE_AFTER_FILL=false -> pas de 2e temps", async () => {
  process.env.EXPLORE_AFTER_FILL = "false";
  const plan = spyPlan([clickOnlyPlan, plan1]);
  let calls = 0;
  const explore = async () => { calls++; return formPage; };
  const { done } = await startRun(input, { crawl: async () => baseCrawl, plan, run: okRun, explore });
  await done;
  assert.equal(calls, 1);
});

test("exécuteur : le 2e temps échoue -> scénario conservé, avec avertissement", async () => {
  const plan = spyPlan([clickOnlyPlan, plan1]);
  let n = 0;
  const explore = async () => { n++; if (n === 1) return formPage; throw new Error("page.goto: Timeout"); };
  const { runId, done } = await startRun(input, { crawl: async () => baseCrawl, plan, run: okRun, explore });
  await done;
  const { runResult, scenario } = await readRun(runId);
  assert.equal(runResult.status, "passed");
  assert.match(scenario.warnings.join(" "), /Exploration après la connexion impossible/);
  assert.equal(runResult.crawl.loginExploration.usedForPlan, false);
});
