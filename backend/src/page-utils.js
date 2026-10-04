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
