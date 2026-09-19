import { loadEnvFile } from "./env.js";
loadEnvFile(".env");

import { crawlPage } from "./crawler.js";
import { generateScenario } from "./planner.js";

async function main() {
  const url = process.argv[2];
  const ticketText = process.argv[3];

  if (!url || !ticketText) {
    console.error(
      'Usage : npm run plan -- <url> "<texte du ticket>"\n' +
        'Exemple : npm run plan -- https://staging.helpify.tn/auth/login "Vérifier que je peux choisir Je suis un Donateur puis continuer"'
    );
    process.exit(1);
  }

  console.error(`→ Crawl de ${url}...`);
  const crawlResult = await crawlPage(url);
  console.error(`→ ${crawlResult.elementCount} éléments détectés. Génération du scénario...`);

  const scenario = await generateScenario(ticketText, crawlResult);
  console.log(JSON.stringify(scenario, null, 2));
}

main().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
