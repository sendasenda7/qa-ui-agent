import { EXPORT_FORMATS, isFailedRun } from "./report-export.js";

/**
 * Logique de la commande `export-report`, séparée de son point d'entrée (export-report.js) :
 * le point d'entrée importe bootstrap.js, qui change le dossier courant, ce qui rendrait les tests
 * dépendants des vrais runs. Ici, tout est injecté : on ne lit et n'écrit rien par soi-même.
 */

export const USAGE = `Usage : npm run export-report -- <runId|latest> [--format ${Object.keys(EXPORT_FORMATS).join("|")}] [--out fichier] [--fail-on-failure]`;

export function parseArgs(argv) {
  const args = { target: null, format: "junit", out: null, failOnFailure: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--format") args.format = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--fail-on-failure") args.failOnFailure = true;
    else if (!arg.startsWith("--") && args.target === null) args.target = arg;
    else throw new Error(`Argument inconnu : ${arg}`);
  }
  return args;
}

/**
 * Exécute l'export. Renvoie { exitCode, stdout, messages } ; l'appelant affiche et quitte.
 *  0 = rapport produit (et, avec --fail-on-failure, le test a réussi)
 *  1 = rapport produit, mais le test a échoué (seulement avec --fail-on-failure)
 *  2 = erreur d'utilisation (arguments, run introuvable ou encore en cours)
 */
export async function runExport(args, { listRuns, readRun, isValidRunId, writeFile }) {
  const fail = (message, withUsage = false) => ({
    exitCode: 2,
    stdout: null,
    messages: withUsage ? [message, USAGE] : [message],
  });

  if (!args.target || !Object.hasOwn(EXPORT_FORMATS, args.format) || (args.out !== null && !args.out)) {
    return fail(USAGE);
  }

  let runId = args.target;
  if (runId === "latest") {
    const finished = (await listRuns()).filter((run) => run.status !== "running");
    if (finished.length === 0) return fail("Aucun run terminé dans runs/.");
    runId = String(finished[0].runId);
  }
  if (!isValidRunId(runId)) return fail(`runId invalide : ${runId}`);

  const content = await readRun(runId);
  if (!content) return fail(`Run introuvable : ${runId}`);
  if (content.runResult?.status === "running") {
    return fail(`Le run ${runId} est encore en cours : exporte-le une fois terminé.`);
  }

  const report = EXPORT_FORMATS[args.format].build(content);
  const messages = [];
  let stdout = null;
  if (args.out) {
    await writeFile(args.out, report, "utf-8");
    messages.push(`→ Rapport ${args.format} du run ${runId} écrit dans ${args.out}`);
  } else {
    stdout = report;
  }

  if (args.failOnFailure && isFailedRun(content)) {
    messages.push(`→ Le run ${runId} a échoué (${content.runResult.status}) : code de sortie 1.`);
    return { exitCode: 1, stdout, messages };
  }
  return { exitCode: 0, stdout, messages };
}
