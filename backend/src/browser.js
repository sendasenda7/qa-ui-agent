import { chromium, firefox, webkit } from "playwright";

/**
 * Point unique de lancement du navigateur : crawler, runner et vérification RTL passent
 * tous par ici, pour qu'un run utilise le MÊME moteur du début à la fin.
 *
 * Les identifiants sont ceux de Playwright, en minuscules ("chromium" | "firefox" | "webkit"),
 * et c'est ce format qui circule partout (API, fichiers de runs, frontend).
 */

export const DEFAULT_BROWSER_ENGINE = "chromium";

const BROWSER_TYPES = { chromium, firefox, webkit };

export const SUPPORTED_BROWSER_ENGINES = Object.keys(BROWSER_TYPES);

export function isSupportedBrowserEngine(value) {
  return typeof value === "string" && Object.hasOwn(BROWSER_TYPES, value);
}

/**
 * Renvoie le moteur à utiliser : `value` s'il est valide, le défaut (Chromium) si absent.
 * Lève une erreur pour une valeur non vide mais inconnue, plutôt que de retomber
 * silencieusement sur Chromium : l'utilisateur croirait avoir testé sur Firefox.
 */
export function resolveBrowserEngine(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_BROWSER_ENGINE;
  if (!isSupportedBrowserEngine(value)) {
    throw new Error(
      `Moteur de navigateur inconnu : "${value}" (attendu : ${SUPPORTED_BROWSER_ENGINES.join(", ")})`
    );
  }
  return value;
}

/** Message plus utile que celui de Playwright quand le binaire du moteur n'est pas installé. */
function explainLaunchError(engine, err) {
  if (/Executable doesn't exist|browserType\.launch.*install/i.test(err.message)) {
    return new Error(
      `Le navigateur ${engine} n'est pas installé. Lance : npx playwright install ${engine}`
    );
  }
  return err;
}

/** Lance le navigateur du moteur demandé. `launchOptions` est transmis tel quel à Playwright. */
export async function launchBrowser(engine, launchOptions = {}) {
  const resolved = resolveBrowserEngine(engine);
  try {
    return await BROWSER_TYPES[resolved].launch(launchOptions);
  } catch (err) {
    throw explainLaunchError(resolved, err);
  }
}
