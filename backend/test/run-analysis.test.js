import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRun, startReplay, reserveRunSlot, getActiveRunCount } from "../src/run-executor.js";
import { readRun, saveRun } from "../src/run-store.js";
import { findBaselineRun, needsAnalysis } from "../src/run-analysis.js";

// run-store et visual-diff écrivent dans des dossiers relatifs (runs/, diff-screenshots/) :
// chaque fichier de test tourne dans son propre processus, on peut donc changer de dossier
// courant sans risque pour les autres tests.
let workDir;
const originalCwd = process.cwd();

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "run-analysis-test-"));
  process.chdir(workDir);
  await mkdir("shots", { recursive: true });
});

after(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

function solidPng(color) {
  const png = new PNG({ width: 10, height: 10 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color[0];
    png.data[i + 1] = color[1];
    png.data[i + 2] = color[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const crawlStub = async () => ({ title: "T", elementCount: 1, durationMs: 1, screenshotPath: "x.png", elements: [] });
const planStub = async () => ({
  ticketSummary: "s",
  warnings: [],
  steps: [{ type: "navigate", selector: null, value: null, description: "Ouvrir", selectorValid: true }],
});

/** Faux runner : écrit une vraie capture de la couleur demandée et la référence dans le résultat. */
function makeRunStub(color) {
  return async (url, scenario, { runId }) => {
    const shot = `shots/${runId}.png`;
    await writeFile(shot, solidPng(color));
    return {
      runId,
      url,
      status: "passed",
      stepsTotal: 1,
      stepsRun: 1,
      stepsPassed: 1,
      results: [{ index: 0, type: "navigate", description: "Ouvrir", status: "passed", screenshot: shot, durationMs: 1 }],
    };
  };
}

const okReport = { url: "u", frDir: "ltr", arDir: "rtl", findingsCount: 0, findings: [] };
const baseInput = { url: "https://exemple.test/", ticketText: "Vérifier X" };

test("needsAnalysis : vrai seulement si au moins une option est activée", () => {
  assert.equal(needsAnalysis(undefined), false);
  assert.equal(needsAnalysis({ checkRtl: false, checkVisualDiff: false }), false);
  assert.equal(needsAnalysis({ checkRtl: true, checkVisualDiff: false }), true);
  assert.equal(needsAnalysis({ checkRtl: false, checkVisualDiff: true }), true);
});

test("aucune option : pas de phase d'analyse, pas de résultats rtl/visualDiff", async () => {
  const { runId, done } = await startRun(baseInput, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) });
  await done;
  const { runResult, options } = await readRun(runId);
  assert.deepEqual(options, { checkRtl: false, checkVisualDiff: false, stepTimeoutMs: 10000, navigationTimeoutMs: 30000, browserEngine: "chromium" });
  assert.equal(runResult.phase, "done");
  assert.equal(runResult.rtl, undefined);
  assert.equal(runResult.visualDiff, undefined);
});

test("checkRtl : la phase 'analyzing' est visible pendant l'analyse, puis le rapport est rattaché au run", async () => {
  // Analyse volontairement lente : laisse le temps à l'observateur de voir la phase intermédiaire.
  const localize = async () => {
    await new Promise((r) => setTimeout(r, 120));
    return okReport;
  };
  const { runId, done } = await startRun(
    { ...baseInput, checkRtl: true },
    { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]), localize }
  );

  // On observe le fichier pendant l'exécution, comme le fait la page de suivi.
  const seen = [];
  let finished = false;
  done.then(() => { finished = true; });
  while (!finished) {
    const run = await readRun(runId);
    if (run) {
      const { phase, status, rtl } = run.runResult;
      const key = `${status}/${phase}/rtl=${rtl ? rtl.status : "-"}`;
      if (seen.at(-1) !== key) seen.push(key);
    }
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.ok(seen.includes("running/analyzing/rtl=-"), `phase d'analyse non observée : ${seen.join(" | ")}`);
  const { runResult } = await readRun(runId);
  assert.equal(runResult.status, "passed");
  assert.equal(runResult.phase, "done");
  assert.deepEqual(runResult.rtl, { status: "done", report: okReport });
  assert.equal(runResult.visualDiff, undefined);
});

test("checkRtl en échec : erreur enregistrée, mais le statut du run reste 'passed'", async () => {
  const localize = async () => { throw new Error("Aucun bouton de langue"); };
  const { runId, done } = await startRun(
    { ...baseInput, checkRtl: true },
    { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]), localize }
  );
  await done;
  const { runResult } = await readRun(runId);
  assert.equal(runResult.status, "passed");
  assert.equal(runResult.phase, "done");
  assert.deepEqual(runResult.rtl, { status: "error", error: "Aucun bouton de langue" });
});

