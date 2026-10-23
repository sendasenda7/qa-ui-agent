import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// L'auth lit process.env au moment des requêtes : on le fixe avant tout.
process.env.AUTH_PASSWORD = "mot-de-passe-de-test";
process.env.JWT_SECRET = "x".repeat(48);

const { scenarioUsesSecrets, finishTracing } = await import("../src/runner.js");
const { createApp } = await import("../src/app.js");

/** Faux contexte Playwright : enregistre les appels à tracing.stop. */
function fakeContext({ failOnStop = false } = {}) {
  const calls = [];
  return {
    calls,
    tracing: {
      async stop(options) {
        calls.push(options ?? null);
        if (failOnStop) throw new Error("disque plein");
      },
    },
  };
}

test("scenarioUsesSecrets : détecte une variable {{QA_SECRET_*}} dans une étape", () => {
  const withSecret = { steps: [{ type: "fill", selector: "#p", value: "{{QA_SECRET_PASSWORD}}" }] };
  const without = { steps: [{ type: "fill", selector: "#p", value: "bonjour" }, { type: "navigate", value: null }] };
  assert.equal(scenarioUsesSecrets(withSecret), true);
  assert.equal(scenarioUsesSecrets(without), false);
  assert.equal(scenarioUsesSecrets({ steps: [] }), false);
  assert.equal(scenarioUsesSecrets(undefined), false);
});

test("finishTracing : un run en échec écrit le zip et renvoie son chemin", async () => {
  const context = fakeContext();
  const result = await finishTracing(context, { failed: true, path: "run-traces/42.zip" });
  assert.equal(result, "run-traces/42.zip");
  assert.deepEqual(context.calls, [{ path: "run-traces/42.zip" }]);
});

test("finishTracing : un run réussi jette la trace (aucun fichier écrit)", async () => {
  const context = fakeContext();
  const result = await finishTracing(context, { failed: false, path: "run-traces/42.zip" });
  assert.equal(result, null);
  assert.deepEqual(context.calls, [null]);
});

test("finishTracing : une erreur d'écriture ne fait jamais échouer le run", async () => {
  const context = fakeContext({ failOnStop: true });
  const result = await finishTracing(context, { failed: true, path: "run-traces/42.zip" });
  assert.equal(result, null);
});

// --- Route /traces : protégée par le token, servie en téléchargement ---
let server, base, workDir, token;
const originalCwd = process.cwd();

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "trace-test-"));
  process.chdir(workDir);
  await mkdir("run-traces", { recursive: true });
  await writeFile("run-traces/42.zip", "faux zip");
  server = createApp({ env: {} }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "mot-de-passe-de-test" }),
  });
  token = (await res.json()).token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

test("/traces : refuse sans token (401)", async () => {
  assert.equal((await fetch(`${base}/traces/42.zip`)).status, 401);
});

test("/traces : sert le zip en téléchargement avec un token valide", async () => {
  const res = await fetch(`${base}/traces/42.zip?token=${token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal(await res.text(), "faux zip");
});

test("/traces : une trace inexistante renvoie 404", async () => {
  assert.equal((await fetch(`${base}/traces/999.zip?token=${token}`)).status, 404);
});
