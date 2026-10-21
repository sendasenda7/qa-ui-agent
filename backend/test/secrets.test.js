import { test } from "node:test";
import assert from "node:assert/strict";
import { listSecretNames, findPlaceholders, resolveSecrets, maskSecrets, maskSecretsDeep } from "../src/secrets.js";
import { validateScenario, generateScenario } from "../src/planner.js";
import { executeStep, executeStepWithRetry } from "../src/runner.js";

const env = { QA_SECRET_EMAIL: "qa.test@exemple.tn", QA_SECRET_PASSWORD: "Mot2Passe!Secret", QA_SECRET_EMPTY: "", GROQ_API_KEY: "gsk_ne_jamais_lire", JWT_SECRET: "x".repeat(40) };

test("listSecretNames : seulement les QA_SECRET_ non vides, jamais les valeurs ni d'autres variables", () => {
  assert.deepEqual(listSecretNames(env), ["QA_SECRET_EMAIL", "QA_SECRET_PASSWORD"]);
  assert.deepEqual(listSecretNames({}), []);
});

test("findPlaceholders / resolveSecrets", () => {
  assert.deepEqual(findPlaceholders("{{QA_SECRET_EMAIL}} et {{ QA_SECRET_PASSWORD }}"), ["QA_SECRET_EMAIL", "QA_SECRET_PASSWORD"]);
  assert.deepEqual(findPlaceholders("{{GROQ_API_KEY}}"), [], "seuls les noms QA_SECRET_ sont des variables");
  assert.deepEqual(findPlaceholders(null), []);
  assert.deepEqual(resolveSecrets("{{QA_SECRET_EMAIL}}", env), { value: "qa.test@exemple.tn", missing: [] });
  assert.deepEqual(resolveSecrets("pre-{{QA_SECRET_PASSWORD}}-post", env).value, "pre-Mot2Passe!Secret-post");
  const r = resolveSecrets("{{QA_SECRET_ABSENT}} {{QA_SECRET_EMPTY}}", env);
  assert.deepEqual(r.missing, ["QA_SECRET_ABSENT", "QA_SECRET_EMPTY"]);
  assert.equal(r.value, "{{QA_SECRET_ABSENT}} {{QA_SECRET_EMPTY}}");
  // GROQ_API_KEY n'est jamais lisible, même si on l'écrit en variable
  assert.equal(resolveSecrets("{{GROQ_API_KEY}}", env).value, "{{GROQ_API_KEY}}");
});

test("maskSecrets / maskSecretsDeep : la valeur n'apparaît plus, même échappée dans du JSON", () => {
  assert.equal(maskSecrets('Texte attendu "Mot2Passe!Secret" introuvable', env), 'Texte attendu "***" introuvable');
  const tricky = { ...env, QA_SECRET_X: 'a"b\\c' };
  const failure = { code: "E-TXT-001", message: 'Attendu "Mot2Passe!Secret"', found: 'a"b\\c', nested: ["qa.test@exemple.tn"] };
  const masked = maskSecretsDeep(failure, tricky);
  assert.equal(JSON.stringify(masked).includes("Mot2Passe"), false);
  assert.equal(JSON.stringify(masked).includes("qa.test@exemple.tn"), false);
  assert.equal(masked.found, "***");
  assert.equal(failure.message.includes("Mot2Passe"), true, "l'original n'est pas modifié");
  assert.equal(maskSecrets("abc", { QA_SECRET_SHORT: "abc" }), "abc", "trop court pour être masqué sans abîmer le texte");
  assert.equal(maskSecretsDeep({ a: 1 }, {}).a, 1);
});

// ---- exécution ----
function fakePage() {
  const filled = [];
  const locator = {
    fill: async (value) => filled.push(value),
    selectOption: async (value) => filled.push(value),
    waitFor: async () => {},
    innerText: async () => "Bonjour qa.test@exemple.tn",
    first() { return this; },
    count: async () => 1,
  };
  return { filled, locator: () => locator, url: () => "https://x.test/" };
}
const withEnv = async (vars, fn) => {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; process.env[k] = v; }
  try { await fn(); } finally { for (const k of Object.keys(vars)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } }
};

