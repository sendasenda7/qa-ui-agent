import { useEffect, useState } from "react";
import { Routes, Route } from "react-router-dom";
import AppShell from "./layout/AppShell.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Explore from "./pages/Explore.jsx";
import NewRun from "./pages/NewRun.jsx";
import LiveRuns from "./pages/LiveRuns.jsx";
import LiveRunDetail from "./pages/LiveRunDetail.jsx";
import VisualRtl from "./pages/VisualRtl.jsx";
import Reports from "./pages/Reports.jsx";
import ReportDetail from "./pages/ReportDetail.jsx";
import { isLoggedIn } from "./lib/api.js";

export default function App() {
  const [authed, setAuthed] = useState(isLoggedIn());

  useEffect(() => {
    // Déclenché par lib/api.js dès qu'une requête renvoie 401 (token expiré/absent),
    // quel que soit l'écran où ça arrive.
    function handleUnauthorized() {
      setAuthed(false);
    }
    window.addEventListener("qa-ui-agent:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("qa-ui-agent:unauthorized", handleUnauthorized);
  }, []);

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return (
    <AppShell onLogout={() => setAuthed(false)}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/explore" element={<Explore />} />
        <Route path="/new-run" element={<NewRun />} />
        <Route path="/live-runs" element={<LiveRuns />} />
        <Route path="/live-runs/:id" element={<LiveRunDetail />} />
        <Route path="/visual-rtl" element={<VisualRtl />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/reports/:id" element={<ReportDetail />} />
      </Routes>
    </AppShell>
  );
}
