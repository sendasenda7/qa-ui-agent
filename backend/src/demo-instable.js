import "./bootstrap.js";
import { createServer } from "node:http";
import { startRun } from "./run-executor.js";
import { readRun } from "./run-store.js";

/**
 * Démonstration de la relance automatique : lance UN VRAI test dans un navigateur sur une page
 * locale dont le message n'apparaît qu'au bout de 4,5 s, alors que chaque étape n'attend que 2 s.
 * La première tentative échoue, la relance réussit : le test est signalé « instable ».
 *
 * Usage (depuis backend/) :  node src/demo-instable.js
 * Le run est enregistré comme les autres : ouvre ensuite « Reports » dans l'application.
 *
 * Pas de dépendance à l'IA : le scénario est écrit à la main, donc le résultat est reproductible.
 */

const PORT = 8123;
const APPEARS_AFTER_MS = 4500;
const STEP_TIMEOUT_MS = 2000;

const PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Démo test instable</title></head>
<body style="font-family:sans-serif;padding:2rem">
  <h1>Démo : un message qui arrive en retard</h1>
  <p>Le message ci-dessous apparaît ${APPEARS_AFTER_MS / 1000} secondes après le chargement.</p>
  <p id="msg" hidden style="color:green;font-weight:bold">Chargement terminé</p>
  <script>setTimeout(function () { document.getElementById("msg").hidden = false; }, ${APPEARS_AFTER_MS});</script>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${PORT}/`;

try {
  console.log(`Page de démo sur ${url} (le message apparaît après ${APPEARS_AFTER_MS / 1000} s, chaque étape attend ${STEP_TIMEOUT_MS / 1000} s).`);

  // Exploration et scénario écrits à la main : seul le navigateur est réel.
  const crawl = async () => ({ title: "Démo test instable", elementCount: 1, textElements: [], elements: [], durationMs: 0, screenshotPath: null });
  const plan = async () => ({
    ticketSummary: "Vérifier que le message « Chargement terminé » finit par apparaître",
    warnings: [],
    confidence: 100,
    steps: [
      { type: "navigate", selector: null, value: null, description: "Ouvrir la page de démo", selectorValid: true },
      { type: "assert_visible", selector: "#msg", value: null, description: "Le message « Chargement terminé » est visible", selectorValid: true },
    ],
  });

  const { runId, done } = await startRun(
    { url, ticketText: "Démo : vérifier que le message « Chargement terminé » apparaît", timeoutMs: STEP_TIMEOUT_MS, navigationTimeoutMs: 15000 },
    { crawl, plan }
  );
  await done;

  const { runResult } = await readRun(runId);
  console.log(`\nRun #${runId} : ${runResult.status}`);
  for (const step of runResult.results) {
    const retried = step.attempts > 1 ? ` — ${step.attempts} tentatives${step.firstFailure ? ` (1er essai : ${step.firstFailure.code})` : ""}` : "";
    console.log(`  ${step.status === "passed" ? "✓" : "✗"} ${step.description}${retried}`);
  }
  if (runResult.error) console.log(`Erreur : ${runResult.error}`);

  if (runResult.flakySteps > 0) {
    console.log(`\n→ Test INSTABLE détecté (${runResult.flakySteps} étape réussie à la relance).`);
  } else if (runResult.status === "passed") {
    console.log("\n→ Réussi du premier coup : la page a été plus lente à charger que prévu. Relance le script.");
  }
  console.log("Ouvre « Reports » dans l'application pour voir le rapport.");
} finally {
  server.close();
}
