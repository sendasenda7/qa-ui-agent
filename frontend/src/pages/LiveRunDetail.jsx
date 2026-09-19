import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import PipelineTabs from "../components/PipelineTabs.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import ProgressBar from "../components/ProgressBar.jsx";
import PhaseTimeline from "../components/PhaseTimeline.jsx";
import BrowserFrame from "../components/BrowserFrame.jsx";
import RunStepList from "../components/RunStepList.jsx";
import { useRunPolling } from "../hooks/useRunPolling.js";
import { useNow } from "../hooks/useNow.js";
import { formatClock } from "../lib/format.js";

// Étape du bandeau Ticket → Explore → AI Plan → Run → Regressions → Report.
const PIPELINE_STEP_BY_PHASE = { crawling: 2, planning: 3, running: 4 };

function getElapsedMs(runResult, now) {
  const startMs = Date.parse(runResult.startedAt);
  if (runResult.finishedAt) return Date.parse(runResult.finishedAt) - startMs;
  if (runResult.status === "running") return now - startMs;
  // Ancien run sauvegardé avant l'ajout de finishedAt : on additionne la durée des étapes.
  return runResult.results.reduce((sum, step) => sum + step.durationMs, 0);
}

function getHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function InfoCell({ label, value }) {
  return (
    <div className="bg-surface border border-border rounded-xl px-3 py-2 flex flex-col">
      <span className="text-[11px] text-text-faint">{label}</span>
      <span className="text-sm font-mono truncate">{value}</span>
    </div>
  );
}

export default function LiveRunDetail() {
  const { id } = useParams();
  const { data, error } = useRunPolling(id);
  const isRunning = data?.runResult.status === "running";
  const now = useNow(isRunning);

  if (error) {
    return (
      <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
        {error}
        <div className="text-[11px] text-text-faint mt-1">
          Vérifie que le serveur backend tourne (npm run server dans le dossier backend).
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 text-text-muted text-sm py-8">
        <Loader2 size={16} className="animate-spin" />
        Chargement du run...
      </div>
    );
  }

  const { runResult } = data;
  const steps = data.scenario.steps ?? [];
  const results = runResult.results ?? [];
  const ticket = data.ticketText ?? data.scenario.ticketSummary;
  const currentStep = runResult.currentStep;

  const lastScreenshot = [...results].reverse().find((step) => step.screenshot)?.screenshot ?? null;
  const percent = runResult.stepsTotal ? (runResult.stepsRun / runResult.stepsTotal) * 100 : 0;
  const isFinished = runResult.status === "passed" || runResult.status === "failed";
  const hasSteps = runResult.stepsTotal > 0;
  // Un run arrêté avant sa première étape n'aura jamais de capture : inutile d'afficher la fenêtre vide.
  const showBrowser = isRunning || lastScreenshot !== null;
  const title = isRunning ? "Test en cours" : runResult.status === "error" ? "Test interrompu" : "Test terminé";

  return (
    <div className="flex flex-col gap-5">
      <PipelineTabs currentStep={PIPELINE_STEP_BY_PHASE[runResult.phase] ?? 6} />

      <Link to="/live-runs" className="flex items-center gap-1 text-xs text-text-muted">
        <ArrowLeft size={14} />
        Tous les runs
      </Link>

      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-faint font-mono">RUN #{runResult.runId}</span>
          <StatusBadge status={runResult.status} />
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-text-muted">{ticket}</p>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <InfoCell label="Navigateur" value="Chromium" />
        <InfoCell label="Environnement" value={getHost(runResult.url)} />
        <InfoCell label="Temps écoulé" value={formatClock(getElapsedMs(runResult, now))} />
        <InfoCell label="Étapes" value={hasSteps ? `${runResult.stepsRun} / ${runResult.stepsTotal}` : "—"} />
      </section>

      <section className="flex flex-col gap-2" aria-live="polite">
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>Pipeline d'exécution</span>
          <span>
            {hasSteps
              ? `${runResult.stepsRun} sur ${runResult.stepsTotal} étapes (${Math.round(percent)}%)`
              : "En attente du scénario"}
          </span>
        </div>
        <ProgressBar
          percent={percent}
          tone={runResult.status === "failed" || runResult.status === "error" ? "danger" : "accent"}
        />
      </section>

      <PhaseTimeline run={runResult} />

      {runResult.error && (
        <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
          {runResult.error}
        </div>
      )}

      {showBrowser && (
        <BrowserFrame
          url={runResult.url}
          screenshot={lastScreenshot}
          caption={currentStep ? `Étape ${currentStep.index + 1} : ${currentStep.description}` : null}
          isLive={isRunning}
        />
      )}

      <RunStepList steps={steps} results={results} currentIndex={currentStep?.index ?? null} />

      {isFinished && (
        <Link
          to={`/reports/${runResult.runId}`}
          className="gradient-accent rounded-xl py-3 text-white font-medium text-center"
        >
          Voir le rapport
        </Link>
      )}
      {runResult.status === "error" && (
        <Link
          to="/new-run"
          className="border border-border rounded-xl py-3 text-text font-medium text-center"
        >
          Lancer un nouveau test
        </Link>
      )}
    </div>
  );
}
