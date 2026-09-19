import { Bot } from "lucide-react";

/**
 * Barre supérieure persistante : identité du produit + contexte cible (env. testé)
 * + statut du serveur. Reprend le style des maquettes (logo dégradé, breadcrumb,
 * pastille "Ready").
 */
export default function TopBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/95 backdrop-blur">
      <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="gradient-accent w-7 h-7 rounded-lg flex items-center justify-center shrink-0">
            <Bot size={15} className="text-white" />
          </span>
          <div className="flex flex-col leading-tight min-w-0">
            <span className="text-xs font-semibold tracking-wide truncate">
              QA-UI AGENT
            </span>
            <span className="text-[11px] text-accent-blue truncate">
              Helpify / Staging
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-text-muted shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-success" />
          Ready
        </div>
      </div>
    </header>
  );
}