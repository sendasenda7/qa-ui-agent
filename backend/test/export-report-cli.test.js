import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, runExport, USAGE } from "../src/report-cli.js";

const makeRun = (runId, status) => ({
  ticketText: "t",
  scenario: { ticketSummary: "Ticket", steps: [{ type: "navigate", description: "Ouvrir" }], warnings: [] },
  runResult: {
    runId,
    url: "https://exemple.test/",
    status,
    startedAt: new Date(runId).toISOString(),
    finishedAt: status === "running" ? null : new Date(runId + 1000).toISOString(),
    results: [
      { index: 0, type: "navigate", description: "Ouvrir", status: status === "failed" ? "failed" : "passed", attempts: 1, durationMs: 500, error: status === "failed" ? "Échec" : null },
    ],
  },
});

/** Dépendances factices : trois runs en mémoire, et un « disque » qui enregistre les écritures. */
function fakeDeps() {
  const runs = { 1000: makeRun(1000, "passed"), 2000: makeRun(2000, "failed"), 3000: makeRun(3000, "running") };
  const written = [];
  return {
    written,
    listRuns: async () =>
      Object.values(runs)
        .map((content) => ({ runId: content.runResult.runId, status: content.runResult.status }))
        .sort((a, b) => b.runId - a.runId),
    readRun: async (id) => runs[id] ?? null,
    isValidRunId: (id) => /^\d+$/.test(String(id)),
    writeFile: async (file, data) => written.push({ file, data }),
  };
}

test("parseArgs : valeurs par défaut, options et argument inconnu", () => {
  assert.deepEqual(parseArgs(["1000"]), { target: "1000", format: "junit", out: null, failOnFailure: false });
  assert.deepEqual(parseArgs(["latest", "--format", "json", "--out", "r.json", "--fail-on-failure"]), {
    target: "latest",
    format: "json",
    out: "r.json",
    failOnFailure: true,
  });
  assert.throws(() => parseArgs(["1000", "--bizarre"]), /Argument inconnu : --bizarre/);
  assert.throws(() => parseArgs(["1000", "2000"]), /Argument inconnu : 2000/);
});

test("sans --out, le rapport JUnit est renvoyé pour la sortie standard", async () => {
  const result = await runExport(parseArgs(["1000"]), fakeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(result.stdout, /<testsuites [^>]*tests="1" failures="0"/);
  assert.deepEqual(result.messages, []);
});

test("--out écrit un fichier et laisse la sortie standard vide ; --format json produit du JSON", async () => {
  const deps = fakeDeps();
  const result = await runExport(parseArgs(["1000", "--format", "json", "--out", "rapport.json"]), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, null);
  assert.match(result.messages[0], /écrit dans rapport\.json/);
  assert.equal(deps.written.length, 1);
  assert.equal(deps.written[0].file, "rapport.json");
  assert.equal(JSON.parse(deps.written[0].data).run.id, "1000");
});

test("« latest » prend le run terminé le plus récent, en ignorant le run en cours", async () => {
  const result = await runExport(parseArgs(["latest", "--format", "json"]), fakeDeps());
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).run.id, "2000");
});

test("« latest » sans aucun run terminé -> code 2", async () => {
  const deps = { ...fakeDeps(), listRuns: async () => [{ runId: 3000, status: "running" }] };
  const result = await runExport(parseArgs(["latest"]), deps);
  assert.equal(result.exitCode, 2);
  assert.match(result.messages[0], /Aucun run terminé/);
});

test("--fail-on-failure : code 1 pour un run échoué, 0 pour un run réussi ; le rapport est produit dans les deux cas", async () => {
  const failed = await runExport(parseArgs(["2000", "--fail-on-failure"]), fakeDeps());
  assert.equal(failed.exitCode, 1);
  assert.ok(failed.stdout.includes("<failure"), "le rapport est quand même produit");
  assert.match(failed.messages.at(-1), /a échoué/);

  assert.equal((await runExport(parseArgs(["1000", "--fail-on-failure"]), fakeDeps())).exitCode, 0);
  // Sans l'option, un run échoué s'exporte normalement.
  assert.equal((await runExport(parseArgs(["2000"]), fakeDeps())).exitCode, 0);
});

test("erreurs d'utilisation -> code 2 avec un message clair", async () => {
  const deps = fakeDeps();
  const code = async (argv) => runExport(parseArgs(argv), deps);

  const noTarget = await code([]);
  assert.equal(noTarget.exitCode, 2);
  assert.deepEqual(noTarget.messages, [USAGE]);

  assert.equal((await code(["1000", "--format", "pdf"])).exitCode, 2);
  assert.equal((await code(["1000", "--format", "constructor"])).exitCode, 2, "noms d'objet JavaScript refusés");
  assert.equal((await code(["1000", "--out"])).exitCode, 2, "--out sans fichier");

  const missing = await code(["999999"]);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.messages[0], /Run introuvable : 999999/);

  const traversal = await code(["../etc/passwd"]);
  assert.equal(traversal.exitCode, 2);
  assert.match(traversal.messages[0], /runId invalide/);

  const running = await code(["3000"]);
  assert.equal(running.exitCode, 2);
  assert.match(running.messages[0], /encore en cours/);
  assert.equal(deps.written.length, 0, "rien n'est écrit en cas d'erreur");
});

test("point d'entrée : un vrai processus répond par le code 2 et le message d'usage", () => {
  const entry = fileURLToPath(new URL("../src/export-report.js", import.meta.url));
  const noArgs = spawnSync(process.execPath, [entry], { encoding: "utf-8" });
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /Usage/);

  const badId = spawnSync(process.execPath, [entry, "../etc/passwd"], { encoding: "utf-8" });
  assert.equal(badId.status, 2);
  assert.match(badId.stderr, /runId invalide/);
});
