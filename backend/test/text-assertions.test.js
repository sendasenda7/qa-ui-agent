import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTextCandidates, resolveTextSelectors } from "../src/crawler.js";
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
        { type: "navigate", description: "ouvrir" },
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
  assert.deepEqual(steps.map((s) => s.selectorValid), [true, true, true, true, true, false, false, false]);
  assert.deepEqual(steps.map((s) => s.selectorKind), [undefined, undefined, undefined, "dynamic", "dynamic", undefined, undefined, undefined]);
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
        { type: "navigate", description: "ouvrir" },
        { type: "click", selector: 'text=\\"Je suis un Donateur\\"', description: "clic" },
        { type: "assert_visible", selector: 'text=\\"Espace donateur bientôt disponible\\"', description: "message après clic" },
        { type: "click", selector: 'text=\\"Inventé\\"', description: "inventé" },
      ],
    },
    crawlWithCard
  );
  assert.equal(steps[1].selector, 'text="Je suis un Donateur"');
  assert.equal(steps[1].selectorValid, true);
  assert.equal(steps[2].selector, 'text="Espace donateur bientôt disponible"');
  assert.equal(steps[2].selectorKind, "dynamic");
  assert.equal(steps[3].selectorValid, false, "click sur un texte absent du crawl reste refusé");
  assert.equal(warnings.length, 1);
});

test("planner : un texte dynamique contenant légitimement des guillemets échappés n'est pas modifié", () => {
  const { steps } = validateScenario(
    { steps: [{ type: "navigate", description: "ouvrir" }, { type: "assert_visible", selector: 'text="Dire \\"non\\""', description: "citation" }] },
    { elements: [], textElements: [] }
  );
  assert.equal(steps[1].selector, 'text="Dire \\"non\\""');
  assert.equal(steps[1].selectorValid, true);
});

test("texte avec une balise : dernier candidat = début du texte (:has-text), sans antislash ni regex", () => {
  const text = "Prix (HTML) : 10.5 €/mois [promo]";
  const candidates = buildTextCandidates({ tag: "p", kind: "texte", ariaRole: null, text });
  assert.deepEqual(candidates, [`text="${text}"`, `p:has-text("${text}")`]);
  // L'IA recopie les sélecteurs dans du JSON : aucun antislash à mal échapper.
  assert.equal(candidates.some((c) => c.includes("\\")), false);
});

test("sans balise connue ou avec une balise douteuse : pas de candidat :has-text", () => {
  assert.equal(buildTextCandidates({ kind: "texte", ariaRole: null, text: "Bonjour" }).length, 1);
  assert.equal(buildTextCandidates({ tag: "p > a", kind: "texte", ariaRole: null, text: "Bonjour" }).length, 1);
});

/** Fausse page : chaque sélecteur désigne autant d'éléments que dans `counts` (0 si absent). */
function fakePage(counts) {
  return { locator: (selector) => ({ count: async () => counts[selector] ?? 0 }) };
}

test("paragraphe plus long que 120 caractères : l'exact ne trouve rien, le début du texte le retrouve", async () => {
  // Texte tel que le crawler le garde : les 120 premiers caractères du paragraphe complet.
  const kept = "This domain is for use in documentation examples without needing permission. This is not a service; avoid relyi";
  const item = { tag: "p", kind: "texte", ariaRole: null, text: kept };
  const [exact, substring] = buildTextCandidates(item);

  // L'exact (texte entier de l'élément) ne correspond à rien ; la sous-chaîne désigne un seul élément.
  const resolved = await resolveTextSelectors(fakePage({ [exact]: 0, [substring]: 1 }), [item]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].selector, substring);
  assert.match(resolved[0].selector, /^p:has-text\("This domain is for use/);
});

test("le sélecteur exact reste prioritaire quand il désigne un seul élément", async () => {
  const item = { tag: "p", kind: "texte", ariaRole: null, text: "Connexion" };
  const [exact, substring] = buildTextCandidates(item);
  const resolved = await resolveTextSelectors(fakePage({ [exact]: 1, [substring]: 1 }), [item]);
  assert.equal(resolved[0].selector, exact);
});

test("un texte présent plusieurs fois (sous-chaîne ambiguë) reste écarté plutôt que mal ciblé", async () => {
  const item = { tag: "p", kind: "texte", ariaRole: null, text: "Merci" };
  const [exact, substring] = buildTextCandidates(item);
  const resolved = await resolveTextSelectors(fakePage({ [exact]: 0, [substring]: 3 }), [item]);
  assert.deepEqual(resolved, []);
});
