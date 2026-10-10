import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScenario } from "../src/planner.js";

const crawlResult = { elements: [{ selector: "#msg" }] };

test("retire un assert_text sans texte attendu et l'explique dans les warnings", () => {
  const { steps, warnings } = validateScenario(
    {
      steps: [
        { type: "assert_text", selector: "#msg", value: "", description: "vide" },
        { type: "assert_text", selector: "#msg", description: "absente" },
        { type: "assert_text", selector: "#msg", value: "   ", description: "espaces" },
        { type: "assert_text", selector: "#msg", value: "Bienvenue", description: "ok" },
      ],
    },
    crawlResult
  );
  assert.deepEqual(steps.map((s) => s.description), ["ok"]);
  assert.equal(warnings.filter((w) => w.includes("assert_text")).length, 3);
});
