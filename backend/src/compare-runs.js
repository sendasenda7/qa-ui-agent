import { readFile } from "fs/promises";
import { compareRuns } from "./visual-diff.js";

async function main() {
  const runIdA = process.argv[2];
  const runIdB = process.argv[3];

  if (!runIdA || !runIdB) {
    console.error(
      "Usage : npm run compare -- <runId_A> <runId_B>\n" +
        "Les runId viennent du dossier backend/runs/ (créés automatiquement par npm run test-run)."
    );
    process.exit(1);
  }

  const runA = JSON.parse(await readFile(`runs/${runIdA}.json`, "utf-8"));
  const runB = JSON.parse(await readFile(`runs/${runIdB}.json`, "utf-8"));

  const diffReport = await compareRuns(runA, runB);

  console.error(
    `→ Comparaison terminée : ${diffReport.regressionCount}/${diffReport.stepCount} étape(s) avec régression visuelle`
  );

  console.log(JSON.stringify(diffReport, null, 2));
}

main().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
