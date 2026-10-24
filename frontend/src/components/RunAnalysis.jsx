import { Link } from "react-router-dom";
import { screenshotUrl } from "../lib/api.js";
import AnalysisCard from "./AnalysisCard.jsx";
import AccessibilityCard from "./AccessibilityCard.jsx";

function Message({ children, danger = false }) {
  return <p className={`text-sm ${danger ? "text-danger" : "text-text-faint"}`}>{children}</p>;
}

function RtlCard({ enabled, rtl }) {
  if (!enabled) {
    return (
      <AnalysisCard title="RTL & localisation FR/AR" badge="Non activé">
        <Message>Interrupteur désactivé au lancement de ce test.</Message>
      </AnalysisCard>
    );
  }
  if (!rtl) {
    return (
      <AnalysisCard title="RTL & localisation FR/AR" badge="En attente" tone="warning">
        <Message>L'analyse n'a pas produit de résultat (run interrompu ?).</Message>
      </AnalysisCard>
    );
  }
  if (rtl.status === "error") {
    return (
      <AnalysisCard title="RTL & localisation FR/AR" badge="Analyse impossible" tone="warning">
        <Message danger>{rtl.error}</Message>
      </AnalysisCard>
    );
  }

  const { report } = rtl;
  const hasFindings = report.findingsCount > 0;

  return (
    <AnalysisCard
      title="RTL & localisation FR/AR"
      badge={hasFindings ? `${report.findingsCount} anomalie(s)` : "Aucune anomalie"}
      tone={hasFindings ? "danger" : "success"}
    >
      <p className="text-sm">
        Direction du document : <span className="font-mono">{report.frDir}</span> en FR,{" "}
        <span className="font-mono">{report.arDir}</span> en AR ·{" "}
        {report.elementsComparedCount} éléments comparés
      </p>
      {hasFindings && (
        <ul className="flex flex-col gap-2">
          {report.findings.map((finding, index) => (
            <li key={index} className="text-sm border border-danger/30 bg-danger-muted rounded-lg p-2">
              <span className="text-danger">{finding.description}</span>
              {finding.selector && (
                <code className="block text-[11px] font-mono text-text-faint truncate mt-1">
                  {finding.selector}
                </code>
              )}
            </li>
          ))}
        </ul>
      )}
    </AnalysisCard>
  );
}

function VisualDiffCard({ enabled, visualDiff }) {
  const title = "Régression visuelle";

  if (!enabled) {
    return (
      <AnalysisCard title={title} badge="Non activé">
        <Message>Interrupteur désactivé au lancement de ce test.</Message>
      </AnalysisCard>
    );
  }
  if (!visualDiff) {
    return (
      <AnalysisCard title={title} badge="En attente" tone="warning">
        <Message>L'analyse n'a pas produit de résultat (run interrompu ?).</Message>
      </AnalysisCard>
    );
  }
  if (visualDiff.status === "error") {
    return (
      <AnalysisCard title={title} badge="Analyse impossible" tone="warning">
        <Message danger>{visualDiff.error}</Message>
      </AnalysisCard>
    );
  }
  if (visualDiff.status === "no_baseline") {
    return (
      <AnalysisCard title={title} badge="Pas de référence">
        <Message>{visualDiff.reason}</Message>
      </AnalysisCard>
    );
  }

  const { report, baselineRunId } = visualDiff;
  const regressedSteps = report.steps.filter((step) => step.isRegression);
  // Aucune étape comparable (scénarios différents, captures manquantes) : pas de verdict, et surtout
  // pas un faux « Aucune régression » rassurant. Les anciens rapports n'ont pas ce compteur.
  const nothingCompared = !report.hasRegressions && (report.comparedStepCount ?? report.stepCount) === 0;
  const badge = report.hasRegressions
    ? `${report.regressionCount} régression(s)`
    : nothingCompared
      ? "Non comparable"
      : "Aucune régression";
  const tone = report.hasRegressions ? "danger" : nothingCompared ? "warning" : "success";

  return (
    <AnalysisCard title={title} badge={badge} tone={tone}>
      <p className="text-sm">
        Comparé au run{" "}
        <Link to={`/reports/${baselineRunId}`} className="text-accent-blue font-mono">
          #{baselineRunId}
        </Link>{" "}
        · {report.stepCount} étape(s)
        {report.maxDiffPercent !== null && <> · écart maximal {report.maxDiffPercent}%</>}
      </p>

      {report.warnings.map((warning, index) => (
        <p key={index} className="text-[11px] text-warning">
          {warning}
        </p>
      ))}

      {regressedSteps.length > 0 && (
        <ul className="flex flex-col gap-2">
          {regressedSteps.map((step) => (
            <li key={step.index} className="flex items-center gap-3 border border-border rounded-lg p-2">
              {step.diffImagePath && (
                <img
                  src={screenshotUrl(step.diffImagePath)}
                  alt={`Différences visuelles, étape ${step.index + 1}`}
                  className="w-20 h-14 object-cover rounded border border-border shrink-0"
                />
              )}
              <div className="flex flex-col min-w-0">
                <span className="text-sm truncate">
                  Étape {step.index + 1} : {step.description}
                </span>
                <span className="text-[11px] text-danger">{step.diffPercent}% de pixels différents</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </AnalysisCard>
  );
}

/**
 * Résultats des analyses RTL et diff visuel rattachées à un run.
 * `options` vient du run (data.options) ; absent sur les anciens runs → "Non activé".
 */
export default function RunAnalysis({ options, runResult }) {
  return (
    <>
      <RtlCard enabled={Boolean(options?.checkRtl)} rtl={runResult.rtl} />
      <VisualDiffCard enabled={Boolean(options?.checkVisualDiff)} visualDiff={runResult.visualDiff} />
      <AccessibilityCard enabled={Boolean(options?.checkA11y)} accessibility={runResult.accessibility} />
    </>
  );
}
