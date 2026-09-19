import { chromium } from "playwright";
import { pathToFileURL } from "url";
import { mkdir } from "fs/promises";

/**
 * Génère un sélecteur "le plus stable possible" pour un élément donné,
 * dans l'ordre de préférence : data-testid > id > name > role+texte accessible > sélecteur CSS de secours.
 */
export function buildSelectorInBrowser() {
  // Cette fonction est sérialisée et exécutée dans le contexte de la page (page.evaluate),
  // donc elle ne peut pas utiliser de closures externes.
  function getAccessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const text = (el.innerText || el.value || "").trim();
    return text.slice(0, 60);
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    const path = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && path.length < 6) {
      let selector = node.nodeName.toLowerCase();
      if (node.id) {
        selector += `#${node.id}`;
        path.unshift(selector);
        break;
      } else {
        let sibling = node;
        let nth = 1;
        while ((sibling = sibling.previousElementSibling)) {
          if (sibling.nodeName.toLowerCase() === selector) nth++;
        }
        selector += `:nth-of-type(${nth})`;
      }
      path.unshift(selector);
      node = node.parentElement;
    }
    return path.join(" > ");
  }

  const INTERACTIVE_SELECTOR = [
    "button",
    "a[href]",
    "input",
    "select",
    "textarea",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=tab]",
    "[onclick]",
    "[contenteditable=true]",
  ].join(",");

  const elements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const alreadyFound = new Set(elements);

  // Filet de sécurité : certains éléments cliquables (frameworks type Angular avec
  // des directives (click) sur un simple <div>) n'ont AUCUN indice HTML sémantique.
  // On les repère par un indice visuel : le curseur "pointer" (ou "not-allowed" pour
  // un élément cliquable mais temporairement désactivé), que les devs ajoutent
  // presque toujours pour signaler l'interactivité.
  //
  // Comme `cursor` est une propriété CSS héritée, un enfant de texte/icône hérite
  // souvent le curseur de son conteneur cliquable. On remonte donc jusqu'à l'ancêtre
  // le plus haut qui a encore ce même curseur, pour capter LE conteneur cliquable
  // entier plutôt que chacun de ses fragments internes (titre, texte, icône...).
  function findClickableRoot(el, cursorValue) {
    let node = el;
    while (
      node.parentElement &&
      node.parentElement !== document.body &&
      window.getComputedStyle(node.parentElement).cursor === cursorValue
    ) {
      node = node.parentElement;
    }
    return node;
  }

  const CLICKABLE_CURSORS = new Set(["pointer", "not-allowed"]);
  const heuristicRoots = new Map(); // dédoublonnage par élément racine

  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (alreadyFound.has(el)) continue;
    const cursor = window.getComputedStyle(el).cursor;
    if (!CLICKABLE_CURSORS.has(cursor)) continue;

    const root = findClickableRoot(el, cursor);
    if (alreadyFound.has(root)) continue;
    if (!heuristicRoots.has(root)) {
      heuristicRoots.set(root, cursor);
    }
  }

  const combined = [
    ...elements.map((el) => ({ el, heuristic: false, disabledLooking: false })),
    ...Array.from(heuristicRoots.entries()).map(([el, cursor]) => ({
      el,
      heuristic: true,
      disabledLooking: cursor === "not-allowed",
    })),
  ];

  return combined
    .filter(({ el }) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    })
    .map(({ el, heuristic, disabledLooking }, index) => {
      const testId =
        el.getAttribute("data-testid") || el.getAttribute("data-test-id");
      const id = el.id;
      const name = el.getAttribute("name");

      let preferredSelector;
      let selectorStrategy;
      if (testId) {
        preferredSelector = `[data-testid="${testId}"]`;
        selectorStrategy = "data-testid";
      } else if (id) {
        preferredSelector = `#${id}`;
        selectorStrategy = "id";
      } else if (name) {
        preferredSelector = `[name="${name}"]`;
        selectorStrategy = "name";
      } else {
        preferredSelector = cssPath(el);
        selectorStrategy = "css-path (fragile, à surveiller)";
      }

      return {
        index,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || null,
        role: el.getAttribute("role") || null,
        accessibleName: getAccessibleName(el),
        selector: preferredSelector,
        selectorStrategy,
        placeholder: el.getAttribute("placeholder") || null,
        detectedBy: heuristic
          ? "heuristique (cursor, sans sémantique HTML — à vérifier)"
          : "sémantique (balise/role/attribut HTML standard)",
        disabledLooking,
      };
    });
}

/**
 * Crawle une URL et retourne la liste des éléments interactifs détectés,
 * avec le sélecteur le plus stable trouvé pour chacun.
 */
export async function crawlPage(url) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const startedAt = Date.now();
  await page.goto(url, { waitUntil: "networkidle" });
  const title = await page.title();

  // Les applis SPA (Angular, React...) affichent parfois le contenu principal
  // un peu après que le réseau soit "calme" (hydratation côté client).
  // On laisse une chance à un vrai champ de formulaire d'apparaître avant de lister les éléments.
  await page
    .waitForSelector("input, textarea, select", { timeout: 5000 })
    .catch(() => {
      // Pas grave si rien n'apparaît : on continue quand même avec ce qui est déjà là.
    });

  const elements = await page.evaluate(buildSelectorInBrowser);

  await mkdir("debug-screenshots", { recursive: true });
  const screenshotPath = `debug-screenshots/${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await browser.close();

  return {
    url,
    title,
    crawledAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    elementCount: elements.length,
    screenshotPath,
    elements,
  };
}

// Exécution directe : `npm run crawl -- <url>`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetUrl = process.argv[2] || "https://the-internet.herokuapp.com/login";
  crawlPage(targetUrl)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error("Erreur de crawl :", err);
      process.exit(1);
    });
}
