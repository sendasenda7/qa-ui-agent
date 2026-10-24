import "./bootstrap.js";
import { createServer } from "node:http";
import { runScenario } from "./runner.js";

/**
 * Démonstration du contrôle responsive : ouvre dans un VRAI navigateur une page locale qui cumule les défauts
 * classiques, et affiche ce que le contrôle en dit.
 *
 *   - pas de balise <meta name="viewport">         -> R-NO-VIEWPORT-META (mobile)
 *   - un tableau large de 900 px                   -> R-OVERFLOW (mobile et tablette, pas bureau)
 *   - un bouton « fermer » de 16 x 16 px           -> R-SMALL-TARGET (mobile et tablette)
 *
 * Usage (depuis backend/) :  node src/demo-responsive.js
 * Attendu : mobile 3 défauts, tablette 2 défauts (débordement + cible), bureau 0 défaut.
 * Les captures sont dans backend/run-screenshots/<runId>-responsive-p0-<taille>.png.
 */

const PORT = 8125;
const PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Démo responsive</title></head>
<body style="font-family:sans-serif;margin:0;padding:1rem">
  <h1>Page de démo responsive</h1>
  <button id="close" style="width:16px;height:16px;padding:0;font-size:10px">x</button>
  <table id="prix" style="width:900px;border-collapse:collapse" border="1">
    <tr><th>Offre</th><th>Détail</th><th>Prix</th></tr>
    <tr><td>Standard</td><td>Un tableau volontairement trop large pour un téléphone</td><td>10 DT</td></tr>
  </table>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

try {
  const url = `http://127.0.0.1:${PORT}/`;
  const scenario = {
    ticketSummary: "Démo responsive",
    warnings: [],
    steps: [{ type: "navigate", selector: null, value: null, description: "Ouvrir la page de démo", selectorValid: true }],
  };
  const result = await runScenario(url, scenario, { checkResponsive: true, trace: false });
  const responsive = result.responsive;

  console.log(`Run ${result.runId} : ${result.status}`);
  if (responsive.status !== "done") {
    console.log("Contrôle responsive :", responsive.status, responsive.error ?? "");
  } else {
    for (const page of responsive.pages) {
      for (const viewport of page.viewports) {
        const label = viewport.error ? `erreur : ${viewport.error}` : `${viewport.issues.length} défaut(s)`;
        console.log(`\n${viewport.label} (${viewport.width} px) : ${label}`);
        for (const issue of viewport.issues) console.log(`  - [${issue.severity}] ${issue.code} : ${issue.message}`);
        if (viewport.screenshot) console.log(`  capture : ${viewport.screenshot}`);
      }
    }
    console.log("\nTotaux :", responsive.totals);
  }
} finally {
  server.close();
}
