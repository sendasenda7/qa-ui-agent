/**
 * Contrôle des liens cassés pendant le scénario : chaque NOUVELLE page rencontrée est lue dans le navigateur
 * (liens, ancres, images), puis les liens sont vérifiés par le serveur avec de simples requêtes HTTP.
 *
 * Ce qui est signalé :
 *   - lien cassé       : 404 / 410, erreur serveur (5xx), site injoignable ou délai dépassé ;
 *   - ancre cassée     : un lien `#section` dont aucun élément de la page n'a cet identifiant ;
 *   - image cassée     : une image qui n'a pas pu se charger.
 * Ce qui est compté à part, sans être « cassé » : les liens protégés (401, 403, 429), qu'un visiteur non connecté ne
 * peut pas juger, et les liens non vérifiés (adresse locale ou hôte non autorisé, trop de liens, délai global).
 *
 * Sécurité (le serveur fait des requêtes vers des adresses lues dans une page) :
 *   - chaque adresse, et chaque étape d'une redirection, passe par assertSafeTargetUrl : une page ne peut pas faire
 *     contacter localhost, un réseau privé ou une adresse de métadonnées cloud (ni via une redirection) ;
 *   - requêtes SANS cookies ni session : un lien « Déconnexion » ou « Supprimer » ne peut rien déclencher ;
 *   - HEAD d'abord, puis GET limité à 1 octet si le serveur refuse HEAD ; aucun contenu n'est conservé.
 *
 * Le contrôle ne change JAMAIS le statut du run. Les vérifications réseau tournent en arrière-plan pendant le
 * scénario : `finish()` les attend à la fin.
 */

import { maskSecretsDeep } from "./secrets.js";
import { redactUrl, waitForRendered } from "./page-utils.js";
import { pageKey } from "./accessibility.js";
import { assertSafeTargetUrl } from "./url-guard.js";

export const MAX_LINK_PAGES = 4;
export const MAX_LINKS_PER_PAGE = 40;
export const LINK_TIMEOUT_MS = 6000;
export const LINK_PAGE_DEADLINE_MS = 30000;
export const LINK_CONCURRENCY = 6;
const MAX_REDIRECTS = 5;
const MAX_LISTED = 15;
const USER_AGENT = "qa-ui-agent-link-check/1.0";

/**
 * Lit les liens, ancres et images de la page courante. Exécutée DANS le navigateur (page.evaluate) : doit rester autonome.
 */
export function collectLinks() {
  const anchors = [...document.querySelectorAll("a[href]")];
  const links = [];
  const seen = new Set();
  const brokenAnchors = [];
  const labelOf = (a) => (a.textContent || a.getAttribute("aria-label") || a.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 60);

  for (const a of anchors) {
    const raw = (a.getAttribute("href") || "").trim();
    if (!raw) continue;
    if (raw.startsWith("#")) {
      let id = raw.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // Identifiant mal encodé : on le prend tel quel.
      }
      if (id && id.toLowerCase() !== "top" && !document.getElementById(id) && document.getElementsByName(id).length === 0) {
        if (brokenAnchors.length < 15) brokenAnchors.push({ href: raw, text: labelOf(a) });
      }
      continue;
    }
    if (/^(mailto:|tel:|javascript:|sms:|data:|blob:)/i.test(raw)) continue;
    let absolute;
    try {
      absolute = new URL(raw, document.baseURI);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(absolute.protocol)) continue;
    absolute.hash = "";
    const href = absolute.href;
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: labelOf(a), external: absolute.origin !== location.origin });
    if (links.length >= 300) break;
  }

  const brokenImages = [...document.images]
    .filter((img) => {
      const src = img.currentSrc || img.src;
      return img.complete && img.naturalWidth === 0 && src && !src.startsWith("data:") && !/\.svg(\?|$)/i.test(src);
    })
    .slice(0, 15)
    .map((img) => ({ src: (img.currentSrc || img.src).slice(0, 200), alt: (img.getAttribute("alt") || "").slice(0, 60) }));

  return { totalAnchors: anchors.length, links, brokenAnchors, brokenImages };
}

