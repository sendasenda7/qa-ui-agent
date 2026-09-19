import { loadEnvFile } from "./env.js";
loadEnvFile(".env");

import express from "express";
import cors from "cors";
import { crawlPage } from "./crawler.js";
import { generateScenario } from "./planner.js";
import { checkLocalization } from "./localization-check.js";
import { compareRuns } from "./visual-diff.js";
import { startRun, startReplay, getActiveRunCount } from "./run-executor.js";
import { listRuns, readRun, recoverInterruptedRuns } from "./run-store.js";

const app = express();
const PORT = process.env.PORT || 4000;

// Chaque run lance un vrai Chromium : on limite le nombre de runs simultanés
// pour ne pas saturer la machine. Modifiable via MAX_CONCURRENT_RUNS dans backend/.env.
const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS) || 2;

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

/** Seules les URLs http(s) sont acceptées (pas de file://, chrome://, etc.). */
function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
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

// Pipeline complet : crawl + IA + exécution réelle (utile pour les écrans "Run" et "Live Runs").
// Le run démarre en arrière-plan : on répond tout de suite (202) avec son identifiant,
// et le frontend suit la progression via GET /api/runs/:id.
app.post(
  "/api/test-run",
  asyncRoute(async (req, res) => {
    const { url, ticketText } = req.body;
    if (!url || !ticketText) {
      return res.status(400).json({ error: "url et ticketText requis" });
    }
    if (!isHttpUrl(url)) {
      return res.status(400).json({ error: "url invalide (http:// ou https:// attendu)" });
    }
    if (getActiveRunCount() >= MAX_CONCURRENT_RUNS) {
      return res.status(429).json({
        error: `Déjà ${MAX_CONCURRENT_RUNS} runs en cours : attends qu'un run se termine avant d'en lancer un autre.`,
      });
    }

    const { runId } = await startRun({ url, ticketText });
    res.status(202).json({ runId });
  })
);

// Rejoue le scénario EXACT d'un run existant, sans repasser par le crawl ni par l'IA
// (utile depuis le rapport : "Relancer ce scénario" — donne deux runs strictement
// comparables pour le diff visuel de l'écran "Visual & RTL").
app.post(
  "/api/runs/:id/replay",
  asyncRoute(async (req, res) => {
    if (getActiveRunCount() >= MAX_CONCURRENT_RUNS) {
      return res.status(429).json({
        error: `Déjà ${MAX_CONCURRENT_RUNS} runs en cours : attends qu'un run se termine avant d'en lancer un autre.`,
      });
    }

    const { runId } = await startReplay(req.params.id);
    res.status(202).json({ runId });
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

// Liste des runs sauvegardés (Dashboard, Live Runs, Reports), du plus récent au plus ancien.
// Filtre optionnel : GET /api/runs?status=running
app.get(
  "/api/runs",
  asyncRoute(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(await listRuns({ status }));
  })
);

// Détail complet d'un run (scénario + résultat étape par étape).
// Pendant l'exécution, ce endpoint renvoie l'état courant : le frontend le relit régulièrement.
app.get(
  "/api/runs/:id",
  asyncRoute(async (req, res) => {
    const content = await readRun(req.params.id);
    if (!content) return res.status(404).json({ error: "Run introuvable" });
    res.json(content);
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

    const runA = await readRun(runIdA);
    const runB = await readRun(runIdB);
    if (!runA || !runB) {
      return res.status(404).json({ error: "Run introuvable" });
    }

    const diffReport = await compareRuns(runA, runB);
    res.json(diffReport);
  })
);

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Les runs restés "running" sur disque après un arrêt brutal sont marqués en erreur.
try {
  const interruptedCount = await recoverInterruptedRuns();
  if (interruptedCount > 0) {
    console.log(`→ ${interruptedCount} run(s) interrompu(s) marqué(s) en erreur`);
  }
} catch (err) {
  console.error("Impossible de vérifier les runs interrompus :", err.message);
}

app.listen(PORT, () => {
  console.log(`→ API QA-UI Agent démarrée sur http://localhost:${PORT}`);
});