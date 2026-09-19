import { chromium } from "playwright";
import { mkdir } from "fs/promises";

/**
 * Exécute réellement un scénario généré (voir planner.js) dans un vrai navigateur :
 * clics, saisies, vérifications. Capture un screenshot après CHAQUE étape, qu'elle
 * réussisse ou échoue, pour qu'on puisse visuellement rejouer le déroulé du test.
 *
 * Options :
 *  - runId      : identifiant du run (par défaut, le timestamp courant) ;
 *  - onProgress : callback appelé au fil de l'exécution, pour suivre le run en direct :
 *                   { type: "step_start", index, step }
 *                   { type: "step_end",   index, result }
 */
export async function runScenario(url, scenario, options = {}) {
  const {
    headless = true,
    screenshotDir = "run-screenshots",
    runId = Date.now(),
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

  const browser = await chromium.launch({ headless });
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
        await executeStep(page, url, step);
      } catch (err) {
        stepResult.status = "failed";
        stepResult.error = err.message;
        overallStatus = "failed";
      }
      stepResult.durationMs = Date.now() - startedAt;

      // Screenshot après chaque étape, même en cas d'échec — c'est souvent l'échec
      // qui est le plus utile à voir.
      const screenshotPath = `${screenshotDir}/${runId}-step${index}-${step.type}.png`;
      try {
        await page.screenshot({ path: screenshotPath });
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
    // Même si quelque chose plante en cours de route, on ne laisse jamais un Chromium orphelin.
    await browser.close();
  }

  return {
    runId,
    url,
    startedAt: new Date(runId).toISOString(),
    status: overallStatus,
    stepsTotal: scenario.steps.length,
    stepsRun: results.length,
    stepsPassed: results.filter((r) => r.status === "passed").length,
    results,
  };
}

async function executeStep(page, baseUrl, step) {
  switch (step.type) {
    case "navigate":
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      return;

    case "go_back":
      await page.goBack({ waitUntil: "networkidle" });
      return;

    case "click":
      await page.locator(step.selector).click({ timeout: 10000 });
      return;

    case "fill":
      await page.locator(step.selector).fill(step.value ?? "", { timeout: 10000 });
      return;

    case "select":
      await page.locator(step.selector).selectOption(step.value ?? "", { timeout: 10000 });
      return;

    case "assert_visible":
      await page.locator(step.selector).waitFor({ state: "visible", timeout: 10000 });
      return;

    case "assert_enabled": {
      await page.locator(step.selector).waitFor({ state: "visible", timeout: 10000 });
      const isDisabled = await page.locator(step.selector).evaluate((el) => {
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
      const locator = page.locator(step.selector);
      await locator.waitFor({ state: "visible", timeout: 10000 });
      const actualText = (await locator.innerText()).trim();
      if (!actualText.includes((step.value ?? "").trim())) {
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
