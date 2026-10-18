import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StepError,
  ERROR_CODES,
  CATEGORY_LABELS,
  classifyError,
  collectPageSnapshot,
  enrichFailure,
} from "../src/step-errors.js";
import { executeStep, newStepResult } from "../src/runner.js";

const TIMEOUTS = { stepTimeoutMs: 100, navigationTimeoutMs: 100 };

/** Message type d'une erreur Playwright : en-tête + "Call log" avec codes couleur du terminal. */
function playwrightMessage(header, ...logLines) {
  return `${header}\n\u001b[2mCall log:\u001b[22m\n${logLines.map((l) => `\u001b[2m  - ${l}\u001b[22m`).join("\n")}`;
}

test("chaque catégorie a un code stable unique et un libellé", () => {
  const codes = Object.values(ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length, "codes uniques");
  for (const category of Object.keys(ERROR_CODES)) {
    assert.match(ERROR_CODES[category], /^E-[A-Z]{3}-\d{3}$/);
    assert.ok(CATEGORY_LABELS[category], `libellé pour ${category}`);
  }
  assert.equal(ERROR_CODES.URL_MISMATCH, "E-URL-001");
});

test("StepError : failure complète, détail technique omis s'il répète le message", () => {
  const err = new StepError("TEXT_MISMATCH", "Texte différent", {
    expected: "A",
    found: "B",
    hint: "Piste",
    technical: "Texte différent",
  });
  assert.deepEqual(err.toFailure(), {
    code: "E-TXT-001",
    category: "TEXT_MISMATCH",
    label: "Texte différent",
    expected: "A",
    found: "B",
    hint: "Piste",
    technical: null,
  });
  assert.equal(new StepError("PAS_UNE_CATEGORIE", "x").category, "UNKNOWN");
});

test("classifyError : élément jamais trouvé -> ELEMENT_NOT_FOUND, message Playwright replié dans technical", () => {
  const raw = new Error(playwrightMessage("locator.click: Timeout 10000ms exceeded.", "waiting for locator('#go')"));
  const err = classifyError(raw, { type: "click", selector: "#go" });
  assert.equal(err.category, "ELEMENT_NOT_FOUND");
  assert.equal(err.code, "E-ELM-001");
  assert.match(err.message, /Élément introuvable après 10 s/);
  assert.equal(err.message.includes("Call log"), false, "la phrase lisible n'affiche pas le call log");
  assert.match(err.toFailure().technical, /Call log/);
  assert.equal(err.toFailure().technical.includes("\u001b"), false, "codes couleur retirés");
  assert.match(err.expected, /#go/);
});

test("classifyError : élément présent mais caché -> ELEMENT_NOT_VISIBLE", () => {
  const raw = new Error(
    playwrightMessage("locator.waitFor: Timeout 10000ms exceeded.", "waiting for locator('#msg') to be visible", "locator resolved to hidden <div id=\"msg\"></div>")
  );
  assert.equal(classifyError(raw, { type: "assert_visible", selector: "#msg" }).category, "ELEMENT_NOT_VISIBLE");
});

test("classifyError : sélecteur ambigu, élément recouvert, élément désactivé", () => {
  const ambiguous = new Error("locator.click: Error: strict mode violation: locator('button') resolved to 3 elements:");
  const a = classifyError(ambiguous, { type: "click", selector: "button" });
  assert.equal(a.category, "ELEMENT_AMBIGUOUS");
  assert.match(a.found, /3 éléments/);

  const obscured = new Error(playwrightMessage("locator.click: Timeout 10000ms exceeded.", "<div class=\"cookie\"> intercepts pointer events"));
  assert.equal(classifyError(obscured, { type: "click", selector: "#ok" }).category, "ELEMENT_OBSCURED");

  const disabled = new Error(playwrightMessage("locator.click: Timeout 10000ms exceeded.", "element is not enabled"));
  assert.equal(classifyError(disabled, { type: "click", selector: "#ok" }).category, "ELEMENT_DISABLED");
});

test("classifyError : timeout avec élément présent mais pas prêt -> TIMEOUT", () => {
  const raw = new Error(playwrightMessage("locator.click: Timeout 5000ms exceeded.", "locator resolved to <button>OK</button>", "element is not stable"));
  const err = classifyError(raw, { type: "click", selector: "#ok" });
  assert.equal(err.category, "TIMEOUT");
  assert.match(err.message, /5 s/);
});

test("classifyError : erreurs de navigation (DNS, connexion refusée, certificat, lenteur)", () => {
  const nav = (text) => classifyError(new Error(text), { type: "navigate" });
  assert.equal(nav("page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.tn/").category, "NAVIGATION_ERROR");
  assert.match(nav("page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.tn/").message, /Adresse introuvable/);
  assert.match(nav("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:1/").message, /refusé ou coupé/);
  assert.match(nav("page.goto: net::ERR_CERT_DATE_INVALID at https://x.tn/").message, /certificat/i);
  const slow = nav("page.goto: Timeout 30000ms exceeded.");
  assert.equal(slow.category, "TIMEOUT");
  assert.match(slow.message, /30 s/);
  assert.equal(classifyError(new Error("boom"), { type: "go_back" }).category, "NAVIGATION_ERROR");
});

test("classifyError : erreur inconnue -> UNKNOWN avec première ligne comme phrase", () => {
  const err = classifyError(new Error("Quelque chose d'inattendu\nsur deux lignes"), { type: "click", selector: "#a" });
  assert.equal(err.category, "UNKNOWN");
  assert.equal(err.message, "Quelque chose d'inattendu");
  assert.equal(classifyError(null, { type: "click" }).category, "UNKNOWN");
});

test("classifyError : une StepError est rendue telle quelle", () => {
  const original = new StepError("URL_MISMATCH", "x");
  assert.equal(classifyError(original, { type: "assert_url" }), original);
});

/** Fausse page dont le locator échoue avec le message donné sur l'action donnée. */
function failingPage(method, message, extra = {}) {
  return {
    locator: () => ({ [method]: async () => { throw new Error(message); }, ...extra }),
  };
}

test("executeStep lève toujours une StepError : clic sur un élément introuvable", async () => {
  const page = failingPage("click", playwrightMessage("locator.click: Timeout 100ms exceeded.", "waiting for locator('#go')"));
  await assert.rejects(
    () => executeStep(page, "https://x.tn/", { type: "click", selector: "#go", selectorValid: true }, TIMEOUTS),
    (err) => err instanceof StepError && err.category === "ELEMENT_NOT_FOUND" && err.code === "E-ELM-001"
  );
});

test("executeStep : assert_text avec un autre texte -> TEXT_MISMATCH (attendu / trouvé / piste)", async () => {
  const page = {
    locator: () => ({ waitFor: async () => {}, innerText: async () => "Bienvenue" }),
  };
  await assert.rejects(
    () => executeStep(page, "https://x.tn/", { type: "assert_text", selector: "#t", value: "Connexion Association", selectorValid: true }, TIMEOUTS),
    (err) =>
      err.category === "TEXT_MISMATCH" &&
      err.code === "E-TXT-001" &&
      /Connexion Association/.test(err.expected) &&
      /Bienvenue/.test(err.found) &&
      /Texte attendu introuvable/.test(err.message) &&
      typeof err.hint === "string"
  );
});

test("executeStep : assert_text ne diffère que par la casse -> piste dédiée", async () => {
  const page = { locator: () => ({ waitFor: async () => {}, innerText: async () => "CONNEXION" }) };
  await assert.rejects(
    () => executeStep(page, "https://x.tn/", { type: "assert_text", selector: "#t", value: "connexion", selectorValid: true }, TIMEOUTS),
    (err) => /casse/.test(err.hint)
  );
});

test("executeStep : sélecteur halluciné et étape sans sélecteur -> SELECTOR_HALLUCINATED / INVALID_STEP", async () => {
  await assert.rejects(
    () => executeStep({}, "https://x.tn/", { type: "click", selector: "#fantome", selectorValid: false }, TIMEOUTS),
    (err) => err.category === "SELECTOR_HALLUCINATED" && err.code === "E-SEL-001" && /halluciné/.test(err.message)
  );
  await assert.rejects(
    () => executeStep({}, "https://x.tn/", { type: "click", selector: null }, TIMEOUTS),
    (err) => err.category === "INVALID_STEP" && err.code === "E-STP-001"
  );
  await assert.rejects(
    () => executeStep({}, "https://x.tn/", { type: "teleporter", selector: "#a", selectorValid: true }, TIMEOUTS),
    (err) => err.category === "INVALID_STEP" && /Type d'étape inconnu/.test(err.message)
  );
});

test("executeStep : assert_enabled sur un élément désactivé -> ELEMENT_DISABLED", async () => {
  const page = { locator: () => ({ waitFor: async () => {}, evaluate: async () => true }) };
  await assert.rejects(
    () => executeStep(page, "https://x.tn/", { type: "assert_enabled", selector: "#go", selectorValid: true }, TIMEOUTS),
    (err) => err.category === "ELEMENT_DISABLED" && err.code === "E-ELM-003"
  );
});

test("executeStep : assert_url en échec -> URL_MISMATCH, adresse réelle sans secret", async () => {
  const page = {
    url: () => "https://x.tn/auth/login?token=SECRET42",
    waitForURL: async () => { throw new Error("Timeout"); },
  };
  await assert.rejects(
    () => executeStep(page, "https://x.tn/", { type: "assert_url", value: "/association" }, TIMEOUTS),
    (err) => {
      const failure = err.toFailure();
      return (
        err.category === "URL_MISMATCH" &&
        err.code === "E-URL-001" &&
        /association/.test(failure.expected) &&
        /token=\*\*\*/.test(failure.found) &&
        !JSON.stringify(failure).includes("SECRET42")
      );
    }
  );
});

test("la valeur saisie dans un fill (mot de passe) n'apparaît jamais dans l'échec", async () => {
  const page = failingPage("fill", playwrightMessage("locator.fill: Timeout 100ms exceeded.", "waiting for locator('#pw')"));
  await assert.rejects(
    () => executeStep(page, "https://x.tn/", { type: "fill", selector: "#pw", value: "MotDePasse!123", selectorValid: true }, TIMEOUTS),
    (err) => !JSON.stringify(err.toFailure()).includes("MotDePasse") && !err.message.includes("MotDePasse")
  );
});

test("résultat d'étape : champ failure présent (null tant que l'étape n'a pas échoué)", () => {
  const result = newStepResult(0, { type: "click", selector: "#a", description: "d" });
  assert.equal(result.failure, null);
  assert.equal(result.error, null);
});

/** Fausse page dont evaluate renvoie l'instantané donné. */
function snapshotPage(snapshot) {
  return { evaluate: async () => snapshot };
}

test("collectPageSnapshot : renvoie null si la page n'est pas lisible (jamais d'exception)", async () => {
  assert.equal(await collectPageSnapshot(null), null);
  assert.equal(await collectPageSnapshot({}), null);
  assert.equal(await collectPageSnapshot({ evaluate: async () => { throw new Error("page fermée"); } }), null);
  assert.equal(await collectPageSnapshot({ evaluate: () => new Promise(() => {}) }, { timeoutMs: 20 }), null);
});

test("enrichFailure : vérification qui échoue -> textes visibles + piste « il manque un clic »", async () => {
  const failure = classifyError(
    new Error(playwrightMessage("locator.waitFor: Timeout 10000ms exceeded.", "waiting for locator('text=\"Connexion Association\"')")),
    { type: "assert_visible", selector: 'text="Connexion Association"' }
  );
  const page = snapshotPage({ texts: ["Votre don, leur avenir"], actions: ["Continuer"] });
  await enrichFailure(page, { type: "assert_visible" }, failure);
  assert.match(failure.found, /Textes visibles sur la page : « Votre don, leur avenir »/);
  assert.match(failure.hint, /Une action manque peut-être/);
  assert.match(failure.hint, /« Continuer »/);
});

test("enrichFailure : action sur un élément introuvable -> boutons et liens visibles", async () => {
  const failure = classifyError(
    new Error(playwrightMessage("locator.click: Timeout 10000ms exceeded.", "waiting for locator('#go')")),
    { type: "click", selector: "#go" }
  );
  await enrichFailure(snapshotPage({ texts: ["Titre"], actions: ["Se connecter", "Retour"] }), { type: "click" }, failure);
  assert.match(failure.found, /Boutons et liens visibles : « Se connecter », « Retour »/);
});

test("enrichFailure : page vide -> piste sur l'affichage de l'appli", async () => {
  const failure = classifyError(
    new Error(playwrightMessage("locator.waitFor: Timeout 10000ms exceeded.", "waiting for locator('#x')")),
    { type: "assert_visible", selector: "#x" }
  );
  await enrichFailure(snapshotPage({ texts: [], actions: [] }), { type: "assert_visible" }, failure);
  assert.match(failure.found, /Aucun texte visible/);
  assert.match(failure.hint, /RENDER_TIMEOUT_MS/);
});

test("enrichFailure : TEXT_MISMATCH garde son « trouvé » ; les autres catégories et pages illisibles sont laissées intactes", async () => {
  const mismatch = new StepError("TEXT_MISMATCH", "m", { expected: "A", found: "« B »", hint: "h" });
  await enrichFailure(snapshotPage({ texts: ["Autre"], actions: ["Ok"] }), { type: "assert_text" }, mismatch);
  assert.equal(mismatch.found, "« B »");
  assert.equal(mismatch.hint, "h");

  const url = new StepError("URL_MISMATCH", "u", { found: "Adresse actuelle : x", hint: "h" });
  await enrichFailure(snapshotPage({ texts: ["Autre"], actions: ["Ok"] }), { type: "assert_url" }, url);
  assert.equal(url.found, "Adresse actuelle : x");

  const unreadable = new StepError("ELEMENT_NOT_FOUND", "n", { found: "origine", hint: "h" });
  await enrichFailure({}, { type: "click" }, unreadable);
  assert.equal(unreadable.found, "origine");
});

test("classifyError : pour une vérification de texte, « attendu » donne le texte, pas le sélecteur", () => {
  const raw = new Error(playwrightMessage("locator.waitFor: Timeout 10000ms exceeded.", "waiting for locator('text=\"Mot de passe incorrect\"').first() to be visible"));
  const fromValue = classifyError(raw, { type: "assert_text", selector: 'text="Mot de passe incorrect"', value: "Mot de passe incorrect" });
  assert.equal(fromValue.expected, "Texte « Mot de passe incorrect » visible");
  const fromSelector = classifyError(raw, { type: "assert_visible", selector: 'text="Bienvenue"' });
  assert.equal(fromSelector.expected, "Texte « Bienvenue » visible");
  const escaped = classifyError(raw, { type: "assert_visible", selector: 'text="Dire \\"non\\""' });
  assert.equal(escaped.expected, 'Texte « Dire "non" » visible');
  const click = classifyError(
    new Error(playwrightMessage("locator.click: Timeout 10000ms exceeded.", "waiting for locator('#go')")),
    { type: "click", selector: "#go" }
  );
  assert.equal(click.expected, "Élément #go");
});

test("enrichFailure : un message affiché mais différent -> « Messages affichés » + piste sur le libellé (pas « il manque un clic »)", async () => {
  const failure = classifyError(
    new Error(playwrightMessage("locator.waitFor: Timeout 10000ms exceeded.", "waiting for locator('text=\"Mot de passe incorrect\"').first() to be visible")),
    { type: "assert_text", selector: 'text="Mot de passe incorrect"', value: "Mot de passe incorrect" }
  );
  const page = snapshotPage({
    messages: ["Your username is invalid!"],
    texts: ["Login Page", "Username"],
    actions: ["Login", "Elemental Selenium"],
  });
  await enrichFailure(page, { type: "assert_text" }, failure);
  assert.match(failure.found, /Messages affichés : « Your username is invalid! »/);
  assert.match(failure.found, /Textes visibles sur la page : « Login Page », « Username »/);
  assert.match(failure.hint, /Un message est bien affiché, mais son texte diffère/);
  assert.equal(/Une action manque/.test(failure.hint), false);
});

test("collectPageSnapshot : retire le « × » de fermeture, ignore les faux boutons et les textes cachés", async () => {
  const el = (innerText, { visible = true, attrs = {}, type, value } = {}) => ({
    innerText,
    type,
    value,
    getAttribute: (name) => attrs[name] ?? null,
    getBoundingClientRect: () => (visible ? { width: 10, height: 10 } : { width: 0, height: 0 }),
  });
  const dom = {
    flash: [el("Your username is invalid!\n×"), el("Message caché", { visible: false })],
    headings: [el("Login Page"), el("Your username is invalid!\n×")],
    actions: [el("×"), el("Login"), el("Elemental Selenium"), el("", { type: "submit", value: "Envoyer" })],
  };
  const previous = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = {
    querySelectorAll: (selector) => (selector.includes("flash") ? dom.flash : selector.includes("h1") ? dom.headings : dom.actions),
  };
  globalThis.getComputedStyle = () => ({ visibility: "visible", display: "block" });
  try {
    const snapshot = await collectPageSnapshot({ evaluate: async (fn) => fn() });
    assert.deepEqual(snapshot.messages, ["Your username is invalid!"]);
    assert.deepEqual(snapshot.texts, ["Login Page"], "le message n'est pas répété dans les textes");
    assert.deepEqual(snapshot.actions, ["Login", "Elemental Selenium", "Envoyer"], "« × » n'est pas un bouton");
  } finally {
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.getComputedStyle;
  }
});

test("classifyError : un texte attendu introuvable est annoncé comme tel, un élément comme un élément", () => {
  const raw = new Error(playwrightMessage("locator.waitFor: Timeout 10000ms exceeded.", "waiting for locator('text=\"Mot de passe incorrect\"').first() to be visible"));
  const text = classifyError(raw, { type: "assert_text", selector: 'text="Mot de passe incorrect"', value: "Mot de passe incorrect" });
  assert.equal(text.category, "ELEMENT_NOT_FOUND");
  assert.equal(text.message, "Texte attendu introuvable après 10 s.");
  const click = classifyError(
    new Error(playwrightMessage("locator.click: Timeout 10000ms exceeded.", "waiting for locator('#go')")),
    { type: "click", selector: "#go" }
  );
  assert.equal(click.message, "Élément introuvable après 10 s.");
});
