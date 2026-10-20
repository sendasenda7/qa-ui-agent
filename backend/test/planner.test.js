import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScenario, reviewScenario, NO_CHECK_WARNING, NO_OPEN_WARNING } from "../src/planner.js";

const crawlResult = {
  elements: [
    { selector: "#continue-btn" },
    { selector: "#role-select" },
    { selector: "#back-btn" },
  ],
};

test("neutralise un sélecteur halluciné et ajoute un avertissement", () => {
  const scenario = {
    ticketSummary: "test",
    warnings: [],
    steps: [
      { type: "navigate", description: "ouvrir la page" },
      { type: "click", selector: "#does-not-exist", description: "clic fantôme" },
      { type: "assert_visible", selector: "#continue-btn", description: "bouton visible" },
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps[1].selectorValid, false);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Sélecteur halluciné/);
});

test("retire un assert_enabled isolé (bug TR-0248 : ni action d'activation avant, ni clic après)", () => {
  const scenario = {
    ticketSummary: "Vérifier que le bouton Continuer est actif",
    warnings: [],
    steps: [
      { type: "navigate", description: "ouvrir la page" },
      { type: "assert_visible", selector: "#continue-btn", description: "bouton visible" },
      { type: "assert_enabled", selector: "#continue-btn", description: "bouton activé" },
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].type, "assert_visible");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Étape incohérente retirée/);
  // Un avertissement -> 100 - 15 = 85.
  assert.equal(result.confidence, 85);
});

test("garde un assert_enabled cohérent (action d'activation avant + clic après sur le même sélecteur)", () => {
  const scenario = {
    ticketSummary: "Choisir un rôle puis valider",
    warnings: [],
    steps: [
      { type: "navigate", description: "ouvrir la page" },
      { type: "select", selector: "#role-select", value: "medical", description: "choix du rôle" },
      { type: "assert_enabled", selector: "#continue-btn", description: "bouton activé" },
      { type: "click", selector: "#continue-btn", description: "clic sur continuer" },
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps.length, 4);
  assert.deepEqual(
    result.steps.map((s) => s.type),
    ["navigate", "select", "assert_enabled", "click"]
  );
  assert.equal(result.warnings.length, 0);
  assert.equal(result.confidence, 100);
});

test("un scénario vide obtient une confiance de 0", () => {
  const scenario = { ticketSummary: "rien à faire", warnings: [], steps: [] };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.confidence, 0);
});

test("un champ 'steps' qui n'est pas un tableau est neutralisé avec un avertissement clair", () => {
  const scenario = { ticketSummary: "test", warnings: [], steps: "pas un tableau" };

  const result = validateScenario(scenario, crawlResult);

  assert.deepEqual(result.steps, []);
  assert.equal(result.confidence, 0);
  assert.ok(result.warnings.some((w) => /un tableau d'étapes valide/.test(w)));
});

test("une étape avec un type inconnu (halluciné) est retirée avec un avertissement", () => {
  const scenario = {
    ticketSummary: "test",
    warnings: [],
    steps: [
      { type: "navigate", description: "aller sur la page" },
      { type: "double_click", selector: "#continue-btn", description: "double-clic inventé" },
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].type, "navigate");
  assert.ok(result.warnings.some((w) => /type d'étape inconnu "double_click"/.test(w)));
});

test("une étape qui n'est pas un objet (null, chaîne...) est ignorée sans planter", () => {
  const scenario = {
    ticketSummary: "test",
    warnings: [],
    steps: [
      { type: "navigate", description: "ok" },
      { type: "assert_visible", selector: "#continue-btn", description: "bouton visible" },
      null,
      "texte inattendu",
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps.length, 2);
  assert.equal(result.warnings.length, 2);
});

test("une description manquante est remplacée par un texte de repli plutôt que 'undefined'", () => {
  const scenario = {
    ticketSummary: "test",
    warnings: [],
    steps: [{ type: "navigate", description: "ouvrir la page" }, { type: "assert_visible", selector: "#continue-btn" }],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps[1].description, "(étape sans description)");
});
test("un scénario sans aucune vérification est signalé et sa confiance est plafonnée à 30", () => {
  const scenario = {
    ticketSummary: "Vérifier que le texte est affiché",
    warnings: [],
    steps: [
      { type: "navigate", description: "ouvrir la page" },
      { type: "click", selector: "#continue-btn", description: "cliquer" },
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.warnings, [NO_CHECK_WARNING]);
  assert.match(result.warnings[0], /Aucune vérification dans ce scénario/);
  // 100 - 15 = 85 sans le plafond ; avec, 30.
  assert.equal(result.confidence, 30);
});

test("le plafond ne remonte jamais une confiance déjà plus basse", () => {
  const scenario = {
    ticketSummary: "test",
    warnings: ["a", "b", "c", "d", "e"],
    steps: [{ type: "navigate", description: "ouvrir" }],
  };

  const result = validateScenario(scenario, crawlResult);

  // 5 avertissements de l'IA + celui d'absence de vérification = 6 -> 100 - 90 = 10 (sous le plafond).
  assert.equal(result.warnings.length, 6);
  assert.equal(result.confidence, 10);
});

test("chaque type de vérification suffit : assert_visible, assert_text, assert_url, assert_enabled", () => {
  const checks = [
    { type: "assert_visible", selector: "#continue-btn", description: "visible" },
    { type: "assert_text", selector: "#continue-btn", value: "Continuer", description: "texte" },
    { type: "assert_url", value: "/merci", description: "adresse" },
    { type: "assert_enabled", selector: "#continue-btn", description: "actif" },
  ];
  for (const check of checks) {
    // assert_enabled doit rester cohérent : une action d'activation avant, un clic après.
    const steps =
      check.type === "assert_enabled"
        ? [{ type: "navigate", description: "ouvrir" }, { type: "select", selector: "#role-select", value: "medical", description: "choix" }, check, { type: "click", selector: "#continue-btn", description: "clic" }]
        : [{ type: "navigate", description: "ouvrir" }, check];
    const result = validateScenario({ ticketSummary: "t", warnings: [], steps }, crawlResult);
    assert.equal(result.warnings.includes(NO_CHECK_WARNING), false, `${check.type} compte comme une vérification`);
    assert.equal(result.confidence, 100, check.type);
  }
});

test("un scénario vide n'a ni l'avertissement d'absence de vérification, ni de confiance", () => {
  const result = validateScenario({ ticketSummary: "rien", warnings: [], steps: [] }, crawlResult);
  assert.equal(result.warnings.includes(NO_CHECK_WARNING), false);
  assert.equal(result.confidence, 0);
});

test("la relecture IA garde le plafond quand le scénario ne vérifie rien", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ isCoherent: false, issues: ["Aucune étape ne vérifie le texte demandé."] }) } }],
    }),
    text: async () => "",
  });
  try {
    const scenario = validateScenario(
      { ticketSummary: "t", warnings: [], steps: [{ type: "navigate", description: "ouvrir" }] },
      crawlResult
    );
    assert.equal(scenario.confidence, 30);

    const reviewed = await reviewScenario("un ticket", scenario, "fake-key");
    // 2 avertissements (absence de vérification + relecture) : 100 - 30 = 70, plafonné à 30.
    assert.equal(reviewed.warnings.length, 2);
    assert.equal(reviewed.confidence, 30);
  } finally {
    global.fetch = originalFetch;
  }
});

