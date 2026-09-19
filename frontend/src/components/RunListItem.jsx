import StatusBadge from "./StatusBadge.jsx";

const PHASE_LABELS = {
  crawling: "Exploration de la page…",
  planning: "Génération du scénario…",
  running: "Exécution…",
};

/** Texte de droite : la phase tant qu'il n'y a pas d'étapes, puis la progression réelle. */
function getProgressLabel(run) {
  if (run.status === "running" && !run.stepsTotal) {
    return PHASE_LABELS[run.phase] ?? "Démarrage…";
  }
  if (run.status === "error" && !run.stepsTotal) return "Aucune étape exécutée";
  const done = run.status === "running" ? (run.stepsRun ?? 0) : run.stepsPassed;
  return `${done}/${run.stepsTotal} étapes`;
}

export default function RunListItem({ run }) {
  return (
    <div className="flex items-center justify-between bg-surface border border-border rounded-xl px-4 py-3">
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-medium truncate">{run.ticketSummary}</span>
        <span className="text-xs text-text-faint font-mono truncate">{run.url}</span>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0 pl-3">
        <StatusBadge status={run.status} />
        <span className="text-[11px] text-text-faint">{getProgressLabel(run)}</span>
      </div>
    </div>
  );
}
