import { Ticket, Search, PlayCircle, GitCompare, Languages } from "lucide-react";

const STAGES = [
  { label: "Ticket", icon: Ticket },
  { label: "Explore", icon: Search },
  { label: "E2E", icon: PlayCircle },
  { label: "Diff", icon: GitCompare },
  { label: "RTL", icon: Languages },
];

/** Illustration des grandes étapes du pipeline (crawl → IA → exécution → diff → i18n). */
export default function PipelineStrip() {
  return (
    <div className="flex items-center justify-between px-2">
      {STAGES.map(({ label, icon: Icon }, i) => (
        <div key={label} className="flex items-center flex-1 last:flex-none">
          <div className="flex flex-col items-center gap-1.5 shrink-0">
            <span className="w-9 h-9 rounded-full bg-surface-raised border border-border flex items-center justify-center">
              <Icon size={16} className="text-text-muted" />
            </span>
            <span className="text-[10px] text-text-faint">{label}</span>
          </div>
          {i < STAGES.length - 1 && <span className="flex-1 h-px bg-border mx-1" />}
        </div>
      ))}
    </div>
  );
}