import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJsonReport,
  buildJunitXml,
  escapeXml,
  isFailedRun,
  EXPORT_FORMATS,
  REPORT_SCHEMA_VERSION,
} from "../src/report-export.js";

/** Vérification minimale de « bonne formation » XML : balises ouvertes/fermées dans le bon ordre. */
function assertWellFormed(xml) {
  const body = xml.replace(/<\?xml[^>]*\?>/, "");
  const stack = [];
  for (const [, closing, name, , selfClosing] of body.matchAll(/<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g)) {
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), name, `balise </${name}> inattendue`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], "balises non fermées");
  // Aucun '<' ou '&' brut dans le texte ni dans les attributs en dehors des balises et entités.
  assert.equal(/&(?!(amp|lt|gt|quot|#\d+);)/.test(body), false, "& non échappé");
  assert.equal(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), false, "caractère de contrôle interdit");
}

const failedRun = () => ({
  ticketText: "Vérifier que le message d'erreur contient « Mot de passe incorrect »",
  scenario: {
    ticketSummary: "Vérifier le message d'erreur du login",
    confidence: 85,
    warnings: ["Un avertissement avec <balise> & \"guillemets\""],
    steps: [
      { type: "navigate", description: "Ouvrir la page de connexion" },
      { type: "fill", selector: "#username", description: "Saisir un identifiant incorrect" },
      { type: "assert_text", selector: "role=alert", description: "Vérifier le message" },
      { type: "click", selector: "#after", description: "Étape jamais exécutée" },
    ],
  },
  runResult: {
    runId: 1792405526828,
    url: "https://the-internet.herokuapp.com/login",
    browserEngine: "chromium",
    status: "failed",
    phase: "done",
    startedAt: "2026-10-19T11:25:26.828Z",
    finishedAt: "2026-10-19T11:25:44.828Z",
    results: [
      { index: 0, type: "navigate", description: "Ouvrir la page de connexion", status: "passed", attempts: 1, durationMs: 2680, screenshot: "screenshots/a.png" },
      { index: 1, type: "fill", selector: "#username", description: "Saisir un identifiant incorrect", status: "passed", attempts: 2, durationMs: 4100, firstFailure: { code: "E-ELM-002", message: "L'élément existe mais n'est pas visible" } },
      {
        index: 2,
        type: "assert_text",
        selector: "role=alert",
        description: "Vérifier le message",
        status: "failed",
        attempts: 2,
        durationMs: 13545,
        error: "Texte attendu introuvable après 13 s en 2 essais.",
        failure: {
          code: "E-ELM-001",
          label: "Élément introuvable",
          category: "ELEMENT_NOT_FOUND",
          expected: "Texte « Mot de passe incorrect » visible",
          found: "Messages affichés : « Your username is invalid! »",
          hint: "Un message est bien affiché, mais son texte diffère.",
          technical: "locator.waitFor: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('role=alert')",
        },
      },
    ],
    error: null,
    failure: null,
    rtl: { status: "error", error: "Aucun bouton de langue" },
    visualDiff: { status: "done", baselineRunId: 1, report: { regressionCount: 0, comparedStepCount: 3, maxDiffPercent: 0.1 } },
  },
});

test("escapeXml : caractères spéciaux échappés, caractères de contrôle interdits retirés", () => {
  assert.equal(escapeXml(`a & b < c > "d"`), "a &amp; b &lt; c &gt; &quot;d&quot;");
  assert.equal(escapeXml("a\u0000b\u0008c\u001Fd"), "abcd");
  assert.equal(escapeXml("ligne1\nligne2\tok"), "ligne1\nligne2\tok", "retours à la ligne et tabulation conservés");
  assert.equal(escapeXml(null), "");
});

test("JUnit : un testcase par étape, échec avec code stable, étape non exécutée ignorée", () => {
  const xml = buildJunitXml(failedRun());
  assertWellFormed(xml);

  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<testsuites name="QA-UI Agent" tests="4" failures="1" errors="0" skipped="1" time="18.000">/);
  assert.match(xml, /<testsuite name="Vérifier le message d&apos;erreur du login"|<testsuite name="Vérifier le message d'erreur du login"/);
  assert.match(xml, /id="1792405526828"/);
  assert.match(xml, /timestamp="2026-10-19T11:25:26.828Z"/);

  // Étapes réussies : classname = domaine, temps en secondes.
  assert.match(xml, /<testcase classname="the-internet.herokuapp.com" name="1\. Ouvrir la page de connexion" time="2.680"\/?>/);

  // Échec : message, code stable dans type, corps lisible.
  assert.match(xml, /<failure message="Texte attendu introuvable après 13 s en 2 essais\." type="E-ELM-001">/);
  assert.match(xml, /Code : E-ELM-001 \(Élément introuvable\)/);
  assert.match(xml, /Attendu : Texte « Mot de passe incorrect » visible/);
  assert.match(xml, /Trouvé : Messages affichés : « Your username is invalid! »/);
  assert.match(xml, /Piste : Un message est bien affiché/);
  assert.match(xml, /Détails techniques :\nlocator\.waitFor: Timeout 10000ms exceeded\./);

  // Étape jamais exécutée : skipped, avec une raison.
  assert.match(xml, /name="4\. Étape jamais exécutée" time="0.000">\s*<skipped message="Non exécutée/);
});

test("JUnit : une étape réussie à la relance reste un succès mais son instabilité est écrite", () => {
  const xml = buildJunitXml(failedRun());
  const stepTwo = xml.slice(xml.indexOf('name="2. Saisir un identifiant incorrect"'), xml.indexOf('name="3. Vérifier le message"'));
  assert.equal(/<failure|<error/.test(stepTwo), false, "l'étape instable n'est pas un échec");
  assert.match(stepTwo, /Instable : réussi au 2e essai\./);
  assert.match(stepTwo, /1er essai : E-ELM-002 L&apos;élément existe mais|1er essai : E-ELM-002 L'élément existe mais/);
  assert.match(xml, /<property name="flakySteps" value="1"\/>/);
});

test("JUnit : propriétés de la suite (url, navigateur, confiance, ticket, avertissements échappés)", () => {
  const xml = buildJunitXml(failedRun());
  assert.match(xml, /<property name="url" value="https:\/\/the-internet\.herokuapp\.com\/login"\/>/);
  assert.match(xml, /<property name="browser" value="chromium"\/>/);
  assert.match(xml, /<property name="status" value="failed"\/>/);
  assert.match(xml, /<property name="confidence" value="85"\/>/);
  assert.match(xml, /<property name="warning" value="Un avertissement avec &lt;balise&gt; &amp; &quot;guillemets&quot;"\/>/);
});

test("JUnit : texte hostile (balises, esperluettes, caractères de contrôle, retours à la ligne) -> XML bien formé", () => {
  const content = failedRun();
  content.runResult.results[2].error = 'Erreur <script>alert("x")</script> & co\u0000\nsur deux lignes';
  content.runResult.results[2].failure.technical = "]]> <![CDATA[ & \u0007";
  content.scenario.steps[0].description = 'Ouvrir "la" page <b>';
  content.runResult.results[0].description = 'Ouvrir "la" page <b>';
  const xml = buildJunitXml(content);
  assertWellFormed(xml);
  assert.equal(xml.includes("<script>"), false);
  assert.match(xml, /message="Erreur &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; co&#10;sur deux lignes"/);
});

test("JUnit : run réussi -> aucun failure, aucun skipped", () => {
  const content = failedRun();
  content.runResult.status = "passed";
  content.scenario.steps = content.scenario.steps.slice(0, 2);
  content.runResult.results = content.runResult.results.slice(0, 2);
  const xml = buildJunitXml(content);
  assertWellFormed(xml);
  assert.match(xml, /<testsuites [^>]*tests="2" failures="0" errors="0" skipped="0"/);
  assert.equal(/<failure|<error|<skipped/.test(xml), false);
});

test("JUnit : erreur qui interrompt le run (page vide) -> un testcase « Préparation du test » en <error>", () => {
  const xml = buildJunitXml({
    ticketText: "Vérifier le formulaire",
    scenario: { ticketSummary: "Vérifier le formulaire", steps: [], warnings: [] },
    runResult: {
      runId: 1792999999999,
      url: "http://127.0.0.1:8123/",
      status: "error",
      startedAt: "2026-10-20T10:00:00.000Z",
      finishedAt: "2026-10-20T10:00:17.000Z",
      results: [],
      error: "Aucun élément détecté sur la page : l'exploration n'a rien trouvé à tester.",
      failure: { code: "E-CRW-001", label: "Page vide à l'exploration", expected: "Une page avec des champs", found: "0 élément", hint: "Le site est peut-être endormi." },
    },
  });
  assertWellFormed(xml);
  assert.match(xml, /<testsuites [^>]*tests="1" failures="0" errors="1" skipped="0"/);
  assert.match(xml, /name="Préparation du test \(exploration et scénario\)"/);
  assert.match(xml, /<error message="Aucun élément détecté sur la page[^"]*" type="E-CRW-001">/);
  assert.match(xml, /Piste : Le site est peut-être endormi\./);
});

test("JUnit : run en cours -> les étapes à venir ne sont pas marquées « ignorées »", () => {
  const content = failedRun();
  content.runResult.status = "running";
  content.runResult.finishedAt = null;
  content.runResult.results = content.runResult.results.slice(0, 1);
  const xml = buildJunitXml(content);
  assertWellFormed(xml);
  assert.equal(xml.includes("<skipped"), false);
  assert.match(xml, /<testsuites [^>]*tests="1"/);
});

test("JUnit : ancien run sans failure/attempts/scénario -> toujours exportable", () => {
  const xml = buildJunitXml({
    runResult: {
      runId: 1700000000000,
      url: "pas une url",
      status: "failed",
      results: [{ index: 0, description: "Ancienne étape", status: "failed", error: "Vieux message brut de Playwright", durationMs: 100 }],
    },
  });
  assertWellFormed(xml);
  assert.match(xml, /classname="qa-ui-agent"/, "URL invalide : classname par défaut");
  assert.match(xml, /<failure message="Vieux message brut de Playwright" type="failure">/);
});

test("JSON : schéma versionné, résumé, étapes et analyses", () => {
  const report = buildJsonReport(failedRun());

  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(report.generator, "qa-ui-agent");
  assert.equal(report.run.id, "1792405526828");
  assert.equal(report.run.status, "failed");
  assert.equal(report.run.durationMs, 18000);
  assert.equal(report.ticket.confidence, 85);
  assert.deepEqual(report.summary, { total: 4, passed: 2, failed: 1, errors: 0, skipped: 1, flaky: 1 });

  assert.deepEqual(report.steps.map((s) => s.status), ["passed", "passed", "failed", "skipped"]);
  assert.equal(report.steps[1].flaky, true);
  assert.equal(report.steps[1].attempts, 2);
  assert.equal(report.steps[1].firstFailure.code, "E-ELM-002");
  assert.equal(report.steps[2].error.code, "E-ELM-001");
  assert.equal(report.steps[2].error.found, "Messages affichés : « Your username is invalid! »");
  assert.equal(report.steps[3].error, null);
  assert.equal(report.steps[3].attempts, 0);

  assert.equal(report.failure, null);
  assert.equal(report.analyses.rtl.status, "error");
  assert.equal(report.analyses.visualDiff.comparedStepCount, 3);
  assert.equal(report.analyses.visualDiff.maxDiffPercent, 0.1);
});

test("JSON : erreur de run (page vide) exposée dans `failure`, sans étapes", () => {
  const report = buildJsonReport({
    scenario: { steps: [], warnings: [] },
    runResult: {
      runId: 5,
      status: "error",
      results: [],
      error: "Aucun élément détecté sur la page.",
      failure: { code: "E-CRW-001", category: "CRAWL_EMPTY" },
    },
  });
  assert.equal(report.failure.code, "E-CRW-001");
  assert.equal(report.failure.message, "Aucun élément détecté sur la page.");
  assert.deepEqual(report.summary, { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0, flaky: 0 });
});

test("EXPORT_FORMATS : junit et json, avec leur type de contenu et leur extension", () => {
  assert.deepEqual(Object.keys(EXPORT_FORMATS), ["junit", "json"]);
  assert.equal(EXPORT_FORMATS.junit.extension, "xml");
  assert.match(EXPORT_FORMATS.junit.contentType, /^application\/xml/);
  assert.equal(EXPORT_FORMATS.json.extension, "json");
  assert.doesNotThrow(() => JSON.parse(EXPORT_FORMATS.json.build(failedRun())));
});

test("isFailedRun : failed et error font échouer une CI, passed non", () => {
  assert.equal(isFailedRun({ runResult: { status: "failed" } }), true);
  assert.equal(isFailedRun({ runResult: { status: "error" } }), true);
  assert.equal(isFailedRun({ runResult: { status: "passed" } }), false);
  assert.equal(isFailedRun({}), false);
});