test("scénario qui n'ouvre jamais la page : une étape « navigate » est ajoutée au début, avec un avertissement", () => {
  // Le cas réel : l'IA a oublié l'ouverture, le navigateur serait resté sur une page blanche.
  const scenario = {
    ticketSummary: "Vérifier le message d'erreur",
    warnings: [],
    steps: [
      { type: "fill", selector: "#continue-btn", value: "x", description: "Saisir le nom d'utilisateur" },
      { type: "click", selector: "#continue-btn", description: "Cliquer sur Login" },
      { type: "assert_visible", selector: "#continue-btn", description: "Message visible" },
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps.length, 4);
  assert.equal(result.steps[0].type, "navigate");
  assert.equal(result.steps[0].selectorValid, true);
  assert.equal(result.steps[0].description, "Ouvrir la page");
  assert.deepEqual(result.steps.slice(1).map((step) => step.type), ["fill", "click", "assert_visible"]);
  assert.deepEqual(result.warnings, [NO_OPEN_WARNING]);
  // Un avertissement -> 100 - 15 = 85.
  assert.equal(result.confidence, 85);
});

test("scénario qui commence déjà par navigate : rien n'est ajouté, aucun avertissement", () => {
  const scenario = {
    ticketSummary: "t",
    warnings: [],
    steps: [
      { type: "navigate", description: "Ouvrir la page de login" },
      { type: "assert_visible", selector: "#continue-btn", description: "visible" },
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].description, "Ouvrir la page de login", "l'étape de l'IA est conservée telle quelle");
  assert.equal(result.warnings.includes(NO_OPEN_WARNING), false);
  assert.equal(result.confidence, 100);
});

test("les deux défauts cumulés : page jamais ouverte ET aucune vérification", () => {
  const result = validateScenario(
    { ticketSummary: "t", warnings: [], steps: [{ type: "click", selector: "#continue-btn", description: "clic" }] },
    crawlResult
  );
  assert.deepEqual(result.steps.map((step) => step.type), ["navigate", "click"]);
  assert.deepEqual(result.warnings, [NO_OPEN_WARNING, NO_CHECK_WARNING]);
  assert.equal(result.confidence, 30);
});

test("les étapes retirées ne déclenchent pas l'ajout d'un « navigate » quand le scénario devient vide", () => {
  const result = validateScenario(
    { ticketSummary: "t", warnings: [], steps: [{ type: "double_click", selector: "#continue-btn", description: "inventé" }] },
    crawlResult
  );
  assert.deepEqual(result.steps, []);
  assert.equal(result.warnings.includes(NO_OPEN_WARNING), false);
  assert.equal(result.confidence, 0);
});
