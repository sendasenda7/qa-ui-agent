import { chromium } from "playwright";
import { buildSelectorInBrowser } from "./crawler.js";

const AR_TOGGLE_KEYWORDS = ["arabe", "العربية", " ar ", "(ar)"];
const TEXT_CHAR_PATTERN = /[A-Za-zÀ-ÿ]/; // au moins une lettre latine (pour ignorer icônes/nombres seuls)

/**
 * Cherche, dans une liste d'éléments crawlés, celui qui sert probablement à
 * basculer la langue vers l'arabe (bouton "Passer en arabe", etc.).
 */
function findArabicToggle(elements) {
  return elements.find((el) => {
    const name = (el.accessibleName || "").toLowerCase();
    return AR_TOGGLE_KEYWORDS.some((kw) => name.includes(kw));
  });
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
export async function checkLocalization(url) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "networkidle" });
  await page
    .waitForSelector("input, textarea, select, button, a", { timeout: 5000 })
    .catch(() => {});

  const frElements = await page.evaluate(buildSelectorInBrowser);
  const frState = await readPageLocalizationState(page);

  const toggle = findArabicToggle(frElements);
  if (!toggle) {
    await browser.close();
    throw new Error(
      "Aucun bouton de changement de langue vers l'arabe détecté parmi les éléments crawlés. " +
        "Vérifie manuellement le libellé utilisé sur le site et ajuste AR_TOGGLE_KEYWORDS si besoin."
    );
  }

  await page.locator(toggle.selector).click();
  // Un changement de langue Angular ne déclenche pas forcément de nouvelle requête réseau
  // (souvent un simple re-rendu côté client) : on attend un court instant fixe plutôt
  // que "networkidle", qui ne se déclencherait pas ici.
  await page.waitForTimeout(800);

  const arElements = await page.evaluate(buildSelectorInBrowser);
  const arState = await readPageLocalizationState(page);

  await browser.close();

  return compareLocalization(
    { url, elements: frElements, ...frState },
    { elements: arElements, ...arState }
  );
}

function compareLocalization(fr, ar) {
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
    const arEl = arBySelector.get(frEl.selector);
    if (!arEl) continue; // élément absent côté AR : pas forcément un bug, on ne le compte pas.
    comparedCount++;

    const frText = (frEl.accessibleName || "").trim();
    const arText = (arEl.accessibleName || "").trim();

    if (frText.length >= 2 && frText === arText && TEXT_CHAR_PATTERN.test(frText)) {
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