test("checkVisualDiff sans run précédent : 'no_baseline', sans erreur", async () => {
  const { runId, done } = await startRun(
    { url: "https://premiere-fois.test/", ticketText: "Ticket jamais vu", checkVisualDiff: true },
    { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) }
  );
  await done;
  const { runResult } = await readRun(runId);
  assert.equal(runResult.status, "passed");
  assert.equal(runResult.visualDiff.status, "no_baseline");
  assert.match(runResult.visualDiff.reason, /servira de référence/);
});

test("checkVisualDiff : compare au run précédent de même URL et même ticket, et détecte une régression", async () => {
  const url = "https://regression.test/";
  const ticketText = "Ticket régression";
  const first = await startRun({ url, ticketText, checkVisualDiff: true }, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) });
  await first.done;
  const second = await startRun({ url, ticketText, checkVisualDiff: true }, { crawl: crawlStub, plan: planStub, run: makeRunStub([255, 255, 255]) });
  await second.done;

  const { runResult } = await readRun(second.runId);
  assert.equal(runResult.visualDiff.status, "done");
  assert.equal(runResult.visualDiff.baselineRunId, first.runId);
  assert.equal(runResult.visualDiff.report.hasRegressions, true);
  assert.equal(runResult.status, "passed", "une régression visuelle ne change pas le statut du run");
});

test("la référence ignore un run d'une autre URL ou d'un autre ticket", async () => {
  const other = await startRun({ url: "https://autre.test/", ticketText: "Ticket régression" }, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) });
  await other.done;
  const differentTicket = await startRun({ url: "https://regression.test/", ticketText: "Un autre ticket" }, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) });
  await differentTicket.done;

  const state = {
    ticketText: "Ticket sans historique",
    runResult: { runId: Date.now() + 10_000, url: "https://regression.test/" },
  };
  assert.equal(await findBaselineRun(state), null);
});

test("erreur du diff visuel (baseline illisible) : enregistrée sans faire échouer le run", async () => {
  const compare = async () => { throw new Error("PNG corrompu"); };
  const url = "https://erreur-diff.test/";
  const ticketText = "Ticket erreur diff";
  const first = await startRun({ url, ticketText }, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) });
  await first.done;
  const second = await startRun({ url, ticketText, checkVisualDiff: true }, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]), compare });
  await second.done;
  const { runResult } = await readRun(second.runId);
  assert.equal(runResult.status, "passed");
  assert.deepEqual(runResult.visualDiff, { status: "error", error: "PNG corrompu" });
});

test("rejeu : diff visuel toujours activé, comparé au run d'origine, RTL hérité", async () => {
  const url = "https://replay.test/";
  const ticketText = "Ticket rejeu";
  const localize = async () => okReport;
  const original = await startRun({ url, ticketText, checkRtl: true }, { crawl: crawlStub, plan: planStub, run: makeRunStub([10, 10, 10]), localize });
  await original.done;

  const replay = await startReplay(String(original.runId), { run: makeRunStub([10, 10, 10]), localize });
  await replay.done;

  const saved = await readRun(replay.runId);
  assert.deepEqual(saved.options, { checkRtl: true, checkVisualDiff: true, stepTimeoutMs: 10000, navigationTimeoutMs: 30000, browserEngine: "chromium" });
  assert.equal(saved.runResult.replayOf, String(original.runId));
  assert.equal(saved.runResult.visualDiff.status, "done");
  assert.equal(saved.runResult.visualDiff.baselineRunId, original.runId);
  assert.equal(saved.runResult.visualDiff.report.hasRegressions, false);
  assert.equal(saved.runResult.rtl.status, "done");
});

test("rejeu d'un ancien run sans options ni capture : no_baseline, pas de plantage", async () => {
  const oldRunId = 1000000000123;
  await saveRun(oldRunId, {
    ticketText: "ancien",
    scenario: { ticketSummary: "ancien", warnings: [], steps: [{ type: "navigate", selector: null, description: "Ouvrir", selectorValid: true }] },
    runResult: { runId: oldRunId, url: "https://ancien.test/", status: "passed", results: [{ index: 0, description: "Ouvrir", status: "passed", screenshot: null }] },
  });
  const replay = await startReplay(String(oldRunId), { run: makeRunStub([1, 1, 1]) });
  await replay.done;
  const { options, runResult } = await readRun(replay.runId);
  assert.deepEqual(options, { checkRtl: false, checkVisualDiff: true, stepTimeoutMs: 10000, navigationTimeoutMs: 30000, browserEngine: "chromium" });
  assert.equal(runResult.visualDiff.status, "no_baseline");
});