/** Code HTTP -> "ok" | "restricted" | "broken". */
export function classifyStatus(status) {
  if (status >= 200 && status < 400) return "ok";
  if (status === 401 || status === 403 || status === 429) return "restricted";
  return "broken";
}

function describeFetchError(err, timeoutMs) {
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return `délai dépassé (${Math.round(timeoutMs / 1000)} s)`;
  const code = err?.cause?.code ?? err?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "nom de domaine introuvable";
  if (code === "ECONNREFUSED") return "connexion refusée";
  if (code === "ECONNRESET") return "connexion coupée";
  if (/CERT|SSL|TLS/i.test(String(code))) return "certificat HTTPS invalide";
  return "site injoignable";
}

/**
 * Vérifie un lien. Renvoie { href, outcome, status?, detail? } avec outcome = "ok" | "restricted" | "broken" | "unchecked".
 * Ne lève jamais d'erreur.
 */
export async function checkOneLink(href, { fetchImpl = fetch, assertSafe = assertSafeTargetUrl, timeoutMs = LINK_TIMEOUT_MS, env = process.env } = {}) {
  let current = href;
  const request = async (url, method) => {
    const headers = { "user-agent": USER_AGENT, accept: "*/*" };
    if (method === "GET") headers.range = "bytes=0-0";
    const response = await fetchImpl(url, { method, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    try {
      await response.body?.cancel();
    } catch {
      // Corps déjà fermé : rien à libérer.
    }
    return response;
  };

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      try {
        await assertSafe(current, { env });
      } catch (err) {
        return { href, outcome: "unchecked", detail: String(err?.message ?? "adresse refusée").slice(0, 120) };
      }

      let response = null;
      let requestError = null;
      try {
        response = await request(current, "HEAD");
      } catch (err) {
        requestError = err;
      }
      // Beaucoup de serveurs refusent HEAD : on confirme avec un GET d'1 octet avant de conclure.
      if (!response || response.status >= 400) {
        try {
          response = await request(current, "GET");
          requestError = null;
        } catch (err) {
          requestError = requestError ?? err;
          response = null;
        }
      }
      if (!response) return { href, outcome: "broken", detail: describeFetchError(requestError, timeoutMs) };

      const location = response.headers?.get?.("location");
      if (response.status >= 300 && response.status < 400 && location) {
        try {
          current = new URL(location, current).href;
        } catch {
          return { href, outcome: "broken", status: response.status, detail: "redirection invalide" };
        }
        continue;
      }
      const outcome = classifyStatus(response.status);
      return { href, outcome, status: response.status, ...(hop > 0 ? { redirected: true } : {}) };
    }
    return { href, outcome: "broken", detail: `trop de redirections (plus de ${MAX_REDIRECTS})` };
  } catch (err) {
    return { href, outcome: "broken", detail: describeFetchError(err, timeoutMs) };
  }
}

/** Vérifie une liste de liens (concurrence limitée, délai global). Renvoie les résultats dans l'ordre. */
export async function checkLinks(links, { check = checkOneLink, concurrency = LINK_CONCURRENCY, deadlineMs = LINK_PAGE_DEADLINE_MS, now = Date.now, ...options } = {}) {
  const results = new Array(links.length);
  const startedAt = now();
  let next = 0;
  async function worker() {
    while (next < links.length) {
      const index = next;
      next += 1;
      if (now() - startedAt > deadlineMs) {
        results[index] = { href: links[index].href, outcome: "unchecked", detail: "délai global dépassé" };
        continue;
      }
      results[index] = await check(links[index].href, options);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, links.length) }, worker));
  return results;
}

