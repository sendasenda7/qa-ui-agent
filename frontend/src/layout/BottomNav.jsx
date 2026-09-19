import { NavLink } from "react-router-dom";
import { LayoutGrid, Plus, Radio, Languages, FileBarChart } from "lucide-react";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutGrid },
  { to: "/live-runs", label: "Live Runs", icon: Radio },
  { to: "/new-run", label: "New Run", icon: Plus, primary: true },
  { to: "/visual-rtl", label: "Visual/RTL", icon: Languages },
  { to: "/reports", label: "Reports", icon: FileBarChart },
];

export default function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 border-t border-border bg-surface/95 backdrop-blur">
      <div className="max-w-2xl mx-auto px-4 flex items-end justify-between py-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon, primary }) =>
          primary ? (
            <NavLink
              key={to}
              to={to}
              className="flex flex-col items-center -mt-6"
            >
              <span className="gradient-accent flex items-center justify-center w-12 h-12 rounded-full shadow-lg shadow-accent-violet/30">
                <Icon size={22} className="text-white" strokeWidth={2.5} />
              </span>
              <span className="text-[11px] text-text-muted mt-1">{label}</span>
            </NavLink>
          ) : (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 px-2 py-1.5 rounded-lg transition-colors ${
                  isActive ? "text-text" : "text-text-faint"
                }`
              }
            >
              <Icon size={20} strokeWidth={2} />
              <span className="text-[11px]">{label}</span>
            </NavLink>
          )
        )}
      </div>
    </nav>
  );
}
