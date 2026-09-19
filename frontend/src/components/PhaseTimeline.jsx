import { CheckCircle2, XCircle, Loader2, Circle } from "lucide-react";

const PHASES = ["crawling", "planning", "running"];

/**
 * Index de la phase en cours (0 = exploration, 1 = scénario IA, 2 = exécution, 3 = tout est fini).
 * Les anciens runs n'ont pas de champ `phase` : ils sont forcément terminés.
 */
function getActiveIndex({ phase, status, crawl, stepsTotal }) {
  if (status === "error") {
    // Le pipeline a planté : on retrouve à quelle phase d'après ce qui a déjà été produit.
    if (!crawl) return 0;
    if (!stepsTotal) return 1;
    return 2;
  }
  const index = PHASES.indexOf(phase);
  return index === -1 ? PHASES.length : index;
}

function PhaseIcon({ state }) {
  if (state === "done") return <CheckCircle2 size={18} className="text-success" />;
  if (state === "failed") return <XCircle size={18} className="text-danger" />;
  if (state === "active") return <Loader2 size={18} className="text-accent-blue animate-spin" />;
  return <Circle size={18} className="text-text-faint" />;
}

const PHASE_LABELS = [
  "Exploration de la page",
  "Scénario généré par l'IA",
  "Exécution dans le navigateur",
];

/** Petit texte sous le titre de chaque phase, selon son état ("pending" | "active" | "done" | "failed"). */
function describePhase(index, state, { crawl, stepsTotal, stepsRun }) {
  if (state === "failed" && index < PHASES.length - 1) return "Échec de cette phase";

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

  if (state === "pending") return "En attente du scénario";
  return `${stepsRun} sur ${stepsTotal} étapes terminées`;
}

export default function PhaseTimeline({ run }) {
  const activeIndex = getActiveIndex(run);

  return (
    <ol className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-3">
      {PHASE_LABELS.map((label, index) => {
        let state = "pending";
        if (index < activeIndex) state = "done";
        else if (index === activeIndex) state = run.status === "error" ? "failed" : "active";
        // Un test dont une étape a échoué : la dernière phase est terminée mais en échec.
        if (run.status === "failed" && index === PHASES.length - 1) state = "failed";

        return (
          <li key={label} className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0">
              <PhaseIcon state={state} />
            </span>
            <div className="flex flex-col min-w-0">
              <span className={`text-sm ${state === "pending" ? "text-text-faint" : "text-text"}`}>
                {label}
              </span>
              <span className="text-[11px] text-text-faint">{describePhase(index, state, run)}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
