import StatusBadge from "./StatusBadge.jsx";

export default function RunListItem({ run }) {
  return (
    <div className="flex items-center justify-between bg-surface border border-border rounded-xl px-4 py-3">
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-medium truncate">{run.ticketSummary}</span>
        <span className="text-xs text-text-faint font-mono truncate">{run.url}</span>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0 pl-3">
        <StatusBadge status={run.status} />
        <span className="text-[11px] text-text-faint">
          {run.stepsPassed}/{run.stepsTotal} étapes
        </span>
      </div>
    </div>
  );
}
