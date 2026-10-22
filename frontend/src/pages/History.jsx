import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, ChevronRight } from "lucide-react";
import StatCard from "../components/StatCard.jsx";
import { TrendBadge, RunStrip, RunDots, DurationLine } from "../components/HistoryCharts.jsx";
import { getHistory } from "../lib/api.js";
import { formatDuration } from "../lib/format.js";
import { browserEngineLabel } from "../lib/browser-engines.js";

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function rateTone(rate) {
  if (rate === null) return "neutral";
  if (rate >= 80) return "success";
  if (rate >= 50) return "warning";
  return "danger";
}

function TicketCard({ ticket }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-sm font-medium break-words">{ticket.ticketSummary}</span>
          <span className="text-xs text-text-faint font-mono truncate">
            {hostOf(ticket.url)} · {browserEngineLabel(ticket.browserEngine)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TrendBadge trend={ticket.trend} />
          {ticket.slower && (
            <span className="text-[11px] font-medium px-2 py-1 rounded-full bg-warning-muted text-warning">
              De plus en plus lent
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <RunDots runs={ticket.runs} />
        <DurationLine runs={ticket.runs} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
        <span>
          {ticket.total} run{ticket.total > 1 ? "s" : ""} · {ticket.passRate} % de réussite
          {ticket.avgDurationMs ? ` · ${formatDuration(ticket.avgDurationMs)} en moyenne` : ""}
          {ticket.lastFailureCode ? ` · dernier échec ${ticket.lastFailureCode}` : ""}
        </span>
        <Link to={`/reports/${ticket.lastRunId}`} className="flex items-center gap-1 text-accent-blue">
          Dernier rapport <ChevronRight size={14} />
        </Link>
      </div>
    </div>
  );
}

export default function History() {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getHistory()
      .then(setHistory)
      .catch((err) => setError(err.message));
  }, []);

  const overall = history?.overall;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Historique</h1>
        <p className="text-sm text-text-muted">
          Tendances de tes tests : réussite, durée, instabilité et erreurs qui reviennent.
        </p>
      </header>

      {error && (
        <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">{error}</div>
      )}

      {!history && !error && (
        <div className="flex items-center justify-center gap-2 text-text-muted text-sm py-8">
          <Loader2 size={16} className="animate-spin" />
          Chargement...
        </div>
      )}

      {history && overall.total === 0 && (
        <p className="text-sm text-text-faint">Aucun run terminé pour l'instant : lance un test depuis « New Run ».</p>
      )}

      {history && overall.total > 0 && (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard
              label="Runs terminés"
              value={overall.total}
              sublabel={`${overall.passed} réussis · ${overall.failed} échoués · ${overall.errored} en erreur`}
            />
            <StatCard
              label="Taux de réussite"
              value={`${overall.passRate} %`}
              tone={rateTone(overall.passRate)}
              sublabel={`sur ${overall.distinctTickets} ticket${overall.distinctTickets > 1 ? "s" : ""} différent${overall.distinctTickets > 1 ? "s" : ""}`}
            />
            <StatCard
              label="Durée moyenne"
              value={overall.avgDurationMs ? formatDuration(overall.avgDurationMs) : "—"}
              sublabel="d'un run, du début à la fin"
            />
            <StatCard
              label="Runs instables"
              value={overall.flakyRuns}
              tone={overall.flakyRuns > 0 ? "warning" : "success"}
              sublabel="avec une étape réussie après relance"
            />
          </section>

          <section className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-text-muted">Derniers runs</h2>
              <span className="flex items-center gap-3 text-[11px] text-text-faint">
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-success" /> réussi</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-danger" /> échoué</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-warning" /> erreur</span>
                <span>hauteur = durée</span>
              </span>
            </div>
            <RunStrip runs={history.recent} />
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-text-muted">Par ticket (les plus inquiétants d'abord)</h2>
            {history.tickets.map((ticket) => (
              <TicketCard key={`${ticket.url}|${ticket.browserEngine}|${ticket.ticketSummary}|${ticket.lastRunId}`} ticket={ticket} />
            ))}
          </section>

          {history.topErrors.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-text-muted">Erreurs les plus fréquentes</h2>
              <ul className="flex flex-col gap-2">
                {history.topErrors.map((item) => (
                  <li key={item.code} className="bg-surface border border-border rounded-xl px-4 py-3 flex items-start gap-3">
                    <code className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded bg-danger/15 text-danger">{item.code}</code>
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-sm">{item.label ?? "Erreur"}</span>
                      {item.example && <span className="text-xs text-text-faint break-words">{item.example}</span>}
                    </div>
                    <Link to={`/reports/${item.lastRunId}`} className="shrink-0 text-xs text-text-muted whitespace-nowrap">
                      {item.count} fois
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
