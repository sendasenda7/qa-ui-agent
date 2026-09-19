import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, ChevronRight } from "lucide-react";
import StatusBadge from "../components/StatusBadge.jsx";
import { getRuns } from "../lib/api.js";

export default function Reports() {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getRuns()
      .then(setRuns)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Rapports</h1>
        <p className="text-sm text-text-muted">
          Rapport détaillé de chaque test exécuté.
        </p>
      </header>

      {error && (
        <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
          {error}
        </div>
      )}

      {!runs && !error && (
        <div className="flex items-center justify-center gap-2 text-text-muted text-sm py-8">
          <Loader2 size={16} className="animate-spin" />
          Chargement...
        </div>
      )}

      {runs?.length === 0 && (
        <p className="text-sm text-text-faint">Aucun rapport pour l'instant.</p>
      )}

      <div className="flex flex-col gap-2">
        {runs?.map((run) => (
          <Link
            key={run.runId}
            to={`/reports/${run.runId}`}
            className="flex items-center justify-between bg-surface border border-border rounded-xl px-4 py-3"
          >
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-sm font-medium truncate">{run.ticketSummary}</span>
              <span className="text-xs text-text-faint font-mono truncate">{run.url}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0 pl-3">
              <StatusBadge status={run.status} />
              <ChevronRight size={16} className="text-text-faint" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
