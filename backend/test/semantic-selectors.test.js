import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSemanticCandidates } from "../src/crawler.js";
import { resolveLocator } from "../src/runner.js";
import { validateScenario } from "../src/planner.js";

const sel = (el) => buildSemanticCandidates(el).map((c) => c.selector);

test("bouton : rôle + nom accessible", () => {
  assert.deepEqual(sel({ ariaRole: "button", accessibleName: "Continuer" }), ['role=button[name="Continuer"]']);
});

test("champ de saisie : rôle + nom, puis placeholder", () => {
  assert.deepEqual(sel({ ariaRole: "textbox", accessibleName: "Email", placeholder: "Email" }), [
    'role=textbox[name="Email"]',
    '[placeholder="Email"]',
  ]);
});

test("conteneur cliquable sans sémantique (carte) : texte visible", () => {
  assert.deepEqual(sel({ ariaRole: null, accessibleName: "Je suis un Donateur\nEspace", visibleText: "Je suis un Donateur" }), [
    'text="Je suis un Donateur"',
  ]);
});

test("les guillemets et antislashs du texte sont échappés", () => {
  assert.deepEqual(sel({ ariaRole: "button", accessibleName: 'Dire "salut" \\o/' }), [
    'role=button[name="Dire \\"salut\\" \\\\o/"]',
  ]);
});

test("pas de candidat pour un nom vide, multiligne ou trop long", () => {
  assert.deepEqual(sel({ ariaRole: "button", accessibleName: "" }), []);
  assert.deepEqual(sel({ ariaRole: "button", accessibleName: "ligne1\nligne2" }), []);
  assert.deepEqual(sel({ ariaRole: "button", accessibleName: "x".repeat(61) }), []);
});

/** Faux locator : `attached` dit si le sélecteur principal trouve quelque chose. */
function fakePage(attachedSelectors) {
  const used = [];
  return {
    used,
    locator: (selector) => ({
      selector,
      first: () => ({
        waitFor: async () => {
          used.push(selector);
          if (!attachedSelectors.includes(selector)) throw new Error("Timeout");
        },
      }),
    }),
  };
}

test("runner : le sélecteur principal est utilisé quand il trouve l'élément", async () => {
  const step = { selector: 'role=button[name="Continuer"]', fallbackSelector: "app-x > button" };
  const locator = await resolveLocator(fakePage([step.selector]), step, 5000);
  assert.equal(locator.selector, step.selector);
});

test("runner : sinon (ex. site passé en arabe), le sélecteur de secours prend le relais", async () => {
  const step = { selector: 'role=button[name="Continuer"]', fallbackSelector: "app-x > button" };
  const locator = await resolveLocator(fakePage([]), step, 5000);
  assert.equal(locator.selector, "app-x > button");
});

test("runner : sans secours, comportement inchangé (pas d'attente supplémentaire)", async () => {
  const page = fakePage([]);
  const locator = await resolveLocator(page, { selector: "#a" }, 5000);
  assert.equal(locator.selector, "#a");
  assert.deepEqual(page.used, []);
});

test("planner : le sélecteur de secours du crawl est copié dans l'étape", () => {
  const crawl = {
    elements: [
      { selector: 'role=button[name="Continuer"]', fallbackSelector: "html > body > button" },
      { selector: "#lang" },
    ],
  };
  const { steps } = validateScenario(
    {
      steps: [
        { type: "click", selector: 'role=button[name="Continuer"]', description: "a" },
        { type: "click", selector: "#lang", description: "b" },
        { type: "click", selector: 'role=button[name="Inventé"]', description: "c" },
      ],
    },
    crawl
  );
  assert.equal(steps[0].fallbackSelector, "html > body > button");
  assert.equal("fallbackSelector" in steps[1], false);
  assert.equal(steps[2].selectorValid, false);
  assert.equal("fallbackSelector" in steps[2], false);
});
