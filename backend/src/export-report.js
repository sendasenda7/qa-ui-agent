import "./bootstrap.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { listRuns, readRun, isValidRunId } from "./run-store.js";
import { parseArgs, runExport } from "./report-cli.js";

/**
 * Exporte un run enregistré (backend/runs/) en JUnit XML ou en JSON, pour une CI.
 *
 *   npm run export-report -- <runId|latest> [--format junit|json] [--out fichier] [--fail-on-failure]
 *
 *  - runId ou « latest » (le run terminé le plus récent) ;
 *  - --format : junit (défaut) ou json ;
 *  - --out    : écrit dans un fichier (sinon le rapport est affiché sur la sortie standard) ;
 *  - --fail-on-failure : code de sortie 1 si le test a échoué, pour faire échouer l'étape de la CI.
 *
 * La logique est dans report-cli.js (testée). Attention : bootstrap.js place le processus dans
 * backend/, donc un chemin relatif pour --out est relatif à backend/, pas au dossier d'où tu lances.
 */

try {
  const { exitCode, stdout, messages } = await runExport(parseArgs(process.argv.slice(2)), {
    listRuns,
    readRun,
    isValidRunId,
    // Crée le dossier de destination s'il n'existe pas (ex. --out reports/qa.xml sur une CI vierge).
    writeFile: async (file, data, encoding) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data, encoding);
    },
  });
  if (stdout !== null) process.stdout.write(stdout);
  for (const message of messages) console.error(message);
  process.exitCode = exitCode;
} catch (err) {
  console.error(err.message);
  process.exitCode = 2;
}
