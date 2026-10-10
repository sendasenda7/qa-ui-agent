import { test } from "node:test";
import assert from "node:assert/strict";
import { executeStep } from "../src/runner.js";

const timeouts = { stepTimeoutMs: 100, navigationTimeoutMs: 100 };
// Une fausse page qui échoue si on la touche : ces gardes doivent agir AVANT tout appel Playwright.
const explodingPage = new Proxy({}, { get() { throw new Error("la page ne doit pas être utilisée"); } });

test("une étape au sélecteur halluciné échoue immédiatement, sans attendre le timeout", async () => {
  const step = { type: "click", selector: "#fantome", selectorValid: false };
  await assert.rejects(() => executeStep(explodingPage, "http://x", step, timeouts), /absent de la page crawlée/);
});

test("une étape sans sélecteur échoue avec un message clair", async () => {
  await assert.rejects(
    () => executeStep(explodingPage, "http://x", { type: "fill", selector: null }, timeouts),
    /sans sélecteur/
  );
});

test("assert_text sans texte attendu est refusé (il passerait toujours)", async () => {
  const locator = { waitFor: async () => {}, innerText: async () => "Bienvenue" };
  const page = { locator: () => locator };
  for (const value of ["", "   ", undefined, null]) {
    await assert.rejects(
      () => executeStep(page, "http://x", { type: "assert_text", selector: "#msg", selectorValid: true, value }, timeouts),
      /sans texte attendu/
    );
  }
});

test("assert_text avec un texte présent réussit, absent échoue", async () => {
  const locator = { waitFor: async () => {}, innerText: async () => "  Bienvenue Sandouda " };
  const page = { locator: () => locator };
  const base = { type: "assert_text", selector: "#msg", selectorValid: true };
  await executeStep(page, "http://x", { ...base, value: "Bienvenue" }, timeouts);
  await assert.rejects(() => executeStep(page, "http://x", { ...base, value: "Au revoir" }, timeouts), /introuvable/);
});
