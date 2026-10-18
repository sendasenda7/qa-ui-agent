/**
 * Erreurs d'étape structurées.
 *
 * Avant, une étape en échec affichait le message brut de Playwright
 * ("locator.waitFor: Timeout 10000ms exceeded. Call log: ..."), illisible pour un QA. Ici chaque
 * échec reçoit :
 *  - une catégorie (ELEMENT_NOT_FOUND, TEXT_MISMATCH, URL_MISMATCH...) ;
 *  - un code stable (E-ELM-001...) pour retrouver et regrouper les échecs ;
 *  - une phrase lisible (`message`), ce que l'on attendait (`expected`), ce que l'on a trouvé
 *    (`found`) et une piste d'action (`hint`) ;
 *  - le message d'origine de Playwright, gardé à part dans `technical` (affiché replié).
 *
 * Ce module n'importe rien d'autre du projet (page-utils.js l'importe, pas l'inverse), pour éviter
 * toute dépendance circulaire.
 */

export const ERROR_CODES = Object.freeze({
  SELECTOR_HALLUCINATED: "E-SEL-001",
  INVALID_STEP: "E-STP-001",
  ELEMENT_NOT_FOUND: "E-ELM-001",
  ELEMENT_NOT_VISIBLE: "E-ELM-002",
  ELEMENT_DISABLED: "E-ELM-003",
  ELEMENT_OBSCURED: "E-ELM-004",
  ELEMENT_AMBIGUOUS: "E-ELM-005",
  TEXT_MISMATCH: "E-TXT-001",
  URL_MISMATCH: "E-URL-001",
  NAVIGATION_ERROR: "E-NAV-001",
  TIMEOUT: "E-TMO-001",
  CRAWL_EMPTY: "E-CRW-001",
  PLAN_EMPTY: "E-PLN-001",
  UNKNOWN: "E-UNK-001",
});

export const CATEGORY_LABELS = Object.freeze({
  SELECTOR_HALLUCINATED: "Sélecteur inventé par l'IA",
  INVALID_STEP: "Étape invalide",
  ELEMENT_NOT_FOUND: "Élément introuvable",
  ELEMENT_NOT_VISIBLE: "Élément non visible",
  ELEMENT_DISABLED: "Élément désactivé",
  ELEMENT_OBSCURED: "Élément masqué par un autre",
  ELEMENT_AMBIGUOUS: "Sélecteur ambigu",
  TEXT_MISMATCH: "Texte différent",
  URL_MISMATCH: "Adresse différente",
  NAVIGATION_ERROR: "Erreur de navigation",
  TIMEOUT: "Délai dépassé",
  CRAWL_EMPTY: "Page vide à l'exploration",
  PLAN_EMPTY: "Aucune étape générée",
  UNKNOWN: "Erreur inconnue",
});

const MAX_TECHNICAL_CHARS = 1500;
const MAX_FIELD_CHARS = 400;

/**
 * Masque ce qui ne doit jamais finir dans un fichier de run ni dans le rapport : chemins du serveur
 * et clés d'API (mêmes règles que `publicErrorMessage` dans app.js).
 */
function maskSensitive(text) {
  return text
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "[chemin masqué]")
    .replace(/\/(?:home|Users|root|var|tmp|opt|app|usr|etc|mnt)\/[^\s'"]+/g, "[chemin masqué]")
    .replace(/gsk_[A-Za-z0-9]+/g, "[clé masquée]");
}

/** Retire les codes de couleur du terminal que Playwright met dans ses messages, puis masque les secrets. */
function cleanTechnical(text) {
  return maskSensitive(String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "")).trim();
}

