/**
 * Exploration « après un clic » : logique pure (sans navigateur), partagée par le planner et
 * l'exécuteur de runs. Le navigateur, lui, n'est utilisé que par `crawlAfterClicks` (crawler.js).
 */

import { hasPlaceholder, PASSWORD_FIELD } from "./secrets.js";

/** Nombre maximum de clics enchaînés pendant l'exploration (au-delà, on s'arrête). */
export const MAX_EXPLORE_CLICKS = 3;

/** Nombre maximum d'actions (clics + saisies) rejouées pendant l'exploration. */
export const MAX_EXPLORE_ACTIONS = 6;

/**
 * Choisit, dans un scénario déjà validé, les clics qui mènent vers la page suivante : les clics du
 * début du scénario, jusqu'à la première saisie (fill/select) ou le premier retour arrière. Les
 * ouvertures de page et les vérifications ne changent pas l'état de la page : elles sont sautées.
 * Un clic dont le sélecteur a été refusé par la validation n'est jamais tenté en PREMIER (la page de
 * départ ne l'a pas). Après un premier clic en revanche, il est tenté : un bouton comme « Continuer »
 * n'existe souvent qu'une fois le rôle choisi, donc il manque forcément au crawl de la page de départ.
 * Si ce clic échoue vraiment (sélecteur inventé), l'exploration s'arrête là et le dit (failedClick).
 */
export function pickExplorationClicks(steps, max = MAX_EXPLORE_CLICKS) {
  const clicks = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (clicks.length >= max) break;
    if (step.type === "fill" || step.type === "select" || step.type === "go_back") break;
    if (step.type !== "click") continue; // navigate, assert_* : l'état de la page ne change pas
    if (!step.selector) break;
    if (step.selectorValid === false && clicks.length === 0) break;
    clicks.push({
      selector: step.selector,
      fallbackSelector: step.fallbackSelector,
      description: step.description,
    });
  }
  return clicks;
}

/** Une saisie « de connexion » : variable secrète `{{QA_SECRET_*}}` ou champ de mot de passe. */
function isCredentialFill(step) {
  if (step.type !== "fill") return false;
  return (
    (typeof step.value === "string" && hasPlaceholder(step.value)) ||
    step.sensitive === true ||
    PASSWORD_FIELD.test(`${step.selector ?? ""} ${step.description ?? ""}`)
  );
}

/**
 * Exploration « après une saisie » : pour un formulaire de CONNEXION (au moins une saisie d'identifiant secret ou
 * de mot de passe, puis un clic de validation), on rejoue clics ET saisies du début du scénario jusqu'à ce clic de
 * validation inclus, pour voir la page atteinte après la connexion.
 *
 * Volontairement limitée aux connexions : valider un autre formulaire (création d'un ticket, d'un don...) pendant
 * l'exploration créerait des données sur le site testé, en plus de celles créées par le vrai test.
 * Dans tous les autres cas, on retombe sur l'exploration après des clics seuls (pickExplorationClicks).
 * Renvoie des actions { type: "click" | "fill" | "select", selector, fallbackSelector, description, value? }.
 */
export function pickExplorationActions(steps, max = MAX_EXPLORE_ACTIONS) {
  const list = Array.isArray(steps) ? steps : [];
  const actions = [];
  let sawFill = false;
  let credentials = false;
  let submitted = false;

  for (const step of list) {
    if (actions.length >= max) break;
    if (step.type === "go_back") break;
    if (!["click", "fill", "select"].includes(step.type)) continue; // navigate, assert_* : rien ne change
    if (!step.selector) break;
    if (step.selectorValid === false && actions.length === 0) break;

    actions.push({
      type: step.type,
      selector: step.selector,
      fallbackSelector: step.fallbackSelector,
      description: step.description,
      ...(step.type === "click" ? {} : { value: step.value }),
    });
    if (step.type !== "click") {
      sawFill = true;
      if (isCredentialFill(step)) credentials = true;
    } else if (sawFill) {
      submitted = true;
      break;
    }
  }

  if (submitted && credentials) return actions;
  return pickExplorationClicks(list);
}

