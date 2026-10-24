import AnalysisCard from "./AnalysisCard.jsx";

const RATING_STYLES = {
  good: { label: "Bon", cls: "text-success" },
  "needs-improvement": { label: "À améliorer", cls: "text-warning" },
  poor: { label: "Mauvais", cls: "text-danger" },
};
const SEVERITY_STYLES = {
  high: "bg-danger-muted text-danger",
  medium: "bg-warning-muted text-warning",
  low: "bg-surface-raised text-text-muted",
};
const SEVERITY_LABELS = { high: "Important", medium: "Moyen", low: "Faible" };

function Message({ children, danger = false }) {
  return <p className={`text-sm ${danger ? "text-danger" : "text-text-faint"}`}>{children}</p>;
}

function pathOf(url) {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

function formatMs(value) {
  if (value === null || value === undefined) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(2).replace(".", ",")} s` : `${value} ms`;
}

function formatBytes(bytes) {
  if (!bytes) return "taille inconnue";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo` : `${Math.round(bytes / 1024)} Ko`;
}

function Metric({ label, value, rating }) {
  const style = RATING_STYLES[rating];
  return (
    <div className="flex flex-col gap-0.5 bg-bg border border-border rounded-lg p-2.5 min-w-0">
      <span className="text-[11px] text-text-faint">{label}</span>
      <span className="text-sm font-medium">{value ?? "non mesuré"}</span>
      <span className={`text-[11px] ${style ? style.cls : "text-text-faint"}`}>{style ? style.label : "—"}</span>
    </div>
  );
}

function PageBlock({ page }) {
  const { metrics, ratings } = page;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium break-words">{page.title || "(page sans titre)"}</span>
        <span className="text-[11px] text-text-faint font-mono truncate">{pathOf(page.url)}</span>
      </div>

      {page.notMeasured ? (
        <p className="text-[12px] text-text-faint">
          Page atteinte sans rechargement (application monopage) : les chronométrages du navigateur décrivent la première
          page chargée, pas celle-ci. Elle n'est donc pas notée.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Metric label="TTFB (premier octet)" value={formatMs(metrics.ttfbMs)} rating={ratings.ttfb} />
            <Metric label="FCP (premier contenu)" value={formatMs(metrics.fcpMs)} rating={ratings.fcp} />
            <Metric label="LCP (plus gros élément)" value={formatMs(metrics.lcpMs)} rating={ratings.lcp} />
            <Metric
              label="CLS (décalages)"
              value={metrics.cls === null ? null : String(metrics.cls).replace(".", ",")}
              rating={ratings.cls}
            />
          </div>
          <p className="text-[12px] text-text-muted">
            {metrics.requests} requête{metrics.requests > 1 ? "s" : ""} · {formatBytes(metrics.transferBytes)} transférés
            {metrics.loadMs !== null && <> · chargement complet en {formatMs(metrics.loadMs)}</>}
          </p>
          {page.slowest?.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-text-faint">Ressources les plus lentes</span>
              {page.slowest.map((item) => (
                <div key={item.url} className="flex items-center justify-between gap-2">
                  <code className="text-[11px] font-mono text-accent-blue truncate">{item.url}</code>
                  <span className="text-[11px] text-text-faint whitespace-nowrap">{formatMs(item.durationMs)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {page.issues.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {page.issues.map((issue) => (
            <li key={issue.code} className="flex flex-wrap items-start gap-2 border-l-2 border-border pl-2">
              <span
                className={`text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${SEVERITY_STYLES[issue.severity] ?? SEVERITY_STYLES.low}`}
              >
                {SEVERITY_LABELS[issue.severity] ?? issue.severity}
              </span>
              <code className="text-[10px] font-mono text-text-faint mt-1">{issue.code}</code>
              <p className="text-[12px] text-text basis-full break-words">{issue.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Performance : mesures par page (TTFB, FCP, LCP, CLS, poids), notées selon les seuils de Google. */
export default function PerformanceCard({ enabled, performance }) {
  const title = "Performance (Core Web Vitals)";
  if (!enabled && !performance) {
    return (
      <AnalysisCard title={title} badge="Non activé">
        <Message>Interrupteur désactivé au lancement de ce test.</Message>
      </AnalysisCard>
    );
  }
  if (!performance) {
    return (
      <AnalysisCard title={title} badge="En attente" tone="warning">
        <Message>Le contrôle n'a pas produit de résultat (run interrompu ?).</Message>
      </AnalysisCard>
    );
  }
  if (performance.status === "error") {
    return (
      <AnalysisCard title={title} badge="Contrôle impossible" tone="warning">
        <Message danger>{performance.error}</Message>
      </AnalysisCard>
    );
  }
  if (!performance.pages?.length) {
    return (
      <AnalysisCard title={title} badge="Aucune page mesurée" tone="warning">
        <Message>Le test n'a atteint aucune page à mesurer (ouverture de la page échouée ?).</Message>
      </AnalysisCard>
    );
  }

  const { totals } = performance;
  const tone = totals.high > 0 ? "danger" : totals.issues > 0 ? "warning" : "success";
  const badge = totals.issues === 0 ? "Aucun point faible" : `${totals.issues} point${totals.issues > 1 ? "s" : ""} faible${totals.issues > 1 ? "s" : ""}`;

  return (
    <AnalysisCard title={title} badge={badge} tone={tone}>
      <p className="text-sm">
        {performance.pages.length} page{performance.pages.length > 1 ? "s" : ""} mesurée{performance.pages.length > 1 ? "s" : ""} pendant le test.
      </p>
      {performance.pages.map((page) => (
        <PageBlock key={page.url} page={page} />
      ))}
      {performance.partialError && (
        <p className="text-[11px] text-warning">Une page n'a pas pu être mesurée : {performance.partialError}</p>
      )}
      <p className="text-[11px] text-text-faint">
        Mesure de laboratoire : un seul chargement, depuis la machine qui exécute l'outil. Elle varie d'un test à l'autre et ne
        remplace pas une mesure sur de vrais utilisateurs. LCP et CLS ne sont mesurés que sur Chromium. Seuils : ceux de Google
        (LCP bon sous 2,5 s, CLS bon sous 0,1).
      </p>
    </AnalysisCard>
  );
}