function clip(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** « a », « b », « c » — pour lister des textes dans un message. */
function quoteList(values) {
  return values.map((v) => `« ${v} »`).join(", ");
}

export class StepError extends Error {
  /**
   * @param {keyof typeof ERROR_CODES} category
   * @param {string} message  phrase lisible, aussi enregistrée dans `result.error`
   * @param {{expected?: string|null, found?: string|null, hint?: string|null, technical?: string|null}} [details]
   */
  constructor(category, message, { expected = null, found = null, hint = null, technical = null } = {}) {
    super(message);
    this.name = "StepError";
    this.category = ERROR_CODES[category] ? category : "UNKNOWN";
    this.code = ERROR_CODES[this.category];
    this.expected = expected;
    this.found = found;
    this.hint = hint;
    this.technical = technical;
  }

  /** Forme enregistrée dans le fichier du run (`result.failure`). */
  toFailure() {
    return {
      code: this.code,
      category: this.category,
      label: CATEGORY_LABELS[this.category],
      expected: this.expected == null ? null : clip(this.expected, MAX_FIELD_CHARS),
      found: this.found == null ? null : clip(this.found, MAX_FIELD_CHARS),
      hint: this.hint ?? null,
      // Le message technique n'est gardé que s'il apporte quelque chose de plus que la phrase.
      technical: this.technical && this.technical !== this.message ? clip(this.technical, MAX_TECHNICAL_CHARS) : null,
    };
  }
}

const ASSERTION_TYPES = ["assert_visible", "assert_text", "assert_enabled"];
const ACTION_TYPES = ["click", "fill", "select"];

function describeTarget(step) {
  return step?.selector ? `Élément ${step.selector}` : "Élément ciblé";
}

/**
 * Ce qu'on attendait, en français : pour une vérification de texte, le texte lui-même plutôt que
 * le sélecteur (`text="Mot de passe incorrect"`).
 */
function describeExpected(step) {
  const value = typeof step?.value === "string" ? step.value.trim() : "";
  if (step?.type === "assert_text" && value) return `Texte « ${value} » visible`;
  const fromSelector = /^text="(.*)"$/.exec(step?.selector ?? "");
  if (ASSERTION_TYPES.includes(step?.type) && fromSelector) return `Texte « ${fromSelector[1].replace(/\\"/g, '"')} » visible`;
  return describeTarget(step);
}

function classifyNavigationError(message, technical) {
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) {
    return new StepError("NAVIGATION_ERROR", "Adresse introuvable : le nom de domaine n'existe pas ou n'est pas joignable.", {
      expected: "Une page qui se charge",
      found: "Nom de domaine non résolu (ERR_NAME_NOT_RESOLVED)",
      hint: "Vérifie l'adresse saisie (faute de frappe ?) et ta connexion Internet.",
      technical,
    });
  }
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/.test(message)) {
    return new StepError("NAVIGATION_ERROR", "Le serveur a refusé ou coupé la connexion.", {
      expected: "Une page qui se charge",
      found: "Connexion refusée ou interrompue",
      hint: "Le site est peut-être arrêté, ou le port est mauvais. Vérifie qu'il répond depuis ton navigateur.",
      technical,
    });
  }
  if (/ERR_CERT|SSL|certificate/i.test(message)) {
    return new StepError("NAVIGATION_ERROR", "Problème de certificat HTTPS.", {
      expected: "Une page qui se charge en HTTPS",
      found: "Certificat invalide, expiré ou non reconnu",
      hint: "Le certificat du site est à renouveler ou à corriger côté serveur.",
      technical,
    });
  }
  if (/Timeout \d+ms exceeded/.test(message)) {
    const seconds = Math.round(Number(/Timeout (\d+)ms/.exec(message)[1]) / 1000);
    return new StepError("TIMEOUT", `Chargement de la page trop long (plus de ${seconds} s).`, {
      expected: "Une page qui répond dans le délai",
      found: `Aucune réponse en ${seconds} s`,
      hint: "Le site est lent : augmente le délai de navigation (écran New Test) ou réessaie plus tard.",
      technical,
    });
  }
  return new StepError("NAVIGATION_ERROR", "La navigation a échoué.", {
    expected: "Une page qui se charge",
    hint: "Voir le détail technique ci-dessous.",
    technical,
  });
}

/**
 * Transforme n'importe quelle erreur levée pendant une étape en StepError. Les StepError sont
 * rendues telles quelles ; les erreurs brutes de Playwright sont reconnues à leur message.
 * Exporté pour les tests.
 */
