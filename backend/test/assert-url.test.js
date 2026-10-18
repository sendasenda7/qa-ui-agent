import { test } from "node:test";
import assert from "node:assert/strict";
import { isMeaningfulUrlFragment, redactUrl, waitForUrlContaining } from "../src/page-utils.js";
import { STEPS_WITHOUT_SELECTOR } from "../src/step-types.js";
import { validateScenario } from "../src/planner.js";
import { executeStep, newStepResult } from "../src/runner.js";

test("adresse attendue exploitable : au moins une lettre/un chiffre, pas seulement un protocole", () => {
  for (const ok of ["/association", "association", "/auth/login", "?tab=2", " /merci "]) {
    assert.equal(isMeaningfulUrlFragment(ok), true, ok);
  }
  for (const bad of ["", "   ", "/", "//", "?", "#", "http", "https", "https:", "http://", "https://", null, undefined, 42]) {
    assert.equal(isMeaningfulUrlFragment(bad), false, String(bad));
  }
});

test("redactUrl masque les paramètres sensibles et tronque", () => {
  assert.equal(redactUrl("https://x.tn/reset?token=abc123&page=2"), "https://x.tn/reset?token=***&page=2");
  assert.match(redactUrl("https://x.tn/a?session_id=zz&Code=9"), /session_id=\*\*\*&Code=\*\*\*/);
  assert.equal(redactUrl("about:blank"), "about:blank");
  assert.equal(redactUrl("https://x.tn/" + "a".repeat(400)).length, 200);
  assert.equal(redactUrl(null), "");
});

test("assert_url n'a pas besoin de sélecteur (liste partagée planner/runner)", () => {
  assert.ok(STEPS_WITHOUT_SELECTOR.includes("assert_url"));
  const { steps } = validateScenario(
    { steps: [{ type: "assert_url", selector: null, value: "/association", description: "URL" }] },
    { elements: [] }
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0].selectorValid, true);
});

test("planner : une adresse vide ou triviale est retirée avec un avertissement", () => {
  const { steps, warnings } = validateScenario(
    {
      steps: [
        { type: "assert_url", value: "/", description: "slash" },
        { type: "assert_url", value: "", description: "vide" },
        { type: "assert_url", description: "absente" },
        { type: "assert_url", value: "https://", description: "protocole" },
        { type: "assert_url", value: "/merci", description: "ok" },
      ],
    },
    { elements: [] }
  );
  assert.deepEqual(steps.map((s) => s.description), ["ok"]);
  assert.equal(warnings.filter((w) => w.includes("assert_url")).length, 4);
});

/** Fausse page : waitForURL évalue le prédicat sur l'adresse courante, comme Playwright. */
function fakePage(currentUrl) {
  const calls = [];
  return {
    calls,
    url: () => currentUrl,
    waitForURL: async (predicate, options) => {
      calls.push(options);
      if (!predicate(new URL(currentUrl))) throw new Error("Timeout");
    },
  };
}

test("runner : l'étape réussit si l'adresse contient le texte, avec le timeout des étapes", async () => {
  const page = fakePage("https://x.tn/association/accueil");
  await executeStep(page, "https://x.tn/", { type: "assert_url", value: " /association " }, { stepTimeoutMs: 4321, navigationTimeoutMs: 1 });
  assert.equal(page.calls[0].timeout, 4321);
  assert.equal(page.calls[0].waitUntil, "commit");
});

test("runner : sinon l'erreur donne l'adresse réelle, secrets masqués", async () => {
  const page = fakePage("https://x.tn/auth/login?token=SECRET42");
  await assert.rejects(
    () => executeStep(page, "https://x.tn/", { type: "assert_url", value: "/association" }, { stepTimeoutMs: 100 }),
    (err) => /Adresse attendue \(contient\) : "\/association"/.test(err.message) && /token=\*\*\*/.test(err.message) && !err.message.includes("SECRET42")
  );
});

test("runner : une adresse triviale est refusée sans même attendre", async () => {
  const page = fakePage("https://x.tn/");
  for (const value of ["/", "", undefined, "http://"]) {
    await assert.rejects(
      () => executeStep(page, "https://x.tn/", { type: "assert_url", value }, { stepTimeoutMs: 100 }),
      /sans adresse exploitable/
    );
  }
  assert.equal(page.calls.length, 0);
});

test("waitForUrlContaining : un prédicat qui ne matche jamais échoue", async () => {
  await assert.rejects(() => waitForUrlContaining(fakePage("https://x.tn/a"), "/b", 50), /Adresse attendue/);
});

test("résultat d'étape : l'adresse attendue est enregistrée, jamais la valeur d'un fill (mot de passe)", () => {
  assert.equal(newStepResult(0, { type: "assert_url", value: "/merci", selector: null, description: "d" }).expected, "/merci");
  const fill = newStepResult(1, { type: "fill", value: "MotDePasse!123", selector: "#pw", description: "d" });
  assert.equal("expected" in fill, false);
  assert.equal(JSON.stringify(fill).includes("MotDePasse"), false);
});
