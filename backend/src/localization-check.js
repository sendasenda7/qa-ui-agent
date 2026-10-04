import { launchBrowser } from "./browser.js";
import { buildSelectorInBrowser } from "./crawler.js";

// Libellés (en minuscules) qui désignent un bouton "passer en arabe". Complétables sans toucher
// au code via AR_TOGGLE_KEYWORDS dans backend/.env (liste séparée par des virgules).
const DEFAULT_AR_TOGGLE_KEYWORDS = ["arabe", "arabic", "العربية", "عربي", "عربى"];
// "AR" seul n'est reconnu que comme MOT entier ("AR", "(AR)", "Passer en AR"), jamais
// à l'intérieur d'un autre mot ("Parler", "Carte"...).
const AR_WORD_PATTERN = /(^|[^a-z0-9])ar([^a-z0-9]|$)/i;

function getArToggleKeywords(env = process.env) {
  const extra = (env.AR_TOGGLE_KEYWORDS || "")
    .split(",")
    .map((kw) => kw.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_AR_TOGGLE_KEYWORDS, ...extra];
}

/** Ce libellé (nom accessible d'un élément) désigne-t-il un bouton de passage en arabe ? */
export function isArabicToggleLabel(label, env = process.env) {
  const name = (label || "").toLowerCase();
  if (!name) return false;
  return AR_WORD_PATTERN.test(name) || getArToggleKeywords(env).some((kw) => name.includes(kw));
}
const TEXT_CHAR_PATTERN = /[A-Za-zÀ-ÿ]/; // au moins une lettre latine (pour ignorer icônes/nombres seuls)
const EMAIL_PATTERN = /\S+@\S+\.\S+/;
const URL_PATTERN = /^(https?:\/\/|www\.)\S+$/i;

/**
 * Cherche, dans une liste d'éléments crawlés, celui qui sert probablement à
 * basculer la langue vers l'arabe (bouton "Passer en arabe", etc.).
 */
export function findArabicToggle(elements, env = process.env) {
  // 1) un élément qui déclare lui-même la langue arabe (lang="ar" / hreflang="ar-TN"...) ;
  const byLangAttribute = elements.find((el) => /^ar(-|$)/i.test(el.lang || ""));
  if (byLangAttribute) return byLangAttribute;
  // 2) sinon, par son libellé.
  return elements.find((el) => isArabicToggleLabel(el.accessibleName, env));
}

/**
 * Textes identiques en FR et en AR qui ne sont PAS un oubli de traduction : e-mails, URLs,
 * et tout ce que l'équipe liste dans I18N_IGNORE_TEXTS (marques : "Helpify, Espoir"...).
 */
export function shouldIgnoreUntranslated(text, env = process.env) {
  const value = text.trim();
  if (EMAIL_PATTERN.test(value) || URL_PATTERN.test(value)) return true;
  const ignored = (env.I18N_IGNORE_TEXTS || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return ignored.includes(value.toLowerCase());
}

async function readPageLocalizationState(page) {
  return page.evaluate(() => ({
    dir:
      document.documentElement.getAttribute("dir") ||
      window.getComputedStyle(document.documentElement).direction,
    lang: document.documentElement.getAttribute("lang"),
  }));
}

/**
 * Charge une page en français, bascule en arabe via le bouton détecté par le
 * crawler, puis compare les deux états : direction RTL appliquée ? textes
 * identiques dans les deux langues (= oubli de traduction, comme NOTIF-21) ?
 */
export async function checkLocalization(url, options = {}) {
  const { navigationTimeoutMs = 30000, browserEngine } = options;
  const browser = await launchBrowser(browserEngine);

  // try/finally : quelle que soit l'étape qui échoue (page injoignable, bouton de bascule
  // devenu introuvable, sélecteur périmé...), le navigateur doit toujours être fermé. Sans ça,
  // chaque échec sur l'écran Visual/RTL laisse un processus orphelin (même bug que crawler.js).
  try {
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "networkidle", timeout: navigationTimeoutMs });
    await page
      .waitForSelector("input, textarea, select, button, a", { timeout: 5000 })
      .catch(() => {});

    const frElements = await page.evaluate(buildSelectorInBrowser);
    const frState = await readPageLocalizationState(page);

    const toggle = findArabicToggle(frElements);
    if (!toggle) {
      throw new Error(
        "Aucun bouton de changement de langue vers l'arabe détecté parmi les éléments crawlés. " +
          "Vérifie manuellement le libellé utilisé sur le site et ajuste AR_TOGGLE_KEYWORDS si besoin."
      );
    }

    await page.locator(toggle.selector).click();
    // Un changement de langue Angular ne déclenche pas forcément de nouvelle requête réseau
    // (souvent un simple re-rendu côté client), donc pas de "networkidle". On attend plutôt
    // que <html> change de dir/lang (jusqu'à 4 s : si rien ne bouge, c'est précisément le
    // bug "rtl-not-applied" que compareLocalization signalera), puis un court temps de
    // stabilisation pour laisser finir le re-rendu des textes.
    await page
      .waitForFunction(
        ({ dir, lang }) =>
          document.documentElement.getAttribute("dir") !== dir ||
          document.documentElement.getAttribute("lang") !== lang,
        { dir: frState.dir, lang: frState.lang },
        { timeout: 4000 }
      )
      .catch(() => {});
    await page.waitForTimeout(300);

    const arElements = await page.evaluate(buildSelectorInBrowser);
    const arState = await readPageLocalizationState(page);

    return compareLocalization(
      { url, elements: frElements, toggleSelector: toggle.selector, ...frState },
      { elements: arElements, ...arState }
    );
  } finally {
    await browser.close();
  }
}

export function compareLocalization(fr, ar) {
  const findings = [];

  if (ar.dir !== "rtl") {
    findings.push({
      severity: "high",
      type: "rtl-not-applied",
      description: `La direction du document est toujours "${ar.dir}" après passage en arabe (attendu : "rtl").`,
    });
  }

  // On associe les éléments FR/AR par leur sélecteur : celui-ci est basé sur la
  // structure du DOM (id, data-testid, ou position), pas sur le texte affiché —
  // il reste donc identique d'une langue à l'autre tant que la mise en page ne change pas.
  const arBySelector = new Map(ar.elements.map((el) => [el.selector, el]));

  let comparedCount = 0;
  for (const frEl of fr.elements) {
    // Le bouton de langue garde légitimement son libellé ("AR", "EN"...) dans les deux états.
    if (frEl.selector === fr.toggleSelector) continue;
    const arEl = arBySelector.get(frEl.selector);
    if (!arEl) continue; // élément absent côté AR : pas forcément un bug, on ne le compte pas.
    comparedCount++;

    const frText = (frEl.accessibleName || "").trim();
    const arText = (arEl.accessibleName || "").trim();

    if (
      frText.length >= 2 &&
      frText === arText &&
      TEXT_CHAR_PATTERN.test(frText) &&
      !shouldIgnoreUntranslated(frText)
    ) {
      findings.push({
        severity: "high",
        type: "untranslated-text",
        selector: frEl.selector,
        description: `Texte identique en FR et en AR (probable oubli de traduction) : "${frText}"`,
      });
    }
  }

  return {
    url: fr.url,
    frDir: fr.dir,
    arDir: ar.dir,
    frLang: fr.lang,
    arLang: ar.lang,
    elementsComparedCount: comparedCount,
    findingsCount: findings.length,
    findings,
  };
}
