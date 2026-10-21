import { launchBrowser } from "./browser.js";
import { MAX_EXPLORE_CLICKS } from "./exploration.js";
import { gotoAndSettle, settlePage, waitForRendered, redactUrl, stripAnsi } from "./page-utils.js";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { mkdir } from "fs/promises";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
    // Le texte réellement affiché : le libellé associé (<label>) pour une case/radio, et
    // value uniquement pour les boutons <input type=button|submit|reset> (pour une case ou un
    // champ de saisie, value n'est PAS du texte visible : "donor", valeur saisie...).
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const valueIsLabel = tag === "input" && ["button", "submit", "reset"].includes(type);
    const labelText = el.labels && el.labels.length ? el.labels[0].innerText : "";
    const text = (el.innerText || labelText || (valueIsLabel ? el.value : "") || "").trim();
    return text.slice(0, 60);
  }

  // Rôle ARIA de l'élément (explicite ou implicite d'après sa balise) : sert à construire des
  // sélecteurs lisibles du type role=button[name="Continuer"] (voir upgradeToSemanticSelectors).
  function getAriaRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "hidden") return null;
      return "textbox";
    }
    return null;
  }

  // Première ligne de texte visible (pour un conteneur cliquable sans sémantique : une "carte").
  function getVisibleText(el) {
    const firstLine = (el.innerText || "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    return firstLine ? firstLine.slice(0, 60) : null;
  }

  // Échappe un identifiant CSS (ids React ":r0:", ids commençant par un chiffre...).
  function cssEscape(value) {
    return typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(value)
      : String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  }

  // Valeur d'attribut entre guillemets doubles, avec \ et " échappés.
  function attrValue(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  // Un sélecteur n'est utilisable que s'il désigne EXACTEMENT cet élément.
  function isUnique(selector, el) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === el;
    } catch {
      return false;
    }
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    const path = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && path.length < 12) {
      let selector = node.nodeName.toLowerCase();
      if (node.id) {
        selector += `#${cssEscape(node.id)}`;
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

  const visible = combined.filter(({ el }) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  });

  // Mémorise les éléments (même ordre que `index`) : crawlPage s'en sert pour vérifier côté Node
  // qu'un sélecteur de remplacement désigne bien CET élément, puis efface cette variable.
  window.__qaCrawlElements = visible.map(({ el }) => el);

  return visible
    .map(({ el, heuristic, disabledLooking }, index) => {
      const testId =
        el.getAttribute("data-testid") || el.getAttribute("data-test-id");
      const id = el.id;
      const name = el.getAttribute("name");

      // Chaque stratégie n'est retenue que si elle est valide ET unique dans la page ;
      // sinon on passe à la suivante (un groupe de radios partage le même name, par exemple).
      const candidates = [];
      if (testId) {
        candidates.push([`[data-testid=${attrValue(testId)}]`, "data-testid"]);
      }
      if (id) candidates.push([`#${cssEscape(id)}`, "id"]);
      if (name) {
        candidates.push([`[name=${attrValue(name)}]`, "name"]);
        const value = el.getAttribute("value");
        if (value !== null) {
          candidates.push([`[name=${attrValue(name)}][value=${attrValue(value)}]`, "name+value"]);
        }
      }

      let preferredSelector = null;
      let selectorStrategy = null;
      for (const [candidate, strategy] of candidates) {
        if (isUnique(candidate, el)) {
          preferredSelector = candidate;
          selectorStrategy = strategy;
          break;
        }
      }
      if (!preferredSelector) {
        preferredSelector = cssPath(el);
        selectorStrategy = "css-path (fragile, à surveiller)";
      }

      return {
        index,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || null,
        role: el.getAttribute("role") || null,
        ariaRole: getAriaRole(el),
        visibleText: getVisibleText(el),
        accessibleName: getAccessibleName(el),
        selector: preferredSelector,
        selectorStrategy,
        placeholder: el.getAttribute("placeholder") || null,
        lang: el.getAttribute("lang") || el.getAttribute("hreflang") || null,
        detectedBy: heuristic
          ? "heuristique (cursor, sans sémantique HTML — à vérifier)"
          : "sémantique (balise/role/attribut HTML standard)",
        disabledLooking,
      };
    });
}

