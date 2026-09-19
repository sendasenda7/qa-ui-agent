import { mkdir, readFile, readdir, rename, writeFile } from "fs/promises";

/**
 * Stockage des runs dans runs/<runId>.json.
 *
 * Un run est maintenant mis à jour PENDANT son exécution (le frontend le relit
 * toutes les secondes). Deux précautions pour ne jamais lire un fichier à moitié écrit :
 *  - l'écriture se fait dans un fichier temporaire, puis un rename (opération atomique) ;
 *  - sous Windows, un rename ou une lecture peut échouer brièvement (EPERM/EBUSY) si
 *    l'autre côté a le fichier ouvert : on réessaie quelques millisecondes plus tard.
 */

const RUNS_DIR = "runs";
const RUN_ID_PATTERN = /^\d+$/;
const TRANSIENT_FS_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(operation, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (!TRANSIENT_FS_ERRORS.has(err.code) || attempt >= attempts) throw err;
      await sleep(25 * attempt);
    }
  }
}

/**
 * Un runId est un timestamp numérique. On refuse tout le reste : l'identifiant
 * vient de l'URL (/api/runs/:id) et ne doit jamais pouvoir contenir "../".
 */
export function isValidRunId(runId) {
  return RUN_ID_PATTERN.test(String(runId));
}

function runPath(runId) {
  return `${RUNS_DIR}/${runId}.json`;
}

export async function saveRun(runId, data) {
  if (!isValidRunId(runId)) throw new Error(`runId invalide : ${runId}`);

  await mkdir(RUNS_DIR, { recursive: true });
  const finalPath = runPath(runId);
  const tempPath = `${finalPath}.tmp`;

  await writeFile(tempPath, JSON.stringify(data, null, 2));
  await withRetry(() => rename(tempPath, finalPath));
}

/** Renvoie le contenu du run, ou null s'il n'existe pas (ou si l'id est invalide). */
export async function readRun(runId) {
  if (!isValidRunId(runId)) return null;

  try {
    const raw = await withRetry(() => readFile(runPath(runId), "utf-8"));
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Résumé de tous les runs, du plus récent au plus ancien.
 * `status` (optionnel) filtre sur un statut : "running", "passed", "failed", "error".
 */
export async function listRuns({ status } = {}) {
  await mkdir(RUNS_DIR, { recursive: true });
  const files = (await readdir(RUNS_DIR)).filter((file) => file.endsWith(".json"));

  const summaries = await Promise.all(
    files.map(async (file) => {
      try {
        const content = await readRun(file.slice(0, -".json".length));
        if (!content?.runResult) return null;

        const { runResult, scenario } = content;
        return {
          runId: runResult.runId,
          url: runResult.url,
          ticketSummary: scenario?.ticketSummary ?? "",
          status: runResult.status,
          phase: runResult.phase ?? null,
          stepsPassed: runResult.stepsPassed ?? 0,
          stepsRun: runResult.stepsRun ?? 0,
          stepsTotal: runResult.stepsTotal ?? 0,
          warningsCount: (scenario?.warnings || []).length,
          startedAt: runResult.startedAt,
          finishedAt: runResult.finishedAt ?? null,
        };
      } catch {
        // Un fichier illisible ne doit pas casser toute la liste.
        return null;
      }
    })
  );

  return summaries
    .filter(Boolean)
    .filter((summary) => !status || summary.status === status)
    .sort((a, b) => b.runId - a.runId);
}

/**
 * Au démarrage du serveur, aucun run ne peut réellement être en cours : ceux qui
 * sont encore marqués "running" sur disque ont été interrompus (crash, Ctrl+C...).
 * On les passe en erreur pour qu'ils n'apparaissent pas "en cours" indéfiniment.
 */
export async function recoverInterruptedRuns() {
  const staleRuns = await listRuns({ status: "running" });

  for (const { runId } of staleRuns) {
    const content = await readRun(runId);
    if (!content) continue;

    content.runResult.status = "error";
    content.runResult.phase = "error";
    content.runResult.error =
      "Run interrompu : le serveur s'est arrêté pendant l'exécution.";
    content.runResult.currentStep = null;
    content.runResult.finishedAt = new Date().toISOString();
    await saveRun(runId, content);
  }

  return staleRuns.length;
}