import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRun } from "../src/run-executor.js";
import { readRun } from "../src/run-store.js";
import { describeEmptyCrawl, classifyRunError, StepError } from "../src/step-errors.js";

// run-store écrit dans runs/ (dossier relatif) : chaque fichier de test tourne dans son processus.
let workDir;
const originalCwd = process.cwd();

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "run-failure-test-"));
  process.chdir(workDir);
});

after(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

const baseInput = { url: "https://exemple.test/", ticketText: "Vérifier que le message d'erreur s'affiche" };

const emptyCrawl = { title: "", elementCount: 0, textElements: [], elements: [], durationMs: 17000, screenshotPath: "debug-screenshots/x.png" };
const goodCrawl = { title: "Login", elementCount: 3, textElements: [], elements: [{ selector: "#a" }], durationMs: 100, screenshotPath: "debug-screenshots/y.png" };

const okPlan = async () => ({
  ticketSummary: "s",
  warnings: [],
  steps: [{ type: "navigate", selector: null, value: null, description: "Ouvrir", selectorValid: true }],
});
const okRun = async (url, scenario, { runId }) => ({
  runId, url, status: "passed", stepsTotal: 1, stepsRun: 1, stepsPassed: 1,
  results: [{ index: 0, type: "navigate", description: "Ouvrir", status: "passed", screenshot: null, durationMs: 1 }],
});

/** Plan espion : permet de vérifier que l'IA n'est PAS appelée. */
function spyPlan(impl = okPlan) {
  const spy = async (...args) => {
    spy.calls += 1;
    return impl(...args);
  };
  spy.calls = 0;
  return spy;
}

test("describeEmptyCrawl : rien d'interactif ni de texte -> E-CRW-001 ; sinon null", () => {
  const err = describeEmptyCrawl(emptyCrawl);
  assert.ok(err instanceof StepError);
  assert.equal(err.code, "E-CRW-001");
  assert.equal(err.category, "CRAWL_EMPTY");
  assert.match(err.found, /page vide ou sans titre/);
  assert.match(err.hint, /RENDER_TIMEOUT_MS/);

  assert.match(describeEmptyCrawl({ ...emptyCrawl, title: "Application error" }).found, /« Application error »/);
  assert.equal(describeEmptyCrawl(goodCrawl), null);
  // Une page qui n'a que du texte (pas de champ ni de bouton) reste testable avec assert_text.
  assert.equal(describeEmptyCrawl({ elementCount: 0, textElements: [{ selector: "role=heading", text: "Bonjour" }] }), null);
});

test("classifyRunError : l'exploration est classée comme navigation, le reste garde son message", () => {
  const dns = classifyRunError(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.tn/"), "crawling");
  assert.equal(dns.code, "E-NAV-001");
  assert.match(dns.message, /Adresse introuvable/);

  const groq = classifyRunError(new Error("GROQ_API_KEY manquante dans backend/.env"));
  assert.equal(groq.code, "E-UNK-001");
  assert.equal(groq.message, "GROQ_API_KEY manquante dans backend/.env");

  const own = new StepError("PLAN_EMPTY", "x");
  assert.equal(classifyRunError(own, "crawling"), own);
});

test("page vide : le run s'arrête avec E-CRW-001, l'IA n'est jamais appelée", async () => {
  const plan = spyPlan();
  const { runId, done } = await startRun(baseInput, { crawl: async () => emptyCrawl, plan, run: okRun });
  await done;

  assert.equal(plan.calls, 0, "pas d'appel à l'IA sur une page vide");
  const { runResult } = await readRun(runId);
  assert.equal(runResult.status, "error");
  assert.equal(runResult.phase, "error");
  assert.equal(runResult.failure.code, "E-CRW-001");
  assert.equal(runResult.failure.category, "CRAWL_EMPTY");
  assert.match(runResult.error, /Aucun élément détecté/);
  assert.equal(runResult.crawl.elementCount, 0, "le résumé du crawl reste consultable");
  assert.ok(runResult.finishedAt);
});

test("page avec du texte seulement : le run continue", async () => {
  const textOnly = { title: "Merci", elementCount: 0, textElements: [{ selector: 'role=heading[name="Merci"]', kind: "titre", text: "Merci" }], elements: [] };
  const plan = spyPlan();
  const { runId, done } = await startRun(baseInput, { crawl: async () => textOnly, plan, run: okRun });
  await done;
  assert.equal(plan.calls, 1);
  const { runResult } = await readRun(runId);
  assert.equal(runResult.status, "passed");
  assert.equal(runResult.failure, null);
});

test("site injoignable pendant l'exploration : E-NAV-001, phrase lisible, IA non appelée", async () => {
  const plan = spyPlan();
  const crawl = async () => {
    throw new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://exemple.test/\nCall log:\n  - navigating");
  };
  const { runId, done } = await startRun(baseInput, { crawl, plan, run: okRun });
  await done;

  assert.equal(plan.calls, 0);
  const { runResult } = await readRun(runId);
  assert.equal(runResult.status, "error");
  assert.equal(runResult.failure.code, "E-NAV-001");
  assert.match(runResult.error, /Adresse introuvable/);
  assert.match(runResult.failure.technical, /ERR_NAME_NOT_RESOLVED/);
});

test("l'IA ne génère aucune étape : E-PLN-001, avec le message habituel", async () => {
  const plan = async () => ({ ticketSummary: "s", warnings: ["Sélecteur inventé retiré."], steps: [] });
  const { runId, done } = await startRun(baseInput, { crawl: async () => goodCrawl, plan, run: okRun });
  await done;

  const { runResult } = await readRun(runId);
  assert.equal(runResult.status, "error");
  assert.equal(runResult.failure.code, "E-PLN-001");
  assert.match(runResult.error, /L'IA n'a généré aucune étape exécutable pour ce ticket\. Sélecteur inventé retiré\./);
  assert.ok(runResult.failure.hint);
  assert.match(runResult.failure.found, /fourni 3 éléments interactifs et 0 texte visible/);
});

test("E-PLN-001 : « trouvé » indique ce que l'exploration a fourni (singulier et pluriel)", async () => {
  const oneEach = { title: "Exemple", elementCount: 1, textElements: [{ selector: 'role=heading[name="A"]', kind: "titre", text: "A" }], elements: [{ selector: "#a" }] };
  const plan = async () => ({ ticketSummary: "s", warnings: [], steps: [] });
  const { runId, done } = await startRun(baseInput, { crawl: async () => oneEach, plan, run: okRun });
  await done;
  const { runResult } = await readRun(runId);
  assert.match(runResult.failure.found, /fourni 1 élément interactif et 1 texte visible$/);
});

test("erreur inattendue (clé IA manquante) : message d'origine conservé, code E-UNK-001", async () => {
  const plan = async () => {
    throw new Error("GROQ_API_KEY manquante dans backend/.env");
  };
  const { runId, done } = await startRun(baseInput, { crawl: async () => goodCrawl, plan, run: okRun });
  await done;

  const { runResult } = await readRun(runId);
  assert.equal(runResult.error, "GROQ_API_KEY manquante dans backend/.env");
  assert.equal(runResult.failure.code, "E-UNK-001");
});

test("le navigateur plante pendant l'exécution : run en erreur avec détail structuré", async () => {
  const run = async () => {
    throw new Error("browserType.launch: Executable doesn't exist");
  };
  const { runId, done } = await startRun(baseInput, { crawl: async () => goodCrawl, plan: okPlan, run });
  await done;

  const { runResult } = await readRun(runId);
  assert.equal(runResult.status, "error");
  assert.equal(runResult.phase, "error");
  assert.equal(runResult.failure.code, "E-UNK-001");
  assert.match(runResult.error, /Executable doesn't exist/);
});

test("un run réussi a failure: null", async () => {
  const { runId, done } = await startRun(baseInput, { crawl: async () => goodCrawl, plan: okPlan, run: okRun });
  await done;
  const { runResult } = await readRun(runId);
  assert.equal(runResult.status, "passed");
  assert.equal(runResult.failure, null);
  assert.equal(runResult.error, null);
});

test("les chemins du serveur et les clés d'API ne finissent jamais dans le run enregistré", async () => {
  const plan = async () => {
    throw new Error("Échec Groq avec gsk_AbC123xyz depuis /home/senda/qa-ui-agent/backend/.env\nCall log:\n  - /mnt/data/secret.txt");
  };
  const { runId, done } = await startRun(baseInput, { crawl: async () => goodCrawl, plan, run: okRun });
  await done;

  const { runResult } = await readRun(runId);
  const stored = JSON.stringify(runResult);
  assert.equal(stored.includes("gsk_AbC123xyz"), false);
  assert.equal(stored.includes("/home/senda"), false);
  assert.equal(stored.includes("/mnt/data"), false);
  assert.match(runResult.error, /\[clé masquée\].*\[chemin masqué\]/);
  assert.match(runResult.failure.technical, /Call log/);
});

test("étape réussie seulement à la relance : le run reste réussi mais est compté comme instable", async () => {
  const run = async (url, scenario, { runId, onProgress }) => {
    const results = [
      { index: 0, type: "navigate", description: "Ouvrir", status: "passed", attempts: 1, screenshot: null, durationMs: 1 },
      { index: 1, type: "assert_text", description: "Texte", status: "passed", attempts: 2, screenshot: null, durationMs: 4000 },
    ];
    for (const result of results) await onProgress({ type: "step_end", index: result.index, result });
    return { runId, url, status: "passed", stepsTotal: 2, stepsRun: 2, stepsPassed: 2, results };
  };
  const plan = async () => ({
    ticketSummary: "s",
    warnings: [],
    steps: [
      { type: "navigate", selector: null, value: null, description: "Ouvrir", selectorValid: true },
      { type: "assert_text", selector: "#t", value: "x", description: "Texte", selectorValid: true },
    ],
  });
  const { runId, done } = await startRun(baseInput, { crawl: async () => goodCrawl, plan, run });
  await done;

  const { runResult } = await readRun(runId);
  assert.equal(runResult.status, "passed");
  assert.equal(runResult.flakySteps, 1);
  assert.equal(runResult.results[1].attempts, 2);
});

test("run sans relance : flakySteps vaut 0", async () => {
  const { runId, done } = await startRun(baseInput, { crawl: async () => goodCrawl, plan: okPlan, run: okRun });
  await done;
  const { runResult } = await readRun(runId);
  assert.equal(runResult.flakySteps, 0);
});
