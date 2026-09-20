import { useEffect, useState } from "react";
import { useParams, useNavigate, Link, Navigate } from "react-router-dom";
import { Loader2, Sparkles, ArrowLeft, RotateCw, FileDown } from "lucide-react";
import PipelineTabs from "../components/PipelineTabs.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import ProgressBar from "../components/ProgressBar.jsx";
import { getRun, replayRun, screenshotUrl } from "../lib/api.js";
import { formatDuration } from "../lib/format.js";

export default function ReportDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [replaying, setReplaying] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);

  useEffect(() => {
    getRun(id)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [id]);

  async function handleReplay() {
    setReplaying(true);
    try {
      const { runId } = await replayRun(id);
      navigate(`/live-runs/${runId}`);
    } catch (err) {
      setError(err.message);
      setReplaying(false);
    }
  }

  async function handleExportPdf() {
    setExportingPdf(true);
    try {
      const { exportRunReportToPdf } = await import("../lib/pdf-export.js");
      await exportRunReportToPdf(data);
    } catch (err) {
      setError(`Export PDF impossible : ${err.message}`);
    } finally {
      setExportingPdf(false);
    }
  }

  if (error) {
    return (
      <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 text-text-muted text-sm py-8">
        <Loader2 size={16} className="animate-spin" />
        Chargement du rapport...
      </div>
    );
  }

  const { scenario, runResult } = data;

  // Un run encore en cours n'a pas de rapport final : on affiche son suivi en direct.
  if (runResult.status === "running") {
    return <Navigate to={`/live-runs/${id}`} replace />;
  }

  const totalDurationMs = runResult.results.reduce((sum, s) => sum + s.durationMs, 0);
  const invalidSelectorCount = scenario.steps.filter((s) => s.selectorValid === false).length;
  const hasWarnings = (scenario.warnings || []).length > 0;

  const isFailure = runResult.status === "failed" || runResult.status === "error";
  const overallLabel =
    runResult.status === "error"
      ? "ERREUR"
      : runResult.status === "failed"
        ? "ÉCHOUÉ"
        : hasWarnings
          ? "TERMINÉ AVEC AVERTISSEMENTS"
          : "TERMINÉ";
  const overallTone = isFailure ? "danger" : hasWarnings ? "warning" : "success";

  return (
    <div className="flex flex-col gap-5">
      <PipelineTabs currentStep={6} />

      <Link to="/reports" className="flex items-center gap-1 text-xs text-text-muted">
        <ArrowLeft size={14} />
        Retour aux rapports
      </Link>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleReplay}
          disabled={replaying}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border bg-surface disabled:opacity-60"
        >
          {replaying ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RotateCw size={13} />
          )}
          {replaying ? "Lancement..." : "Relancer ce scénario"}
        </button>

        <button
          type="button"
          onClick={handleExportPdf}
          disabled={exportingPdf}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border bg-surface disabled:opacity-60"
        >
          {exportingPdf ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <FileDown size={13} />
          )}
          {exportingPdf ? "Génération..." : "Exporter en PDF"}
        </button>
      </div>

      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-faint font-mono">
            RUN #{runResult.runId}
          </span>
          <span
            className={`text-[11px] font-medium px-2 py-1 rounded-full ${
              overallTone === "danger"
                ? "bg-danger-muted text-danger"
                : overallTone === "warning"
                  ? "bg-warning-muted text-warning"
                  : "bg-success-muted text-success"
            }`}
          >
            {overallLabel}
          </span>
        </div>
        <h1 className="text-xl font-semibold">Rapport d'exécution</h1>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-faint">
          <span>{new Date(runResult.startedAt).toLocaleString("fr-FR")}</span>
          <span>·</span>
          <span>Chromium</span>
          <span>·</span>
          <span>{formatDuration(totalDurationMs)} au total</span>
        </div>
      </header>

      {/* Diagnostic — résumé du ticket, score de confiance réel du plan (voir planner.js)
          et avertissements réels : rien n'est inventé, tout se déduit de scenario.warnings. */}
      <section className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-accent-blue font-medium">
            <Sparkles size={14} />
            RÉSUMÉ DU TICKET
          </div>
          {typeof scenario.confidence === "number" && (
            <span
              className={`text-[11px] font-mono px-2 py-0.5 rounded-full ${
                scenario.confidence >= 85
                  ? "bg-success-muted text-success"
                  : scenario.confidence >= 50
                    ? "bg-warning-muted text-warning"
                    : "bg-danger-muted text-danger"
              }`}
              title="Confiance dans le plan généré : 100% moins 15 points par avertissement (sélecteur halluciné, étape incohérente retirée)."
            >
              Confiance : {scenario.confidence}%
            </span>
          )}
        </div>
        <p className="text-sm">{scenario.ticketSummary}</p>
        {hasWarnings && (
          <ul className="flex flex-col gap-1 mt-1">
            {scenario.warnings.map((w, i) => (
              <li key={i} className="text-xs text-warning">
                ⚠ {w}
              </li>
            ))}
          </ul>
        )}
      </section>

      {runResult.error && (
        <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
          {runResult.error}
        </div>
      )}

      {/* Cartes de stats */}
      <section className="grid grid-cols-2 gap-3">
        <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-2">
          <span className="text-xs text-text-muted">Étapes exécutées</span>
          <span className="text-2xl font-semibold">
            {runResult.stepsPassed}
            <span className="text-text-faint text-base"> / {runResult.stepsTotal}</span>
          </span>
          <ProgressBar
            percent={runResult.stepsTotal ? (runResult.stepsPassed / runResult.stepsTotal) * 100 : 0}
            tone={isFailure ? "danger" : "success"}
          />
        </div>

        <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-2">
          <span className="text-xs text-text-muted">Sélecteurs invalides</span>
          <span
            className={`text-2xl font-semibold ${
              invalidSelectorCount > 0 ? "text-danger" : "text-text"
            }`}
          >
            {invalidSelectorCount}
          </span>
          <span className="text-[11px] text-text-faint">sur {scenario.steps.length} étapes générées</span>
        </div>

        <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-2 col-span-2">
          <span className="text-xs text-text-muted">Régression visuelle & RTL</span>
          <span className="text-sm text-text-faint">
            Non rattaché à ce run — utilise{" "}
            <Link to="/visual-rtl" className="text-accent-blue">
              Visual/RTL
            </Link>{" "}
            pour ces vérifications.
          </span>
        </div>
      </section>

      {/* Étapes détaillées */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-text-muted">Étapes d'exécution</h2>
        {runResult.results.map((step, i) => (
          <div
            key={step.index}
            className="bg-surface border border-border rounded-xl p-3 flex gap-3"
          >
            {step.screenshot && (
              <img
                src={screenshotUrl(step.screenshot)}
                alt={step.description}
                className="w-16 h-12 object-cover rounded-lg border border-border shrink-0"
              />
            )}
            <div className="flex flex-col min-w-0 flex-1 gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-text-faint">Étape {i + 1}</span>
                <StatusBadge status={step.status} />
              </div>
              <span className="text-sm">{step.description}</span>
              {step.selector && (
                <code className="text-[11px] font-mono text-text-faint truncate">
                  {step.type}('{step.selector}')
                </code>
              )}
              {step.error && (
                <span className="text-[11px] text-danger">{step.error}</span>
              )}
              <span className="text-[11px] text-text-faint">{step.durationMs}ms</span>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}