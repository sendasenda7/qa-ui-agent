import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Loader2, Search } from "lucide-react";
import StatCard from "../components/StatCard.jsx";
import RunListItem from "../components/RunListItem.jsx";
import PipelineStrip from "../components/PipelineStrip.jsx";
import { getRuns } from "../lib/api.js";

const FILTERS = [
  { key: "all", label: "Tous" },
  { key: "running", label: "En cours" },
  { key: "failed", label: "Échoués" },
  { key: "warnings", label: "Avertissements" },
];

export default function Dashboard() {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    getRuns()
      .then(setRuns)
      .catch((err) => setError(err.message));
  }, []);

  const stats = runs
    ? {
        total: runs.length,
        passed: runs.filter((r) => r.status === "passed").length,
        failed: runs.filter((r) => r.status === "failed" || r.status === "error").length,
        warnings: runs.filter((r) => (r.warningsCount ?? 0) > 0).length,
      }
    : null;

  const passRate = stats && stats.total ? Math.round((stats.passed / stats.total) * 100) : null;

  const normalizedQuery = query.trim().toLowerCase();

  const visibleRuns = runs
    ? runs.filter((r) => {
        if (filter === "running" && r.status !== "running") return false;
        if (filter === "failed" && r.status !== "failed" && r.status !== "error") return false;
        if (filter === "warnings" && !((r.warningsCount ?? 0) > 0)) return false;
        if (
          normalizedQuery &&
          !r.ticketSummary?.toLowerCase().includes(normalizedQuery) &&
          !r.url?.toLowerCase().includes(normalizedQuery)
        ) {
          return false;
        }
        return true;
      })
    : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">QA Dashboard</h1>
        <p className="text-sm text-text-muted">
          Suivi des tests E2E, régressions visuelles et localisation, générés et exécutés
          automatiquement à partir de tes tickets.
        </p>
      </header>

      {/* Pipeline + lancement d'un nouveau test */}
      <section className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-4">
        <PipelineStrip />
        <Link
          to="/new-run"
          className="gradient-accent rounded-xl px-4 py-2.5 flex items-center justify-between gap-3 text-white text-sm font-medium w-full sm:w-auto sm:self-end"
        >
          Nouveau test
          <ArrowRight size={16} />
        </Link>
      </section>

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
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Tests totaux" value={stats.total} />
          <StatCard
            label="Réussis"
            value={stats.passed}
            tone="success"
            sublabel={passRate !== null ? `${passRate}%` : undefined}
          />
          <StatCard
            label="Échoués"
            value={stats.failed}
            tone={stats.failed > 0 ? "danger" : "neutral"}
          />
          <StatCard
            label="Avertissements"
            value={stats.warnings}
            tone={stats.warnings > 0 ? "warning" : "neutral"}
            sublabel="Runs avec au moins un avertissement"
          />
        </section>
      )}

      {runs && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-text-muted">Runs récents</h2>
          </div>

          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mx-4 px-4 md:mx-0 md:px-0 scrollbar-none">
              {FILTERS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full whitespace-nowrap transition-colors ${
                    filter === key
                      ? "gradient-accent text-white"
                      : "bg-surface-raised text-text-muted border border-border"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {runs.length > 0 && (
              <div className="relative md:w-72 shrink-0">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Rechercher par ticket ou URL..."
                  className="w-full bg-surface-raised border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent-blue"
                />
              </div>
            )}
          </div>

          {visibleRuns.length === 0 ? (
            <p className="text-sm text-text-faint">
              {runs.length === 0
                ? "Aucun run pour l'instant — lance ton premier test."
                : "Aucun run ne correspond à ce filtre."}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {visibleRuns.slice(0, 10).map((run) => (
                <RunListItem key={run.runId} run={run} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}