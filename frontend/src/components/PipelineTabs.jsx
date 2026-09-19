const STEPS = ["Ticket", "Explore", "AI Plan", "Run", "Regressions", "Report"];

export default function PipelineTabs({ currentStep }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1 -mx-4 px-4 scrollbar-none">
      {STEPS.map((label, i) => {
        const stepNumber = i + 1;
        const isActive = stepNumber === currentStep;
        const isDone = stepNumber < currentStep;

        return (
          <div key={label} className="flex items-center gap-1 shrink-0">
            <span
              className={`text-xs whitespace-nowrap px-2 py-1 rounded-md font-medium transition-colors ${
                isActive
                  ? "text-text bg-surface-raised"
                  : isDone
                    ? "text-accent-blue"
                    : "text-text-faint"
              }`}
            >
              {stepNumber}. {label}
            </span>
            {stepNumber < STEPS.length && (
              <span className="w-3 h-px bg-border shrink-0" />
            )}
          </div>
        );
      })}
    </div>
  );
}
