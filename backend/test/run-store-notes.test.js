import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveRun, readRun, saveNotes, listRuns } from "../src/run-store.js";

let workDir;
const originalCwd = process.cwd();
before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "notes-test-"));
  process.chdir(workDir);
});
after(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

const run = (stepsRun, status = "running") => ({ runResult: { runId: 1700000000000, status, stepsRun } });

test("les notes saisies PENDANT un run survivent à ses écritures suivantes", async () => {
  const id = 1700000000000;
  await saveRun(id, run(1));
  await saveNotes(id, "faux positif confirmé");
  await saveRun(id, run(2)); // le run continue de se sauvegarder
  await saveRun(id, run(3, "passed"));

  const content = await readRun(id);
  assert.equal(content.notes, "faux positif confirmé");
  assert.equal(content.runResult.stepsRun, 3, "les notes ne font pas revenir le run en arrière");
  assert.equal(content.runResult.status, "passed");
});

test("les anciens runs avec notes intégrées restent lisibles", async () => {
  const id = 1700000000001;
  await saveRun(id, { ...run(1, "passed"), runResult: { runId: id, status: "passed" }, notes: "ancienne note" });
  assert.equal((await readRun(id)).notes, "ancienne note");
});

test("le fichier de notes n'apparaît pas comme un run dans la liste", async () => {
  const runs = await listRuns();
  assert.deepEqual(runs.map((r) => r.runId).sort(), [1700000000000, 1700000000001]);
});

test("un id de run invalide est refusé pour les notes", async () => {
  await assert.rejects(() => saveNotes("../x", "boom"), /runId invalide/);
  await writeFile("runs/.keep", "");
});
