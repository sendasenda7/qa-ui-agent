import { readdir, stat, unlink } from "fs/promises";
import { readRun, saveRun } from "./run-store.js";

/**
 * Nettoyage automatique des fichiers lourds des vieux runs (captures, traces, diffs).
 *
 * Règles :
 *  - un fichier n'est supprimé que s'il a plus de RETENTION_DAYS jours (défaut 30 ; 0 = jamais) ;
 *  - les fichiers des KEEP_RUNS runs les plus récents (défaut 50) sont toujours conservés ;
 *  - le fichier de résultats `runs/<id>.json` n'est JAMAIS supprimé : l'historique, les tendances et
 *    les rapports continuent de fonctionner. Le run est simplement marqué `artifactsPurgedAt`, pour que
 *    l'interface dise « captures supprimées » au lieu d'afficher des images cassées.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_KEEP_RUNS = 50;
const CLEANUP_INTERVAL_MS = DAY_MS;

// Dossiers nettoyés. "byRunId" : le nom du fichier commence par l'id du run ("<runId>-step0.png", "<runId>.zip") ;
// sinon (diffs, captures de debug) seule l'ancienneté du fichier compte.
const CLEANED_DIRS = [
  { dir: "run-screenshots", byRunId: true },
  { dir: "run-traces", byRunId: true },
  { dir: "diff-screenshots", byRunId: false },
  { dir: "debug-screenshots", byRunId: false },
];
const RUN_FILE_PATTERN = /^(\d+)\.json$/;
const FILE_RUN_ID_PATTERN = /^(\d+)[-.]/;

function readNonNegativeInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Réglages lus dans l'environnement (RETENTION_DAYS, RETENTION_KEEP_RUNS). Une valeur invalide donne le défaut. */
export function getRetentionConfig(env = process.env) {
  return {
    retentionDays: readNonNegativeInteger(env.RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    keepRuns: readNonNegativeInteger(env.RETENTION_KEEP_RUNS, DEFAULT_KEEP_RUNS),
  };
}

async function listDir(dir) {
  try {
    return await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** Marque un run terminé comme « captures supprimées ». Silencieux si le run est illisible ou en cours. */
async function markRunPurged(runId, nowIso) {
  const content = await readRun(runId);
  if (!content?.runResult || content.runResult.status === "running") return false;
  if (content.runResult.artifactsPurgedAt) return false;
  content.runResult.artifactsPurgedAt = nowIso;
  await saveRun(runId, content);
  return true;
}

/**
 * Supprime les vieux fichiers. Renvoie { deletedFiles, freedBytes, runsMarked }.
 * Ne lève jamais pour un fichier précis (un fichier verrouillé sous Windows sera repris au prochain passage).
 */
export async function cleanupOldFiles({ retentionDays, keepRuns, now = Date.now() } = {}) {
  const config = { ...getRetentionConfig(), ...(retentionDays !== undefined ? { retentionDays } : {}), ...(keepRuns !== undefined ? { keepRuns } : {}) };
  const summary = { deletedFiles: 0, freedBytes: 0, runsMarked: 0 };
  if (config.retentionDays <= 0) return summary;

  const cutoff = now - config.retentionDays * DAY_MS;
  const runIds = (await listDir("runs"))
    .map((file) => RUN_FILE_PATTERN.exec(file)?.[1])
    .filter(Boolean)
    .sort((a, b) => Number(b) - Number(a));
  const protectedRunIds = new Set(runIds.slice(0, config.keepRuns));
  const purgedRunIds = new Set();

  for (const { dir, byRunId } of CLEANED_DIRS) {
    for (const file of await listDir(dir)) {
      const runId = byRunId ? FILE_RUN_ID_PATTERN.exec(file)?.[1] : undefined;
      if (runId && protectedRunIds.has(runId)) continue;

      try {
        const path = `${dir}/${file}`;
        const info = await stat(path);
        if (!info.isFile() || info.mtimeMs >= cutoff) continue;
        await unlink(path);
        summary.deletedFiles += 1;
        summary.freedBytes += info.size;
        if (runId) purgedRunIds.add(runId);
      } catch {
        // fichier déjà supprimé ou verrouillé : on le reprendra au prochain passage
      }
    }
  }

  const nowIso = new Date(now).toISOString();
  for (const runId of purgedRunIds) {
    try {
      if (await markRunPurged(runId, nowIso)) summary.runsMarked += 1;
    } catch {
      // le marquage est un confort d'affichage : son échec ne doit rien casser
    }
  }
  return summary;
}

function formatMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Lance le nettoyage au démarrage puis une fois par jour. Ne bloque ni n'empêche l'arrêt du serveur
 * (le minuteur est « unref »). Renvoie le minuteur, ou null si le nettoyage est désactivé.
 */
export function startCleanupSchedule({ env = process.env, log = console, cleanup = cleanupOldFiles, intervalMs = CLEANUP_INTERVAL_MS } = {}) {
  const config = getRetentionConfig(env);
  if (config.retentionDays <= 0) {
    log.log("→ Nettoyage automatique désactivé (RETENTION_DAYS=0)");
    return null;
  }

  async function runOnce() {
    try {
      const result = await cleanup(config);
      if (result.deletedFiles > 0) {
        log.log(
          `→ Nettoyage : ${result.deletedFiles} fichier(s) de plus de ${config.retentionDays} jours supprimé(s) ` +
            `(${formatMegabytes(result.freedBytes)} Mo libérés)`
        );
      }
    } catch (err) {
      log.error("Nettoyage automatique impossible :", err.message);
    }
  }

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref();
  return timer;
}
