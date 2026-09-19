import { useEffect, useState } from "react";
import { getRun } from "../lib/api.js";

const POLL_INTERVAL_MS = 1000;
// Quelques échecs réseau d'affilée sont tolérés (redémarrage du serveur, lecture pendant
// une écriture...) avant d'afficher une erreur à l'utilisateur.
const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * Suit un run en relisant GET /api/runs/:id chaque seconde, jusqu'à ce qu'il soit terminé
 * (statut différent de "running"). Le polling s'arrête tout seul et se nettoie au démontage.
 *
 * Renvoie { data, error } : data vaut null tant que la première réponse n'est pas arrivée.
 */
export function useRunPolling(runId) {
  // On mémorise à quel run appartiennent les données : si l'id change, on n'affiche
  // jamais les données de l'ancien run.
  const [state, setState] = useState({ runId: null, data: null, error: null });

  useEffect(() => {
    let isCancelled = false;
    let timeoutId;
    let consecutiveErrors = 0;

    async function poll() {
      try {
        const data = await getRun(runId);
        if (isCancelled) return;

        consecutiveErrors = 0;
        setState({ runId, data, error: null });

        if (data.runResult.status !== "running") return; // terminé : on arrête de relire
      } catch (err) {
        if (isCancelled) return;

        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          setState({ runId, data: null, error: err.message });
          return;
        }
      }

      timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
    }

    poll();

    return () => {
      isCancelled = true;
      clearTimeout(timeoutId);
    };
  }, [runId]);

  const isCurrent = state.runId === runId;
  return {
    data: isCurrent ? state.data : null,
    error: isCurrent ? state.error : null,
  };
}
