import { test } from "node:test";
import assert from "node:assert/strict";
import { collectTextInBrowser } from "../src/crawler.js";

/** Faux élément de page : juste ce que collectTextInBrowser lit. */
function el(tag, innerText, { visible = true, className = "", attrs = {} } = {}) {
  return {
    tagName: tag.toUpperCase(),
    innerText,
    className,
    getAttribute: (name) => attrs[name] ?? null,
    getBoundingClientRect: () => (visible ? { width: 100, height: 20 } : { width: 0, height: 0 }),
  };
}

/**
 * Exécute collectTextInBrowser contre un faux document. `priority` répond au sélecteur des titres et
 * messages, `body` à celui des paragraphes (on les distingue par leur contenu).
 */
function collectFrom({ priority = [], body = [] }) {
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = {
    querySelectorAll: (selector) => (selector.includes("h1") ? priority : body),
  };
  try {
    return collectTextInBrowser();
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  }
}

test("un paragraphe est collecté (cas d'une page sans titre, comme example.com)", () => {
  const items = collectFrom({
    body: [el("p", "This domain is for use in documentation examples without needing permission.")],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "texte");
  assert.equal(items[0].tag, "p");
  assert.match(items[0].text, /^This domain is for use in documentation examples/);
});

test("titres et messages passent en premier, puis le texte courant ; doublons et textes cachés ignorés", () => {
  const items = collectFrom({
    priority: [
      el("h1", "Login Page"),
      el("div", "Your username is invalid!", { className: "flash error" }),
      el("h2", "Titre caché", { visible: false }),
    ],
    body: [
      el("p", "Login Page"), // même texte que le titre : pas de doublon
      el("p", "Entrez vos identifiants pour continuer."),
      el("li", "Premier point"),
      el("p", "x"), // trop court
    ],
  });
  assert.deepEqual(
    items.map((i) => [i.kind, i.text]),
    [
      ["titre", "Login Page"],
      ["message", "Your username is invalid!"],
      ["texte", "Entrez vos identifiants pour continuer."],
      ["texte", "Premier point"],
    ]
  );
});

test("seul le début du texte est gardé : première ligne, 120 caractères au plus", () => {
  const long = "A".repeat(300);
  const items = collectFrom({ body: [el("p", `${long}\nDeuxième ligne`)] });
  assert.equal(items[0].text.length, 120);
  assert.equal(items[0].text.includes("Deuxième"), false);
});

test("les paragraphes sont limités (25) et ne chassent jamais les titres ni les messages", () => {
  const paragraphs = Array.from({ length: 60 }, (_, i) => el("p", `Paragraphe numéro ${i}`));
  const important = Array.from({ length: 20 }, (_, i) => el("h2", `Titre ${i}`));
  const items = collectFrom({ priority: important, body: paragraphs });
  assert.equal(items.filter((i) => i.kind === "titre").length, 20, "tous les titres sont gardés");
  assert.equal(items.filter((i) => i.kind === "texte").length, 20, "il reste de la place pour 20 paragraphes sur 40");
  assert.equal(items.length, 40, "plafond total de 40 textes");

  const onlyBody = collectFrom({ body: paragraphs });
  assert.equal(onlyBody.length, 25, "sans titre, pas plus de 25 paragraphes");
});

test("page sans aucun texte visible : liste vide", () => {
  assert.deepEqual(collectFrom({}), []);
});
