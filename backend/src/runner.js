import { launchBrowser, resolveBrowserEngine } from "./browser.js";
import { gotoAndSettle, goBackAndSettle, stripAnsi } from "./page-utils.js";
import { mkdir } from "fs/promises";

/**
 * Exécute réellement un scénario généré (voir planner.js) dans un vrai navigateur :
 * clics, saisies, vérifications. Capture un screenshot après CHAQUE étape, qu'elle
 * réussisse ou échoue, pour qu'on puisse visuellement rejouer le déroulé du test.
 *
 * Options :
 *  - runId               : identifiant du run (par défaut, le timestamp courant) ;
 *  - stepTimeoutMs        : délai max par action/vérification (défaut 10s) — à augmenter
 *                           sur une page lente à répondre (staging chargé, réseau faible) ;
 *  - navigationTimeoutMs  : délai max pour navigate/go_back (défaut 30s) ;
 *  - browserEngine        : "chromium" (défaut) | "firefox" | "webkit" ;
 *  - onProgress           : callback appelé au fil de l'exécution, pour suivre le run en direct :
 *                             { type: "step_start", index, step }
 *                             { type: "step_end",   index, result }
 */
export async function runScenario(url, scenario, options = {}) {
  const {
    headless = true,
    screenshotDir = "run-screenshots",
    runId = Date.now(),
    stepTimeoutMs = 10000,
    navigationTimeoutMs = 30000,
    browserEngine,
    onProgress,
  } = options;

  // Une erreur dans le callback de suivi ne doit jamais faire échouer le test lui-même.
  async function notify(event) {
    if (!onProgress) return;
    try {
      await onProgress(event);
    } catch (err) {
      console.error("onProgress a échoué :", err.message);
    }
  }

  await mkdir(screenshotDir, { recursive: true });

  const browser = await launchBrowser(browserEngine, { headless });
  const results = [];
  let overallStatus = "passed";

  try {
    const page = await browser.newPage();

    for (const [index, step] of scenario.steps.entries()) {
      await notify({ type: "step_start", index, step });

      const stepResult = {
        index,
        type: step.type,
        description: step.description,
        selector: step.selector,
        status: "passed",
        error: null,
        screenshot: null,
        durationMs: 0,
      };

      const startedAt = Date.now();
      try {
        await executeStep(page, url, step, { stepTimeoutMs, navigationTimeoutMs });
      } catch (err) {
        stepResult.status = "failed";
        stepResult.error = stripAnsi(err.message);
        overallStatus = "failed";
      }
      stepResult.durationMs = Date.now() - startedAt;

      // Screenshot après chaque étape, même en cas d'échec — c'est souvent l'échec
      // qui est le plus utile à voir.
      const screenshotPath = `${screenshotDir}/${runId}-step${index}-${step.type}.png`;
      try {
        // animations: "disabled" fige les animations CSS : sans cela, deux captures du même
        // écran diffèrent (spinners, fondus) et le diff visuel crie à la régression.
        await page.screenshot({ path: screenshotPath, animations: "disabled", caret: "hide" });
        stepResult.screenshot = screenshotPath;
      } catch {
        // Si même le screenshot échoue (page fermée, crash...), on continue sans bloquer.
      }

      results.push(stepResult);
      await notify({ type: "step_end", index, result: stepResult });

      // On arrête le scénario dès qu'une étape échoue : les étapes suivantes
      // supposent presque toujours que les précédentes ont réussi.
      if (stepResult.status === "failed") break;
    }
  } finally {
    // Même si quelque chose plante en cours de route, on ne laisse jamais un navigateur orphelin.
    await browser.close();
  }

  return {
    runId,
    url,
    browserEngine: resolveBrowserEngine(browserEngine),
    startedAt: new Date(runId).toISOString(),
    status: overallStatus,
    stepsTotal: scenario.steps.length,
    stepsRun: results.length,
    stepsPassed: results.filter((r) => r.status === "passed").length,
    results,
  };
}

// Types d'étape qui n'agissent pas sur un élément précis.
const STEPS_WITHOUT_SELECTOR = ["navigate", "go_back"];

// Combien de temps (ms, au plus) on laisse au sélecteur principal pour apparaître avant d'essayer
// le sélecteur de secours.
const PRIMARY_SELECTOR_PROBE_MS = 2000;

