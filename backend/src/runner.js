import { launchBrowser, resolveBrowserEngine } from "./browser.js";
import { captureFailureScreenshot } from "./failure-capture.js";
import { gotoAndSettle, goBackAndSettle, waitForUrlContaining, isMeaningfulUrlFragment } from "./page-utils.js";
import { StepError, classifyError, enrichFailure, isRetryable } from "./step-errors.js";
import { STEPS_WITHOUT_SELECTOR } from "./step-types.js";
import { resolveSecrets, maskSecretsDeep, hasPlaceholder } from "./secrets.js";
import { createAccessibilityRecorder } from "./accessibility.js";
import { mkdir } from "fs/promises";

// Relance automatique d'une étape en échec : une page qui se met à jour, un réseau lent ou un
// élément qui apparaît une demi-seconde trop tard font échouer un test qui passerait une seconde
// plus tard. Une étape qui ne réussit qu'à la relance est signalée « instable » : le test passe, mais
// il n'est pas fiable. Réglable via STEP_RETRIES (0 à 2, défaut 1) et STEP_RETRY_TIMEOUT_MS.
const DEFAULT_STEP_RETRIES = 1;
const MAX_STEP_RETRIES = 2;
const DEFAULT_RETRY_TIMEOUT_MS = 3000;
const DEFAULT_RETRY_DELAY_MS = 500;

/** Lit STEP_RETRIES / STEP_RETRY_TIMEOUT_MS (valeurs invalides ignorées). Exporté pour les tests. */
export function getRetryConfig(env = process.env) {
  const retries = Number(env.STEP_RETRIES);
  const timeout = Number(env.STEP_RETRY_TIMEOUT_MS);
  return {
    maxRetries:
      env.STEP_RETRIES !== undefined && env.STEP_RETRIES !== "" && Number.isInteger(retries) && retries >= 0
        ? Math.min(retries, MAX_STEP_RETRIES)
        : DEFAULT_STEP_RETRIES,
    retryTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_RETRY_TIMEOUT_MS,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  };
}

/** Champ de mot de passe d'après le sélecteur ou la description (scénarios anciens, sans repère `sensitive`). */
const PASSWORD_FIELD = /passw|mot\s*de\s*passe|\bmdp\b|\bpwd\b/i;

/**
 * Une trace Playwright (zip rejouable avec `npx playwright show-trace`) enregistre chaque action
 * AVEC ses arguments : une valeur secrète saisie par un `fill` s'y retrouverait en clair, alors que
 * les rapports et les captures les masquent. On n'enregistre donc pas de trace quand :
 *  - le scénario cite une variable `{{QA_SECRET_*}}` ;
 *  - ou un mot de passe est saisi EN CLAIR (étape marquée `sensitive` par le planner, ou champ de
 *    mot de passe reconnu à son sélecteur / sa description pour les scénarios plus anciens).
 * Exporté pour les tests.
 */
export function scenarioUsesSecrets(scenario) {
  return (scenario?.steps ?? []).some(
    (step) =>
      (typeof step.value === "string" && hasPlaceholder(step.value)) ||
      step.sensitive === true ||
      (step.type === "fill" && PASSWORD_FIELD.test(`${step.selector ?? ""} ${step.description ?? ""}`))
  );
}

/**
 * Termine l'enregistrement de la trace : si le run a échoué on écrit le zip à `path`, sinon on
 * jette l'enregistrement (une trace pèse plusieurs Mo, inutile pour un test réussi).
 * Ne lève jamais d'erreur : la trace est une aide au diagnostic, elle ne doit pas faire échouer
 * le run. Renvoie le chemin écrit, ou null. Exporté pour les tests.
 */