/** Page lue + résultats des vérifications -> résumé stocké dans le run (pur, testé sans réseau). */
export function summarizeLinks({ url, title, collected, results, skipped = 0 }) {
  const byHref = new Map(collected.links.map((link) => [link.href, link]));
  const entry = (result) => {
    const link = byHref.get(result.href);
    return {
      href: redactUrl(result.href),
      text: link?.text ?? "",
      external: Boolean(link?.external),
      ...(result.status ? { status: result.status } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.redirected ? { redirected: true } : {}),
    };
  };
  const pick = (outcome) => results.filter((result) => result.outcome === outcome);
  const broken = pick("broken");
  const restricted = pick("restricted");
  const unchecked = pick("unchecked");

  return {
    url: redactUrl(url ?? ""),
    title: String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    total: collected.links.length,
    checked: results.length - unchecked.length,
    skipped,
    broken: broken.slice(0, MAX_LISTED).map(entry),
    brokenCount: broken.length,
    restricted: restricted.slice(0, MAX_LISTED).map(entry),
    restrictedCount: restricted.length,
    uncheckedCount: unchecked.length,
    uncheckedReasons: [...new Set(unchecked.map((result) => result.detail).filter(Boolean))].slice(0, 3),
    brokenAnchors: collected.brokenAnchors.map((anchor) => ({ href: anchor.href, text: anchor.text })),
    brokenImages: collected.brokenImages.map((image) => ({ src: redactUrl(image.src), alt: image.alt })),
  };
}

export function summarizeLinksRun(pages) {
  const totals = { pages: pages.length, checked: 0, broken: 0, restricted: 0, unchecked: 0, brokenAnchors: 0, brokenImages: 0, issues: 0 };
  for (const page of pages) {
    totals.checked += page.checked;
    totals.broken += page.brokenCount;
    totals.restricted += page.restrictedCount;
    totals.unchecked += page.uncheckedCount + page.skipped;
    totals.brokenAnchors += page.brokenAnchors.length;
    totals.brokenImages += page.brokenImages.length;
  }
  totals.issues = totals.broken + totals.brokenAnchors + totals.brokenImages;
  return { status: "done", pages, totals };
}

/**
 * Suivi pendant un scénario : `afterStep(page)` lit les liens de la page courante (si nouvelle adresse) et lance leur
 * vérification en arrière-plan ; `finish()` attend tout et renvoie le résultat. Ne lève jamais d'erreur.
 */
export function createLinksRecorder({
  collect = (page) => page.evaluate(collectLinks),
  check = checkLinks,
  settle = waitForRendered,
  maxPages = MAX_LINK_PAGES,
  maxLinks = MAX_LINKS_PER_PAGE,
  checkOptions = {},
} = {}) {
  const jobs = [];
  const seen = new Set();
  let error = null;

  return {
    async afterStep(page) {
      if (error || jobs.length >= maxPages) return;
      let key = null;
      let url = null;
      try {
        url = page.url();
        key = pageKey(url);
      } catch {
        return;
      }
      if (!key || seen.has(key)) return;
      seen.add(key);
      try {
        await settle(page, 3000);
        const collected = await collect(page);
        const title = await page.title().catch(() => "");
        // Les liens du même site d'abord : ce sont ceux que l'équipe peut corriger.
        const ordered = [...collected.links].sort((a, b) => Number(a.external) - Number(b.external));
        const toCheck = ordered.slice(0, maxLinks);
        jobs.push(
          check(toCheck, checkOptions)
            .then((results) => summarizeLinks({ url, title, collected: { ...collected, links: toCheck }, results, skipped: ordered.length - toCheck.length }))
            .catch((err) => {
              error = String(err?.message ?? err).split("\n")[0].slice(0, 200);
              return null;
            })
        );
      } catch (err) {
        error = String(err?.message ?? err).split("\n")[0].slice(0, 200);
      }
    },
    async finish() {
      const pages = (await Promise.all(jobs)).filter(Boolean);
      if (pages.length === 0 && error) return { status: "error", error };
      if (pages.length === 0) return { status: "empty", pages: [], totals: summarizeLinksRun([]).totals };
      return maskSecretsDeep({ ...summarizeLinksRun(pages), ...(error ? { partialError: error } : {}) });
    },
  };
}
