import { test } from "node:test";
import assert from "node:assert/strict";
import { executeStepWithRetry, getRetryConfig, newStepResult } from "../src/runner.js";
import { StepError, isRetryable, countFlakySteps } from "../src/step-errors.js";

const TIMEOUTS = { stepTimeoutMs: 10000, navigationTimeoutMs: 30000 };

/** Message type d'une erreur Playwright : cible jamais trouvée dans le délai. */
const NOT_FOUND = "locator.waitFor: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('#x') to be visible";

/** Sommeil factice : on mesure les attentes au lieu de les subir. */
function fakeSleep() {
  const sleep = async (ms) => {
    sleep.calls.push(ms);
  };
  sleep.calls = [];
  return sleep;
}

test("getRetryConfig : valeurs par défaut, plafond à 2, valeurs invalides ignorées", () => {
  assert.deepEqual(getRetryConfig({}), { maxRetries: 1, retryTimeoutMs: 3000, retryDelayMs: 500 });
  assert.equal(getRetryConfig({ STEP_RETRIES: "0" }).maxRetries, 0);
  assert.equal(getRetryConfig({ STEP_RETRIES: "2" }).maxRetries, 2);
  assert.equal(getRetryConfig({ STEP_RETRIES: "9" }).maxRetries, 2, "plafonné");
  for (const bad of ["abc", "-1", "1.5", ""]) {
    assert.equal(getRetryConfig({ STEP_RETRIES: bad }).maxRetries, 1, `STEP_RETRIES="${bad}" ignoré`);
  }
  assert.equal(getRetryConfig({ STEP_RETRY_TIMEOUT_MS: "1500" }).retryTimeoutMs, 1500);
  assert.equal(getRetryConfig({ STEP_RETRY_TIMEOUT_MS: "0" }).retryTimeoutMs, 3000);
});

test("isRetryable : relance sûre seulement (jamais un clic qui a pu s'exécuter, jamais l'erreur déterministe)", () => {
  const f = (category, extra = {}) => ({ category, ...extra });

  // Cible pas encore là : on retente, même pour un clic (il n'a pas pu s'exécuter).
  for (const category of ["ELEMENT_NOT_FOUND", "ELEMENT_NOT_VISIBLE", "ELEMENT_OBSCURED", "ELEMENT_DISABLED"]) {
    assert.equal(isRetryable(f(category), { type: "click" }), true, `click / ${category}`);
  }
  // Un clic qui expire AVEC l'élément présent a pu partir : jamais relancé (risque de double action).
  assert.equal(isRetryable(f("TIMEOUT"), { type: "click" }), false);
  assert.equal(isRetryable(f("UNKNOWN"), { type: "click" }), false);
  // Saisie et choix sont idempotents : le délai dépassé est aussi retenté.
  assert.equal(isRetryable(f("TIMEOUT"), { type: "fill" }), true);
  assert.equal(isRetryable(f("TIMEOUT"), { type: "select" }), true);
  // Vérifications : texte et adresse qui s'affichent à l'instant.
  for (const type of ["assert_visible", "assert_text", "assert_enabled", "assert_url"]) {
    assert.equal(isRetryable(f("TEXT_MISMATCH"), { type }), true, `${type} / TEXT_MISMATCH`);
    assert.equal(isRetryable(f("URL_MISMATCH"), { type }), true, `${type} / URL_MISMATCH`);
  }
  // Erreurs déterministes : jamais.
  for (const category of ["INVALID_STEP", "SELECTOR_HALLUCINATED", "ELEMENT_AMBIGUOUS", "UNKNOWN"]) {
    for (const type of ["click", "fill", "assert_text", "assert_visible"]) {
      assert.equal(isRetryable(f(category), { type }), false, `${type} / ${category}`);
    }
  }
  // Navigation : délai et coupure oui ; DNS et certificat non.
  assert.equal(isRetryable(f("TIMEOUT"), { type: "navigate" }), true);
  assert.equal(isRetryable(f("NAVIGATION_ERROR", { found: "Connexion refusée ou interrompue" }), { type: "navigate" }), true);
  assert.equal(isRetryable(f("NAVIGATION_ERROR", { found: "Nom de domaine non résolu (ERR_NAME_NOT_RESOLVED)" }), { type: "navigate" }), false);
  assert.equal(isRetryable(f("NAVIGATION_ERROR", { found: "Certificat invalide, expiré ou non reconnu" }), { type: "navigate" }), false);
  // Retour arrière : jamais (reculer deux fois).
  assert.equal(isRetryable(f("TIMEOUT"), { type: "go_back" }), false);
  assert.equal(isRetryable(f("NAVIGATION_ERROR"), { type: "go_back" }), false);
});

