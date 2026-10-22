/**
 * Capture « au moment de l'échec » : une seconde image, prise juste après qu'une étape a échoué,
 * où l'élément visé est encadré en rouge et où une bannière rappelle le code et la cause de l'erreur.
 *
 * Elle s'ajoute à la capture normale de l'étape (celle qui sert au diff visuel reste inchangée) :
 *  - élément trouvé et visible  -> cadre rouge autour de lui ;
 *  - élément absent ou invisible -> pas de cadre, la bannière le dit ;
 *  - étape sans élément (adresse, ouverture de page...) -> bannière seule.
 *
 * Le repère est un calque posé par la page (position: fixed) : il ne dépend ni de la structure de la
 * page ni de sa politique de sécurité (CSP), et il est retiré juste après la capture. Rien ici ne doit
 * jamais faire échouer ou ralentir le run : tout est borné dans le temps et enveloppé de try/catch.
 */

const STEP_TIMEOUT_MS = 1500;
const MAX_BANNER_LENGTH = 180;

/** Types d'étapes qui visent un élément de la page. */
const ELEMENT_STEPS = ["click", "fill", "select", "assert_visible", "assert_text", "assert_enabled"];

function limit(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Phrase courte pour la bannière, déjà débarrassée des valeurs secrètes (la failure reçue est masquée). */
export function buildBannerText(index, step, failure, targetState) {
  const where = `Étape ${index + 1}`;
  const code = failure?.code ? `${failure.code} · ` : "";
  const cause = String(failure?.expected ?? failure?.message ?? "Échec")
    .replace(/\s+/g, " ")
    .trim();
  const state =
    targetState === "hidden"
      ? " — élément présent mais non visible"
      : targetState === "missing"
        ? " — élément introuvable sur la page"
        : "";
  const text = `${where} échouée : ${code}${cause}${state}`;
  return text.length > MAX_BANNER_LENGTH ? `${text.slice(0, MAX_BANNER_LENGTH - 1)}…` : text;
}

/**
 * Cherche l'élément visé par l'étape : le sélecteur principal, sinon le sélecteur de secours.
 * Renvoie { state: "none" | "missing" | "hidden" | "visible", box? }.
 */
export async function locateTarget(page, step) {
  if (!ELEMENT_STEPS.includes(step?.type) || !step?.selector || typeof page.locator !== "function") {
    return { state: "none" };
  }
  try {
    const selectors = [step.selector, step.fallbackSelector].filter(Boolean);
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      const count = await limit(page.locator(selector).count(), STEP_TIMEOUT_MS);
      if (!count) continue;
      await limit(locator.scrollIntoViewIfNeeded({ timeout: 1000 }), STEP_TIMEOUT_MS).catch(() => {});
      const box = await limit(locator.boundingBox({ timeout: 1000 }), STEP_TIMEOUT_MS).catch(() => null);
      return box && box.width > 0 && box.height > 0 ? { state: "visible", box } : { state: "hidden" };
    }
    return { state: "missing" };
  } catch {
    return { state: "none" };
  }
}

/** Exécuté dans la page : pose le cadre et la bannière. Écrit en texte brut (textContent), jamais en HTML. */
function drawOverlay({ box, banner }) {
  const root = document.createElement("div");
  root.setAttribute("data-qa-failure-overlay", "");
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  if (box) {
    const frame = document.createElement("div");
    frame.style.cssText =
      `position:fixed;left:${Math.max(box.x - 4, 0)}px;top:${Math.max(box.y - 4, 0)}px;` +
      `width:${box.width + 8}px;height:${box.height + 8}px;box-sizing:border-box;` +
      "border:3px solid #ef4444;border-radius:6px;box-shadow:0 0 0 4px rgba(239,68,68,.30);";
    root.appendChild(frame);
  }
  const bar = document.createElement("div");
  bar.textContent = banner;
  bar.style.cssText =
    "position:fixed;left:0;right:0;top:0;padding:8px 14px;background:#b91c1c;color:#fff;" +
    "font:600 13px/1.35 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35);";
  root.appendChild(bar);
  document.documentElement.appendChild(root);
}

function removeOverlay() {
  document.querySelectorAll("[data-qa-failure-overlay]").forEach((el) => el.remove());
}

/**
 * Prend la capture d'échec. `failure` est la failure déjà masquée (aucune valeur secrète).
 * Renvoie le chemin de l'image, ou null si elle n'a pas pu être prise.
 */
export async function captureFailureScreenshot(page, { index, step, failure, path }) {
  if (!page || typeof page.screenshot !== "function" || typeof page.evaluate !== "function") return null;
  try {
    const target = await locateTarget(page, step);
    const banner = buildBannerText(index, step, failure, target.state);
    await limit(page.evaluate(drawOverlay, { box: target.state === "visible" ? target.box : null, banner }), STEP_TIMEOUT_MS);
    try {
      await limit(page.screenshot({ path, animations: "disabled", caret: "hide" }), 5000);
    } finally {
      await limit(page.evaluate(removeOverlay), STEP_TIMEOUT_MS).catch(() => {});
    }
    return path;
  } catch {
    return null;
  }
}
