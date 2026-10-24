import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRun } from "../src/run-executor.js";
import { readRun } from "../src/run-store.js";
import { buildJsonReport } from "../src/report-export.js";
import { classifyStatus, checkOneLink, checkLinks, summarizeLinks, summarizeLinksRun, createLinksRecorder, collectLinks } from "../src/links.js";

let workDir;
const originalCwd = process.cwd();
before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "links-test-"));
  process.chdir(workDir);
});
after(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

/** Faux fetch : `routes` associe une URL à { status, location } ou à une erreur à lever ; enregistre les appels. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, redirect: options.redirect });
    const route = routes[url] ?? { status: 404 };
    const handler = typeof route === "function" ? route(options.method) : route;
    if (handler.throws) throw handler.throws;
    return { status: handler.status, headers: { get: (name) => (name.toLowerCase() === "location" ? handler.location ?? null : null) }, body: { cancel: async () => {} } };
  };
  impl.calls = calls;
  return impl;
}
const safeEnv = { env: {} };
const allowAll = async () => {};

test("classifyStatus : 2xx/3xx ok, 401/403/429 protégés, le reste cassé", () => {
  for (const s of [200, 204, 301, 304]) assert.equal(classifyStatus(s), "ok");
  for (const s of [401, 403, 429]) assert.equal(classifyStatus(s), "restricted");
  for (const s of [404, 410, 500, 503, 400]) assert.equal(classifyStatus(s), "broken");
});

test("checkOneLink : 200 en HEAD -> ok, sans cookies, avec user-agent dédié, redirection manuelle", async () => {
  const fetchImpl = fakeFetch({ "https://x.tn/ok": { status: 200 } });
  const result = await checkOneLink("https://x.tn/ok", { fetchImpl, assertSafe: allowAll });
  assert.deepEqual(result, { href: "https://x.tn/ok", outcome: "ok", status: 200 });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].method, "HEAD");
  assert.equal(fetchImpl.calls[0].redirect, "manual");
  assert.match(fetchImpl.calls[0].headers["user-agent"], /qa-ui-agent/);
  assert.equal(fetchImpl.calls[0].headers.cookie, undefined);
});

test("checkOneLink : HEAD refusé (405) puis GET d'1 octet OK -> lien ok", async () => {
  const fetchImpl = fakeFetch({ "https://x.tn/a": (method) => (method === "HEAD" ? { status: 405 } : { status: 206 }) });
  const result = await checkOneLink("https://x.tn/a", { fetchImpl, assertSafe: allowAll });
  assert.equal(result.outcome, "ok");
  assert.deepEqual(fetchImpl.calls.map((c) => c.method), ["HEAD", "GET"]);
  assert.equal(fetchImpl.calls[1].headers.range, "bytes=0-0");
});

test("checkOneLink : 404 confirmé par GET -> cassé ; 500 -> cassé ; 403 -> protégé", async () => {
  const fetchImpl = fakeFetch({ "https://x.tn/404": { status: 404 }, "https://x.tn/500": { status: 500 }, "https://x.tn/403": { status: 403 } });
  assert.deepEqual(await checkOneLink("https://x.tn/404", { fetchImpl, assertSafe: allowAll }), { href: "https://x.tn/404", outcome: "broken", status: 404 });
  assert.equal((await checkOneLink("https://x.tn/500", { fetchImpl, assertSafe: allowAll })).outcome, "broken");
  assert.equal((await checkOneLink("https://x.tn/403", { fetchImpl, assertSafe: allowAll })).outcome, "restricted");
});

test("checkOneLink : redirection suivie puis évaluée ; boucle de redirections -> cassé", async () => {
  const fetchImpl = fakeFetch({ "https://x.tn/old": { status: 301, location: "/new" }, "https://x.tn/new": { status: 200 } });
  const moved = await checkOneLink("https://x.tn/old", { fetchImpl, assertSafe: allowAll });
  assert.equal(moved.outcome, "ok");
  assert.equal(moved.redirected, true);
  const loop = fakeFetch({ "https://x.tn/a": { status: 302, location: "/b" }, "https://x.tn/b": { status: 302, location: "/a" } });
  const looped = await checkOneLink("https://x.tn/a", { fetchImpl: loop, assertSafe: allowAll });
  assert.equal(looped.outcome, "broken");
  assert.match(looped.detail, /trop de redirections/);
});

test("checkOneLink : erreurs réseau décrites en français (domaine, refus, délai)", async () => {
  const mk = (err) => checkOneLink("https://x.tn/a", { fetchImpl: fakeFetch({ "https://x.tn/a": { throws: err } }), assertSafe: allowAll });
  assert.match((await mk(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))).detail, /introuvable/);
  assert.match((await mk(Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }))).detail, /refusée/);
  assert.match((await mk(Object.assign(new Error("x"), { name: "TimeoutError" }))).detail, /délai dépassé/);
  assert.match((await mk(new Error("inconnue"))).detail, /injoignable/);
});

test("SÉCURITÉ : une adresse locale ou privée n'est jamais contactée", async () => {
  for (const href of ["http://localhost:3000/", "http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://[::1]/"]) {
    const fetchImpl = fakeFetch({});
    const result = await checkOneLink(href, { fetchImpl, env: {} });
    assert.equal(result.outcome, "unchecked", href);
    assert.equal(fetchImpl.calls.length, 0, `${href} ne doit déclencher aucune requête`);
  }
});

test("SÉCURITÉ : une redirection vers une adresse interne est refusée (pas de SSRF par redirection)", async () => {
  const fetchImpl = fakeFetch({ "https://x.tn/piege": { status: 302, location: "http://169.254.169.254/latest/meta-data/" } });
  const result = await checkOneLink("https://x.tn/piege", { fetchImpl, assertSafe: async (url) => { if (/169\.254/.test(url)) throw new Error("adresse locale ou privée refusée"); } });
  assert.equal(result.outcome, "unchecked");
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), ["https://x.tn/piege"], "la cible interne n'est jamais requêtée");
});

test("SÉCURITÉ : ALLOWED_TARGET_HOSTS est respecté pour les liens externes", async () => {
  const fetchImpl = fakeFetch({});
  const result = await checkOneLink("https://autre-site.com/", { fetchImpl, env: { ALLOWED_TARGET_HOSTS: "staging.helpify.tn" } });
  assert.equal(result.outcome, "unchecked");
  assert.equal(fetchImpl.calls.length, 0);
});

test("checkLinks : concurrence limitée, ordre conservé, délai global -> non vérifiés", async () => {
  let running = 0;
  let maxRunning = 0;
  const check = async (href) => { running += 1; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 5)); running -= 1; return { href, outcome: "ok", status: 200 }; };
  const links = Array.from({ length: 12 }, (_, i) => ({ href: `https://x.tn/${i}` }));
  const results = await checkLinks(links, { check, concurrency: 3 });
  assert.deepEqual(results.map((r) => r.href), links.map((l) => l.href));
  assert.ok(maxRunning <= 3 && maxRunning >= 2);

  let t = 0;
  const late = await checkLinks(links.slice(0, 4), { check, concurrency: 1, deadlineMs: 10, now: () => (t += 8) });
  assert.ok(late.some((r) => r.outcome === "unchecked" && /délai global/.test(r.detail)));
  assert.deepEqual(await checkLinks([], { check }), []);
});

const collected = {
  totalAnchors: 5,
  links: [{ href: "https://x.tn/ok", text: "Accueil", external: false }, { href: "https://x.tn/gone", text: "Ancien tarif", external: false }, { href: "https://ext.com/p?token=SECRET123", text: "Partenaire", external: true }, { href: "https://x.tn/prive", text: "Mon compte", external: false }],
  brokenAnchors: [{ href: "#tarifs", text: "Nos tarifs" }],
  brokenImages: [{ src: "https://x.tn/img/logo.png?key=SECRET123", alt: "Logo" }],
};
const results = [
  { href: "https://x.tn/ok", outcome: "ok", status: 200 },
  { href: "https://x.tn/gone", outcome: "broken", status: 404 },
  { href: "https://ext.com/p?token=SECRET123", outcome: "broken", detail: "nom de domaine introuvable" },
  { href: "https://x.tn/prive", outcome: "restricted", status: 403 },
];

test("summarizeLinks : liens cassés, protégés, ancres, images ; secrets de l'adresse masqués", () => {
  const s = summarizeLinks({ url: "https://x.tn/page", title: " Ma  page ", collected, results, skipped: 2 });
  assert.equal(s.total, 4);
  assert.equal(s.checked, 4);
  assert.equal(s.skipped, 2);
  assert.equal(s.brokenCount, 2);
  assert.equal(s.broken[0].text, "Ancien tarif");
  assert.equal(s.broken[0].status, 404);
  assert.equal(s.broken[1].external, true);
  assert.equal(s.restrictedCount, 1);
  assert.equal(s.brokenAnchors[0].href, "#tarifs");
  assert.equal(s.brokenImages[0].alt, "Logo");
  assert.doesNotMatch(JSON.stringify(s), /SECRET123/);
});

test("summarizeLinksRun : totaux (problèmes = liens + ancres + images cassés)", () => {
  const page = summarizeLinks({ url: "https://x.tn/page", title: "P", collected, results, skipped: 2 });
  assert.deepEqual(summarizeLinksRun([page]).totals, { pages: 1, checked: 4, broken: 2, restricted: 1, unchecked: 2, brokenAnchors: 1, brokenImages: 1, issues: 4 });
});

const fakePage = (url = "https://x.tn/a") => ({ currentUrl: url, url() { return this.currentUrl; }, title: async () => "Titre" });

test("recorder : collecte, vérifie en arrière-plan, finish() attend tout ; liens internes vérifiés d'abord", async () => {
  const seenOrder = [];
  const rec = createLinksRecorder({
    settle: async () => {},
    collect: async () => ({ totalAnchors: 3, brokenAnchors: [], brokenImages: [], links: [{ href: "https://ext.com/", text: "e", external: true }, { href: "https://x.tn/1", text: "1", external: false }, { href: "https://x.tn/2", text: "2", external: false }] }),
    check: async (links) => { seenOrder.push(...links.map((l) => l.href)); return links.map((l) => ({ href: l.href, outcome: "ok", status: 200 })); },
    maxLinks: 2,
  });
  await rec.afterStep(fakePage());
  const result = await rec.finish();
  assert.deepEqual(seenOrder, ["https://x.tn/1", "https://x.tn/2"]);
  assert.equal(result.status, "done");
  assert.equal(result.pages[0].skipped, 1);
  assert.equal(result.totals.issues, 0);
});

test("recorder : même adresse (sans ?requête) une seule fois, 4 pages au plus, erreurs sans exception", async () => {
  let calls = 0;
  const rec = createLinksRecorder({ settle: async () => {}, collect: async () => { calls += 1; return { totalAnchors: 0, links: [], brokenAnchors: [], brokenImages: [] }; }, check: async () => [] });
  const page = fakePage("https://x.tn/a?x=1");
  await rec.afterStep(page);
  page.currentUrl = "https://x.tn/a?x=2";
  await rec.afterStep(page);
  assert.equal(calls, 1);
  for (let i = 0; i < 6; i++) { page.currentUrl = `https://x.tn/p${i}`; await rec.afterStep(page); }
  assert.equal((await rec.finish()).pages.length, 4);

  const failing = createLinksRecorder({ settle: async () => {}, collect: async () => { throw new Error("Target closed"); } });
  await failing.afterStep(fakePage());
  assert.equal((await failing.finish()).status, "error");
  const none = createLinksRecorder();
  await none.afterStep({ url() { throw new Error("closed"); } });
  assert.equal((await none.finish()).status, "empty");
});

test("collectLinks : fonction autonome (sérialisable pour page.evaluate)", () => {
  const source = collectLinks.toString();
  assert.match(source, /^function collectLinks/);
  assert.doesNotMatch(source, /\b(classifyStatus|checkOneLink|MAX_LINKS_PER_PAGE)\b/);
});

const plan = async () => ({ ticketSummary: "s", warnings: [], steps: [{ type: "navigate", selector: null, value: null, description: "Ouvrir", selectorValid: true }] });
const crawl = async () => ({ title: "Login", elementCount: 1, textElements: [], elements: [{ selector: "#a" }], durationMs: 1, screenshotPath: "x.png" });

test("startRun : checkLinks transmis, stocké, exporté, sans changer le statut", async () => {
  let seen = null;
  const run = async (url, scenario, options) => {
    seen = options;
    const rec = createLinksRecorder({ settle: async () => {}, collect: async () => collected, check: async () => results });
    await rec.afterStep(fakePage("https://exemple.test/"));
    return { runId: options.runId, url, status: "passed", stepsTotal: 1, stepsRun: 1, stepsPassed: 1, links: await rec.finish(),
      results: [{ index: 0, type: "navigate", description: "Ouvrir", status: "passed", screenshot: null, durationMs: 1 }] };
  };
  const { runId, done } = await startRun({ url: "https://exemple.test/", ticketText: "Vérifier les liens", checkLinks: true }, { crawl, plan, run });
  await done;
  assert.equal(seen.checkLinks, true);
  assert.equal(seen.checkPerformance, false);
  const content = await readRun(runId);
  assert.equal(content.options.checkLinks, true);
  assert.equal(content.runResult.status, "passed", "le contrôle ne change jamais le statut");
  assert.equal(content.runResult.links.totals.issues, 4);
  const json = buildJsonReport(content);
  assert.equal(json.analyses.links.totals.broken, 2);
  assert.equal(json.analyses.links.pages[0].broken[0].status, 404);
  assert.doesNotMatch(JSON.stringify(json), /SECRET123/);
});
