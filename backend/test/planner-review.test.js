import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewScenario, generateScenario } from "../src/planner.js";

const crawlResult = {
  url: "https://example.test",
  elements: [
    { selector: "#continue-btn", tag: "button", type: "submit" },
    { selector: "#error-message", tag: "div", type: null },
  ],
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

test("reviewScenario ajoute les problèmes trouvés aux warnings et baisse la confiance", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    groqResponse(
      JSON.stringify({
        isCoherent: false,
        issues: ["Le ticket demande de vérifier le message d'erreur, mais aucune étape ne le fait."],
      })
    );

  try {
    const scenario = {
      ticketSummary: "test",
      warnings: [],
      steps: [{ type: "click", selector: "#continue-btn", description: "clic" }],
      confidence: 100,
    };

    const result = await reviewScenario("un ticket", scenario, "fake-key");

    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^Relecture IA : /);
    assert.equal(result.confidence, 85);
  } finally {
    global.fetch = originalFetch;
  }
});

test("reviewScenario ne touche à rien quand la relecture ne trouve aucun problème", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => groqResponse(JSON.stringify({ isCoherent: true, issues: [] }));

  try {
    const scenario = {
      ticketSummary: "test",
      warnings: [],
      steps: [{ type: "click", selector: "#continue-btn", description: "clic" }],
      confidence: 100,
    };

    const result = await reviewScenario("un ticket", scenario, "fake-key");

    assert.deepEqual(result, scenario);
  } finally {
    global.fetch = originalFetch;
  }
});

test("reviewScenario dégrade proprement si Groq est indisponible, sans faire échouer le scénario", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => groqResponse("pas du JSON valide");

  try {
    const scenario = {
      ticketSummary: "test",
      warnings: [],
      steps: [{ type: "click", selector: "#continue-btn", description: "clic" }],
      confidence: 100,
    };

    const result = await reviewScenario("un ticket", scenario, "fake-key");

    assert.equal(result.steps.length, 1); // le scénario original reste utilisable
    assert.ok(result.warnings.some((w) => /Relecture IA indisponible/.test(w)));
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateScenario avec deepReview: true fait bien les deux passes", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "fake-key";

  let callCount = 0;
  global.fetch = async (_url, { body }) => {
    callCount++;
    const parsedBody = JSON.parse(body);
    const isReviewCall = parsedBody.messages[0].content.includes("relecteur QA senior");

    if (isReviewCall) {
      return groqResponse(JSON.stringify({ isCoherent: true, issues: ["problème sémantique trouvé"] }));
    }
    return groqResponse(
      JSON.stringify({
        ticketSummary: "test",
        warnings: [],
        steps: [{ type: "click", selector: "#continue-btn", description: "clic" }],
      })
    );
  };

  try {
    const scenario = await generateScenario("un ticket", crawlResult, { deepReview: true });

    assert.equal(callCount, 2); // génération + relecture
    assert.ok(scenario.warnings.some((w) => /Relecture IA : problème sémantique trouvé/.test(w)));
    assert.equal(scenario.confidence, 85);
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
});

test("generateScenario sans deepReview ne fait qu'une seule passe (comportement par défaut inchangé)", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "fake-key";

  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return groqResponse(
      JSON.stringify({
        ticketSummary: "test",
        warnings: [],
        steps: [{ type: "click", selector: "#continue-btn", description: "clic" }],
      })
    );
  };

  try {
    const scenario = await generateScenario("un ticket", crawlResult);

    assert.equal(callCount, 1);
    assert.equal(scenario.confidence, 100);
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
});