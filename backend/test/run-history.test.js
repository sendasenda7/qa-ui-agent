import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHistory, computeTrend, isGettingSlower, normalizeTicketKey, failureLabel } from "../src/run-history.js";

let nextId = 1000;
const run = (status, extra = {}) => ({
  runId: (nextId += 1),
  url: "https://x.test/login",
  ticketText: "Se connecter",
  ticketSummary: "Se connecter",
  browserEngine: "chromium",
  status,
  durationMs: 10000,
  stepsPassed: status === "passed" ? 4 : 2,
  stepsTotal: 4,
  flakySteps: 0,
  confidence: 85,
  failureCode: status === "passed" ? null : "E-ELM-001",
  failureMessage: status === "passed" ? null : "Élément introuvable",
  ...extra,
});
const seq = (...statuses) => statuses.map((s) => run(s));

test("computeTrend : stable, régression, échec répétés, rétabli, instable, premier run", () => {
  assert.equal(computeTrend([]).code, "none");
  assert.equal(computeTrend(seq("passed")).code, "new_ok");
  assert.equal(computeTrend(seq("failed")).code, "new_ko");
  assert.equal(computeTrend(seq("passed", "passed", "passed")).code, "stable");
  assert.equal(computeTrend(seq("passed", "passed", "failed")).code, "regression");
  assert.equal(computeTrend(seq("passed", "failed", "failed")).code, "failing");
  assert.equal(computeTrend(seq("failed", "failed", "passed")).code, "recovered");
  assert.equal(computeTrend(seq("passed", "failed", "passed", "failed", "passed")).code, "unstable");
  // un dernier run réussi mais seulement après une relance d'étape = instable
  const flakyLast = [run("passed"), run("passed", { flakySteps: 1 })];
  assert.equal(computeTrend(flakyLast).code, "unstable");
  // une erreur de pipeline (site injoignable) compte comme un échec
  assert.equal(computeTrend(seq("passed", "error")).code, "regression");
});

test("isGettingSlower : seulement si les 3 derniers runs durent 30 % de plus que les 3 d'avant", () => {
  assert.equal(isGettingSlower([10, 10, 10]), false, "pas assez de runs");
  assert.equal(isGettingSlower([10000, 10000, 10000, 20000, 21000, 19000]), true);
  assert.equal(isGettingSlower([10000, 10000, 10000, 11000, 10500, 10200]), false);
  assert.equal(isGettingSlower([null, null, 5, 5, 5, 5]), false);
});

test("normalizeTicketKey ignore les espaces et la casse", () => {
  assert.equal(normalizeTicketKey("  Se   Connecter\n"), normalizeTicketKey("se connecter"));
});

test("failureLabel : code stable -> libellé lisible", () => {
  assert.equal(failureLabel("E-ELM-001"), "Élément introuvable");
  assert.equal(failureLabel("E-NAV-001"), "Erreur de navigation");
  assert.equal(failureLabel("E-XXX-999"), null);
  assert.equal(failureLabel(null), null);
});

test("buildHistory : chiffres globaux, runs en cours ignorés, taux de réussite", () => {
  const history = buildHistory([...seq("passed", "passed", "failed"), run("running"), run("error", { failureCode: "E-NAV-001" })]);
  assert.equal(history.overall.total, 4);
  assert.equal(history.overall.passed, 2);
  assert.equal(history.overall.failed, 1);
  assert.equal(history.overall.errored, 1);
  assert.equal(history.overall.passRate, 50);
  assert.equal(history.overall.avgDurationMs, 10000);
  assert.equal(history.recent.length, 4);
  assert.deepEqual(buildHistory([]).overall.passRate, null);
  assert.deepEqual(buildHistory(undefined).tickets, []);
});

test("buildHistory : un groupe par ticket + URL + navigateur ; espaces et casse ignorés", () => {
  const history = buildHistory([
    run("passed"),
    run("passed", { ticketText: "  se  CONNECTER " }),
    run("passed", { url: "https://x.test/autre" }),
    run("passed", { browserEngine: "firefox" }),
  ]);
  assert.equal(history.tickets.length, 3);
  const main = history.tickets.find((t) => t.total === 2);
  assert.ok(main, "les deux écritures du même ticket sont regroupées");
});

test("buildHistory : les tests qui cassent passent en premier, avec leurs derniers runs", () => {
  const healthy = Array.from({ length: 3 }, () => run("passed", { ticketText: "ticket sain", ticketSummary: "Sain" }));
  const broken = [run("passed", { ticketText: "ticket cassé", ticketSummary: "Cassé" }), run("failed", { ticketText: "ticket cassé", ticketSummary: "Cassé" })];
  const history = buildHistory([...healthy, ...broken]);
  assert.equal(history.tickets[0].ticketSummary, "Cassé");
  assert.equal(history.tickets[0].trend.code, "regression");
  assert.equal(history.tickets[0].lastFailureCode, "E-ELM-001");
  assert.equal(history.tickets[0].passRate, 50);
  assert.equal(history.tickets[1].trend.code, "stable");
  assert.equal(history.tickets[1].runs.length, 3);
});

test("buildHistory : jamais plus de 20 runs par ticket, les plus récents", () => {
  const many = Array.from({ length: 25 }, () => run("passed"));
  const [ticket] = buildHistory(many).tickets;
  assert.equal(ticket.total, 25);
  assert.equal(ticket.runs.length, 20);
  assert.equal(ticket.runs[19].runId, many[24].runId);
});

test("buildHistory : erreurs les plus fréquentes, avec libellé", () => {
  const history = buildHistory([
    run("failed"),
    run("failed"),
    run("failed", { failureCode: "E-URL-001", failureMessage: "Adresse différente" }),
    run("error", { failureCode: null }),
    run("passed"),
  ]);
  assert.equal(history.topErrors[0].code, "E-ELM-001");
  assert.equal(history.topErrors[0].count, 2);
  assert.equal(history.topErrors[0].label, "Élément introuvable");
  assert.equal(history.topErrors.length, 2, "un échec sans code n'est pas compté");
});
