import { Routes, Route } from "react-router-dom";
import AppShell from "./layout/AppShell.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import NewRun from "./pages/NewRun.jsx";
import LiveRuns from "./pages/LiveRuns.jsx";
import VisualRtl from "./pages/VisualRtl.jsx";
import Reports from "./pages/Reports.jsx";
import ReportDetail from "./pages/ReportDetail.jsx";

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/new-run" element={<NewRun />} />
        <Route path="/live-runs" element={<LiveRuns />} />
        <Route path="/visual-rtl" element={<VisualRtl />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/reports/:id" element={<ReportDetail />} />
      </Routes>
    </AppShell>
  );
}
