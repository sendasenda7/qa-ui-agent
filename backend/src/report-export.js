/**
 * Export d'un run en JUnit XML et en JSON, pour brancher le rapport sur une CI.
 *
 *  - JUnit XML : le format que lisent GitHub Actions (via une action de rapport), GitLab CI, Jenkins,
 *    Azure DevOps... Une étape du scénario = un `testcase` ; un échec porte le code stable
 *    (`E-ELM-001`...) dans `type`, et « attendu / trouvé / piste » dans le corps.
 *  - JSON : un format stable et versionné (`schemaVersion`), pour des outils maison.
 *
 * Fonctions pures : elles ne lisent rien sur le disque et ne dépendent ni du serveur ni du navigateur,
 * donc elles se testent sans rien lancer. Le contenu attendu est celui de `runs/<runId>.json`
 * ({ ticketText, scenario, runResult, ... }).
 */

export const REPORT_SCHEMA_VERSION = 1;

const MAX_TEXT_CHARS = 4000;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/**
 * Échappe un texte pour XML 1.0. Retire aussi les caractères interdits en XML (codes de contrôle,
 * sauf tabulation et retours à la ligne) : un seul suffit à rendre tout le fichier illisible pour
 * la plupart des outils.
 */
export function escapeXml(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Valeur d'attribut : en plus, les retours à la ligne sont codés (sinon un parseur les normalise). */
function attr(value) {
  return escapeXml(value).replace(/\r?\n/g, "&#10;").replace(/\t/g, "&#9;");
}

function clip(text, max = MAX_TEXT_CHARS) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function seconds(ms) {
  const value = Number(ms);
  return (Number.isFinite(value) && value > 0 ? value / 1000 : 0).toFixed(3);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname || "qa-ui-agent";
  } catch {
    return "qa-ui-agent";
  }
}

function ordinalFr(n) {
  return n === 1 ? "1er" : `${n}e`;
}

/** Ce qu'on sait d'une étape, avec des valeurs par défaut pour les anciens runs. */
function normalizeSteps(content) {
  const planned = Array.isArray(content?.scenario?.steps) ? content.scenario.steps : [];
  const results = Array.isArray(content?.runResult?.results) ? content.runResult.results : [];
  return { planned, results };
}

function stepName(index, description) {
  return `${index + 1}. ${description || "(étape sans description)"}`;
}

/** Texte lisible d'un échec structuré (corps d'un <failure> ou d'un <error>). */
function describeFailure(failure, message) {
  const lines = [];
  if (failure?.code) lines.push(`Code : ${failure.code}${failure.label ? ` (${failure.label})` : ""}`);
  lines.push(`Message : ${message ?? failure?.message ?? ""}`);
  if (failure?.expected) lines.push(`Attendu : ${failure.expected}`);
  if (failure?.found) lines.push(`Trouvé : ${failure.found}`);
  if (failure?.hint) lines.push(`Piste : ${failure.hint}`);
  if (failure?.technical) lines.push(`Détails techniques :\n${failure.technical}`);
  return clip(lines.join("\n"));
}

