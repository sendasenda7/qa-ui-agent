/**
 * Utilitaires de navigation partagés par le crawler, le runner et la vérification FR/AR.
 */

// Temps maximum (ms) qu'on accepte d'attendre que le réseau se calme APRÈS le chargement de la
// page. Réglable via NETWORK_SETTLE_TIMEOUT_MS dans backend/.env.
const DEFAULT_SETTLE_TIMEOUT_MS = 5000;

function getSettleTimeoutMs(env = process.env) {
  const configured = Number(env.NETWORK_SETTLE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_SETTLE_TIMEOUT_MS;
}

/**
 * Attend, SANS jamais échouer, que la page se stabilise : événement "load" puis réseau inactif.
 *
 * Pourquoi "sans jamais échouer" : un site moderne (carrousel, analytics, websocket, polling,
 * chat...) émet des requêtes en continu et n'atteint JAMAIS le "réseau inactif". Exiger cet état
 * (waitUntil: "networkidle") faisait échouer le test après 30 s alors que la page était
 * parfaitement affichée. Ici, le réseau inactif est un bonus : on attend au plus quelques
 * secondes, puis on continue.
 */
export async function settlePage(page, settleTimeoutMs = getSettleTimeoutMs()) {
  await page.waitForLoadState("load", { timeout: settleTimeoutMs }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: settleTimeoutMs }).catch(() => {});
}

/**
 * Charge une URL : seule l'arrivée du HTML (domcontentloaded) est exigée dans `timeout` ; la
 * stabilisation de la page est ensuite "au mieux" (voir settlePage). Un vrai problème (site
 * injoignable, DNS, certificat, serveur trop lent à répondre) échoue toujours, avec le timeout.
 */
export async function gotoAndSettle(page, url, { timeout = 30000, settleTimeoutMs } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await settlePage(page, settleTimeoutMs);
}

/** Même chose pour "page précédente". */
export async function goBackAndSettle(page, { timeout = 30000, settleTimeoutMs } = {}) {
  await page.goBack({ waitUntil: "domcontentloaded", timeout });
  await settlePage(page, settleTimeoutMs);
}

/**
 * Retire les codes de couleur du terminal (ex. "\u001b[2m") que Playwright met dans ses messages
 * d'erreur : dans l'interface web ils s'affichaient comme des caractères parasites.
 */
export function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

const SENSITIVE_QUERY_KEY = /token|key|secret|pass|pwd|code|auth|session|sig/i;

/**
 * URL affichable dans un rapport : la valeur des paramètres qui ressemblent à un secret
 * (token, code, session...) est masquée, et le texte est limité à 200 caractères. Une adresse de
 * réinitialisation de mot de passe ne doit pas finir en clair dans les fichiers de runs ni le PDF.
 */
export function redactUrl(value) {
  const text = String(value ?? "");
  let shown = text;
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "***");
    }
    shown = url.toString();
  } catch {
    // pas une URL valide (about:blank...) : affichée telle quelle
  }
  return shown.length > 200 ? `${shown.slice(0, 199)}…` : shown;
}

/**
 * Une adresse attendue qui serait vraie sur presque n'importe quelle page ("/", "http", ":") ne
 * prouve rien : elle donnerait un faux « réussi ». Il faut au moins une lettre ou un chiffre, et
 * pas seulement un protocole.
 */
export function isMeaningfulUrlFragment(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return /[a-z0-9]/i.test(v) && !/^https?:?\/{0,2}$/i.test(v);
}

/**
 * Attend (jusqu'à `timeout`) que l'adresse de la page CONTIENNE `expected`. On attend plutôt que de
 * lire l'adresse une fois : après un clic, la redirection ou le changement de route d'une appli
 * monopage arrive quelques instants plus tard. Échoue avec l'adresse réellement atteinte.
 */
export async function waitForUrlContaining(page, expected, timeout) {
  const wanted = String(expected ?? "").trim();
  try {
    await page.waitForURL((url) => url.href.includes(wanted), { timeout, waitUntil: "commit" });
  } catch {
    throw new Error(
      `Adresse attendue (contient) : "${wanted}" — adresse actuelle : "${redactUrl(page.url())}"`
    );
  }
}
