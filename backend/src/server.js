import { loadEnvFile } from "./env.js";
loadEnvFile(".env");

import express from "express";
import cors from "cors";
import { mkdir, writeFile, readdir, readFile } from "fs/promises";
import { crawlPage } from "./crawler.js";
import { generateScenario } from "./planner.js";
import { runScenario } from "./runner.js";
import { checkLocalization } from "./localization-check.js";
import { compareRuns } from "./visual-diff.js";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Permet au frontend d'afficher les screenshots générés (<img src="/screenshots/...">).
app.use("/screenshots", express.static("run-screenshots"));
app.use("/debug-screenshots", express.static("debug-screenshots"));
app.use("/diff-screenshots", express.static("diff-screenshots"));

/**
 * Enveloppe une route async pour transmettre proprement les erreurs à Express,
 * plutôt que de laisser un crash silencieux si une promesse rejette.
 */
function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((err) => {
      console.error(err);
      res.status(500).json({ error: err.message });
    });
  };
}

// Étape 1-2 : crawl seul (utile pour l'écran "Explore").
app.post(
  "/api/crawl",
  asyncRoute(async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url manquante" });

    const crawlResult = await crawlPage(url);
    res.json(crawlResult);
  })
);

// Étape 3 : crawl + génération du scénario par l'IA (utile pour l'écran "AI Plan").
app.post(
  "/api/plan",
  asyncRoute(async (req, res) => {
    const { url, ticketText } = req.body;
    if (!url || !ticketText) {
      return res.status(400).json({ error: "url et ticketText requis" });
    }

    const crawlResult = await crawlPage(url);
    const scenario = await generateScenario(ticketText, crawlResult);
    res.json({ crawlResult, scenario });
  })
);

// Pipeline complet : crawl + IA + exécution réelle (utile pour l'écran "Run").
app.post(
  "/api/test-run",
  asyncRoute(async (req, res) => {
    const { url, ticketText } = req.body;
    if (!url || !ticketText) {
      return res.status(400).json({ error: "url et ticketText requis" });
    }

    const crawlResult = await crawlPage(url);
    const scenario = await generateScenario(ticketText, crawlResult);
    const runResult = await runScenario(url, scenario);

    await mkdir("runs", { recursive: true });
    await writeFile(
      `runs/${runResult.runId}.json`,
      JSON.stringify({ scenario, runResult }, null, 2)
    );

    res.json({ scenario, runResult });
  })
);

// Vérification FR/AR + RTL (utile pour l'écran "Visual & RTL").
app.post(
  "/api/check-i18n",
  asyncRoute(async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url manquante" });

    const report = await checkLocalization(url);
    res.json(report);
  })
);

// Liste des runs sauvegardés (pour le Dashboard). Triés du plus récent au plus ancien.
app.get(
  "/api/runs",
  asyncRoute(async (req, res) => {
    await mkdir("runs", { recursive: true });
    const files = (await readdir("runs")).filter((f) => f.endsWith(".json"));

    const runs = await Promise.all(
      files.map(async (file) => {
        const content = JSON.parse(await readFile(`runs/${file}`, "utf-8"));
        return {
          runId: content.runResult.runId,
          url: content.runResult.url,
          ticketSummary: content.scenario.ticketSummary,
          status: content.runResult.status,
          stepsPassed: content.runResult.stepsPassed,
          stepsTotal: content.runResult.stepsTotal,
          startedAt: content.runResult.startedAt,
        };
      })
    );

    runs.sort((a, b) => b.runId - a.runId);
    res.json(runs);
  })
);

// Détail complet d'un run (scénario + résultat étape par étape).
app.get(
  "/api/runs/:id",
  asyncRoute(async (req, res) => {
    try {
      const content = JSON.parse(await readFile(`runs/${req.params.id}.json`, "utf-8"));
      res.json(content);
    } catch {
      res.status(404).json({ error: "Run introuvable" });
    }
  })
);

// Diff visuel entre deux runs sauvegardés (utile pour l'écran "Visual & RTL").
app.post(
  "/api/compare",
  asyncRoute(async (req, res) => {
    const { runIdA, runIdB } = req.body;
    if (!runIdA || !runIdB) {
      return res.status(400).json({ error: "runIdA et runIdB requis" });
    }

    const runA = JSON.parse(await readFile(`runs/${runIdA}.json`, "utf-8"));
    const runB = JSON.parse(await readFile(`runs/${runIdB}.json`, "utf-8"));

    const diffReport = await compareRuns(runA, runB);
    res.json(diffReport);
  })
);

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`→ API QA-UI Agent démarrée sur http://localhost:${PORT}`);
});
