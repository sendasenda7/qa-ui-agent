import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Loader2 } from "lucide-react";
import StatCard from "../components/StatCard.jsx";
import RunListItem from "../components/RunListItem.jsx";
import { getRuns } from "../lib/api.js";

export default function Dashboard() {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getRuns()
      .then(setRuns)
      .catch((err) => setError(err.message));
  }, []);

  const stats = runs
    ? {
        total: runs.length,
        passed: runs.filter((r) => r.status === "passed").length,
        failed: runs.filter((r) => r.status === "failed").length,
      }
    : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Vue d'ensemble</h1>
        <p className="text-sm text-text-muted">
          Suivi des tests E2E générés et exécutés automatiquement à partir de tes tickets.
        </p>
      </header>

      <Link
        to="/new-run"
        className="gradient-accent rounded-2xl px-4 py-3 flex items-center justify-between text-white font-medium"
      >
        Lancer un nouveau test
        <ArrowRight size={18} />
      </Link>

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

      {stats && (
        <section className="grid grid-cols-3 gap-3">
          <StatCard label="Runs totaux" value={stats.total} />
          <StatCard label="Réussis" value={stats.passed} tone="success" />
          <StatCard label="Échoués" value={stats.failed} tone="danger" />
        </section>
      )}

      {runs && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-text-muted">Runs récents</h2>
          {runs.length === 0 ? (
            <p className="text-sm text-text-faint">
              Aucun run pour l'instant — lance ton premier test.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {runs.slice(0, 10).map((run) => (
                <RunListItem key={run.runId} run={run} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
