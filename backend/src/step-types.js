/**
 * Types d'étape qui n'agissent pas sur un élément précis de la page, donc sans sélecteur.
 * Partagé par planner.js (validation du scénario) et runner.js (exécution) : une seule liste,
 * pour qu'ils ne puissent pas se contredire.
 */
export const STEPS_WITHOUT_SELECTOR = ["navigate", "go_back", "assert_url"];
