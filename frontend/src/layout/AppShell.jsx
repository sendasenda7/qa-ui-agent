import Sidebar from "./Sidebar.jsx";
import TopBar from "./TopBar.jsx";
import BottomNav from "./BottomNav.jsx";

export default function AppShell({ children, onLogout }) {
  return (
    <div className="min-h-screen bg-bg text-text flex">
      <Sidebar onLogout={onLogout} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Barre du haut : seulement sur mobile, la Sidebar la remplace sur desktop */}
        <div className="md:hidden">
          <TopBar onLogout={onLogout} />
        </div>

        <main className="flex-1 pb-24 md:pb-10 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
          {children}
        </main>

        {/* Nav du bas : seulement sur mobile */}
        <div className="md:hidden">
          <BottomNav />
        </div>
      </div>
    </div>
  );
}
