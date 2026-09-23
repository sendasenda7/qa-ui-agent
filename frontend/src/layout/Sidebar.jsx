import { NavLink } from "react-router-dom";
import {
  Bot,
  LayoutGrid,
  Search,
  Plus,
  Radio,
  Languages,
  FileBarChart,
  LogOut,
} from "lucide-react";
import { logout } from "../lib/api.js";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutGrid, end: true },
  { to: "/explore", label: "Explore", icon: Search },
  { to: "/new-run", label: "New Run", icon: Plus },
  { to: "/live-runs", label: "Live Runs", icon: Radio },
  { to: "/visual-rtl", label: "Visual/RTL", icon: Languages },
  { to: "/reports", label: "Reports", icon: FileBarChart },
];

export default function Sidebar({ onLogout }) {
  function handleLogout() {
    logout();
    onLogout?.();
  }

  return (
    <aside className="hidden md:flex md:w-60 lg:w-64 shrink-0 flex-col border-r border-border bg-surface/40 h-screen sticky top-0">
      <div className="flex items-center gap-2 px-5 h-16 border-b border-border shrink-0">
        <span className="gradient-accent w-8 h-8 rounded-lg flex items-center justify-center shrink-0">
          <Bot size={16} className="text-white" />
        </span>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-sm font-semibold tracking-wide truncate">
            QA-UI AGENT
          </span>
          <span className="text-[11px] text-accent-blue truncate">
            Helpify / Staging
          </span>
        </div>
      </div>

      <nav className="flex-1 flex flex-col gap-1 px-3 py-4 overflow-y-auto">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-surface-raised text-text"
                  : "text-text-muted hover:text-text hover:bg-surface-raised/60"
              }`
            }
          >
            <Icon size={17} strokeWidth={2} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-border shrink-0">
        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-text-muted hover:text-text hover:bg-surface-raised/60 w-full transition-colors"
        >
          <LogOut size={17} strokeWidth={2} />
          Déconnexion
        </button>
      </div>
    </aside>
  );
}
