import { CheckCircle2, XCircle, Loader2, Circle } from "lucide-react";

const RUNNING_INDEX = 2; // position de la phase "exécution" dans la liste

const BASE_PHASES = [
  { key: "crawling", label: "Exploration de la page" },
  { key: "planning", label: "Scénario généré par l'IA" },
  { key: "running", label: "Exécution dans le navigateur" },
];
const ANALYSIS_PHASE = { key: "analyzing", label: "Analyse RTL & régression visuelle" };

/** L'analyse n'apparaît dans la liste que si au moins un des deux interrupteurs était activé. */
function getPhases(options) {
  const hasAnalysis = Boolean(options?.checkRtl || options?.checkVisualDiff);
  return hasAnalysis ? [...BASE_PHASES, ANALYSIS_PHASE] : BASE_PHASES;
}

/**
 * Index de la phase en cours (== phases.length quand tout est terminé).
 * Les anciens runs n'ont pas de champ `phase` : ils sont forcément terminés.
 */
function getActiveIndex({ phase, status, crawl, stepsTotal, stepsRun }, phases) {
  if (status === "error") {
    // Le pipeline a planté : on retrouve à quelle phase d'après ce qui a déjà été produit.
    if (!crawl) return 0;
    if (!stepsTotal) return 1;
    const scenarioWasCompleted = stepsRun >= stepsTotal;
    return phases.length > 3 && scenarioWasCompleted ? 3 : RUNNING_INDEX;
  }
  const index = phases.findIndex((candidate) => candidate.key === phase);
  return index === -1 ? phases.length : index;
}

function PhaseIcon({ state }) {
  if (state === "done") return <CheckCircle2 size={18} className="text-success" />;
  if (state === "failed") return <XCircle size={18} className="text-danger" />;
  if (state === "active") return <Loader2 size={18} className="text-accent-blue animate-spin" />;
  return <Circle size={18} className="text-text-faint" />;
}

/** Petit texte sous le titre de chaque phase, selon son état ("pending" | "active" | "done" | "failed"). */
function describePhase(index, state, run, options) {
  const { crawl, stepsTotal, stepsRun } = run;
  if (state === "failed" && index !== RUNNING_INDEX) return "Échec de cette phase";

  if (index === 0) {
    if (state === "active") return "Chargement de la page et analyse du DOM";
    if (crawl) return `${crawl.elementCount} éléments interactifs détectés`;
    return "Terminée";
  }

  if (index === 1) {
    if (state === "pending") return "En attente de l'exploration";
    if (state === "active") return "Analyse du ticket et des éléments détectés";
    return stepsTotal ? `${stepsTotal} étapes prévues` : "Terminée";
  }

  if (index === RUNNING_INDEX) {
    if (state === "pending") return "En attente du scénario";
    return `${stepsRun} sur ${stepsTotal} étapes terminées`;
  }

  // Phase d'analyse : on nomme ce qui est réellement demandé.
  const checks = [options?.checkRtl && "vérification RTL FR/AR", options?.checkVisualDiff && "diff visuel"]
    .filter(Boolean)
    .join(" + ");
  if (state === "pending") return `En attente de la fin du scénario (${checks})`;
  if (state === "active") return `En cours : ${checks}`;
  return `Terminée : ${checks}`;
}

export default function PhaseTimeline({ run, options }) {
  const phases = getPhases(options);
  const activeIndex = getActiveIndex(run, phases);

  return (
    <ol className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-3">
      {phases.map(({ key, label }, index) => {
        let state = "pending";
        if (index < activeIndex) state = "done";
        else if (index === activeIndex) state = run.status === "error" ? "failed" : "active";
        // Un test dont une étape a échoué : la phase d'exécution est terminée mais en échec.
        if (run.status === "failed" && index === RUNNING_INDEX) state = "failed";

        return (
          <li key={key} className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0">
              <PhaseIcon state={state} />
            </span>
            <div className="flex flex-col min-w-0">
              <span className={`text-sm ${state === "pending" ? "text-text-faint" : "text-text"}`}>
                {label}
              </span>
              <span className="text-[11px] text-text-faint">
                {describePhase(index, state, run, options)}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
