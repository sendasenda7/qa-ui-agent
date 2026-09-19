import BottomNav from "./BottomNav.jsx";

export default function AppShell({ children }) {
  return (
    <div className="min-h-screen bg-bg text-text flex flex-col">
      <main className="flex-1 pb-24 max-w-2xl w-full mx-auto px-4 pt-6">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