test("runner : fill saisit la vraie valeur, l'étape enregistrée garde la variable", async () => {
  await withEnv({ QA_SECRET_EMAIL: "qa.test@exemple.tn" }, async () => {
    const page = fakePage();
    const step = { type: "fill", selector: "#email", selectorValid: true, value: "{{QA_SECRET_EMAIL}}" };
    await executeStep(page, "https://x.test/", step, { stepTimeoutMs: 100 });
    assert.deepEqual(page.filled, ["qa.test@exemple.tn"]);
    assert.equal(step.value, "{{QA_SECRET_EMAIL}}");
  });
});

test("runner : variable absente -> E-SEC-001 lisible, sans relance", async () => {
  delete process.env.QA_SECRET_ABSENT;
  const page = fakePage();
  const step = { type: "fill", selector: "#email", selectorValid: true, value: "{{QA_SECRET_ABSENT}}" };
  const outcome = await executeStepWithRetry(page, "https://x.test/", step, { stepTimeoutMs: 100 }, { maxRetries: 2, sleep: async () => {} });
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.error.code, "E-SEC-001");
  assert.match(outcome.error.message, /QA_SECRET_ABSENT/);
  assert.deepEqual(page.filled, [], "rien n'est saisi");
});

test("runner : assert_text avec variable compare à la vraie valeur ; l'échec ne l'affiche pas une fois masqué", async () => {
  await withEnv({ QA_SECRET_EMAIL: "qa.test@exemple.tn" }, async () => {
    const page = fakePage();
    await executeStep(page, "https://x.test/", { type: "assert_text", selector: "#who", selectorValid: true, value: "{{QA_SECRET_EMAIL}}" }, { stepTimeoutMs: 100 });
    page.locator().innerText = async () => "Bonjour autre@exemple.tn";
    await assert.rejects(
      () => executeStep(page, "https://x.test/", { type: "assert_text", selector: "#who", selectorValid: true, value: "{{QA_SECRET_EMAIL}}" }, { stepTimeoutMs: 100 }),
      (err) => err.code === "E-TXT-001" && err.message.includes("qa.test@exemple.tn") && !JSON.stringify(maskSecretsDeep(err.toFailure())).includes("qa.test@exemple.tn")
    );
  });
});

// ---- planner ----
const crawl = { url: "https://x.test/", elements: [{ selector: "#email", type: "email" }, { selector: "#pw", type: "password" }] };

test("planner : variable inconnue et mot de passe en clair sont signalés ; une variable connue ne l'est pas", async () => {
  await withEnv({ QA_SECRET_PASSWORD: "Mot2Passe!Secret" }, async () => {
    delete process.env.QA_SECRET_ABSENT;
    const { warnings } = validateScenario(
      { steps: [
        { type: "fill", selector: "#email", value: "{{QA_SECRET_ABSENT}}", description: "email" },
        { type: "fill", selector: "#pw", value: "123456", description: "mot de passe en clair" },
        { type: "fill", selector: "#pw", value: "{{QA_SECRET_PASSWORD}}", description: "mot de passe ok" },
      ] },
      crawl
    );
    assert.equal(warnings.filter((w) => w.includes("QA_SECRET_ABSENT")).length, 1);
    assert.equal(warnings.filter((w) => w.includes("Mot de passe écrit en clair")).length, 1);
    assert.equal(warnings.some((w) => w.includes("mot de passe ok")), false);
  });
});

test("planner : le prompt donne les NOMS des variables, jamais leurs valeurs", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "fake-key";
  const prompts = [];
  global.fetch = async (url, opts) => {
    prompts.push(JSON.parse(opts.body).messages.map((m) => m.content).join("\n"));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ choices: [{ message: { content: JSON.stringify({ ticketSummary: "s", warnings: [], steps: [] }) } }] }) };
  };
  try {
    await generateScenario("ticket", crawl);
    await withEnv({ QA_SECRET_EMAIL: "qa.test@exemple.tn", QA_SECRET_PASSWORD: "Mot2Passe!Secret" }, async () => {
      await generateScenario("ticket", crawl);
    });
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
  assert.doesNotMatch(prompts[0], /VARIABLES SECRÈTES/);
  assert.match(prompts[1], /VARIABLES SECRÈTES DISPONIBLES/);
  assert.match(prompts[1], /- QA_SECRET_EMAIL/);
  assert.match(prompts[1], /- QA_SECRET_PASSWORD/);
  assert.equal(prompts[1].includes("qa.test@exemple.tn"), false);
  assert.equal(prompts[1].includes("Mot2Passe!Secret"), false);
});
