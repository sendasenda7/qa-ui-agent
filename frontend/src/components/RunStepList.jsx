import { CheckCircle2, XCircle, Loader2, Circle } from "lucide-react";
import { screenshotUrl } from "../lib/api.js";

/** "passed" | "failed" si l'étape est terminée, "running" si c'est l'étape en cours, sinon "pending". */
function getStepState(index, results, currentIndex) {
  const result = results[index];
  if (result) return result.status;
  return index === currentIndex ? "running" : "pending";
}

function StepIcon({ state }) {
  if (state === "passed") return <CheckCircle2 size={16} className="text-success" />;
  if (state === "failed") return <XCircle size={16} className="text-danger" />;
  if (state === "running") return <Loader2 size={16} className="text-accent-blue animate-spin" />;
  return <Circle size={16} className="text-text-faint" />;
}

export default function RunStepList({ steps, results, currentIndex }) {
  if (steps.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-text-muted">Étapes d'exécution</h2>
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => {
          const state = getStepState(index, results, currentIndex);
          const result = results[index];

          return (
            <li
              key={index}
              className={`flex items-start gap-3 bg-surface border rounded-xl p-3 ${
                state === "running" ? "border-accent-blue/50" : "border-border"
              } ${state === "pending" ? "opacity-60" : ""}`}
            >
              <span className="mt-0.5 shrink-0">
                <StepIcon state={state} />
              </span>

              <div className="flex flex-col min-w-0 flex-1 gap-1">
                <span className="text-sm">{step.description}</span>
                {step.selector && (
                  <code className="text-[11px] font-mono text-text-faint truncate">
                    {step.type}('{step.selector}')
                  </code>
                )}
                {result?.error && <span className="text-[11px] text-danger">{result.error}</span>}
                {result && <span className="text-[11px] text-text-faint">{result.durationMs}ms</span>}
              </div>

              {result?.screenshot && (
                <img
                  src={screenshotUrl(result.screenshot)}
                  alt=""
                  className="w-16 h-12 object-cover rounded-lg border border-border shrink-0"
                />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