/** Notes d'exécution d'une étape (action, tentatives, instabilité, capture). */
function describeStepNotes(planned, result) {
  const lines = [];
  const action = [result?.type ?? planned?.type, result?.selector ?? planned?.selector].filter(Boolean).join(" ");
  if (action) lines.push(`Étape : ${action}`);
  if (result?.attempts > 1) {
    if (result.status === "passed") {
      lines.push(`Instable : réussi au ${ordinalFr(result.attempts)} essai.`);
      if (result.firstFailure) {
        lines.push(`1er essai : ${result.firstFailure.code ?? ""} ${result.firstFailure.message ?? ""}`.trim());
      }
    } else {
      lines.push(`Échec confirmé après ${result.attempts} essais.`);
    }
  }
  if (result?.screenshot) lines.push(`Capture : ${result.screenshot}`);
  if (result?.failureScreenshot) lines.push(`Capture de l'échec : ${result.failureScreenshot}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function jsonFailure(failure, message) {
  if (!failure && !message) return null;
  return {
    code: failure?.code ?? null,
    category: failure?.category ?? null,
    label: failure?.label ?? null,
    message: message ?? failure?.message ?? null,
    expected: failure?.expected ?? null,
    found: failure?.found ?? null,
    hint: failure?.hint ?? null,
    technical: failure?.technical ?? null,
  };
}

/**
 * Rapport JSON stable et versionné. Seules les informations utiles à une CI ou à un outil externe
 * y figurent (pas le détail du crawl, ni les captures elles-mêmes : seulement leur chemin).
 */
export function buildJsonReport(content) {
  const runResult = content?.runResult ?? {};
  const scenario = content?.scenario ?? {};
  const { planned, results } = normalizeSteps(content);
  const finished = runResult.status && runResult.status !== "running";

  const steps = planned.length > 0 ? planned.map((_, index) => index) : results.map((_, index) => index);
  const stepReports = steps.map((index) => {
    const result = results[index];
    const plan = planned[index];
    const executed = Boolean(result);
    const status = executed ? result.status : finished ? "skipped" : "pending";
    const attempts = executed ? (result.attempts ?? 1) : 0;
    return {
      index,
      type: result?.type ?? plan?.type ?? null,
      description: result?.description ?? plan?.description ?? null,
      selector: result?.selector ?? plan?.selector ?? null,
      status,
      durationMs: executed ? (result.durationMs ?? 0) : 0,
      attempts,
      flaky: status === "passed" && attempts > 1,
      firstFailure: result?.firstFailure ?? null,
      error: executed && result.error ? jsonFailure(result.failure, result.error) : null,
      screenshot: result?.screenshot ?? null,
      failureScreenshot: result?.failureScreenshot ?? null,
    };
  });

  const count = (status) => stepReports.filter((step) => step.status === status).length;
  const rtl = runResult.rtl;
  const visual = runResult.visualDiff;

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generator: "qa-ui-agent",
    run: {
      id: String(runResult.runId ?? ""),
      url: runResult.url ?? null,
      browser: runResult.browserEngine ?? null,
      status: runResult.status ?? null,
      phase: runResult.phase ?? null,
      startedAt: runResult.startedAt ?? null,
      finishedAt: runResult.finishedAt ?? null,
      durationMs:
        runResult.startedAt && runResult.finishedAt
          ? Math.max(0, new Date(runResult.finishedAt) - new Date(runResult.startedAt))
          : null,
      replayOf: content?.replayOf ?? null,
    },
    ticket: {
      text: content?.ticketText ?? null,
      summary: scenario.ticketSummary ?? null,
      confidence: typeof scenario.confidence === "number" ? scenario.confidence : null,
      warnings: Array.isArray(scenario.warnings) ? scenario.warnings : [],
    },
    summary: {
      total: stepReports.length,
      passed: count("passed"),
      failed: count("failed"),
      errors: count("error"),
      skipped: count("skipped"),
      flaky: stepReports.filter((step) => step.flaky).length,
    },
    steps: stepReports,
    // Erreur qui a interrompu tout le run (site injoignable, page vide, IA sans étape...).
    failure: runResult.error || runResult.failure ? jsonFailure(runResult.failure, runResult.error) : null,
    analyses: {
      rtl: rtl
        ? {
            status: rtl.status ?? null,
            error: rtl.error ?? null,
            findingsCount: rtl.report?.findingsCount ?? null,
            elementsComparedCount: rtl.report?.elementsComparedCount ?? null,
          }
        : null,
      accessibility: runResult.accessibility
        ? {
            status: runResult.accessibility.status ?? null,
            error: runResult.accessibility.error ?? null,
            totals: runResult.accessibility.totals ?? null,
            pages: (runResult.accessibility.pages ?? []).map((page) => ({
              url: page.url,
              title: page.title,
              counts: page.counts,
              needsReview: page.needsReview ?? 0,
              violations: (page.violations ?? []).map((rule) => ({
                id: rule.id,
                impact: rule.impact,
                help: rule.help,
                helpUrl: rule.helpUrl,
                nodesCount: rule.nodesCount,
                targets: (rule.nodes ?? []).map((node) => node.target),
              })),
            })),
          }
        : null,
      responsive: runResult.responsive
        ? {
            status: runResult.responsive.status ?? null,
            error: runResult.responsive.error ?? null,
            totals: runResult.responsive.totals ?? null,
            pages: (runResult.responsive.pages ?? []).map((page) => ({
              url: page.url,
              title: page.title,
              viewports: (page.viewports ?? []).map((viewport) => ({
                name: viewport.name,
                width: viewport.width,
                height: viewport.height,
                error: viewport.error ?? null,
                screenshot: viewport.screenshot ?? null,
                issues: (viewport.issues ?? []).map((issue) => ({
                  code: issue.code,
                  severity: issue.severity,
                  message: issue.message,
                  count: issue.count,
                  examples: issue.examples ?? [],
                })),
              })),
            })),
          }
        : null,
      performance: runResult.performance
        ? {
            status: runResult.performance.status ?? null,
            error: runResult.performance.error ?? null,
            totals: runResult.performance.totals ?? null,
            pages: (runResult.performance.pages ?? []).map((page) => ({
              url: page.url,
              title: page.title,
              notMeasured: Boolean(page.notMeasured),
              metrics: page.metrics ?? null,
              ratings: page.ratings ?? null,
              issues: (page.issues ?? []).map((issue) => ({ code: issue.code, severity: issue.severity, message: issue.message })),
            })),
          }
        : null,
      links: runResult.links
        ? {
            status: runResult.links.status ?? null,
            error: runResult.links.error ?? null,
            totals: runResult.links.totals ?? null,
            pages: (runResult.links.pages ?? []).map((page) => ({
              url: page.url,
              title: page.title,
              total: page.total,
              checked: page.checked,
              broken: page.broken ?? [],
              brokenCount: page.brokenCount ?? 0,
              restrictedCount: page.restrictedCount ?? 0,
              uncheckedCount: page.uncheckedCount ?? 0,
              brokenAnchors: page.brokenAnchors ?? [],
              brokenImages: page.brokenImages ?? [],
            })),
          }
        : null,
      visualDiff: visual
        ? {
            status: visual.status ?? null,
            baselineRunId: visual.baselineRunId ?? null,
            regressionCount: visual.report?.regressionCount ?? null,
            comparedStepCount: visual.report?.comparedStepCount ?? null,
            maxDiffPercent: visual.report?.maxDiffPercent ?? null,
            reason: visual.reason ?? null,
            error: visual.error ?? null,
          }
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------

/**
 * Rapport JUnit XML.
 *  - une étape exécutée et réussie -> `testcase` ; échouée -> `<failure type="E-...">` ;
 *  - une étape jamais exécutée (une étape précédente a échoué) -> `<skipped>` ;
 *  - une erreur qui a interrompu le run (site injoignable, page vide...) -> un `testcase`
 *    « Préparation du test » en `<error>`, pour qu'une CI voie un échec et non un rapport vide ;
 *  - une étape instable (réussie à la relance) reste réussie, mais son instabilité est écrite dans
 *    `system-out` et dans la propriété `flakySteps` de la suite.
 */
export function buildJunitXml(content) {
  const runResult = content?.runResult ?? {};
  const scenario = content?.scenario ?? {};
  const { planned, results } = normalizeSteps(content);
  const finished = runResult.status && runResult.status !== "running";
  const classname = hostnameOf(runResult.url);

  const cases = [];
  const total = planned.length > 0 ? planned.length : results.length;

  for (let index = 0; index < total; index++) {
    const result = results[index];
    const plan = planned[index];
    const name = stepName(index, result?.description ?? plan?.description);
    const notes = describeStepNotes(plan, result);

    if (!result) {
      if (!finished) continue; // run en cours : une étape à venir n'est pas « ignorée »
      cases.push({
        kind: "skipped",
        xml: `    <testcase classname="${attr(classname)}" name="${attr(name)}" time="0.000">\n      <skipped message="Non exécutée : une étape précédente a échoué ou le run s'est arrêté."/>\n    </testcase>`,
      });
      continue;
    }

    const open = `    <testcase classname="${attr(classname)}" name="${attr(name)}" time="${seconds(result.durationMs)}"`;
    const out = notes ? `\n      <system-out>${escapeXml(notes)}</system-out>` : "";

    if (result.status === "failed" || result.status === "error") {
      const tag = result.status === "error" ? "error" : "failure";
      const type = result.failure?.code ?? (tag === "error" ? "E-UNK-001" : "failure");
      cases.push({
        kind: tag === "error" ? "error" : "failure",
        xml: `${open}>\n      <${tag} message="${attr(result.error ?? "Étape en échec")}" type="${attr(type)}">${escapeXml(
          describeFailure(result.failure, result.error)
        )}</${tag}>${out}\n    </testcase>`,
      });
    } else {
      cases.push({ kind: "passed", xml: out ? `${open}>${out}\n    </testcase>` : `${open}/>` });
    }
  }

  // Erreur qui a interrompu le run sans qu'aucune étape ne soit en échec.
  const hasStepFailure = cases.some((c) => c.kind === "failure" || c.kind === "error");
  if (runResult.error && !hasStepFailure) {
    const code = runResult.failure?.code ?? "E-UNK-001";
    const name = planned.length === 0 ? "Préparation du test (exploration et scénario)" : "Exécution du test";
    cases.push({
      kind: "error",
      xml: `    <testcase classname="${attr(classname)}" name="${attr(name)}" time="0.000">\n      <error message="${attr(
        runResult.error
      )}" type="${attr(code)}">${escapeXml(describeFailure(runResult.failure, runResult.error))}</error>\n    </testcase>`,
    });
  }

  const failures = cases.filter((c) => c.kind === "failure").length;
  const errors = cases.filter((c) => c.kind === "error").length;
  const skipped = cases.filter((c) => c.kind === "skipped").length;
  const flaky = results.filter((r) => r?.status === "passed" && r.attempts > 1).length;

  const stepsTime = results.reduce((sum, r) => sum + (Number(r?.durationMs) || 0), 0);
  const wallTime =
    runResult.startedAt && runResult.finishedAt ? new Date(runResult.finishedAt) - new Date(runResult.startedAt) : 0;
  const time = seconds(wallTime > 0 ? wallTime : stepsTime);

  const suiteName = clip(scenario.ticketSummary || content?.ticketText || `Run ${runResult.runId ?? ""}`, 200);
  const properties = [
    ["runId", runResult.runId],
    ["url", runResult.url],
    ["browser", runResult.browserEngine],
    ["status", runResult.status],
    ["confidence", typeof scenario.confidence === "number" ? scenario.confidence : null],
    ["flakySteps", flaky],
    ["ticket", content?.ticketText ? clip(content.ticketText, 500) : null],
    ...(Array.isArray(scenario.warnings) ? scenario.warnings.map((w) => ["warning", clip(w, 500)]) : []),
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");

  const propertiesXml = properties
    .map(([name, value]) => `      <property name="${attr(name)}" value="${attr(value)}"/>`)
    .join("\n");

  const timestamp = runResult.startedAt ? new Date(runResult.startedAt).toISOString() : "";
  const suiteAttrs =
    `name="${attr(suiteName)}" id="${attr(runResult.runId ?? "")}" tests="${cases.length}" failures="${failures}" ` +
    `errors="${errors}" skipped="${skipped}" time="${time}"${timestamp ? ` timestamp="${attr(timestamp)}"` : ""}`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="QA-UI Agent" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}">`,
    `  <testsuite ${suiteAttrs}>`,
    propertiesXml ? `    <properties>\n${propertiesXml}\n    </properties>` : null,
    ...cases.map((c) => c.xml),
    "  </testsuite>",
    "</testsuites>",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** Statut du run -> faut-il considérer le test comme un échec pour une CI ? */
export function isFailedRun(content) {
  const status = content?.runResult?.status;
  return status === "failed" || status === "error";
}

export const EXPORT_FORMATS = {
  junit: { contentType: "application/xml; charset=utf-8", extension: "xml", build: buildJunitXml },
  json: {
    contentType: "application/json; charset=utf-8",
    extension: "json",
    build: (content) => `${JSON.stringify(buildJsonReport(content), null, 2)}\n`,
  },
};