export async function finishTracing(context, { failed, path }) {
  try {
    if (failed) {
      await context.tracing.stop({ path });
      return path;
    }
    await context.tracing.stop();
  } catch (err) {
    console.error("Trace Playwright non enregistrée :", err.message);
  }
  return null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exécute une étape, et la relance (au plus `maxRetries` fois) si elle échoue pour une raison
 * qui vaut la peine d'être retentée (voir isRetryable). Les relances ont un délai plus court
 * (`retryTimeoutMs`) que la première tentative : elles servent à rattraper un état passager,
 * pas à attendre à nouveau aussi longtemps.
 *
 * Renvoie { attempts, error, firstError } : `error` est la StepError de la dernière tentative (null
 * si l'étape a réussi) et `firstError` celle de la première (null si elle a réussi du premier coup).
 * Exporté pour les tests.
 */
export async function executeStepWithRetry(page, baseUrl, step, timeouts, options = {}) {
  const { maxRetries = 0, retryTimeoutMs = DEFAULT_RETRY_TIMEOUT_MS, retryDelayMs = DEFAULT_RETRY_DELAY_MS, sleep = defaultSleep } = options;
  const retryTimeouts = { ...timeouts, stepTimeoutMs: Math.min(timeouts.stepTimeoutMs, retryTimeoutMs) };

  let attempts = 0;
  let firstError = null;
  for (;;) {
    attempts += 1;
    try {
      await executeStep(page, baseUrl, step, attempts === 1 ? timeouts : retryTimeouts);
      return { attempts, error: null, firstError };
    } catch (err) {
      const error = classifyError(err, step);
      firstError ??= error;
      if (attempts > maxRetries || !isRetryable(error, step)) {
        if (attempts > 1) {
          // La phrase de l'erreur ne connaît que la dernière tentative (« après 3 s »), alors que la
          // cible a été attendue bien plus longtemps : on donne l'attente totale et le nombre d'essais.
          const totalSeconds = Math.round((timeouts.stepTimeoutMs + (attempts - 1) * retryTimeouts.stepTimeoutMs) / 1000);
          error.message = error.message.replace(/(après|attendu) \d+ s/, `$1 ${totalSeconds} s en ${attempts} essais`);
        }
        return { attempts, error, firstError };
      }
      await sleep(retryDelayMs);
    }
  }
}

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
 *  - checkA11y            : audite l'accessibilité (axe-core) de chaque nouvelle page rencontrée, voir
 *                           accessibility.js (défaut false ; ne change jamais le statut du run) ;
 *  - trace                : enregistre une trace Playwright rejouable, conservée seulement si le
 *                           run échoue (défaut true ; jamais si le scénario utilise des secrets) ;
 *  - traceDir             : dossier des traces (défaut "run-traces") ;
 *  - onProgress           : callback appelé au fil de l'exécution, pour suivre le run en direct :
 *                             { type: "step_start", index, step }
 *                             { type: "step_end",   index, result }
 */
export async function runScenario(url, scenario, options = {}) {
  const {
    headless = true,
    screenshotDir = "run-screenshots",
    traceDir = "run-traces",
    trace = true,
    runId = Date.now(),
    stepTimeoutMs = 10000,
    navigationTimeoutMs = 30000,
    browserEngine,
    checkA11y = false,
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
  if (trace) await mkdir(traceDir, { recursive: true });

  const browser = await launchBrowser(browserEngine, { headless });
  const results = [];
  let overallStatus = "passed";
  const retryConfig = { ...getRetryConfig(), ...(options.stepRetries !== undefined ? { maxRetries: options.stepRetries } : {}) };

  const a11y = checkA11y ? createAccessibilityRecorder() : null;

  // Trace : on passe par un contexte (au lieu de browser.newPage()) pour pouvoir enregistrer la session.
  let context = null;
  let tracing = false;
  let traceSkipped = null;
  let tracePath = null;

  try {
    context = await browser.newContext();
    if (trace) {
      if (scenarioUsesSecrets(scenario)) {
        traceSkipped = "secrets";
      } else {
        try {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
          tracing = true;
        } catch (err) {
          console.error("Trace Playwright non démarrée :", err.message);
        }
      }
    }
    const page = await context.newPage();

    for (const [index, step] of scenario.steps.entries()) {
      await notify({ type: "step_start", index, step });

      const stepResult = newStepResult(index, step);

      const startedAt = Date.now();
      const outcome = await executeStepWithRetry(page, url, step, { stepTimeoutMs, navigationTimeoutMs }, retryConfig);
      stepResult.attempts = outcome.attempts;
      if (outcome.attempts > 1 && outcome.firstError) {
        // Pourquoi la première tentative a échoué : c'est ce qui rend le test « instable ».
        stepResult.firstFailure = maskSecretsDeep({ code: outcome.firstError.code, message: outcome.firstError.message });
      }
      if (outcome.error) {
        // La dernière tentative est une StepError (catégorie, attendu/trouvé/piste). On la complète
        // avec ce qu'on voit sur la page, sans jamais laisser cette lecture faire échouer le run.
        await enrichFailure(page, step, outcome.error);
        stepResult.status = "failed";
        // Une valeur secrète saisie ou attendue ne doit jamais être écrite dans le fichier du run.
        stepResult.error = maskSecretsDeep(outcome.error.message);
        stepResult.failure = maskSecretsDeep(outcome.error.toFailure());
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

      // Échec : une seconde capture, avec l'élément visé encadré et la cause en bandeau.
      if (stepResult.status === "failed") {
        const failureShot = await captureFailureScreenshot(page, {
          index,
          step,
          failure: stepResult.failure,
          path: `${screenshotDir}/${runId}-step${index}-failure.png`,
        });
        if (failureShot) stepResult.failureScreenshot = failureShot;
      }

      // Audit d'accessibilité de la page où l'on se trouve (si c'est une nouvelle adresse).
      if (a11y) await a11y.afterStep(page);

      results.push(stepResult);
      await notify({ type: "step_end", index, result: stepResult });

      // On arrête le scénario dès qu'une étape échoue : les étapes suivantes
      // supposent presque toujours que les précédentes ont réussi.
      if (stepResult.status === "failed") break;
    }

    if (tracing) {
      tracePath = await finishTracing(context, {
        failed: overallStatus === "failed",
        path: `${traceDir}/${runId}.zip`,
      });
      tracing = false;
    }
  } finally {
    if (tracing && context) await finishTracing(context, { failed: false });
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
    ...(tracePath ? { tracePath } : {}),
    ...(traceSkipped ? { traceSkipped } : {}),
    ...(a11y ? { accessibility: a11y.result() } : {}),
    results,
  };
}

/**
 * Résultat initial d'une étape (enregistré dans le fichier du run). L'adresse attendue d'un
 * "assert_url" est la seule `value` recopiée (pour l'afficher dans le rapport) : celle d'un "fill"
 * peut être un mot de passe et ne doit jamais se retrouver dans les fichiers de runs ni le PDF.
 * Exporté pour les tests.
 */
export function newStepResult(index, step) {
  return {
    index,
    type: step.type,
    description: step.description,
    selector: step.selector,
    ...(step.type === "assert_url" ? { expected: step.value ?? null } : {}),
    status: "passed",
    error: null,
    failure: null,
    // Nombre de tentatives (1 = réussie, ou échouée, du premier coup). Au-delà, voir executeStepWithRetry.
    attempts: 1,
    screenshot: null,
    durationMs: 0,
  };
}

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
  try {
    await performStep(page, baseUrl, step, timeouts);
  } catch (err) {
    // Toujours une StepError : les erreurs brutes de Playwright sont traduites ici.
    throw classifyError(err, step);
  }
}

async function performStep(page, baseUrl, step, timeouts) {
  const { stepTimeoutMs, navigationTimeoutMs } = timeouts;

  if (!STEPS_WITHOUT_SELECTOR.includes(step.type)) {
    if (!step.selector) {
      throw new StepError("INVALID_STEP", `Étape "${step.type}" sans sélecteur : impossible de l'exécuter.`, {
        expected: "Un sélecteur d'élément",
        found: "Aucun sélecteur dans l'étape",
        hint: "Régénère le scénario : l'IA n'a pas indiqué quel élément cibler.",
      });
    }
    if (step.selectorValid === false) {
      throw new StepError(
        "SELECTOR_HALLUCINATED",
        `Sélecteur absent de la page crawlée (probablement halluciné par l'IA) : ${step.selector} — étape non exécutée.`,
        {
          expected: "Un élément présent dans le crawl de la page",
          found: `Sélecteur inconnu : ${step.selector}`,
          hint: "Relance l'exploration puis régénère le scénario, ou cite dans le ticket le libellé exact affiché à l'écran.",
        }
      );
    }
  }

  // Valeur de l'étape, avec les variables secrètes ({{QA_SECRET_...}}) remplacées par leur valeur du .env :
  // c'est le seul endroit où elle existe, jamais enregistrée (voir secrets.js).
  let value = step.value;
  if (["fill", "select", "assert_text"].includes(step.type)) {
    const resolved = resolveSecrets(step.value);
    if (resolved.missing.length > 0) {
      throw new StepError("SECRET_MISSING", `Variable secrète absente du .env : ${resolved.missing.join(", ")}`, {
        expected: `${resolved.missing.join(", ")} défini(e) dans backend/.env`,
        found: "Variable absente ou vide",
        hint: "Ajoute la ligne dans backend/.env (ex. QA_SECRET_EMAIL=...), puis redémarre le serveur.",
      });
    }
    value = resolved.value;
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

    case "assert_url": {
      if (!isMeaningfulUrlFragment(step.value)) {
        // Défense en profondeur (planner.js retire déjà ces étapes) : "/" est vrai sur toute page.
        throw new StepError("INVALID_STEP", "assert_url sans adresse exploitable : l'assertion ne vérifierait rien.", {
          expected: "Une adresse précise (ex. /association)",
          found: "Adresse vide ou trop générale",
          hint: "Indique dans le ticket l'adresse exacte attendue après l'action.",
        });
      }
      await waitForUrlContaining(page, step.value, stepTimeoutMs, { baseUrl });
      return;
    }

    case "click":
      await (await locatorFor()).click({ timeout: stepTimeoutMs });
      return;

    case "fill":
      await (await locatorFor()).fill(value ?? "", { timeout: stepTimeoutMs });
      return;

    case "select":
      await (await locatorFor()).selectOption(value ?? "", { timeout: stepTimeoutMs });
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
        throw new StepError("ELEMENT_DISABLED", `Élément toujours désactivé : ${step.selector}`, {
          expected: `Élément ${step.selector} actif (non désactivé)`,
          found: "Élément désactivé (disabled, aria-disabled ou curseur interdit)",
          hint: "Une condition préalable manque peut-être (champ obligatoire vide, case non cochée) : compare avec la capture.",
        });
      }
      return;
    }

    case "assert_text": {
      const locator = await locatorFor();
      await locator.waitFor({ state: "visible", timeout: stepTimeoutMs });
      const expectedText = (value ?? "").trim();
      if (!expectedText) {
        // Défense en profondeur (planner.js retire déjà ces étapes) : "".includes() passe toujours.
        throw new StepError("INVALID_STEP", "assert_text sans texte attendu : l'assertion ne vérifierait rien.", {
          expected: "Un texte précis à retrouver",
          found: "Texte attendu vide",
          hint: "Indique dans le ticket le message exact attendu à l'écran.",
        });
      }
      const actualText = (await locator.innerText()).trim();
      if (!actualText.includes(expectedText)) {
        const caseOnly = actualText.toLowerCase().includes(expectedText.toLowerCase());
        throw new StepError(
          "TEXT_MISMATCH",
          `Texte attendu introuvable. Attendu (contient) : "${value}" — trouvé : "${actualText}"`,
          {
            expected: `Le texte contient « ${expectedText} »`,
            found: actualText ? `« ${actualText} »` : "L'élément est vide",
            hint: caseOnly
              ? "Seule la casse (majuscules/minuscules) diffère."
              : actualText
                ? "Vérifie le libellé exact : accents, ponctuation, langue du site (FR/AR) ou texte qui a changé."
                : "L'élément est présent mais ne contient aucun texte : il se remplit peut-être après un chargement.",
          }
        );
      }
      return;
    }

    default:
      throw new StepError("INVALID_STEP", `Type d'étape inconnu : "${step.type}"`, {
        expected: "navigate, click, fill, select, assert_visible, assert_enabled, assert_text, assert_url ou go_back",
        found: `Type « ${step.type} »`,
        hint: "Régénère le scénario : l'IA a inventé un type d'étape.",
      });
  }
}