test("countFlakySteps : seules les étapes RÉUSSIES après plusieurs tentatives comptent", () => {
  assert.equal(
    countFlakySteps([
      { status: "passed", attempts: 1 },
      { status: "passed", attempts: 2 },
      { status: "failed", attempts: 2 },
      { status: "passed" }, // ancien run, sans `attempts`
      null,
    ]),
    1
  );
  assert.equal(countFlakySteps(undefined), 0);
});

test("étape réussie du premier coup : une seule tentative, aucune attente", async () => {
  const sleep = fakeSleep();
  const page = { locator: () => ({ waitFor: async () => {} }) };
  const outcome = await executeStepWithRetry(page, "https://x.tn/", { type: "assert_visible", selector: "#x", selectorValid: true }, TIMEOUTS, { maxRetries: 2, sleep });
  assert.deepEqual(outcome, { attempts: 1, error: null, firstError: null });
  assert.deepEqual(sleep.calls, []);
});

test("échec passager : réussit à la relance -> 2 tentatives, délai court, première erreur gardée", async () => {
  const sleep = fakeSleep();
  const timeoutsSeen = [];
  let calls = 0;
  const page = {
    locator: () => ({
      waitFor: async ({ timeout }) => {
        timeoutsSeen.push(timeout);
        calls += 1;
        if (calls === 1) throw new Error(NOT_FOUND);
      },
    }),
  };
  const outcome = await executeStepWithRetry(page, "https://x.tn/", { type: "assert_visible", selector: "#x", selectorValid: true }, TIMEOUTS, {
    maxRetries: 1,
    retryTimeoutMs: 3000,
    retryDelayMs: 500,
    sleep,
  });

  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.error, null, "l'étape est réussie");
  assert.equal(outcome.firstError.category, "ELEMENT_NOT_FOUND");
  assert.equal(outcome.firstError.code, "E-ELM-001");
  assert.deepEqual(sleep.calls, [500]);
  assert.deepEqual(timeoutsSeen, [10000, 3000], "la relance attend moins longtemps que la première tentative");
});

test("la relance n'allonge jamais le délai : un délai de base déjà court reste court", async () => {
  const timeoutsSeen = [];
  let calls = 0;
  const page = {
    locator: () => ({
      waitFor: async ({ timeout }) => {
        timeoutsSeen.push(timeout);
        calls += 1;
        if (calls === 1) throw new Error(NOT_FOUND);
      },
    }),
  };
  await executeStepWithRetry(page, "https://x.tn/", { type: "assert_visible", selector: "#x", selectorValid: true }, { stepTimeoutMs: 1000, navigationTimeoutMs: 30000 }, { maxRetries: 1, retryTimeoutMs: 3000, sleep: fakeSleep() });
  assert.deepEqual(timeoutsSeen, [1000, 1000]);
});

test("échec durable : toutes les tentatives sont utilisées, l'erreur rendue est la dernière", async () => {
  for (const [maxRetries, expectedAttempts] of [[0, 1], [1, 2], [2, 3]]) {
    const sleep = fakeSleep();
    let calls = 0;
    const page = {
      locator: () => ({
        waitFor: async () => {
          calls += 1;
          throw new Error(NOT_FOUND);
        },
      }),
    };
    const outcome = await executeStepWithRetry(page, "https://x.tn/", { type: "assert_visible", selector: "#x", selectorValid: true }, TIMEOUTS, { maxRetries, sleep });
    assert.equal(outcome.attempts, expectedAttempts, `maxRetries=${maxRetries}`);
    assert.equal(calls, expectedAttempts);
    assert.ok(outcome.error instanceof StepError);
    assert.equal(outcome.error.category, "ELEMENT_NOT_FOUND");
    assert.equal(sleep.calls.length, expectedAttempts - 1);
  }
});

test("texte qui s'affiche avec un peu de retard : la relance le retrouve", async () => {
  let reads = 0;
  const page = {
    locator: () => ({
      waitFor: async () => {},
      innerText: async () => (++reads === 1 ? "Chargement…" : "Bienvenue Senda"),
    }),
  };
  const outcome = await executeStepWithRetry(page, "https://x.tn/", { type: "assert_text", selector: "#t", value: "Bienvenue", selectorValid: true }, TIMEOUTS, { maxRetries: 1, sleep: fakeSleep() });
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.error, null);
  assert.equal(outcome.firstError.category, "TEXT_MISMATCH");
});

