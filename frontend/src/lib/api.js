const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
const TOKEN_KEY = "qa-ui-agent-token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Quand une requête renvoie 401 (token absent/expiré), on prévient le reste de
 * l'appli via cet évènement plutôt que de rediriger ici — App.jsx l'écoute et
 * bascule sur l'écran de connexion, peu importe quel appel a échoué.
 */
function notifyUnauthorized() {
  clearToken();
  window.dispatchEvent(new Event("qa-ui-agent:unauthorized"));
}

async function request(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => null);

  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error(data?.error || "Authentification requise");
  }

  if (!response.ok) {
    throw new Error(data?.error || `Erreur API (${response.status})`);
  }

  return data;
}

const getJson = (path) => request(path);
const postJson = (path, body) => request(path, { method: "POST", body });
const patchJson = (path, body) => request(path, { method: "PATCH", body });

/** Connexion : mot de passe d'équipe → token stocké pour les appels suivants. */
export async function login(password) {
  const { token } = await postJson("/api/login", { password });
  setToken(token);
}

export function logout() {
  clearToken();
}

export function isLoggedIn() {
  return !!getToken();
}

/**
 * Démarre un run en arrière-plan. Répond tout de suite avec { runId } :
 * la progression se suit ensuite avec getRun(runId) (voir hooks/useRunPolling.js).
 */
export function startTestRun({ url, ticketText, timeoutMs, ticketUrl, deepReview }) {
  return postJson("/api/test-run", { url, ticketText, timeoutMs, ticketUrl, deepReview });
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

/** Remplace entièrement les notes manuelles d'un run (voir ReportDetail.jsx). */
export function saveRunNotes(id, notes) {
  return patchJson(`/api/runs/${id}/notes`, { notes });
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
