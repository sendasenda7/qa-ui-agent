// Données d'exemple, en attendant de brancher le dashboard sur l'API du backend
// (voir backend/src/test-run.js, visual-diff.js, localization-check.js pour les vraies formes de données).

export const mockRecentRuns = [
  {
    ticketSummary: "Vérifier que je peux choisir Je suis un Donateur puis continuer",
    url: "https://staging.helpify.tn/auth/login",
    status: "passed",
    stepsPassed: 5,
    stepsTotal: 5,
  },
  {
    ticketSummary: "Vérifier que le bouton Retour conserve le contexte",
    url: "https://staging.helpify.tn/famille/beneficiaires",
    status: "warning",
    stepsPassed: 4,
    stepsTotal: 5,
  },
  {
    ticketSummary: "Vérifier que le footer est traduit en arabe",
    url: "https://staging.helpify.tn/auth/login",
    status: "failed",
    stepsPassed: 1,
    stepsTotal: 3,
  },
];

export const mockStats = {
  totalRuns: 24,
  passed: 19,
  failed: 3,
  warnings: 2,
  visualRegressions: 1,
  i18nFindings: 1,
};
