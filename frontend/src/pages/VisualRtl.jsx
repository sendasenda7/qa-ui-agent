import { useEffect, useState } from "react";
import { Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { checkI18n, compareRuns, getRuns, screenshotUrl } from "../lib/api.js";

const TABS = [
  { id: "i18n", label: "FR/AR + RTL" },
  { id: "visual", label: "Diff visuel" },
];

function SeverityBadge({ severity }) {
  const isHigh = severity === "high";
  return (
    <span
      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
        isHigh ? "bg-danger-muted text-danger" : "bg-warning-muted text-warning"
      }`}
    >
      {isHigh ? "HIGH" : severity.toUpperCase()}
    </span>
  );
}

function I18nTab() {
  const [url, setUrl] = useState("https://staging.helpify.tn/auth/login");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);

  async function handleCheck() {
    setIsLoading(true);
    setError(null);
    setReport(null);
    try {
      setReport(await checkI18n({ url }));
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-3">
        <span className="text-xs text-text-muted">URL À VÉRIFIER</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="bg-surface-raised border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent-blue"
        />
        <button
          type="button"
          onClick={handleCheck}
          disabled={!url || isLoading}
          className="gradient-accent rounded-lg py-2 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {isLoading && <Loader2 size={14} className="animate-spin" />}
          {isLoading ? "Vérification en cours..." : "Vérifier FR/AR + RTL"}
        </button>
      </div>

      {error && (
        <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-1">
              <span className="text-xs text-text-muted">Direction (FR → AR)</span>
              <span className="text-sm font-mono">
                {report.frDir} → {report.arDir}
              </span>
              {report.arDir === "rtl" ? (
                <span className="text-[11px] text-success flex items-center gap-1">
                  <CheckCircle2 size={12} /> RTL appliqué
                </span>
              ) : (
                <span className="text-[11px] text-danger flex items-center gap-1">
                  <AlertTriangle size={12} /> RTL non appliqué
                </span>
              )}
            </div>
            <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-1">
              <span className="text-xs text-text-muted">Éléments comparés</span>
              <span className="text-2xl font-semibold">{report.elementsComparedCount}</span>
              <span className="text-[11px] text-text-faint">
                {report.findingsCount} problème(s) détecté(s)
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-text-muted">
              Localisation &amp; RTL — Résultats
            </h2>
            {report.findings.length === 0 ? (
              <p className="text-sm text-success flex items-center gap-1">
                <CheckCircle2 size={14} /> Aucun problème détecté.
              </p>
            ) : (
              report.findings.map((finding, i) => (
                <div key={i} className="bg-surface border border-border rounded-xl p-3 flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={finding.severity} />
                    <span className="text-xs text-text-faint">{finding.type}</span>
                  </div>
                  <p className="text-sm">{finding.description}</p>
                  {finding.selector && (
                    <code className="text-[11px] font-mono text-text-faint truncate">
                      {finding.selector}
                    </code>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function VisualDiffTab() {
  const [runs, setRuns] = useState(null);
  const [runIdA, setRunIdA] = useState("");
  const [runIdB, setRunIdB] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);
  const [viewMode, setViewMode] = useState("side-by-side"); // "side-by-side" | "diff"

  useEffect(() => {
    getRuns()
      .then(setRuns)
      .catch((err) => setError(err.message));
  }, []);

  async function handleCompare() {
    setIsLoading(true);
    setError(null);
    setReport(null);
    try {
      setReport(await compareRuns({ runIdA, runIdB }));
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-3">
        <span className="text-xs text-text-muted">
          COMPARER DEUX RUNS (même scénario, exécutés à des moments différents)
        </span>
        {!runs && !error && (
          <span className="text-xs text-text-faint flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Chargement des runs...
          </span>
        )}
        {runs && runs.length < 2 && (
          <span className="text-xs text-text-faint">
            Il faut au moins deux runs sauvegardés pour comparer — lance le même test deux fois
            (ou utilise "Relancer ce scénario" depuis un rapport pour garantir un scénario identique).
          </span>
        )}
        {runs && runs.length >= 2 && (
          <>
            <select
              value={runIdA}
              onChange={(e) => setRunIdA(e.target.value)}
              className="bg-surface-raised border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Run A (référence)</option>
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>
                  #{r.runId} — {r.ticketSummary}
                </option>
              ))}
            </select>
            <select
              value={runIdB}
              onChange={(e) => setRunIdB(e.target.value)}
              className="bg-surface-raised border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Run B (à comparer)</option>
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>
                  #{r.runId} — {r.ticketSummary}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleCompare}
              disabled={!runIdA || !runIdB || isLoading}
              className="gradient-accent rounded-lg py-2 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {isLoading && <Loader2 size={14} className="animate-spin" />}
              {isLoading ? "Comparaison en cours..." : "Comparer"}
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
          {error}
        </div>
      )}

      {report && (
        <>
          {report.warnings?.length > 0 && (
            <div className="bg-warning-muted border border-warning/30 rounded-xl p-3 flex flex-col gap-1">
              {report.warnings.map((w, i) => (
                <span key={i} className="text-xs text-warning">
                  ⚠ {w}
                </span>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-1">
              <span className="text-xs text-text-muted">Delta visuel max</span>
              <span
                className={`text-2xl font-semibold ${
                  report.hasRegressions ? "text-danger" : "text-success"
                }`}
              >
                {report.maxDiffPercent !== null ? `${report.maxDiffPercent}%` : "—"}
              </span>
              <span className="text-[11px] text-text-faint">seuil de régression : 0.5%</span>
            </div>
            <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-1">
              <span className="text-xs text-text-muted">Régressions</span>
              <span
                className={`text-2xl font-semibold ${
                  report.regressionCount > 0 ? "text-danger" : "text-text"
                }`}
              >
                {report.regressionCount}
                <span className="text-text-faint text-base"> / {report.stepCount}</span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {[
              { id: "side-by-side", label: "Côte à côte" },
              { id: "diff", label: "Diff (overlay)" },
            ].map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => setViewMode(mode.id)}
                className={`text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${
                  viewMode === mode.id
                    ? "bg-surface-raised text-text border border-accent-blue"
                    : "text-text-faint border border-border"
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-text-muted">
              {report.regressionCount}/{report.stepCount} étape(s) avec régression
            </h2>
            {report.steps.map((step) => (
              <div key={step.index} className="bg-surface border border-border rounded-xl p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm">{step.description}</span>
                  {step.comparable ? (
                    <span
                      className={`text-xs font-mono ${
                        step.isRegression ? "text-danger" : "text-success"
                      }`}
                    >
                      {step.diffPercent}%
                    </span>
                  ) : (
                    <span className="text-xs text-text-faint">non comparable</span>
                  )}
                </div>

                {!step.comparable && step.reason && (
                  <span className="text-[11px] text-text-faint">{step.reason}</span>
                )}

                {step.comparable && viewMode === "side-by-side" && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] text-text-faint">Référence (A)</span>
                      <img
                        src={screenshotUrl(step.screenshotA)}
                        alt={`${step.description} — référence`}
                        className="rounded-lg border border-border w-full"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] text-text-faint">Actuel (B)</span>
                      <img
                        src={screenshotUrl(step.screenshotB)}
                        alt={`${step.description} — actuel`}
                        className={`rounded-lg border w-full ${
                          step.isRegression ? "border-danger" : "border-border"
                        }`}
                      />
                    </div>
                  </div>
                )}

                {step.comparable && viewMode === "diff" && step.diffImagePath && (
                  <img
                    src={screenshotUrl(step.diffImagePath)}
                    alt={`${step.description} — diff pixel`}
                    className="rounded-lg border border-border w-full"
                  />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function VisualRtl() {
  const [activeTab, setActiveTab] = useState("i18n");

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Visual &amp; RTL</h1>
        <p className="text-sm text-text-muted">
          Diff visuel entre deux runs, et vérification FR/AR + RTL.
        </p>
      </header>

      <div className="flex gap-2 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`text-sm px-3 py-2 border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-accent-blue text-text"
                : "border-transparent text-text-faint"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "i18n" ? <I18nTab /> : <VisualDiffTab />}
    </div>
  );
}