export function classifyError(err, step = {}) {
  if (err instanceof StepError) return err;

  const technical = clip(cleanTechnical(err?.message), MAX_TECHNICAL_CHARS);
  const type = step?.type;

  if (type === "navigate" || type === "go_back") {
    return classifyNavigationError(technical, technical);
  }

  const target = describeTarget(step);
  const selector = step?.selector ?? null;

  // Le sélecteur désigne plusieurs éléments (Playwright : "strict mode violation").
  if (/strict mode violation/i.test(technical)) {
    const count = /resolved to (\d+) elements/i.exec(technical)?.[1];
    return new StepError("ELEMENT_AMBIGUOUS", "Le sélecteur désigne plusieurs éléments à la fois.", {
      expected: `${target} (un seul)`,
      found: count ? `${count} éléments correspondent` : "Plusieurs éléments correspondent",
      hint: "Le sélecteur est trop général : précise-le (libellé exact, rôle) ou régénère le scénario.",
      technical,
    });
  }

  // Un autre élément (bandeau, fenêtre, bandeau cookies...) recouvre la cible.
  if (/intercepts pointer events/i.test(technical)) {
    return new StepError("ELEMENT_OBSCURED", "Un autre élément de la page recouvre la cible et bloque le clic.", {
      expected: `${target} cliquable`,
      found: "Élément recouvert (bandeau, fenêtre ou menu par-dessus)",
      hint: "Regarde la capture : un bandeau cookies ou une fenêtre ouverte masque peut-être le bouton.",
      technical,
    });
  }

  if (/element is not enabled/i.test(technical)) {
    return new StepError("ELEMENT_DISABLED", "L'élément est désactivé : l'action est impossible.", {
      expected: `${target} actif`,
      found: "Élément désactivé",
      hint: "Une condition manque peut-être avant (champ obligatoire vide, case à cocher non cochée).",
      technical,
    });
  }

  if (/Timeout \d+ms exceeded/i.test(technical)) {
    const seconds = Math.round(Number(/Timeout (\d+)ms/i.exec(technical)[1]) / 1000);
    const existsButHidden = /resolved to hidden|element is not visible|not visible/i.test(technical);
    const existsOtherwise = /locator resolved to/i.test(technical);

    if (existsButHidden) {
      return new StepError("ELEMENT_NOT_VISIBLE", `L'élément existe mais n'est pas visible (attendu ${seconds} s).`, {
        expected: ASSERTION_TYPES.includes(type) ? describeExpected(step) : `${target} visible`,
        found: "Élément présent dans la page mais caché",
        hint: ASSERTION_TYPES.includes(type)
          ? "Il apparaît peut-être après une action (clic, saisie) ou un chargement plus long."
          : "Il est peut-être masqué par un menu replié ou une étape précédente non faite.",
        technical,
      });
    }
    if (!existsOtherwise) {
      const expected = describeExpected(step);
      const isText = expected.startsWith("Texte «");
      return new StepError("ELEMENT_NOT_FOUND", `${isText ? "Texte attendu" : "Élément"} introuvable après ${seconds} s.`, {
        expected,
        found: "Aucun élément ne correspond à ce sélecteur sur la page",
        hint: ACTION_TYPES.includes(type)
          ? "La page a peut-être changé (autre langue, autre écran) ou l'élément n'est pas encore affiché."
          : "L'élément n'est pas affiché à ce stade : une action manque peut-être avant cette vérification.",
        technical,
      });
    }
    return new StepError("TIMEOUT", `L'action n'a pas abouti dans le délai (${seconds} s).`, {
      expected: `${target} prêt à recevoir l'action`,
      found: "Élément présent mais pas prêt (instable ou en mouvement)",
      hint: "Augmente le délai des étapes (écran New Test) si le site est lent.",
      technical,
    });
  }

  return new StepError("UNKNOWN", technical ? clip(technical.split("\n")[0], 200) : "Erreur inattendue pendant l'étape.", {
    expected: selector ? target : null,
    hint: "Voir le détail technique ci-dessous.",
    technical,
  });
}

/**
 * Exploration qui ne voit RIEN : ni élément interactif, ni texte. Dans ce cas l'IA n'a rien à
 * utiliser pour écrire le scénario ; autant arrêter tout de suite, avec la cause probable, plutôt
 * que d'appeler l'IA pour obtenir un message flou. Renvoie null si la page contient quelque chose.
 * Exporté pour les tests.
 */
export function describeEmptyCrawl(crawlResult) {
  const interactive = Number(crawlResult?.elementCount ?? crawlResult?.elements?.length ?? 0);
  const texts = Array.isArray(crawlResult?.textElements) ? crawlResult.textElements.length : 0;
  if (interactive > 0 || texts > 0) return null;

  const title = typeof crawlResult?.title === "string" ? crawlResult.title.trim() : "";
  return new StepError("CRAWL_EMPTY", "Aucun élément détecté sur la page : l'exploration n'a rien trouvé à tester.", {
    expected: "Une page avec des champs, des boutons ou des textes",
    found: title
      ? `0 élément interactif et 0 texte visible (titre de la page : « ${title} »)`
      : "0 élément interactif et 0 texte visible (page vide ou sans titre)",
    hint:
      "Le site est peut-être endormi ou en panne (un site hébergé gratuitement met parfois 30 s à se réveiller), " +
      "ou la page n'a pas fini de s'afficher. Ouvre l'adresse dans ton navigateur, puis essaie l'écran Explore ; " +
      "si l'appli est lente, augmente RENDER_TIMEOUT_MS.",
  });
}

/**
 * Classe une erreur qui fait planter le pipeline d'un run (hors étape de scénario) :
 *  - avec `phase === "crawling"` (appelé autour du crawler), un échec de chargement de la page est
 *    une erreur de navigation (site injoignable, DNS, certificat, lenteur) ;
 *  - sinon (IA, navigateur, disque), le message d'origine est gardé tel quel : il est déjà
 *    explicite (clé Groq manquante, quota dépassé...) et le masquer ferait perdre l'information.
 * Exporté pour les tests.
 */
