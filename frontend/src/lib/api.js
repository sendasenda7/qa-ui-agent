const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

async function getJson(path) {
  const response = await fetch(`${API_BASE_URL}${path}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || `Erreur API (${response.status})`);
  }
  return data;
}

async function postJson(path, body) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error || `Erreur API (${response.status})`);
  }

  return data;
}

/**
 * Démarre un run en arrière-plan. Répond tout de suite avec { runId } :
 * la progression se suit ensuite avec getRun(runId) (voir hooks/useRunPolling.js).
 */
export function startTestRun({ url, ticketText, timeoutMs }) {
  return postJson("/api/test-run", { url, ticketText, timeoutMs });
}

export function crawlOnly({ url, timeoutMs }) {
  return postJson("/api/crawl", { url, timeoutMs });
}

export function planOnly({ url, ticketText }) {
  return postJson("/api/plan", { url, ticketText });
}

export function checkI18n({ url }) {
  return postJson("/api/check-i18n", { url });
}

export function compareRuns({ runIdA, runIdB }) {
  return postJson("/api/compare", { runIdA, runIdB });
}

/** Liste des runs. Filtre optionnel : getRuns({ status: "running" }). */
export function getRuns({ status } = {}) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return getJson(`/api/runs${query}`);
}

export function getRun(id) {
  return getJson(`/api/runs/${id}`);
}

/**
 * Rejoue le scénario exact d'un run existant (sans repasser par le crawl ni par
 * l'IA). Répond avec { runId } du NOUVEAU run, à suivre comme n'importe quel run.
 */
export function replayRun(id) {
  return postJson(`/api/runs/${id}/replay`);
}

/**
 * Construit l'URL complète d'un fichier statique renvoyé par le backend
 * (chemins relatifs type "run-screenshots/xxx.png" ou "diff-screenshots/xxx.png").
 */
export function screenshotUrl(relativePath) {
  if (!relativePath) return null;
  const cleaned = relativePath.replace(/^run-screenshots\//, "screenshots/");
  return `${API_BASE_URL}/${cleaned}`;
}