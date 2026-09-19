import { useEffect, useState } from "react";

/**
 * Renvoie l'heure courante (en ms), rafraîchie chaque seconde tant que `isActive` est vrai.
 * Sert à faire avancer un chronomètre sans dépendre du rythme des requêtes réseau.
 */
export function useNow(isActive, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isActive) return undefined;

    const intervalId = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(intervalId);
  }, [isActive, intervalMs]);

  return now;
}
