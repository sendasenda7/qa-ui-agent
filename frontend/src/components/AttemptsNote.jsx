import { RotateCw } from "lucide-react";
import { ordinalFr } from "../lib/attempts.js";

/**
 * Signale une étape qui a été relancée automatiquement :
 *  - réussie à la relance -> « instable » : le test passe, mais il n'est pas fiable ;
 *  - échouée malgré les relances -> le nombre d'essais, pour montrer que ce n'est pas un raté passager.
 * Rien pour une étape du premier coup (et pour les anciens runs, qui n'ont pas `attempts`).
 */
export default function AttemptsNote({ result }) {
  if (!result || !(result.attempts > 1)) return null;

  if (result.status === "passed") {
    return (
      <div className="flex flex-col gap-1">
        <span className="inline-flex items-center gap-1.5 self-start text-[11px] font-medium px-2 py-0.5 rounded-full bg-warning-muted text-warning">
          <RotateCw size={11} />
          Instable : réussi au {ordinalFr(result.attempts)} essai
        </span>
        {result.firstFailure && (
          <span className="text-[11px] text-text-faint break-words">
            1er essai : <code className="font-mono">{result.firstFailure.code}</code> — {result.firstFailure.message}
          </span>
        )}
      </div>
    );
  }

  return <span className="text-[11px] text-text-faint">Échec confirmé après {result.attempts} essais</span>;
}
