import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScenario } from "../src/planner.js";

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
      { type: "click", selector: "#does-not-exist", description: "clic fantôme" },
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps[0].selectorValid, false);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Sélecteur halluciné/);
});

test("retire un assert_enabled isolé (bug TR-0248 : ni action d'activation avant, ni clic après)", () => {
  const scenario = {
    ticketSummary: "Vérifier que le bouton Continuer est actif",
    warnings: [],
    steps: [
      { type: "assert_visible", selector: "#continue-btn", description: "bouton visible" },
      { type: "assert_enabled", selector: "#continue-btn", description: "bouton activé" },
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].type, "assert_visible");
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
      { type: "select", selector: "#role-select", value: "medical", description: "choix du rôle" },
      { type: "assert_enabled", selector: "#continue-btn", description: "bouton activé" },
      { type: "click", selector: "#continue-btn", description: "clic sur continuer" },
    ],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps.length, 3);
  assert.deepEqual(
    result.steps.map((s) => s.type),
    ["select", "assert_enabled", "click"]
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
    steps: [{ type: "navigate", description: "ok" }, null, "texte inattendu"],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps.length, 1);
  assert.equal(result.warnings.length, 2);
});

test("une description manquante est remplacée par un texte de repli plutôt que 'undefined'", () => {
  const scenario = {
    ticketSummary: "test",
    warnings: [],
    steps: [{ type: "assert_visible", selector: "#continue-btn" }],
  };

  const result = validateScenario(scenario, crawlResult);

  assert.equal(result.steps[0].description, "(étape sans description)");
});