export function classifyRunError(err, phase) {
  if (err instanceof StepError) return err;
  if (phase === "crawling") return classifyError(err, { type: "navigate" });
  const technical = clip(cleanTechnical(err?.message), MAX_TECHNICAL_CHARS);
  return new StepError("UNKNOWN", clip(technical.split("\n")[0] || "Erreur inattendue pendant le run.", MAX_FIELD_CHARS), {
    technical,
  });
}

/** Exécute `promise` avec une limite de temps, sans laisser de timer en suspens. */
async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("delai depasse")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lit ce que l'utilisateur voit à l'écran au moment de l'échec : titres et messages, boutons et
 * liens. Ne lit JAMAIS la valeur d'un champ de saisie (mot de passe...). Renvoie null si la page
 * n'est plus lisible (fermée, plantée) : un échec ne doit jamais en provoquer un deuxième.
 */
export async function collectPageSnapshot(page, { timeoutMs = 2000 } = {}) {
  if (!page || typeof page.evaluate !== "function") return null;
  try {
    return await withTimeout(
      page.evaluate(() => {
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        // Espaces réduits, et croix de fermeture (« × ») retirée en fin de texte.
        const clean = (t) => (t || "").replace(/\s+/g, " ").replace(/\s*[×✕✖]$/u, "").trim();
        const pick = (selector, max) => {
          const out = [];
          for (const el of document.querySelectorAll(selector)) {
            if (!isVisible(el)) continue;
            const text = clean(el.innerText || el.getAttribute("aria-label") || (el.type === "submit" ? el.value : ""));
            if (text && text.length <= 100 && !out.includes(text)) out.push(text);
            if (out.length >= max) break;
          }
          return out;
        };
        // Messages affichés (erreur, succès, notification) : le plus utile pour comprendre un échec.
        const messages = pick(
          '[role=alert], [role=status], [class*="alert" i], [class*="error" i], [class*="flash" i], [class*="toast" i], [class*="notif" i], [class*="invalid" i], [class*="danger" i], [class*="success" i]',
          4
        );
        const texts = pick("h1, h2, h3, [role=heading], label, legend, p", 8).filter((t) => !messages.includes(t));
        // Un vrai bouton a un libellé (pas un simple « × » de fermeture).
        const actions = pick("button, a[href], [role=button], input[type=submit]", 8)
          .filter((t) => /[\p{L}\p{N}]{2,}/u.test(t))
          .slice(0, 6);
        return { messages, texts, actions };
      }),
      timeoutMs
    );
  } catch {
    return null;
  }
}

/**
 * Complète une StepError avec ce qu'on voit réellement sur la page : « Textes visibles sur la
 * page : … » et, pour une vérification, les boutons disponibles (« il manque peut-être un clic sur
 * Continuer »). Ne touche qu'aux erreurs où cela aide à comprendre ; ne plante jamais.
 * Exporté pour les tests.
 */
export async function enrichFailure(page, step, failure) {
  const enrichable = ["ELEMENT_NOT_FOUND", "ELEMENT_NOT_VISIBLE", "TEXT_MISMATCH"];
  if (!(failure instanceof StepError) || !enrichable.includes(failure.category)) return failure;

  const snapshot = await collectPageSnapshot(page);
  if (!snapshot) return failure;
  const { messages = [], texts = [], actions = [] } = snapshot;

  const isAssertion = ASSERTION_TYPES.includes(step?.type);

  if (failure.category !== "TEXT_MISMATCH") {
    const parts = [];
    if (messages.length) parts.push(`Messages affichés : ${quoteList(messages)}`);
    if (isAssertion || !actions.length) {
      if (texts.length) parts.push(`Textes visibles sur la page : ${quoteList(texts)}`);
    }
    if (!isAssertion && actions.length) parts.push(`Boutons et liens visibles : ${quoteList(actions)}`);
    failure.found = parts.length
      ? parts.join(" — ")
      : "Aucun texte visible sur la page (vide, ou pas encore affichée)";
  }

  if (!messages.length && !texts.length && !actions.length) {
    failure.hint = "La page semble vide : l'appli n'a peut-être pas fini de s'afficher (augmente RENDER_TIMEOUT_MS).";
  } else if (isAssertion && messages.length && failure.category !== "TEXT_MISMATCH") {
    failure.hint = "Un message est bien affiché, mais son texte diffère de celui attendu : compare le libellé exact (langue du site, accents, formulation).";
  } else if (isAssertion && actions.length && failure.category !== "TEXT_MISMATCH") {
    failure.hint = `Une action manque peut-être avant cette vérification. Boutons visibles : ${quoteList(actions)}.`;
  }
  return failure;
}
