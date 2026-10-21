/**
 * Exploration « après un clic » : logique pure (sans navigateur), partagée par le planner et
 * l'exécuteur de runs. Le navigateur, lui, n'est utilisé que par `crawlAfterClicks` (crawler.js).
 */

/** Nombre maximum de clics enchaînés pendant l'exploration (au-delà, on s'arrête). */
export const MAX_EXPLORE_CLICKS = 3;

/**
 * Choisit, dans un scénario déjà validé, les clics qui mènent vers la page suivante : les clics du
 * début du scénario, jusqu'à la première saisie (fill/select) ou le premier retour arrière. Les
 * ouvertures de page et les vérifications ne changent pas l'état de la page : elles sont sautées.
 * Un clic dont le sélecteur a été refusé par la validation n'est jamais tenté.
 */
export function pickExplorationClicks(steps, max = MAX_EXPLORE_CLICKS) {
  const clicks = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (clicks.length >= max) break;
    if (step.type === "fill" || step.type === "select" || step.type === "go_back") break;
    if (step.type !== "click") continue; // navigate, assert_* : l'état de la page ne change pas
    if (step.selectorValid === false || !step.selector) break;
    clicks.push({
      selector: step.selector,
      fallbackSelector: step.fallbackSelector,
      description: step.description,
    });
  }
  return clicks;
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
    nextPage: { via: next.via, url: next.url, title: next.title, elements, textElements },
  };
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
    error,
  };
}
