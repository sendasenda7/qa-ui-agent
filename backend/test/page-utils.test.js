import { test } from "node:test";
import assert from "node:assert/strict";
import { gotoAndSettle, goBackAndSettle, settlePage, stripAnsi } from "../src/page-utils.js";

/** Fausse page : enregistre les appels ; `idleFails` simule un site qui n'est jamais "réseau inactif". */
function fakePage({ gotoError = null, idleFails = false } = {}) {
  const calls = [];
  return {
    calls,
    goto: async (url, options) => {
      calls.push(["goto", url, options.waitUntil, options.timeout]);
      if (gotoError) throw gotoError;
    },
    goBack: async (options) => calls.push(["goBack", options.waitUntil, options.timeout]),
    waitForLoadState: async (state) => {
      calls.push(["wait", state]);
      if (state === "networkidle" && idleFails) throw new Error("Timeout 5000ms exceeded");
    },
  };
}

test("un site qui n'atteint jamais « réseau inactif » ne fait PAS échouer la navigation", async () => {
  const page = fakePage({ idleFails: true });
  await gotoAndSettle(page, "https://staging.exemple.tn/", { timeout: 30000, settleTimeoutMs: 10 });
  assert.deepEqual(page.calls[0], ["goto", "https://staging.exemple.tn/", "domcontentloaded", 30000]);
  assert.ok(page.calls.some((c) => c[0] === "wait" && c[1] === "networkidle"), "il a quand même essayé d'attendre");
});

test("un vrai échec de chargement (site injoignable, timeout) reste une erreur", async () => {
  const page = fakePage({ gotoError: new Error("page.goto: net::ERR_NAME_NOT_RESOLVED") });
  await assert.rejects(() => gotoAndSettle(page, "https://nexiste-pas.tn/", { timeout: 1000 }), /ERR_NAME_NOT_RESOLVED/);
});

test("go_back suit la même logique", async () => {
  const page = fakePage({ idleFails: true });
  await goBackAndSettle(page, { timeout: 4000, settleTimeoutMs: 10 });
  assert.deepEqual(page.calls[0], ["goBack", "domcontentloaded", 4000]);
});

test("NETWORK_SETTLE_TIMEOUT_MS règle l'attente (0 = pas d'attente)", async () => {
  const waits = [];
  const page = { waitForLoadState: async (state, { timeout }) => waits.push([state, timeout]) };
  const previous = process.env.NETWORK_SETTLE_TIMEOUT_MS;
  process.env.NETWORK_SETTLE_TIMEOUT_MS = "1234";
  try {
    await settlePage(page);
  } finally {
    if (previous === undefined) delete process.env.NETWORK_SETTLE_TIMEOUT_MS;
    else process.env.NETWORK_SETTLE_TIMEOUT_MS = previous;
  }
  assert.deepEqual(waits, [["load", 1234], ["networkidle", 1234]]);
});

test("stripAnsi retire les codes couleur de Playwright", () => {
  const raw = "page.goto: Timeout 30000ms exceeded.\nCall log:\n\u001b[2m  - navigating to \"https://x.tn/\"\u001b[22m";
  assert.equal(stripAnsi(raw).includes("\u001b"), false);
  assert.match(stripAnsi(raw), /navigating to "https:\/\/x\.tn\/"/);
  assert.equal(stripAnsi(null), "");
});
