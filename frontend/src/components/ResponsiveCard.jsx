import AnalysisCard from "./AnalysisCard.jsx";
import { screenshotUrl } from "../lib/api.js";

const SEVERITY_LABELS = { high: "Important", medium: "Moyen", low: "Faible" };
const SEVERITY_STYLES = {
  high: "bg-danger-muted text-danger",
  medium: "bg-warning-muted text-warning",
  low: "bg-surface-raised text-text-muted",
};

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

function Issue({ issue }) {
  return (
    <li className="flex flex-col gap-1 border-l-2 border-border pl-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${SEVERITY_STYLES[issue.severity] ?? SEVERITY_STYLES.low}`}
        >
          {SEVERITY_LABELS[issue.severity] ?? issue.severity}
        </span>
        <code className="text-[10px] font-mono text-text-faint">{issue.code}</code>
      </div>
      <p className="text-[12px] text-text break-words">{issue.message}</p>
      {issue.examples?.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {issue.examples.map((example) => (
            <li key={example}>
              <code className="text-[11px] font-mono text-accent-blue break-all">{example}</code>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ViewportBlock({ viewport }) {
  const url = screenshotUrl(viewport.screenshot);
  return (
    <div className="flex flex-col gap-2 bg-bg border border-border rounded-lg p-2.5 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{viewport.label}</span>
        <span className="text-[11px] text-text-faint whitespace-nowrap">
          {viewport.width} × {viewport.height}
        </span>
      </div>
      {url && (
        <a href={url} target="_blank" rel="noreferrer" title="Cliquer pour agrandir">
          <img
            src={url}
            alt={`Page en affichage ${viewport.label.toLowerCase()}`}
            className="w-full max-h-48 object-cover object-top rounded-md border border-border"
          />
        </a>
      )}
      {viewport.error ? (
        <p className="text-[11px] text-warning break-words">Contrôle impossible : {viewport.error}</p>
      ) : viewport.issues.length === 0 ? (
        <p className="text-[11px] text-success">Aucun défaut détecté</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {viewport.issues.map((issue) => (
            <Issue key={issue.code} issue={issue} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PageBlock({ page }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium break-words">{page.title || "(page sans titre)"}</span>
        <span className="text-[11px] text-text-faint font-mono truncate">{pathOf(page.url)}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {page.viewports.map((viewport) => (
          <ViewportBlock key={viewport.name} viewport={viewport} />
        ))}
      </div>
    </div>
  );
}

/** Contrôle responsive : chaque page rencontrée est vue en mobile, tablette et bureau. */
export default function ResponsiveCard({ enabled, responsive }) {
  const title = "Responsive (mobile, tablette, bureau)";
  if (!enabled && !responsive) {
    return (
      <AnalysisCard title={title} badge="Non activé">
        <Message>Interrupteur désactivé au lancement de ce test.</Message>
      </AnalysisCard>
    );
  }
  if (!responsive) {
    return (
      <AnalysisCard title={title} badge="En attente" tone="warning">
        <Message>Le contrôle n'a pas produit de résultat (run interrompu ?).</Message>
      </AnalysisCard>
    );
  }
  if (responsive.status === "error") {
    return (
      <AnalysisCard title={title} badge="Contrôle impossible" tone="warning">
        <Message danger>{responsive.error}</Message>
      </AnalysisCard>
    );
  }
  if (!responsive.pages?.length) {
    return (
      <AnalysisCard title={title} badge="Aucune page contrôlée" tone="warning">
        <Message>Le test n'a atteint aucune page à contrôler (ouverture de la page échouée ?).</Message>
      </AnalysisCard>
    );
  }

  const { totals } = responsive;
  const tone = totals.high > 0 ? "danger" : totals.issues > 0 ? "warning" : "success";
  const badge = totals.issues === 0 ? "Aucun défaut détecté" : `${totals.issues} défaut${totals.issues > 1 ? "s" : ""}`;

  return (
    <AnalysisCard title={title} badge={badge} tone={tone}>
      <p className="text-sm">
        {responsive.pages.length} page{responsive.pages.length > 1 ? "s" : ""} vue{responsive.pages.length > 1 ? "s" : ""} en 3
        tailles d'écran pendant le test.
      </p>
      {responsive.pages.map((page) => (
        <PageBlock key={page.url} page={page} />
      ))}
      {responsive.partialError && (
        <p className="text-[11px] text-warning">Une page n'a pas pu être contrôlée : {responsive.partialError}</p>
      )}
      <p className="text-[11px] text-text-faint">
        Le contrôle redimensionne la fenêtre du navigateur : ce n'est pas un vrai téléphone (écran tactile, navigateur mobile).
        Il repère les défauts courants (défilement horizontal, cibles tactiles trop petites, balise viewport) mais pas un
        affichage « moche » ; regarde les captures et complète avec un test sur un vrai appareil.
      </p>
    </AnalysisCard>
  );
}
