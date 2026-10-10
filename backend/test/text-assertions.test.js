import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTextCandidates } from "../src/crawler.js";
import { validateScenario, isDynamicAssertionSelector } from "../src/planner.js";
import { resolveLocator } from "../src/runner.js";

test("titre : rôle heading d'abord, puis texte", () => {
  assert.deepEqual(buildTextCandidates({ kind: "titre", ariaRole: "heading", text: "Connexion" }), [
    'role=heading[name="Connexion"]',
    'text="Connexion"',
  ]);
});

test("alerte : role=alert d'abord, puis texte ; guillemets échappés", () => {
  assert.deepEqual(buildTextCandidates({ kind: "message", ariaRole: "alert", text: 'Dire "non"' }), [
    "role=alert",
    'text="Dire \\"non\\""',
  ]);
});

test("sélecteurs dynamiques : seules les formes role=alert|status et text=\"...\" sont acceptées", () => {
  for (const ok of ["role=alert", "role=status", 'text="Mot de passe incorrect"', 'text="Dire \\"non\\""']) {
    assert.equal(isDynamicAssertionSelector(ok), true, ok);
  }
  for (const bad of ["role=button", "#x", "div > span", "text=sans guillemets", 'text=""', 'text="a" >> nth=0', null, 42]) {
    assert.equal(isDynamicAssertionSelector(bad), false, String(bad));
  }
});

const crawl = {
  elements: [{ selector: "#go" }],
  textElements: [{ selector: 'role=heading[name="Connexion"]', kind: "titre", text: "Connexion" }],
};

test("planner : un texte du crawl est valide ; un message post-action est accepté pour assert_* seulement", () => {
  const { steps, warnings } = validateScenario(
    {
      steps: [
        { type: "assert_text", selector: 'role=heading[name="Connexion"]', value: "Connexion", description: "titre" },
        { type: "click", selector: "#go", description: "clic" },
        { type: "assert_text", selector: "role=alert", value: "Erreur", description: "alerte" },
        { type: "assert_visible", selector: 'text="Bienvenue"', description: "texte" },
        { type: "click", selector: "role=alert", description: "clic interdit" },
        { type: "fill", selector: 'text="Bienvenue"', value: "x", description: "fill interdit" },
        { type: "assert_visible", selector: "div > span", description: "css libre" },
      ],
    },
    crawl
  );
  assert.deepEqual(steps.map((s) => s.selectorValid), [true, true, true, true, false, false, false]);
  assert.deepEqual(steps.map((s) => s.selectorKind), [undefined, undefined, "dynamic", "dynamic", undefined, undefined, undefined]);
  assert.equal(warnings.filter((w) => w.includes("halluciné")).length, 3);
});

test("planner : un assert_text dynamique sans texte attendu est toujours retiré", () => {
  const { steps } = validateScenario(
    { steps: [{ type: "assert_text", selector: "role=alert", value: "", description: "vide" }] },
    crawl
  );
  assert.equal(steps.length, 0);
});

test("runner : un sélecteur dynamique cible le premier élément (pas d'erreur « strict mode »)", async () => {
  const page = { locator: (selector) => ({ selector, first: () => ({ selector, isFirst: true }) }) };
  const locator = await resolveLocator(page, { selector: "role=alert", selectorKind: "dynamic" }, 5000);
  assert.equal(locator.isFirst, true);
});

test("planner : un sélecteur recopié avec des guillemets échappés (\\\") est décodé s'il correspond au crawl", () => {
  const crawlWithCard = { elements: [{ selector: 'text="Je suis un Donateur"' }], textElements: [] };
  const { steps, warnings } = validateScenario(
    {
      steps: [
        { type: "click", selector: 'text=\\"Je suis un Donateur\\"', description: "clic" },
        { type: "assert_visible", selector: 'text=\\"Espace donateur bientôt disponible\\"', description: "message après clic" },
        { type: "click", selector: 'text=\\"Inventé\\"', description: "inventé" },
      ],
    },
    crawlWithCard
  );
  assert.equal(steps[0].selector, 'text="Je suis un Donateur"');
  assert.equal(steps[0].selectorValid, true);
  assert.equal(steps[1].selector, 'text="Espace donateur bientôt disponible"');
  assert.equal(steps[1].selectorKind, "dynamic");
  assert.equal(steps[2].selectorValid, false, "click sur un texte absent du crawl reste refusé");
  assert.equal(warnings.length, 1);
});

test("planner : un texte dynamique contenant légitimement des guillemets échappés n'est pas modifié", () => {
  const { steps } = validateScenario(
    { steps: [{ type: "assert_visible", selector: 'text="Dire \\"non\\""', description: "citation" }] },
    { elements: [], textElements: [] }
  );
  assert.equal(steps[0].selector, 'text="Dire \\"non\\""');
  assert.equal(steps[0].selectorValid, true);
});