// Identifiants générés par les frameworks (Angular Material "mat-input-0", React ":r0:"...) : ils
// changent d'un affichage à l'autre, donc un sélecteur #id basé dessus n'est pas fiable.
const VOLATILE_ID_PATTERN = /^(mat-|cdk-|ng-|ngx-|ember|react-|radix-|headlessui-|:r|__)|\d{4,}/i;

/** Échappe un texte pour le mettre entre guillemets dans un sélecteur Playwright. */
function quoteForSelector(text) {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isUsableLabel(text) {
  return typeof text === "string" && text.trim() !== "" && text.length <= 60 && !/[\n\r]/.test(text);
}

/**
 * Sélecteurs lisibles, par ordre de préférence, pour un élément (fonction pure, testée sans navigateur) :
 *  1. rôle + nom accessible : role=button[name="Continuer"]  (ce que voit un utilisateur) ;
 *  2. champ de saisie : [placeholder="Email"] ;
 *  3. conteneur cliquable sans sémantique (une "carte") : text="Je suis un Donateur".
 * Aucun n'est garanti unique : upgradeToSemanticSelectors le vérifie dans la vraie page.
 */
export function buildSemanticCandidates(el) {
  const candidates = [];
  const names = [...new Set([el.accessibleName, el.placeholder].filter(isUsableLabel))];

  if (el.ariaRole) {
    for (const name of names) {
      candidates.push({ selector: `role=${el.ariaRole}[name=${quoteForSelector(name)}]`, strategy: "role+nom" });
    }
  }
  if (isUsableLabel(el.placeholder)) {
    candidates.push({ selector: `[placeholder=${quoteForSelector(el.placeholder)}]`, strategy: "placeholder" });
  }
  if (!el.ariaRole && isUsableLabel(el.visibleText)) {
    candidates.push({ selector: `text=${quoteForSelector(el.visibleText)}`, strategy: "texte" });
  }
  return candidates;
}

/**
 * Remplace les sélecteurs fragiles (chemin CSS "html > body > app-root:nth-of-type(1)...", ids
 * générés) par un sélecteur lisible quand il en existe un qui désigne EXACTEMENT cet élément.
 * L'ancien sélecteur n'est pas perdu : il devient `fallbackSelector`, utilisé par le runner si le
 * sélecteur lisible ne trouve plus rien (par ex. après un passage du site en arabe, où le texte des
 * boutons change alors que la structure de la page reste la même).
 *
 * Doit être appelé tant que window.__qaCrawlElements existe (voir buildSelectorInBrowser).
 */
export async function upgradeToSemanticSelectors(page, elements) {
  for (const el of elements) {
    const isFragile =
      el.selectorStrategy.startsWith("css-path") ||
      (el.selectorStrategy === "id" && VOLATILE_ID_PATTERN.test(el.selector.replace(/^#/, "").replace(/\\/g, "")));
    if (!isFragile) continue;

    for (const candidate of buildSemanticCandidates(el)) {
      try {
        const locator = page.locator(candidate.selector);
        if ((await locator.count()) !== 1) continue; // ambigu ou introuvable
        // Même élément (ou un de ses descendants, ex. le titre d'une carte cliquable) ?
        const isSameElement = await locator.evaluate((node, index) => {
          const target = window.__qaCrawlElements?.[index];
          return Boolean(target) && (node === target || target.contains(node));
        }, el.index);
        if (!isSameElement) continue;

        el.fallbackSelector = el.selector;
        el.selector = candidate.selector;
        el.selectorStrategy = candidate.strategy;
        break;
      } catch {
        // Sélecteur invalide pour Playwright : on essaie le candidat suivant.
      }
    }
  }
  await page.evaluate(() => {
    delete window.__qaCrawlElements;
  });
}

/**
 * Textes visibles de la page qui ne sont PAS interactifs : ce sont eux qu'un ticket demande de
 * vérifier ("le titre affiche...", "un message d'erreur est visible", "le texte ... est affiché").
 * S'exécute dans la page. Deux passes, pour ne pas gonfler le prompt de l'IA :
 *  1. les textes importants (titres, alertes, messages d'erreur, toasts), toujours gardés ;
 *  2. le texte courant (paragraphes, éléments de liste, citations, légendes), pour compléter.
 * Sans la 2e passe, un ticket qui cite une phrase d'un paragraphe n'avait rien à vérifier.
 */
export function collectTextInBrowser() {
  const MAX_ITEMS = 40;
  const MAX_BODY_ITEMS = 25;
  const PRIORITY_SELECTOR = [
    "h1", "h2", "h3", "h4", "[role=heading]",
    "[role=alert]", "[role=status]", "[aria-live]:not([aria-live=off])",
    "mat-error", "[class*=error i]", "[class*=invalid-feedback i]", "[class*=alert i]",
    "[class*=toast i]", "[class*=snack i]", "[class*=notification i]", "[class*=message i]",
  ].join(",");
  const BODY_SELECTOR = "p, li, blockquote, figcaption, caption";

  const seen = new Set();
  const out = [];

  const collect = (selector, limit) => {
    let added = 0;
    for (const el of document.querySelectorAll(selector)) {
      if (out.length >= MAX_ITEMS || added >= limit) break;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
      const text = (el.innerText || "").trim().split("\n")[0].trim().slice(0, 120);
      if (text.length < 2 || seen.has(text)) continue;
      seen.add(text);

      const tag = el.tagName.toLowerCase();
      const explicitRole = el.getAttribute("role");
      const live = el.getAttribute("aria-live");
      let kind = "texte";
      if (/^h[1-6]$/.test(tag) || explicitRole === "heading") kind = "titre";
      if (explicitRole === "alert" || explicitRole === "status" || live === "assertive" || live === "polite" || tag === "mat-error" || /error|invalid|alert|toast|snack|notification/i.test(el.className || "")) kind = "message";
      out.push({ tag, kind, ariaRole: explicitRole || (kind === "titre" ? "heading" : null), text });
      added += 1;
    }
  };

  collect(PRIORITY_SELECTOR, MAX_ITEMS);
  collect(BODY_SELECTOR, MAX_BODY_ITEMS);
  return out;
}

/** Sélecteurs candidats pour un texte visible (fonction pure, testée sans navigateur). */
export function buildTextCandidates(item) {
  const candidates = [];
  if (item.ariaRole === "heading" || item.kind === "titre") {
    candidates.push(`role=heading[name=${quoteForSelector(item.text)}]`);
  }
  if (item.ariaRole === "alert" || item.ariaRole === "status") {
    candidates.push(`role=${item.ariaRole}`);
  }
  candidates.push(`text=${quoteForSelector(item.text)}`);
  // Texte entre guillemets = correspondance EXACTE avec tout le texte de l'élément. Or on ne garde
  // que les 120 premiers caractères de la première ligne : pour un paragraphe plus long, le sélecteur
  // exact ne trouve rien et le texte serait écarté. Ce dernier candidat cherche le début du texte
  // (`:has-text` = sous-chaîne, sans tenir compte de la casse), limité à la même balise pour ne pas
  // viser les conteneurs. Il n'est utilisé que si les précédents n'ont pas désigné un élément unique.
  // Volontairement sans expression régulière : l'IA recopie ces sélecteurs dans du JSON, et les
  // antislashs (\s, \.) y sont une source d'erreurs d'échappement.
  if (/^[a-z][a-z0-9-]*$/.test(item.tag ?? "")) {
    candidates.push(`${item.tag}:has-text(${quoteForSelector(item.text)})`);
  }
  return candidates;
}


/** Pour chaque texte, garde le premier sélecteur qui désigne EXACTEMENT un élément de la page. */
export async function resolveTextSelectors(page, items) {
  const resolved = [];
  for (const item of items) {
    for (const selector of buildTextCandidates(item)) {
      try {
        if ((await page.locator(selector).count()) === 1) {
          resolved.push({ ...item, selector });
          break;
        }
      } catch {
        // sélecteur refusé par Playwright : candidat suivant
      }
    }
  }
  return resolved;
}

/** Liste les éléments interactifs et les textes visibles de l'état ACTUEL de la page. */
async function extractPageState(page) {
  const elements = await page.evaluate(buildSelectorInBrowser);
  await upgradeToSemanticSelectors(page, elements);
  const textElements = await resolveTextSelectors(page, await page.evaluate(collectTextInBrowser));
  return { elements, textElements };
}

/**
 * Explore la page ATTEINTE APRÈS des clics. Le crawl normal ne voit que ce qui est affiché à
 * l'ouverture : sur une appli où l'on choisit d'abord un profil puis « Continuer », le formulaire
 * n'existe pas encore et l'IA ne pouvait pas écrire d'étapes dessus.
 *
 * `clicks` = [{ selector, fallbackSelector?, description? }] dans l'ordre. L'exploration s'arrête
 * proprement (sans erreur) au premier clic impossible : elle renvoie alors ce qu'elle a pu atteindre.
 * Elle ne remplit aucun champ et ne soumet rien : seuls des clics sont faits.
 *
 * Renvoie { via, url, title, elements, textElements, clicksDone } ; `via` = descriptions des clics faits.
 * Option `screenshotPath` : enregistre une capture de la page atteinte (diagnostic).
 */
export async function crawlAfterClicks(url, clicks, options = {}) {
  const { navigationTimeoutMs = 30000, browserEngine, clickTimeoutMs = 8000, screenshotPath = null } = options;
  const browser = await launchBrowser(browserEngine);
  try {
    const page = await browser.newPage();
    await gotoAndSettle(page, url, { timeout: navigationTimeoutMs });

    const via = [];
    let failedClick = null;
    for (const click of clicks.slice(0, MAX_EXPLORE_CLICKS)) {
      let clicked = false;
      let reason = "élément introuvable sur la page";
      // Le clic ATTEND que l'élément apparaisse (comme le fait le run) : sur une appli Angular, le bouton
      // peut s'afficher quelques secondes après le reste de la page. Le sélecteur de secours n'a
      // droit qu'à une attente plus courte.
      const attempts = [
        [click.selector, clickTimeoutMs],
        [click.fallbackSelector, Math.min(3000, clickTimeoutMs)],
      ];
      for (const [selector, timeout] of attempts) {
        if (!selector) continue;
        try {
          await page.locator(selector).first().click({ timeout });
          clicked = true;
          break;
        } catch (err) {
          // sélecteur refusé ou clic impossible : on essaie le sélecteur de secours
          reason = stripAnsi(String(err.message)).split("\n")[0].slice(0, 160);
        }
      }
      if (!clicked) {
        failedClick = { description: click.description || click.selector, selector: click.selector, reason };
        break;
      }
      via.push(click.description || click.selector);
      await settlePage(page, 2000);
      await waitForRendered(page, 4000);
    }

    const { elements, textElements } = via.length > 0 ? await extractPageState(page) : { elements: [], textElements: [] };
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    return {
      via,
      url: redactUrl(page.url()),
      title: await page.title().catch(() => ""),
      elements,
      textElements,
      clicksDone: via.length,
      failedClick,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Crawle une URL et retourne la liste des éléments interactifs détectés,
 * avec le sélecteur le plus stable trouvé pour chacun.
 *
 * Options :
 *  - navigationTimeoutMs : délai max pour le chargement initial de la page (défaut 30s) —
 *    à augmenter sur un environnement de staging plus lent que la prod ;
 *  - browserEngine       : "chromium" (défaut) | "firefox" | "webkit".
 */
export async function crawlPage(url, options = {}) {
  const { navigationTimeoutMs = 30000, browserEngine } = options;
  const browser = await launchBrowser(browserEngine);

  // try/finally : si la page est injoignable (timeout, DNS...), on ferme quand même
  // le navigateur. Indispensable maintenant que les runs tournent en arrière-plan.
  try {
    const page = await browser.newPage();

    const startedAt = Date.now();
    await gotoAndSettle(page, url, { timeout: navigationTimeoutMs });
    const title = await page.title();

    // Les applis SPA (Angular, React...) affichent parfois le contenu principal
    // un peu après que le réseau soit "calme" (hydratation côté client).
    // On laisse une chance à un vrai champ de formulaire d'apparaître avant de lister les éléments.
    await page
      .waitForSelector("input, textarea, select", { timeout: 5000 })
      .catch(() => {
        // Pas grave si rien n'apparaît : on continue quand même avec ce qui est déjà là.
      });

    const { elements, textElements } = await extractPageState(page);

    await mkdir("debug-screenshots", { recursive: true });
    const screenshotPath = `debug-screenshots/${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return {
      url,
      title,
      crawledAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      elementCount: elements.length,
      textElements,
      screenshotPath,
      elements,
    };
  } finally {
    await browser.close();
  }
}

// Exécution directe : `npm run crawl -- <url>`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.chdir(BACKEND_ROOT); // dossiers relatifs (debug-screenshots/) toujours sous backend/
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