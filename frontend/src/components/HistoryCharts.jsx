import { Link } from "react-router-dom";
import { formatDuration } from "../lib/format.js";

const STATUS_WORDS = { passed: "Réussi", failed: "Échoué", error: "Erreur" };
const STATUS_COLORS = { passed: "bg-success", failed: "bg-danger", error: "bg-warning" };

function runTitle(run) {
  const duration = typeof run.durationMs === "number" ? ` · ${formatDuration(run.durationMs)}` : "";
  return `Run #${run.runId} · ${STATUS_WORDS[run.status] ?? run.status}${duration}`;
}

/** Tendance d'un test : le libellé est toujours écrit, la couleur n'est qu'un renfort. */
export function TrendBadge({ trend }) {
  const tone =
    trend.code === "regression" || trend.code === "failing" || trend.code === "new_ko"
      ? "bg-danger-muted text-danger"
      : trend.code === "unstable"
        ? "bg-warning-muted text-warning"
        : "bg-success-muted text-success";
  return <span className={`text-[11px] font-medium px-2 py-1 rounded-full ${tone}`}>{trend.label}</span>;
}

/**
 * Les derniers runs, du plus ancien au plus récent : une barre par run, plus haute quand le run
 * a duré plus longtemps. Chaque barre ouvre le rapport du run.
 */
export function RunStrip({ runs }) {
  const maxDuration = Math.max(1, ...runs.map((r) => r.durationMs ?? 0));
  return (
    <div className="flex items-end gap-1 h-24" role="list" aria-label="Derniers runs, du plus ancien au plus récent">
      {runs.map((run) => {
        const height = Math.max(12, Math.round(((run.durationMs ?? 0) / maxDuration) * 100));
        return (
          <Link
            key={run.runId}
            to={`/reports/${run.runId}`}
            role="listitem"
            title={runTitle(run)}
            aria-label={runTitle(run)}
            className="flex-1 min-w-[6px] max-w-5 flex items-end h-full"
          >
            <span
              className={`w-full rounded-sm ${STATUS_COLORS[run.status] ?? "bg-text-faint"} hover:opacity-80`}
              style={{ height: `${height}%` }}
            />
          </Link>
        );
      })}
    </div>
  );
}

/** Une pastille par run (réussi plein, échoué avec une croix) : lisible sans les couleurs. */
export function RunDots({ runs }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="list" aria-label="Résultat des derniers runs">
      {runs.map((run) => (
        <Link
          key={run.runId}
          to={`/reports/${run.runId}`}
          role="listitem"
          title={runTitle(run)}
          aria-label={runTitle(run)}
          className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] leading-none text-bg font-bold ${
            STATUS_COLORS[run.status] ?? "bg-text-faint"
          }`}
        >
          {run.status === "passed" ? "" : "×"}
        </Link>
      ))}
    </div>
  );
}

/** Petite courbe des durées (au moins 2 runs mesurés). */
export function DurationLine({ runs, width = 140, height = 32 }) {
  const points = runs.filter((r) => typeof r.durationMs === "number" && r.durationMs > 0);
  if (points.length < 2) return null;
  const max = Math.max(...points.map((r) => r.durationMs));
  const min = Math.min(...points.map((r) => r.durationMs));
  const span = Math.max(1, max - min);
  const pad = 3;
  const xy = points.map((r, i) => [
    pad + (i / (points.length - 1)) * (width - pad * 2),
    height - pad - ((r.durationMs - min) / span) * (height - pad * 2),
  ]);
  const last = xy[xy.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Durée des ${points.length} derniers runs : de ${formatDuration(min)} à ${formatDuration(max)}`}
    >
      <polyline
        points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
        fill="none"
        stroke="var(--color-accent-blue)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill="var(--color-accent-blue)" />
    </svg>
  );
}