/**
 * Ajoute au crawl la page atteinte après les clics, mais SEULEMENT ce qu'elle apporte de nouveau
 * (éléments et textes dont le sélecteur n'était pas déjà dans le crawl). Renvoie null s'il n'y a
 * rien de nouveau : inutile alors de redemander un scénario à l'IA.
 */
export function attachNextPage(crawl, next) {
  if (!next || !Array.isArray(next.via) || next.via.length === 0) return null;
  const knownElements = new Set(crawl.elements.map((el) => el.selector));
  const knownTexts = new Set((crawl.textElements || []).map((t) => t.selector));
  const elements = (next.elements || []).filter((el) => !knownElements.has(el.selector));
  const textElements = (next.textElements || []).filter((t) => !knownTexts.has(t.selector));
  if (elements.length === 0 && textElements.length === 0) return null;
  return {
    ...crawl,
    nextPage: {
      via: next.via,
      url: next.url,
      title: next.title,
      elements,
      textElements,
      ...(next.afterFill ? { afterFill: true } : {}),
    },
  };
}

/**
 * 2e temps de l'exploration : la page atteinte APRÈS LA CONNEXION. Elle s'ajoute à la page du formulaire (`nextPage`,
 * conservée telle quelle) : sur Helpify, par exemple, le formulaire n'apparaît qu'après le choix du profil et
 * « Continuer » (1er temps), et le tableau de bord qu'après la connexion (2e temps).
 * Ne garde que ce qu'elle apporte de nouveau par rapport à la page d'ouverture ET à la page du formulaire.
 * Renvoie null s'il n'y a rien de nouveau.
 */
export function attachLoggedPage(crawl, next) {
  if (!next || !Array.isArray(next.via) || next.via.length === 0) return null;
  const knownElements = new Set([...crawl.elements, ...(crawl.nextPage?.elements || [])].map((el) => el.selector));
  // Un texte est « déjà connu » seulement si sélecteur ET texte sont identiques : un même <h1> peut afficher
  // un titre différent une fois connecté.
  const textKey = (t) => `${t.selector}\u0000${t.text ?? ""}`;
  const knownTexts = new Set([...(crawl.textElements || []), ...(crawl.nextPage?.textElements || [])].map(textKey));
  const elements = (next.elements || []).filter((el) => !knownElements.has(el.selector));
  const textElements = (next.textElements || []).filter((t) => !knownTexts.has(textKey(t)));
  if (elements.length === 0 && textElements.length === 0) return null;
  return { ...crawl, afterLogin: { via: next.via, url: next.url, title: next.title, elements, textElements } };
}

/** Résumé stocké dans le run (sans les éléments eux-mêmes). */
export function summarizeNextPage(crawl) {
  const next = crawl?.nextPage;
  if (!next) return null;
  return {
    via: next.via,
    url: next.url,
    title: next.title,
    elementCount: next.elements.length,
    textCount: next.textElements.length,
  };
}

/**
 * Bilan de l'exploration, stocké dans le run et affiché dans le rapport : sans lui, une exploration
 * qui ne trouve rien (ou dont un clic échoue) ne laissait aucune trace et on ne pouvait pas savoir
 * si elle avait eu lieu. `next` = résultat de crawlAfterClicks (ou null), `error` = message si elle a planté.
 */
export function summarizeExploration({ clicks, next = null, enriched = null, used = false, error = null }) {
  return {
    clicksPlanned: clicks.map((c) => c.description || c.selector),
    clicksDone: next?.clicksDone ?? 0,
    failedClick: next?.failedClick ?? null,
    url: next?.url ?? null,
    newElementCount: enriched?.nextPage.elements.length ?? 0,
    newTextCount: enriched?.nextPage.textElements.length ?? 0,
    usedForPlan: used,
    afterFill: Boolean(next?.afterFill),
    error,
  };
}
