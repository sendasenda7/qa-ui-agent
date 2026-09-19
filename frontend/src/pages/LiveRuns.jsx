import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Loader2 } from "lucide-react";
import RunListItem from "../components/RunListItem.jsx";
import { getRuns } from "../lib/api.js";

const REFRESH_INTERVAL_MS = 3000;
const RECENT_RUNS_COUNT = 5;

/** Un test terminé mène à son rapport ; un test en cours (ou en erreur) à la page de suivi. */
function getRunLink(run) {
  const hasReport = run.status === "passed" || run.status === "failed";
  return hasReport ? `/reports/${run.runId}` : `/live-runs/${run.runId}`;
}

export default function LiveRuns() {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let isCancelled = false;

    async function refresh() {
      try {
        const data = await getRuns();
        if (isCancelled) return;
        setRuns(data);
        setError(null);
      } catch (err) {
        if (!isCancelled) setError(err.message);
      }
    }

    refresh();
    const intervalId = setInterval(refresh, REFRESH_INTERVAL_MS);

    return () => {
      isCancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  const runningRuns = runs?.filter((run) => run.status === "running") ?? [];
  const recentRuns = runs?.filter((run) => run.status !== "running").slice(0, RECENT_RUNS_COUNT) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Runs en cours</h1>
        <p className="text-sm text-text-muted">
          Suis en direct les tests lancés depuis « New Run ».
        </p>
      </header>

      {error && (
        <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
          {error}
          <div className="text-[11px] text-text-faint mt-1">
            Vérifie que le serveur backend tourne (npm run server dans le dossier backend).
          </div>
        </div>
      )}

      {!runs && !error && (
        <div className="flex items-center justify-center gap-2 text-text-muted text-sm py-8">
          <Loader2 size={16} className="animate-spin" />
          Chargement des runs...
        </div>
      )}

      {runs && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-text-muted">En cours</h2>
          {runningRuns.length === 0 ? (
            <Link
              to="/new-run"
              className="flex items-center justify-between border border-dashed border-border rounded-xl px-4 py-3 text-sm text-text-muted"
            >
              Aucun test en cours — lancer un nouveau test
              <ArrowRight size={16} />
            </Link>
          ) : (
            <div className="flex flex-col gap-2">
              {runningRuns.map((run) => (
                <Link key={run.runId} to={`/live-runs/${run.runId}`} className="block">
                  <RunListItem run={run} />
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {recentRuns.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-text-muted">Terminés récemment</h2>
          <div className="flex flex-col gap-2">
            {recentRuns.map((run) => (
              <Link key={run.runId} to={getRunLink(run)} className="block">
                <RunListItem run={run} />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
