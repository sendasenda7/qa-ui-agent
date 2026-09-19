export default function StatCard({ label, value, sublabel, tone = "neutral" }) {
  const toneClasses = {
    neutral: "text-text",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  };

  return (
    <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-1">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-2xl font-semibold ${toneClasses[tone]}`}>{value}</span>
      {sublabel && <span className="text-xs text-text-faint">{sublabel}</span>}
    </div>
  );
}
