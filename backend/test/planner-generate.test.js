import { test } from "node:test";
import assert from "node:assert/strict";
import { generateScenario } from "../src/planner.js";

const crawlResult = {
  url: "https://example.test",
  elements: [{ selector: "#continue-btn", tag: "button", type: "submit" }],
};

function groqResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
    headers: { get: () => null },
  };
}

async function withMockedGroq(content, fn) {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "fake-key";
  global.fetch = async () => groqResponse(content);
  try {
    await fn();
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
}

test("rejette clairement une réponse qui n'est pas du JSON valide", async () => {
  await withMockedGroq("ceci n'est pas du JSON", async () => {
    await assert.rejects(
      () => generateScenario("un ticket", crawlResult),
      /n'a pas renvoyé un JSON valide/
    );
  });
});

test("rejette clairement un JSON valide mais dont la racine n'est pas un objet (ex. un tableau)", async () => {
  await withMockedGroq('[{"type": "navigate"}]', async () => {
    await assert.rejects(
      () => generateScenario("un ticket", crawlResult),
      /n'a pas renvoyé un objet JSON/
    );
  });
});

test("un scénario bien formé passe normalement, avec confiance 100", async () => {
  await withMockedGroq(
    JSON.stringify({
      ticketSummary: "test",
      warnings: [],
      steps: [{ type: "navigate", description: "aller sur la page" }],
    }),
    async () => {
      const scenario = await generateScenario("un ticket", crawlResult);
      assert.equal(scenario.steps.length, 1);
      assert.equal(scenario.confidence, 100);
    }
  );
});