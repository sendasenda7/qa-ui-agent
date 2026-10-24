/**
 * Audit d'accessibilité avec axe-core, pendant le scénario.
 *
 * axe-core est le moteur de référence (WCAG 2.0 / 2.1, niveaux A et AA) : il lit la page réelle dans
 * le navigateur et signale par exemple un contraste insuffisant, un champ sans étiquette, un bouton sans
 * nom ou une image sans texte alternatif. Il ne détecte qu'une partie des problèmes (environ un tiers) :
 * « aucun problème trouvé » ne veut jamais dire « accessible ».
 *
 * Règles :
 *  - chaque NOUVELLE page rencontrée (adresse sans la partie ?requête / #ancre) est auditée une fois,
 *    dans la limite de MAX_A11Y_PAGES : l'audit suit le parcours du test (connexion, puis profil...) ;
 *  - l'audit ne change JAMAIS le statut du run ; une erreur d'audit est notée dans le résultat et c'est tout ;
 *  - aucune valeur secrète ne sort : le résultat passe par maskSecretsDeep.
 */

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { maskSecretsDeep } from "./secrets.js";
import { redactUrl, waitForRendered } from "./page-utils.js";

const require = createRequire(import.meta.url);

export const MAX_A11Y_PAGES = 4;
export const AUDIT_TIMEOUT_MS = 15000;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const IMPACTS = ["critical", "serious", "moderate", "minor"];
const MAX_NODES_PER_RULE = 5;
const MAX_HTML_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 300;

let axeCache = null;

/** Code d'axe-core (lu une seule fois) et sa traduction française. */
export async function loadAxe() {
  if (axeCache) return axeCache;
  const source = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
  let locale = null;
  try {
    locale = JSON.parse(await readFile(require.resolve("axe-core/locales/fr.json"), "utf8"));
  } catch {
    // Sans traduction, axe répond en anglais : l'audit marche quand même.
  }
  axeCache = { source, locale };
  return axeCache;
}

/** Adresse sans ?requête ni #ancre : deux « pages » identiques ne sont auditées qu'une fois. */
export function pageKey(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null; // about:blank, file:...
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return null;
  }
}

function clip(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function impactRank(impact) {
  const index = IMPACTS.indexOf(impact);
  return index === -1 ? IMPACTS.length : index;
}

/** Résultat brut d'axe -> forme compacte stockée dans le run (pure, testée sans navigateur). */
export function summarizeAudit({ url, title, violations = [], incomplete = [] }) {
  const rules = (Array.isArray(violations) ? violations : [])
    .map((rule) => {
      const nodes = Array.isArray(rule.nodes) ? rule.nodes : [];
      return {
        id: rule.id,
        impact: IMPACTS.includes(rule.impact) ? rule.impact : "minor",
        help: clip(rule.help, 200),
        description: clip(rule.description, 300),
        helpUrl: typeof rule.helpUrl === "string" ? rule.helpUrl : null,
        // axe-core limite les éléments détaillés à 5 par règle (poids) : `totalNodes` garde le vrai nombre.
        nodesCount: Number(rule.totalNodes) || nodes.length,
        nodes: nodes.slice(0, MAX_NODES_PER_RULE).map((node) => ({
          target: Array.isArray(node.target) ? node.target.map(String).join(" ") : String(node.target ?? ""),
          html: clip(node.html, MAX_HTML_LENGTH),
          summary: clip(node.failureSummary, MAX_SUMMARY_LENGTH),
        })),
      };
    })
    .sort((a, b) => impactRank(a.impact) - impactRank(b.impact) || b.nodesCount - a.nodesCount || a.id.localeCompare(b.id));

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 };
  for (const rule of rules) {
    counts[rule.impact] += 1;
    counts.total += 1;
  }
  return {
    url: redactUrl(url ?? ""),
    title: clip(title, 120),
    counts,
    violations: rules,
    // « À vérifier à la main » : axe n'a pas pu conclure (ex. contraste sur une image de fond).
    needsReview: Array.isArray(incomplete) ? incomplete.length : 0,
  };
}

/** Bilan de tout le run : total par gravité sur toutes les pages auditées. */
export function summarizeAccessibility(pages) {
  const totals = { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 };
  for (const page of pages) {
    for (const key of Object.keys(totals)) totals[key] += page.counts?.[key] ?? 0;
  }
  return { status: "done", pages, totals };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`audit trop long (plus de ${Math.round(ms / 1000)} s)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Exécute axe dans la page et renvoie le résultat résumé. Lève une erreur si l'audit est impossible. */
export async function auditPage(page, { loadAxeSource = loadAxe, timeoutMs = AUDIT_TIMEOUT_MS } = {}) {
  const { source, locale } = await loadAxeSource();
  const raw = await withTimeout(
    (async () => {
      // page.evaluate passe par le protocole du navigateur : la politique de sécurité (CSP) du site n'y change rien.
      await page.evaluate(source);
      return page.evaluate(
        async ({ locale: translation, tags }) => {
          if (translation) window.axe.configure({ locale: translation });
          const result = await window.axe.run(document, {
            runOnly: { type: "tag", values: tags },
            resultTypes: ["violations", "incomplete"],
          });
          const lean = (rule) => ({
            id: rule.id,
            impact: rule.impact,
            help: rule.help,
            description: rule.description,
            helpUrl: rule.helpUrl,
            nodes: rule.nodes.slice(0, 5).map((n) => ({ target: n.target, html: n.html, failureSummary: n.failureSummary })),
            totalNodes: rule.nodes.length,
          });
          return {
            url: location.href,
            title: document.title,
            violations: result.violations.map(lean),
            incomplete: result.incomplete.map((rule) => rule.id),
          };
        },
        { locale, tags: AXE_TAGS }
      );
    })(),
    timeoutMs
  );
  return maskSecretsDeep(summarizeAudit(raw));
}

/**
 * Suivi de l'audit pendant un scénario : `afterStep(page)` est appelé après chaque étape ; il audite la
 * page courante si c'est une nouvelle adresse. Ne lève jamais d'erreur.
 */
export function createAccessibilityRecorder({ audit = auditPage, settle = waitForRendered, maxPages = MAX_A11Y_PAGES } = {}) {
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
      try {
        await settle(page, 3000);
        pages.push(await audit(page));
      } catch (err) {
        // Un audit impossible (page fermée, délai...) n'arrête pas les suivants sauf si c'est axe lui-même qui plante.
        error = String(err?.message ?? err).split("\n")[0].slice(0, 200);
      }
    },
    /** Résultat à stocker dans le run, ou null si rien n'a été audité ni signalé. */
    result() {
      if (pages.length === 0 && error) return { status: "error", error };
      if (pages.length === 0) return { status: "empty", pages: [], totals: summarizeAccessibility([]).totals };
      return { ...summarizeAccessibility(pages), ...(error ? { partialError: error } : {}) };
    },
  };
}
