import { Trash2 } from "lucide-react";

/** Explique l'absence d'images quand le nettoyage automatique a supprimé les captures et la trace d'un vieux run. */
export default function PurgedNotice({ runResult }) {
  if (!runResult?.artifactsPurgedAt) return null;

  const date = new Date(runResult.artifactsPurgedAt);
  const label = Number.isNaN(date.getTime()) ? "" : ` le ${date.toLocaleDateString("fr-FR")}`;

  return (
    <div className="flex items-start gap-2 bg-surface border border-border rounded-xl p-3 text-[11px] text-text-faint">
      <Trash2 size={14} className="mt-0.5 shrink-0" />
      <span>
        Captures d'écran et trace supprimées{label} par le nettoyage automatique (runs anciens). Les résultats,
        l'historique et les notes sont conservés.
      </span>
    </div>
  );
}
