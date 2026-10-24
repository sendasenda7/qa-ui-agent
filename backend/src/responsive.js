/**
 * Contrôle responsive pendant le scénario : chaque NOUVELLE page rencontrée est rejouée à trois tailles
 * d'écran (mobile, tablette, bureau) et on y cherche les défauts d'affichage les plus courants :
 *
 *  - R-OVERFLOW         : la page défile horizontalement (un élément dépasse de l'écran) ;
 *  - R-NO-VIEWPORT-META : pas de balise <meta name="viewport"> (un vrai téléphone afficherait la version bureau réduite) ;
 *  - R-SMALL-TARGET     : boutons, liens ou champs de moins de 24 x 24 px sur mobile / tablette (WCAG 2.2, critère 2.5.8).
 *
 * Principe : on redimensionne la MÊME page (page.setViewportSize) au lieu de la rouvrir : la session, la connexion
 * et l'état du test sont conservés, et aucun clic n'est rejoué. La taille d'origine est toujours rétablie.
 *
 * Limites assumées : on change la taille de la fenêtre, on n'émule pas un vrai téléphone (écran tactile, user-agent,
 * pixels de densité) ; un site qui sert une page différente selon le user-agent n'est donc pas vu comme sur mobile.
 * Le contrôle ne change JAMAIS le statut du run : une erreur est notée dans le résultat et c'est tout.
 */

import { maskSecretsDeep } from "./secrets.js";
import { redactUrl } from "./page-utils.js";
import { pageKey } from "./accessibility.js";

export const MAX_RESPONSIVE_PAGES = 4;
export const MIN_TARGET_SIZE_PX = 24;
const OVERFLOW_TOLERANCE_PX = 1;
const SETTLE_AFTER_RESIZE_MS = 350;
const FALLBACK_SIZE = { width: 1280, height: 720 };

export const VIEWPORTS = [
  { name: "mobile", label: "Mobile", width: 375, height: 812 },
  { name: "tablet", label: "Tablette", width: 768, height: 1024 },
  { name: "desktop", label: "Bureau", width: 1440, height: 900 },
];

/**
 * Mesure la mise en page de la page courante. Exécutée DANS le navigateur (page.evaluate) : elle doit rester
 * autonome, sans rien utiliser de ce module. Renvoie des données brutes, interprétées par evaluateIssues.
 */
