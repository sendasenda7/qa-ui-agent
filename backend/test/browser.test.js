import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BROWSER_ENGINE,
  SUPPORTED_BROWSER_ENGINES,
  isSupportedBrowserEngine,
  resolveBrowserEngine,
  launchBrowser,
} from "../src/browser.js";

test("moteurs supportés : chromium, firefox, webkit", () => {
  assert.deepEqual(SUPPORTED_BROWSER_ENGINES, ["chromium", "firefox", "webkit"]);
  assert.equal(DEFAULT_BROWSER_ENGINE, "chromium");
});

test("isSupportedBrowserEngine : refuse tout ce qui n'est pas un id exact", () => {
  assert.equal(isSupportedBrowserEngine("firefox"), true);
  assert.equal(isSupportedBrowserEngine("Firefox"), false, "la casse compte : le format échangé est en minuscules");
  assert.equal(isSupportedBrowserEngine("edge"), false);
  assert.equal(isSupportedBrowserEngine("toString"), false, "pas de faux positif via le prototype");
  assert.equal(isSupportedBrowserEngine(undefined), false);
  assert.equal(isSupportedBrowserEngine(42), false);
});

test("resolveBrowserEngine : défaut Chromium si absent, erreur explicite si inconnu", () => {
  assert.equal(resolveBrowserEngine(undefined), "chromium");
  assert.equal(resolveBrowserEngine(null), "chromium");
  assert.equal(resolveBrowserEngine(""), "chromium");
  assert.equal(resolveBrowserEngine("webkit"), "webkit");
  assert.throws(() => resolveBrowserEngine("netscape"), /Moteur de navigateur inconnu : "netscape"/);
});

test("launchBrowser : refuse un moteur inconnu sans rien lancer", async () => {
  await assert.rejects(launchBrowser("netscape"), /Moteur de navigateur inconnu/);
});
