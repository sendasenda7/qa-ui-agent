import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBannerText, locateTarget, captureFailureScreenshot } from "../src/failure-capture.js";

/** Fausse page : `found` = nombre d'éléments trouvés, `box` = position de l'élément (null = invisible). */
function fakePage({ found = 1, box = { x: 10, y: 20, width: 100, height: 30 }, screenshotFails = false } = {}) {
  const calls = [];
  const page = {
    calls,
    locator: (selector) => {
      calls.push(["locator", selector]);
      const loc = {
        count: async () => (selector === "#ghost" ? 0 : found),
        first: () => loc,
        scrollIntoViewIfNeeded: async () => calls.push(["scroll"]),
        boundingBox: async () => box,
      };
      return loc;
    },
    evaluate: async (fn, arg) => calls.push(["evaluate", fn.name, arg]),
    screenshot: async (options) => {
      calls.push(["screenshot", options.path]);
      if (screenshotFails) throw new Error("page fermée");
    },
  };
  return page;
}

const failure = { code: "E-ELM-001", message: "Élément introuvable", expected: "Élément #email" };

test("bannière : numéro d'étape, code et cause, sans dépasser la limite", () => {
  const text = buildBannerText(2, { type: "click" }, failure, "missing");
  assert.match(text, /^Étape 3 échouée : E-ELM-001 · Élément #email — élément introuvable/);
  assert.ok(buildBannerText(0, {}, { expected: "x".repeat(500) }, "none").length <= 180);
});

test("élément trouvé et visible : cadre posé à sa position", async () => {
  const page = fakePage();
  const target = await locateTarget(page, { type: "click", selector: "#email" });
  assert.equal(target.state, "visible");
  const out = await captureFailureScreenshot(page, { index: 1, step: { type: "click", selector: "#email" }, failure, path: "x.png" });
  assert.equal(out, "x.png");
  const draw = page.calls.find((c) => c[0] === "evaluate" && c[1] === "drawOverlay");
  assert.deepEqual(draw[2].box, { x: 10, y: 20, width: 100, height: 30 });
  assert.ok(page.calls.some((c) => c[0] === "evaluate" && c[1] === "removeOverlay"), "le calque est retiré après la capture");
});

test("élément absent : bannière seule, sans cadre", async () => {
  const page = fakePage();
  const step = { type: "click", selector: "#ghost" };
  assert.equal((await locateTarget(page, step)).state, "missing");
  await captureFailureScreenshot(page, { index: 0, step, failure, path: "y.png" });
  const draw = page.calls.find((c) => c[1] === "drawOverlay");
  assert.equal(draw[2].box, null);
  assert.match(draw[2].banner, /introuvable sur la page/);
});

test("élément présent mais invisible : dit « non visible »", async () => {
  const page = fakePage({ box: null });
  const step = { type: "assert_visible", selector: "#hidden" };
  assert.equal((await locateTarget(page, step)).state, "hidden");
});

test("le sélecteur de secours est essayé quand le principal ne trouve rien", async () => {
  const page = fakePage();
  const step = { type: "click", selector: "#ghost", fallbackSelector: "form button" };
  assert.equal((await locateTarget(page, step)).state, "visible");
});

test("étape sans élément (adresse, ouverture) : bannière seule", async () => {
  const page = fakePage();
  assert.equal((await locateTarget(page, { type: "assert_url", value: "/x" })).state, "none");
  assert.equal((await locateTarget(page, { type: "navigate" })).state, "none");
});

test("si la capture échoue, rien ne plante et le calque est retiré", async () => {
  const page = fakePage({ screenshotFails: true });
  const out = await captureFailureScreenshot(page, { index: 0, step: { type: "click", selector: "#a" }, failure, path: "z.png" });
  assert.equal(out, null);
  assert.ok(page.calls.some((c) => c[1] === "removeOverlay"));
});

test("une page sans evaluate/screenshot (page fermée) donne null sans erreur", async () => {
  assert.equal(await captureFailureScreenshot({}, { index: 0, step: {}, failure, path: "a.png" }), null);
  assert.equal(await captureFailureScreenshot(null, { index: 0, step: {}, failure, path: "a.png" }), null);
});
