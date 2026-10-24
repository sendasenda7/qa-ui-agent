import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, utimes, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupOldFiles, getRetentionConfig, startCleanupSchedule } from "../src/cleanup.js";
import { saveRun, readRun } from "../src/run-store.js";
import { compareRuns } from "../src/visual-diff.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 24);
let workDir;
const originalCwd = process.cwd();

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cleanup-test-"));
  process.chdir(workDir);
});
after(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const dir of ["runs", "run-screenshots", "run-traces", "diff-screenshots", "debug-screenshots"]) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  }
});

async function makeFile(file, ageDays, content = "x".repeat(100)) {
  await writeFile(file, content);
  const when = new Date(NOW - ageDays * DAY);
  await utimes(file, when, when);
}
const run = (id, status = "passed") => ({ runResult: { runId: id, status }, scenario: { ticketSummary: "t" } });

test("config : défauts, valeurs valides et invalides", () => {
  assert.deepEqual(getRetentionConfig({}), { retentionDays: 30, keepRuns: 50 });
  assert.deepEqual(getRetentionConfig({ RETENTION_DAYS: "7", RETENTION_KEEP_RUNS: "0" }), { retentionDays: 7, keepRuns: 0 });
  assert.deepEqual(getRetentionConfig({ RETENTION_DAYS: "abc", RETENTION_KEEP_RUNS: "-3" }), { retentionDays: 30, keepRuns: 50 });
  assert.deepEqual(getRetentionConfig({ RETENTION_DAYS: "", RETENTION_KEEP_RUNS: "2.5" }), { retentionDays: 30, keepRuns: 50 });
});

test("supprime les vieux fichiers, garde les récents et le fichier de résultats", async () => {
  await saveRun(1000, run(1000));
  await saveRun(2000, run(2000));
  await makeFile("run-screenshots/1000-step0-click.png", 60);
  await makeFile("run-traces/1000.zip", 60);
  await makeFile("run-screenshots/2000-step0-click.png", 2);
  await makeFile("diff-screenshots/step0-1000-vs-2000.png", 60);
  await makeFile("debug-screenshots/old.png", 45);

  const result = await cleanupOldFiles({ retentionDays: 30, keepRuns: 1, now: NOW });

  assert.equal(result.deletedFiles, 4);
  assert.equal(result.freedBytes, 400);
  assert.deepEqual(await readdir("run-screenshots"), ["2000-step0-click.png"]);
  assert.deepEqual(await readdir("run-traces"), []);
  assert.deepEqual(await readdir("diff-screenshots"), []);
  assert.ok(existsSync("runs/1000.json"), "le fichier de résultats est conservé");
});

test("marque le run nettoyé, une seule fois", async () => {
  await saveRun(1000, run(1000));
  await makeFile("run-screenshots/1000-step0-click.png", 60);

  const first = await cleanupOldFiles({ retentionDays: 30, keepRuns: 0, now: NOW });
  assert.equal(first.runsMarked, 1);
  assert.equal((await readRun(1000)).runResult.artifactsPurgedAt, new Date(NOW).toISOString());

  await makeFile("run-screenshots/1000-step1-click.png", 70);
  const second = await cleanupOldFiles({ retentionDays: 30, keepRuns: 0, now: NOW + DAY });
  assert.equal(second.deletedFiles, 1);
  assert.equal(second.runsMarked, 0);
  assert.equal((await readRun(1000)).runResult.artifactsPurgedAt, new Date(NOW).toISOString());
});

test("garde les fichiers des N runs les plus récents même s'ils sont vieux", async () => {
  await saveRun(1000, run(1000));
  await saveRun(2000, run(2000));
  await makeFile("run-screenshots/1000-step0.png", 90);
  await makeFile("run-screenshots/2000-step0.png", 90);

  const result = await cleanupOldFiles({ retentionDays: 30, keepRuns: 1, now: NOW });
  assert.equal(result.deletedFiles, 1);
  assert.deepEqual(await readdir("run-screenshots"), ["2000-step0.png"]);
});

test("ne marque jamais un run en cours", async () => {
  await saveRun(1000, run(1000, "running"));
  await makeFile("run-screenshots/1000-step0.png", 90);
  const result = await cleanupOldFiles({ retentionDays: 30, keepRuns: 0, now: NOW });
  assert.equal(result.runsMarked, 0);
  assert.equal((await readRun(1000)).runResult.artifactsPurgedAt, undefined);
});

test("RETENTION_DAYS=0 désactive tout, et les dossiers absents ne posent pas de problème", async () => {
  await makeFile("run-screenshots/1000-step0.png", 500);
  assert.equal((await cleanupOldFiles({ retentionDays: 0, now: NOW })).deletedFiles, 0);
  assert.ok(existsSync("run-screenshots/1000-step0.png"));

  await rm("run-traces", { recursive: true });
  await rm("debug-screenshots", { recursive: true });
  assert.equal((await cleanupOldFiles({ retentionDays: 30, keepRuns: 0, now: NOW })).deletedFiles, 1);
});

test("ignore les sous-dossiers", async () => {
  await mkdir("run-screenshots/1000-dossier", { recursive: true });
  const result = await cleanupOldFiles({ retentionDays: 0, now: NOW });
  assert.equal(result.deletedFiles, 0);
  const forced = await cleanupOldFiles({ retentionDays: 1, keepRuns: 0, now: NOW + 400 * DAY });
  assert.equal(forced.deletedFiles, 0);
  assert.ok(existsSync("run-screenshots/1000-dossier"));
});

test("planification : désactivée, exécution immédiate, erreur journalisée", async () => {
  const logs = [];
  const log = { log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push("ERR " + a.join(" ")) };

  assert.equal(startCleanupSchedule({ env: { RETENTION_DAYS: "0" }, log }), null);
  assert.match(logs[0], /désactivé/);

  let calls = 0;
  const timer = startCleanupSchedule({
    env: {}, log, intervalMs: 3_600_000,
    cleanup: async (config) => { calls += 1; assert.deepEqual(config, { retentionDays: 30, keepRuns: 50 }); return { deletedFiles: 2, freedBytes: 2 * 1024 * 1024 }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  clearInterval(timer);
  assert.equal(calls, 1);
  assert.ok(logs.some((l) => /2 fichier\(s\).*2\.0 Mo/.test(l)));

  const failing = startCleanupSchedule({ env: {}, log, intervalMs: 3_600_000, cleanup: async () => { throw new Error("boum"); } });
  await new Promise((resolve) => setImmediate(resolve));
  clearInterval(failing);
  assert.ok(logs.some((l) => l.startsWith("ERR") && l.includes("boum")));
});

test("la comparaison visuelle explique une capture supprimée au lieu de planter", async () => {
  const step = (screenshot) => ({ description: "Cliquer", status: "passed", screenshot });
  const a = { runResult: { runId: 1, results: [step("run-screenshots/1-gone.png")] } };
  const b = { runResult: { runId: 2, results: [step("run-screenshots/2-gone.png")] } };
  const result = await compareRuns(a, b, "diff-screenshots");
  assert.equal(result.steps[0].comparable, false);
  assert.match(result.steps[0].reason, /nettoyage automatique/);
});
