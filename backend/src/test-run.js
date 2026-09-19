import { loadEnvFile } from "./env.js";
loadEnvFile(".env");

import { mkdir, writeFile } from "fs/promises";
import { crawlPage } from "./crawler.js";
import { generateScenario } from "./planner.js";
import { runScenario } from "./runner.js";

async function main() {
  const url = process.argv[2];
  const ticketText = process.argv[3];

  if (!url || !ticketText) {
    console.error(
      'Usage : npm run test-run -- <url> "<texte du ticket>"'
    );
    process.exit(1);
  }

  console.error(`→ Crawl de ${url}...`);
  const crawlResult = await crawlPage(url);
  console.error(`→ ${crawlResult.elementCount} éléments détectés. Génération du scénario...`);

  const scenario = await generateScenario(ticketText, crawlResult);
  const invalidSteps = scenario.steps.filter((s) => !s.selectorValid);
  if (invalidSteps.length > 0) {
    console.error(
      `⚠ ${invalidSteps.length} étape(s) avec un sélecteur invalide détectée(s) — arrêt avant exécution.`
    );
    console.log(JSON.stringify(scenario, null, 2));
    process.exit(1);
  }

  console.error(`→ Scénario généré (${scenario.steps.length} étapes). Exécution réelle...`);
  const runResult = await runScenario(url, scenario);

  console.error(
    `→ Terminé : ${runResult.status.toUpperCase()} (${runResult.stepsPassed}/${runResult.stepsTotal} étapes réussies)`
  );

  await mkdir("runs", { recursive: true });
  const savedRunPath = `runs/${runResult.runId}.json`;
  await writeFile(savedRunPath, JSON.stringify({ scenario, runResult }, null, 2));
  console.error(`→ Run sauvegardé : ${savedRunPath} (à réutiliser pour un diff visuel)`);

  console.log(JSON.stringify({ scenario, runResult }, null, 2));
}

main().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