test("erreurs déterministes : jamais relancées, même avec des relances disponibles", async () => {
  const sleep = fakeSleep();
  const hallucinated = await executeStepWithRetry({}, "https://x.tn/", { type: "click", selector: "#fantome", selectorValid: false }, TIMEOUTS, { maxRetries: 2, sleep });
  assert.equal(hallucinated.attempts, 1);
  assert.equal(hallucinated.error.category, "SELECTOR_HALLUCINATED");

  const noSelector = await executeStepWithRetry({}, "https://x.tn/", { type: "click", selector: null }, TIMEOUTS, { maxRetries: 2, sleep });
  assert.equal(noSelector.attempts, 1);
  assert.equal(noSelector.error.category, "INVALID_STEP");
  assert.deepEqual(sleep.calls, []);
});

test("un clic qui expire alors que l'élément est présent n'est JAMAIS relancé (pas de double action)", async () => {
  let clicks = 0;
  const page = {
    locator: () => ({
      click: async () => {
        clicks += 1;
        throw new Error("locator.click: Timeout 10000ms exceeded.\nCall log:\n  - locator resolved to <button>OK</button>\n  - waiting for scheduled navigations to finish");
      },
    }),
  };
  const outcome = await executeStepWithRetry(page, "https://x.tn/", { type: "click", selector: "#ok", selectorValid: true }, TIMEOUTS, { maxRetries: 2, sleep: fakeSleep() });
  assert.equal(clicks, 1, "le clic n'est exécuté qu'une fois");
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.error.category, "TIMEOUT");
});

test("un clic sur un élément pas encore affiché est relancé (il n'a pas pu s'exécuter)", async () => {
  let calls = 0;
  const page = {
    locator: () => ({
      click: async () => {
        calls += 1;
        if (calls === 1) throw new Error("locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('#ok')");
      },
    }),
  };
  const outcome = await executeStepWithRetry(page, "https://x.tn/", { type: "click", selector: "#ok", selectorValid: true }, TIMEOUTS, { maxRetries: 1, sleep: fakeSleep() });
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.error, null);
});

test("le retour arrière n'est jamais relancé", async () => {
  let backs = 0;
  const page = {
    goBack: async () => {
      backs += 1;
      throw new Error("page.goBack: Timeout 30000ms exceeded.");
    },
    url: () => "https://x.tn/",
  };
  const outcome = await executeStepWithRetry(page, "https://x.tn/", { type: "go_back" }, TIMEOUTS, { maxRetries: 2, sleep: fakeSleep() });
  assert.equal(backs, 1);
  assert.equal(outcome.attempts, 1);
  assert.ok(outcome.error);
});

test("newStepResult : une étape commence avec 1 tentative", () => {
  assert.equal(newStepResult(0, { type: "click", selector: "#a", description: "d" }).attempts, 1);
});

test("échec après relances : la phrase donne l'attente TOTALE et le nombre d'essais, pas seulement la dernière tentative", async () => {
  const failing = () => ({
    locator: () => ({
      waitFor: async () => {
        throw new Error(NOT_FOUND);
      },
    }),
  });
  const step = { type: "assert_visible", selector: "#x", selectorValid: true };

  // 10 s (1re tentative) + 3 s (relance) = 13 s.
  const one = await executeStepWithRetry(failing(), "https://x.tn/", step, TIMEOUTS, { maxRetries: 1, retryTimeoutMs: 3000, sleep: fakeSleep() });
  assert.equal(one.error.message, "Élément introuvable après 13 s en 2 essais.");

  // 10 s + 3 s + 3 s = 16 s, 3 essais.
  const two = await executeStepWithRetry(failing(), "https://x.tn/", step, TIMEOUTS, { maxRetries: 2, retryTimeoutMs: 3000, sleep: fakeSleep() });
  assert.equal(two.error.message, "Élément introuvable après 16 s en 3 essais.");

  // Sans relance, la phrase reste celle d'origine.
  const none = await executeStepWithRetry(failing(), "https://x.tn/", step, TIMEOUTS, { maxRetries: 0, sleep: fakeSleep() });
  assert.equal(none.error.message, "Élément introuvable après 10 s.");
});

test("texte attendu introuvable après relances : même correction, vocabulaire du texte conservé", async () => {
  const page = {
    locator: () => ({
      waitFor: async () => {
        throw new Error('locator.waitFor: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator(\'text="Bonjour"\').first() to be visible');
      },
    }),
  };
  const outcome = await executeStepWithRetry(page, "https://x.tn/", { type: "assert_text", selector: 'text="Bonjour"', value: "Bonjour", selectorValid: true }, TIMEOUTS, { maxRetries: 1, sleep: fakeSleep() });
  assert.equal(outcome.error.message, "Texte attendu introuvable après 13 s en 2 essais.");
});
