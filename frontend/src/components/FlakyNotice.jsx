import { RotateCw } from "lucide-react";

/**
 * Bandeau « test instable » : le run est réussi, mais au moins une étape n'a réussi qu'à la relance.
 * Un test qui passe parfois et échoue parfois est un test (ou une page) à corriger.
 */
export default function FlakyNotice({ runResult }) {
  const count = runResult?.flakySteps ?? 0;
  if (count <= 0) return null;

  return (
    <div className="flex items-start gap-2.5 bg-warning-muted border border-warning/30 text-warning text-sm rounded-xl p-3">
      <RotateCw size={16} className="mt-0.5 shrink-0" />
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">
          Test instable : {count} {count > 1 ? "étapes n'ont" : "étape n'a"} réussi qu'à la relance.
        </span>
        <span className="text-[12px] opacity-90">
          Le test est passé, mais pas du premier coup. Cause fréquente : une page lente ou un contenu qui s'affiche
          en retard. Regarde « 1er essai » sur l'étape concernée.
        </span>
      </div>
    </div>
  );
}
