import { test } from "node:test";
import assert from "node:assert/strict";
import { callGroqWithRetry } from "../src/planner.js";

/** Remplace global.fetch le temps du test, puis le restaure — même en cas d'échec du test. */
async function withMockFetch(impl, fn) {
  const original = global.fetch;
  let callCount = 0;
  global.fetch = async (...args) => {
    callCount++;
    return impl(callCount, ...args);
  };
  try {
    await fn(() => callCount);
  } finally {
    global.fetch = original;
  }
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

test("réessaie après un 429 puis réussit", async () => {
  await withMockFetch(
    (call) => {
      if (call === 1) return jsonResponse(429, { error: "rate limited" }, { "retry-after": "0" });
      return jsonResponse(200, { ok: true });
    },
    async (getCallCount) => {
      const response = await callGroqWithRetry("fake-key", { model: "x" });
      const data = await response.json();
      assert.deepEqual(data, { ok: true });
      assert.equal(getCallCount(), 2);
    }
  );
});

test("réessaie après une erreur réseau (fetch qui rejette) puis réussit", async () => {
  await withMockFetch(
    (call) => {
      if (call === 1) throw new Error("ECONNRESET");
      return jsonResponse(200, { ok: true });
    },
    async (getCallCount) => {
      const response = await callGroqWithRetry("fake-key", { model: "x" });
      const data = await response.json();
      assert.deepEqual(data, { ok: true });
      assert.equal(getCallCount(), 2);
    }
  );
});

test("abandonne immédiatement sur une erreur durable (401) sans réessayer", async () => {
  await withMockFetch(
    () => jsonResponse(401, { error: "clé invalide" }),
    async (getCallCount) => {
      await assert.rejects(
        () => callGroqWithRetry("fake-key", { model: "x" }),
        /Erreur API Groq \(401\)/
      );
      assert.equal(getCallCount(), 1);
    }
  );
});

test("abandonne après le nombre max de tentatives si l'erreur persiste", async () => {
  await withMockFetch(
    () => jsonResponse(503, { error: "indisponible" }),
    async (getCallCount) => {
      await assert.rejects(
        () => callGroqWithRetry("fake-key", { model: "x" }),
        /Erreur API Groq \(503\)/
      );
      assert.equal(getCallCount(), 3); // MAX_ATTEMPTS
    }
  );
});