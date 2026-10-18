import StepFailure from "./StepFailure.jsx";

/**
 * Erreur qui a interrompu tout le run (site injoignable, page vide, IA sans étape...).
 * Les runs récents ont un détail structuré (`failure`) : code, attendu / trouvé, piste.
 * Les anciens n'ont que le texte `error`, affiché dans l'encadré rouge d'avant.
 */
export default function RunError({ runResult }) {
  if (!runResult?.error) return null;
  if (runResult.failure) return <StepFailure result={runResult} />;
  return (
    <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
      {runResult.error}
    </div>
  );
}