export function measureLayout() {
  const doc = document.documentElement;
  const viewportWidth = window.innerWidth;
  const scrollWidth = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);

  const describe = (el) => {
    let text = el.tagName.toLowerCase();
    if (el.id) text += `#${el.id}`;
    else if (typeof el.className === "string" && el.className.trim()) text += `.${el.className.trim().split(/\s+/)[0]}`;
    return text.slice(0, 80);
  };
  const isVisible = (el, rect) => {
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  };

  // Éléments qui dépassent : seulement si la page défile vraiment, et seulement le PREMIER élément fautif
  // (dont le parent tient dans l'écran), pas toute sa descendance.
  const overflowing = [];
  if (scrollWidth - viewportWidth > 1 && document.body) {
    const all = document.body.querySelectorAll("*");
    for (let i = 0; i < all.length && i < 4000 && overflowing.length < 5; i++) {
      const el = all[i];
      const rect = el.getBoundingClientRect();
      if (rect.right <= viewportWidth + 1 || !isVisible(el, rect)) continue;
      const parent = el.parentElement;
      const parentRect = parent ? parent.getBoundingClientRect() : null;
      if (parentRect && parent !== document.body && parentRect.right > viewportWidth + 1) continue;
      overflowing.push({ target: describe(el), right: Math.round(rect.right), width: Math.round(rect.width) });
    }
  }

  // Cibles tactiles : éléments interactifs visibles ; les liens « dans une phrase » (display: inline) sont exemptés.
  const interactive = document.querySelectorAll(
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]'
  );
  let interactiveCount = 0;
  let smallCount = 0;
  const smallExamples = [];
  for (const el of interactive) {
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;
    if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue;
    interactiveCount += 1;
    if (Math.min(rect.width, rect.height) < 24) {
      smallCount += 1;
      if (smallExamples.length < 5) {
        smallExamples.push({ target: describe(el), width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    }
  }

  return {
    viewportWidth,
    scrollWidth,
    hasViewportMeta: Boolean(document.querySelector('meta[name="viewport"]')),
    overflowing,
    interactiveCount,
    smallTargets: { count: smallCount, examples: smallExamples },
  };
}

/** Mesure brute -> liste de problèmes pour une taille d'écran (pure, testée sans navigateur). */
export function evaluateIssues(measure, viewport) {
  const issues = [];
  if (!measure) return issues;
  const isTouch = viewport.name === "mobile" || viewport.name === "tablet";

  const overflowBy = (measure.scrollWidth ?? 0) - (measure.viewportWidth ?? viewport.width);
  if (overflowBy > OVERFLOW_TOLERANCE_PX) {
    issues.push({
      code: "R-OVERFLOW",
      severity: isTouch ? "high" : "medium",
      message: `La page défile horizontalement : son contenu fait ${measure.scrollWidth} px de large pour un écran de ${measure.viewportWidth ?? viewport.width} px.`,
      count: Math.max(measure.overflowing?.length ?? 0, 1),
      examples: (measure.overflowing ?? []).map((item) => `${item.target} (dépasse jusqu'à ${item.right} px)`),
    });
  }

  if (viewport.name === "mobile" && measure.hasViewportMeta === false) {
    issues.push({
      code: "R-NO-VIEWPORT-META",
      severity: "high",
      message:
        "Pas de balise <meta name=\"viewport\"> : sur un vrai téléphone, la page s'afficherait en version bureau réduite.",
      count: 1,
      examples: [],
    });
  }

  const small = measure.smallTargets?.count ?? 0;
  if (isTouch && small > 0) {
    issues.push({
      code: "R-SMALL-TARGET",
      severity: small >= 5 ? "medium" : "low",
      message: `${small} élément${small > 1 ? "s" : ""} interactif${small > 1 ? "s" : ""} fait${small > 1 ? "ent" : ""} moins de ${MIN_TARGET_SIZE_PX} x ${MIN_TARGET_SIZE_PX} px : difficile${small > 1 ? "s" : ""} à toucher au doigt (WCAG 2.2, critère 2.5.8).`,
      count: small,
      examples: (measure.smallTargets.examples ?? []).map((item) => `${item.target} (${item.width} x ${item.height} px)`),
    });
  }
  return issues;
}

/** Bilan de tout le run. */
export function summarizeResponsive(pages) {
  const totals = { pages: pages.length, issues: 0, high: 0, medium: 0, low: 0, viewportsWithIssues: 0, viewportsChecked: 0 };
  for (const page of pages) {
    for (const viewport of page.viewports) {
      if (viewport.error) continue;
      totals.viewportsChecked += 1;
      if (viewport.issues.length > 0) totals.viewportsWithIssues += 1;
      for (const issue of viewport.issues) {
        totals.issues += 1;
        totals[issue.severity] += 1;
      }
    }
  }
  return { status: "done", pages, totals };
}

const defaultSettle = (page) => page.waitForTimeout(SETTLE_AFTER_RESIZE_MS);
const measurePage = (page) => page.evaluate(measureLayout);

/**
 * Suivi du contrôle pendant un scénario : `afterStep(page)` est appelé après chaque étape ; il contrôle la page
 * courante si c'est une nouvelle adresse. Ne lève jamais d'erreur.
 */
export function createResponsiveRecorder({
  runId = Date.now(),
  screenshotDir = "run-screenshots",
  viewports = VIEWPORTS,
  maxPages = MAX_RESPONSIVE_PAGES,
  measure = measurePage,
  settle = defaultSettle,
} = {}) {
  const pages = [];
  const seen = new Set();
  let error = null;

  return {
    async afterStep(page) {
      if (error || pages.length >= maxPages) return;
      let key = null;
      try {
        key = pageKey(page.url());
      } catch {
        return;
      }
      if (!key || seen.has(key)) return;
      seen.add(key);

      const pageIndex = pages.length;
      let originalSize = FALLBACK_SIZE;
      try {
        originalSize = page.viewportSize() ?? FALLBACK_SIZE;
      } catch {
        // Taille inconnue : on rétablira la taille par défaut de Playwright.
      }

      const entry = { url: redactUrl(page.url()), title: "", viewports: [] };
      try {
        entry.title = String(await page.title()).replace(/\s+/g, " ").trim().slice(0, 120);
      } catch {
        // Un titre illisible n'empêche pas le contrôle.
      }

      try {
        for (const viewport of viewports) {
          const result = { name: viewport.name, label: viewport.label, width: viewport.width, height: viewport.height, issues: [] };
          try {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await settle(page);
            const measured = await measure(page);
            result.scrollWidth = measured?.scrollWidth ?? null;
            result.issues = evaluateIssues(measured, viewport);
            const screenshotPath = `${screenshotDir}/${runId}-responsive-p${pageIndex}-${viewport.name}.png`;
            try {
              await page.screenshot({ path: screenshotPath, animations: "disabled", caret: "hide" });
              result.screenshot = screenshotPath;
            } catch {
              // Pas de capture : le contrôle reste valable.
            }
          } catch (err) {
            result.error = String(err?.message ?? err).split("\n")[0].slice(0, 200);
            // Page fermée ou plantée : inutile d'insister sur les tailles suivantes.
            if (/closed|crash|Target/i.test(result.error)) {
              entry.viewports.push(result);
              throw err;
            }
          }
          entry.viewports.push(result);
        }
      } catch (err) {
        error = String(err?.message ?? err).split("\n")[0].slice(0, 200);
      } finally {
        try {
          await page.setViewportSize(originalSize);
        } catch {
          // Page déjà fermée : rien à rétablir.
        }
      }
      if (entry.viewports.length > 0) pages.push(entry);
    },
    /** Résultat à stocker dans le run. */
    result() {
      const usable = pages.filter((page) => page.viewports.some((viewport) => !viewport.error));
      if (usable.length === 0 && error) return maskSecretsDeep({ status: "error", error });
      if (usable.length === 0) return { status: "empty", pages: [], totals: summarizeResponsive([]).totals };
      return maskSecretsDeep({ ...summarizeResponsive(usable), ...(error ? { partialError: error } : {}) });
    },
  };
}
