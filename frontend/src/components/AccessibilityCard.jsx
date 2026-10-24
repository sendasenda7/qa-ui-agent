import AnalysisCard from "./AnalysisCard.jsx";

const IMPACT_LABELS = { critical: "Critique", serious: "Grave", moderate: "Modéré", minor: "Mineur" };
const IMPACT_STYLES = {
  critical: "bg-danger-muted text-danger",
  serious: "bg-danger-muted text-danger",
  moderate: "bg-warning-muted text-warning",
  minor: "bg-surface-raised text-text-muted",
};
const IMPACTS = ["critical", "serious", "moderate", "minor"];

function Message({ children, danger = false }) {
  return <p className={`text-sm ${danger ? "text-danger" : "text-text-faint"}`}>{children}</p>;
}

function ImpactChip({ impact, children }) {
  return (
    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${IMPACT_STYLES[impact]}`}>
      {children ?? IMPACT_LABELS[impact]}
    </span>
  );
}

function pathOf(url) {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

function Rule({ rule }) {
  return (
    <details className="bg-bg border border-border rounded-lg">
      <summary className="cursor-pointer select-none px-3 py-2 flex flex-wrap items-center gap-2 text-sm">
        <ImpactChip impact={rule.impact} />
        <span className="flex-1 min-w-0 break-words">{rule.help}</span>
        <span className="text-[11px] text-text-faint whitespace-nowrap">
          {rule.nodesCount} élément{rule.nodesCount > 1 ? "s" : ""}
        </span>
      </summary>
      <div className="px-3 pb-3 flex flex-col gap-2">
        {rule.description && <p className="text-[11px] text-text-muted">{rule.description}</p>}
        <ul className="flex flex-col gap-2">
          {rule.nodes.map((node, index) => (
            <li key={`${node.target}-${index}`} className="flex flex-col gap-1 border-l-2 border-border pl-2">
              <code className="text-[11px] font-mono text-accent-blue break-all">{node.target}</code>
              {node.html && <code className="text-[11px] font-mono text-text-faint break-all">{node.html}</code>}
              {node.summary && <p className="text-[11px] text-text-muted whitespace-pre-line break-words">{node.summary}</p>}
            </li>
          ))}
        </ul>
        {rule.nodesCount > rule.nodes.length && (
          <p className="text-[11px] text-text-faint">
            … et {rule.nodesCount - rule.nodes.length} autre{rule.nodesCount - rule.nodes.length > 1 ? "s" : ""} élément
            {rule.nodesCount - rule.nodes.length > 1 ? "s" : ""} concerné{rule.nodesCount - rule.nodes.length > 1 ? "s" : ""}.
          </p>
        )}
        {rule.helpUrl && (
          <a href={rule.helpUrl} target="_blank" rel="noreferrer" className="text-[11px] text-accent-blue">
            Comment corriger (règle « {rule.id} »)
          </a>
        )}
      </div>
    </details>
  );
}

function PageBlock({ page }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium break-words">{page.title || "(page sans titre)"}</span>
          <span className="text-[11px] text-text-faint font-mono truncate">{pathOf(page.url)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {page.counts.total === 0 ? (
            <span className="text-[11px] text-success">Aucun problème détecté</span>
          ) : (
            IMPACTS.filter((impact) => page.counts[impact] > 0).map((impact) => (
              <ImpactChip key={impact} impact={impact}>
                {page.counts[impact]} {IMPACT_LABELS[impact].toLowerCase()}
                {page.counts[impact] > 1 && impact !== "critical" ? "s" : ""}
              </ImpactChip>
            ))
          )}
        </div>
      </div>
      {page.violations.map((rule) => (
        <Rule key={rule.id} rule={rule} />
      ))}
      {page.needsReview > 0 && (
        <p className="text-[11px] text-text-faint">
          {page.needsReview} point{page.needsReview > 1 ? "s" : ""} que l'outil n'a pas pu trancher : à vérifier à la main.
        </p>
      )}
    </div>
  );
}

/** Audit d'accessibilité (axe-core) : un bloc par page rencontrée pendant le test. */
export default function AccessibilityCard({ enabled, accessibility }) {
  const title = "Accessibilité (WCAG, axe-core)";
  if (!enabled && !accessibility) {
    return (
      <AnalysisCard title={title} badge="Non activé">
        <Message>Interrupteur désactivé au lancement de ce test.</Message>
      </AnalysisCard>
    );
  }
  if (!accessibility) {
    return (
      <AnalysisCard title={title} badge="En attente" tone="warning">
        <Message>L'audit n'a pas produit de résultat (run interrompu ?).</Message>
      </AnalysisCard>
    );
  }
  if (accessibility.status === "error") {
    return (
      <AnalysisCard title={title} badge="Audit impossible" tone="warning">
        <Message danger>{accessibility.error}</Message>
      </AnalysisCard>
    );
  }
  if (!accessibility.pages?.length) {
    return (
      <AnalysisCard title={title} badge="Aucune page auditée" tone="warning">
        <Message>Le test n'a atteint aucune page à auditer (ouverture de la page échouée ?).</Message>
      </AnalysisCard>
    );
  }

  const { totals } = accessibility;
  const tone = totals.critical + totals.serious > 0 ? "danger" : totals.total > 0 ? "warning" : "success";
  const badge = totals.total === 0 ? "Aucun problème détecté" : `${totals.total} problème${totals.total > 1 ? "s" : ""}`;

  return (
    <AnalysisCard title={title} badge={badge} tone={tone}>
      <p className="text-sm">
        {accessibility.pages.length} page{accessibility.pages.length > 1 ? "s" : ""} auditée
        {accessibility.pages.length > 1 ? "s" : ""} pendant le test.
      </p>
      {accessibility.pages.map((page) => (
        <PageBlock key={page.url} page={page} />
      ))}
      {accessibility.partialError && (
        <p className="text-[11px] text-warning">Une page n'a pas pu être auditée : {accessibility.partialError}</p>
      )}
      <p className="text-[11px] text-text-faint">
        Détection automatique (WCAG 2.0 / 2.1, niveaux A et AA) : elle ne repère qu'une partie des problèmes, environ un tiers.
        « Aucun problème détecté » ne prouve pas que la page est accessible : complète avec un test manuel (clavier seul, lecteur d'écran).
      </p>
    </AnalysisCard>
  );
}