/**
 * Choisit le locator d'une étape : le sélecteur principal, ou — s'il ne trouve rien — le sélecteur
 * de secours (`step.fallbackSelector`, voir crawler.js). Le principal est lisible mais dépend du
 * texte affiché (role=button[name="Continuer"]) : après un changement de langue du site il ne
 * trouve plus rien, alors que le sélecteur de secours (structurel) reste valable.
 * Exporté pour les tests.
 */
export async function resolveLocator(page, step, stepTimeoutMs) {
  const primary = page.locator(step.selector);
  // Message apparu après une action : plusieurs éléments peuvent contenir le même texte
  // (ex. un toast et un message sous le champ) ; on vérifie le premier au lieu d'échouer en
  // "strict mode violation".
  if (step.selectorKind === "dynamic") return primary.first();
  if (!step.fallbackSelector) return primary;
  try {
    await primary.first().waitFor({ state: "attached", timeout: Math.min(stepTimeoutMs, PRIMARY_SELECTOR_PROBE_MS) });
    return primary;
  } catch {
    return page.locator(step.fallbackSelector);
  }
}

/**
 * Exporté pour les tests unitaires (avec une fausse `page`).
 *
 * Avant toute action, on refuse sur-le-champ une étape dont le sélecteur n'existe pas dans
 * le crawl (halluciné par l'IA, marqué `selectorValid: false` par planner.js) : sans cela,
 * Playwright attendrait tout le timeout (10 s par défaut) avant d'échouer, avec un message
 * peu parlant.
 */
export async function executeStep(page, baseUrl, step, timeouts) {
  const { stepTimeoutMs, navigationTimeoutMs } = timeouts;

  if (!STEPS_WITHOUT_SELECTOR.includes(step.type)) {
    if (!step.selector) {
      throw new Error(`Étape "${step.type}" sans sélecteur : impossible de l'exécuter.`);
    }
    if (step.selectorValid === false) {
      throw new Error(
        `Sélecteur absent de la page crawlée (probablement halluciné par l'IA) : ${step.selector} — étape non exécutée.`
      );
    }
  }

  // Les étapes qui agissent sur un élément passent toutes par ce locator.
  const locatorFor = () => resolveLocator(page, step, stepTimeoutMs);

  switch (step.type) {
    case "navigate":
      await gotoAndSettle(page, baseUrl, { timeout: navigationTimeoutMs });
      return;

    case "go_back":
      await goBackAndSettle(page, { timeout: navigationTimeoutMs });
      return;

    case "click":
      await (await locatorFor()).click({ timeout: stepTimeoutMs });
      return;

    case "fill":
      await (await locatorFor()).fill(step.value ?? "", { timeout: stepTimeoutMs });
      return;

    case "select":
      await (await locatorFor()).selectOption(step.value ?? "", { timeout: stepTimeoutMs });
      return;

    case "assert_visible":
      await (await locatorFor()).waitFor({ state: "visible", timeout: stepTimeoutMs });
      return;

    case "assert_enabled": {
      const locator = await locatorFor();
      await locator.waitFor({ state: "visible", timeout: stepTimeoutMs });
      const isDisabled = await locator.evaluate((el) => {
        return (
          el.hasAttribute("disabled") ||
          el.getAttribute("aria-disabled") === "true" ||
          window.getComputedStyle(el).cursor === "not-allowed"
        );
      });
      if (isDisabled) {
        throw new Error(`Élément toujours désactivé : ${step.selector}`);
      }
      return;
    }

    case "assert_text": {
      const locator = await locatorFor();
      await locator.waitFor({ state: "visible", timeout: stepTimeoutMs });
      const expectedText = (step.value ?? "").trim();
      if (!expectedText) {
        // Défense en profondeur (planner.js retire déjà ces étapes) : "".includes() passe toujours.
        throw new Error("assert_text sans texte attendu : l'assertion ne vérifierait rien.");
      }
      const actualText = (await locator.innerText()).trim();
      if (!actualText.includes(expectedText)) {
        throw new Error(
          `Texte attendu introuvable. Attendu (contient) : "${step.value}" — trouvé : "${actualText}"`
        );
      }
      return;
    }

    default:
      throw new Error(`Type d'étape inconnu : "${step.type}"`);
  }
}