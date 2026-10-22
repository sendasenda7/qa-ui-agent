import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// L'auth lit process.env au moment des requêtes : on le fixe avant tout.
process.env.AUTH_PASSWORD = "mot-de-passe-de-test";
process.env.JWT_SECRET = "x".repeat(48);

const { createApp, publicErrorMessage } = await import("../src/app.js");
const { resetLoginAttempts } = await import("../src/auth.js");
const { reserveRunSlot, getActiveRunCount } = await import("../src/run-executor.js");
const { saveRun } = await import("../src/run-store.js");

let server, base, workDir, token;
const originalCwd = process.cwd();

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "app-test-"));
  process.chdir(workDir);
  server = createApp({ env: {} }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/login`, json({ password: "mot-de-passe-de-test" }));
  token = (await res.json()).token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

const json = (body, extra = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...extra.headers },
  body: JSON.stringify(body),
});
const authed = (method = "GET", body) => ({
  method,
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("login : mauvais mot de passe 401, puis blocage 429 avec Retry-After après 5 échecs", async () => {
  resetLoginAttempts();
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/api/login`, json({ password: "faux" }));
    assert.equal(res.status, 401);
  }
  const blocked = await fetch(`${base}/api/login`, json({ password: "mot-de-passe-de-test" }));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  resetLoginAttempts();
});

test("l'API exige un token ; ?token= n'est PAS accepté sur /api (seulement sur les fichiers)", async () => {
  assert.equal((await fetch(`${base}/api/runs`)).status, 401);
  assert.equal((await fetch(`${base}/api/runs?token=${token}`)).status, 401);
  assert.equal((await fetch(`${base}/api/runs`, authed())).status, 200);

  // Fichiers statiques : le token en URL est accepté (balise <img>) → 404 (absent), pas 401.
  assert.equal((await fetch(`${base}/screenshots/x.png?token=${token}`)).status, 404);
  assert.equal((await fetch(`${base}/screenshots/x.png`)).status, 401);
});

test("SSRF : toutes les routes qui ouvrent une URL refusent file://, localhost et IP privées", async () => {
  const badUrls = ["file:///etc/passwd", "http://localhost:4000/", "http://169.254.169.254/", "http://[::ffff:127.0.0.1]/"];
  for (const route of ["/api/crawl", "/api/plan", "/api/check-i18n", "/api/test-run"]) {
    for (const url of badUrls) {
      const res = await fetch(`${base}${route}`, authed("POST", { url, ticketText: "t" }));
      assert.equal(res.status, 400, `${route} ${url}`);
    }
  }
});

test("replay d'un run inexistant : 404 (et non 500)", async () => {
  const res = await fetch(`${base}/api/runs/123/replay`, authed("POST"));
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /introuvable/i);
});

test("notes : 404 si le run n'existe pas, sinon enregistrées et relues", async () => {
  assert.equal((await fetch(`${base}/api/runs/42/notes`, authed("PATCH", { notes: "x" }))).status, 404);

  await saveRun(42, { runResult: { runId: 42, status: "passed" } });
  const ok = await fetch(`${base}/api/runs/42/notes`, authed("PATCH", { notes: "à revoir" }));
  assert.equal(ok.status, 200);
  const read = await (await fetch(`${base}/api/runs/42`, authed())).json();
  assert.equal(read.notes, "à revoir");

  assert.equal((await fetch(`${base}/api/runs/42/notes`, authed("PATCH", { notes: 5 }))).status, 400);
});

