import { Link } from "react-router-dom";
import { Ticket, Search, PlayCircle, GitCompare, Languages } from "lucide-react";

const STAGES = [
  { label: "Ticket", icon: Ticket, to: "/new-run" },
  { label: "Explore", icon: Search, to: "/explore" },
  { label: "E2E", icon: PlayCircle, to: "/new-run" },
  { label: "Diff", icon: GitCompare, to: "/visual-rtl" },
  { label: "RTL", icon: Languages, to: "/visual-rtl" },
];

/** Illustration des grandes étapes du pipeline (crawl → IA → exécution → diff → i18n). */
export default function PipelineStrip() {
  return (
    <div className="flex items-center justify-between px-2">
      {STAGES.map(({ label, icon: Icon, to }, i) => (
        <div key={label} className="flex items-center flex-1 last:flex-none">
          <Link to={to} className="flex flex-col items-center gap-1.5 shrink-0">
            <span className="w-9 h-9 rounded-full bg-surface-raised border border-border flex items-center justify-center">
              <Icon size={16} className="text-text-muted" />
            </span>
            <span className="text-[10px] text-text-faint">{label}</span>
          </Link>
          {i < STAGES.length - 1 && <span className="flex-1 h-px bg-border mx-1" />}
        </div>
      ))}
    </div>
  );
}