test("moteur de navigateur : transmis au crawl, au runner et à l'analyse RTL, et enregistré dans le run", async () => {
  const received = {};
  const crawl = async (url, opts) => { received.crawl = opts.browserEngine; return crawlStub(); };
  const baseRun = makeRunStub([0, 0, 0]);
  const run = async (url, scenario, opts) => { received.run = opts.browserEngine; return baseRun(url, scenario, opts); };
  const localize = async (url, opts) => { received.localize = opts.browserEngine; return okReport; };

  const { runId, done } = await startRun(
    { url: "https://firefox.test/", ticketText: "Ticket firefox", checkRtl: true, browserEngine: "firefox" },
    { crawl, plan: planStub, run, localize }
  );
  await done;

  assert.deepEqual(received, { crawl: "firefox", run: "firefox", localize: "firefox" });
  const saved = await readRun(runId);
  assert.equal(saved.options.browserEngine, "firefox");
  assert.equal(saved.runResult.browserEngine, "firefox");
});

test("moteur de navigateur inconnu : startRun refuse avant de créer le run", async () => {
  await assert.rejects(
    startRun({ ...baseInput, browserEngine: "netscape" }, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) }),
    /Moteur de navigateur inconnu/
  );
});

test("la référence du diff visuel ignore les runs d'un autre moteur", async () => {
  const url = "https://moteurs.test/";
  const ticketText = "Ticket moteurs";
  const chromiumRun = await startRun({ url, ticketText, browserEngine: "chromium" }, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) });
  await chromiumRun.done;

  // Firefox ne doit pas se comparer au run Chromium : pas de référence, donc 'no_baseline'.
  const firefoxRun = await startRun({ url, ticketText, checkVisualDiff: true, browserEngine: "firefox" }, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) });
  await firefoxRun.done;
  const firefoxSaved = await readRun(firefoxRun.runId);
  assert.equal(firefoxSaved.runResult.visualDiff.status, "no_baseline");

  // Un second run Firefox, lui, se compare au premier run Firefox (et pas au Chromium).
  const firefoxAgain = await startRun({ url, ticketText, checkVisualDiff: true, browserEngine: "firefox" }, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) });
  await firefoxAgain.done;
  const again = await readRun(firefoxAgain.runId);
  assert.equal(again.runResult.visualDiff.status, "done");
  assert.equal(again.runResult.visualDiff.baselineRunId, firefoxRun.runId);
});

test("un ancien run sans moteur enregistré est traité comme Chromium (référence et rejeu)", async () => {
  const url = "https://ancien.test/";
  const ticketText = "Ticket ancien";
  const legacy = await startRun({ url, ticketText }, { crawl: crawlStub, plan: planStub, run: makeRunStub([0, 0, 0]) });
  await legacy.done;
  // On simule un run écrit avant l'existence du sélecteur : plus de moteur nulle part.
  const legacySaved = await readRun(legacy.runId);
  delete legacySaved.options.browserEngine;
  delete legacySaved.runResult.browserEngine;
  await saveRun(legacy.runId, legacySaved);

  const state = { ticketText, options: { browserEngine: "chromium" }, runResult: { runId: legacy.runId + 10_000, url } };
  const baseline = await findBaselineRun(state);
  assert.equal(baseline?.runResult.runId, legacy.runId);

  let replayEngine;
  const run = async (u, scenario, opts) => { replayEngine = opts.browserEngine; return makeRunStub([0, 0, 0])(u, scenario, opts); };
  const replay = await startReplay(String(legacy.runId), { run });
  await replay.done;
  assert.equal(replayEngine, "chromium");
  assert.equal((await readRun(replay.runId)).runResult.browserEngine, "chromium");
});

test("rejeu : hérite du moteur du run d'origine", async () => {
  const original = await startRun({ url: "https://rejeu-webkit.test/", ticketText: "Ticket webkit", browserEngine: "webkit" }, { crawl: crawlStub, plan: planStub, run: makeRunStub([5, 5, 5]) });
  await original.done;

  let replayEngine;
  const run = async (u, scenario, opts) => { replayEngine = opts.browserEngine; return makeRunStub([5, 5, 5])(u, scenario, opts); };
  const replay = await startReplay(String(original.runId), { run });
  await replay.done;

  assert.equal(replayEngine, "webkit");
  const saved = await readRun(replay.runId);
  assert.equal(saved.options.browserEngine, "webkit");
  assert.equal(saved.runResult.browserEngine, "webkit");
  assert.equal(saved.runResult.visualDiff.status, "done");
});

test("un run démarré remplace sa réservation : la place n'est jamais comptée deux fois", async () => {
  const reservation = reserveRunSlot(2);
  assert.equal(getActiveRunCount(), 1);
  const { done } = await startRun(
    { url: "https://exemple.test", ticketText: "t" },
    { crawl: crawlStub, plan: planStub, run: makeRunStub([1, 2, 3]) },
    reservation
  );
  assert.equal(getActiveRunCount() <= 1, true, "réservation + run actif ne doivent compter que pour 1");
  await done;
  assert.equal(getActiveRunCount(), 0);
});
