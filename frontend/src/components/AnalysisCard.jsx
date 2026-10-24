/** Carte commune aux analyses (RTL, régression visuelle, accessibilité) : titre + badge à droite + contenu. */
export default function AnalysisCard({ title, badge, tone = "neutral", children }) {
  const badgeStyles = {
    success: "bg-success-muted text-success",
    danger: "bg-danger-muted text-danger",
    warning: "bg-warning-muted text-warning",
    neutral: "bg-surface-raised text-text-muted",
  };

  return (
    <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-muted">{title}</span>
        {badge && (
          <span className={`text-[11px] font-medium px-2 py-1 rounded-full ${badgeStyles[tone]}`}>
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