test("JSON malformé : 400 en JSON, sans stack trace ni HTML", async () => {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{pas du json",
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.doesNotMatch(JSON.stringify(body), /at .*\.js/);
});

test("en-têtes de sécurité et CORS limité au frontend", async () => {
  const res = await fetch(`${base}/api/health`, { headers: { Origin: "http://localhost:5173" } });
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-powered-by"), null);

  const evil = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
});

test("route /api inconnue : 404 JSON", async () => {
  const res = await fetch(`${base}/api/nimporte-quoi`, authed());
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});

test("publicErrorMessage : première ligne seulement, sans chemins ni clés", () => {
  const err = new Error(
    "ENOENT: no such file '/home/claude/qa-ui-agent/backend/runs/1.json' avec gsk_AbC123xyz\nCall log:\n  - interne"
  );
  const message = publicErrorMessage(err);
  assert.doesNotMatch(message, /home\/claude|gsk_|Call log/);
  assert.match(message, /\[chemin masqué\]/);
});

test("limite de runs : la réservation est synchrone, 3 demandes simultanées ne passent pas", () => {
  const reservations = [reserveRunSlot(2), reserveRunSlot(2), reserveRunSlot(2)];
  assert.equal(reservations.filter(Boolean).length, 2);
  assert.equal(getActiveRunCount(), 2);
  reservations[0].release();
  reservations[0].release(); // double appel sans effet
  assert.equal(getActiveRunCount(), 1);
  const again = reserveRunSlot(2);
  assert.ok(again, "une place s'est libérée");
  again.release();
  reservations[1].release();
  assert.equal(getActiveRunCount(), 0);
});

test("browserEngine inconnu : 400 sur toutes les routes qui lancent un navigateur", async () => {
  for (const route of ["/api/crawl", "/api/plan", "/api/check-i18n", "/api/test-run"]) {
    const res = await fetch(
      `${base}${route}`,
      authed("POST", { url: "https://exemple.test/", ticketText: "t", browserEngine: "netscape" })
    );
    assert.equal(res.status, 400, route);
    assert.match((await res.json()).error, /browserEngine invalide.*chromium, firefox, webkit/);
  }
});

const exportableRun = (runId, status = "failed") => ({
  ticketText: "Vérifier le message",
  scenario: {
    ticketSummary: "Vérifier le message",
    confidence: 85,
    warnings: [],
    steps: [{ type: "navigate", description: "Ouvrir la page" }, { type: "assert_text", selector: "#m", description: "Texte" }],
  },
  runResult: {
    runId,
    url: "https://exemple.test/",
    browserEngine: "chromium",
    status,
    startedAt: new Date(Number(runId)).toISOString(),
    finishedAt: status === "running" ? null : new Date(Number(runId) + 5000).toISOString(),
    results: [
      { index: 0, type: "navigate", description: "Ouvrir la page", status: "passed", attempts: 1, durationMs: 1000 },
      { index: 1, type: "assert_text", selector: "#m", description: "Texte", status: "failed", attempts: 2, durationMs: 4000, error: "Texte attendu introuvable", failure: { code: "E-ELM-001", label: "Élément introuvable" } },
    ],
  },
});

test("export : JUnit XML par défaut, en téléchargement, avec le code stable de l'échec", async () => {
  await saveRun("7001", exportableRun("7001"));

  const res = await fetch(`${base}/api/runs/7001/export`, authed());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/xml/);
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="qa-ui-agent-run-7001.xml"');

  const xml = await res.text();
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<testsuites [^>]*tests="2" failures="1"/);
  assert.match(xml, /<failure message="Texte attendu introuvable" type="E-ELM-001">/);

  const explicit = await fetch(`${base}/api/runs/7001/export?format=junit`, authed());
  assert.equal(await explicit.text(), xml);
});

test("export : format JSON, valide et versionné", async () => {
  await saveRun("7002", exportableRun("7002", "passed"));

  const res = await fetch(`${base}/api/runs/7002/export?format=json`, authed());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/json/);
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="qa-ui-agent-run-7002.json"');

  const report = JSON.parse(await res.text());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.run.id, "7002");
  assert.equal(report.summary.total, 2);
});

test("export : erreurs claires (format inconnu, run inconnu, run en cours) et authentification exigée", async () => {
  await saveRun("7003", exportableRun("7003", "running"));

  assert.equal((await fetch(`${base}/api/runs/7001/export?format=pdf`, authed())).status, 400);
  // Noms qui existent sur tout objet JavaScript : ne doivent jamais être pris pour un format.
  for (const format of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal((await fetch(`${base}/api/runs/7001/export?format=${format}`, authed())).status, 400, format);
  }
  assert.equal((await fetch(`${base}/api/runs/99999/export`, authed())).status, 404);
  assert.equal((await fetch(`${base}/api/runs/abc/export`, authed())).status, 404, "runId invalide");
  assert.equal((await fetch(`${base}/api/runs/7003/export`, authed())).status, 409);

  assert.equal((await fetch(`${base}/api/runs/7001/export`)).status, 401);
  assert.equal((await fetch(`${base}/api/runs/7001/export?token=${token}`)).status, 401, "?token= refusé sur /api");
});

test("GET /api/history : exige un token et résume les runs enregistrés", async () => {
  assert.equal((await fetch(`${base}/api/history`)).status, 401);

  const make = (runId, status) => ({
    ticketText: "Se connecter",
    options: { browserEngine: "chromium" },
    scenario: { ticketSummary: "Se connecter", confidence: 85, warnings: [], steps: [] },
    runResult: {
      runId,
      url: "https://x.test/",
      status,
      startedAt: new Date(runId).toISOString(),
      finishedAt: new Date(runId + 12000).toISOString(),
      stepsTotal: 2,
      stepsRun: 2,
      stepsPassed: status === "passed" ? 2 : 1,
      flakySteps: 0,
      results: status === "passed" ? [] : [{ status: "failed", description: "Cliquer", error: "Élément introuvable", failure: { code: "E-ELM-001" } }],
    },
  });
  await saveRun(1700000000001, make(1700000000001, "passed"));
  await saveRun(1700000000002, make(1700000000002, "failed"));
  await saveRun(1700000000003, make(1700000000003, "running"));

  const res = await fetch(`${base}/api/history`, authed());
  assert.equal(res.status, 200);
  const history = await res.json();
  const ticket = history.tickets.find((t) => t.url === "https://x.test/");
  assert.ok(ticket, "le ticket des runs enregistrés est dans l'historique");
  assert.equal(ticket.total, 2, "le run en cours n'est pas compté");
  assert.equal(ticket.passRate, 50);
  assert.equal(ticket.avgDurationMs, 12000);
  assert.equal(ticket.trend.code, "regression");
  assert.ok(history.overall.total >= 2);
  assert.ok(history.topErrors.some((item) => item.code === "E-ELM-001"));
});
