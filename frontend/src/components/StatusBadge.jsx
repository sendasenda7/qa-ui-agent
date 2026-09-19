const STATUS_STYLES = {
  passed: "bg-success-muted text-success",
  failed: "bg-danger-muted text-danger",
  warning: "bg-warning-muted text-warning",
  running: "bg-accent-blue/15 text-accent-blue",
  error: "bg-danger-muted text-danger",
};

const STATUS_LABELS = {
  passed: "Réussi",
  failed: "Échoué",
  warning: "Avertissement",
  running: "En cours",
  error: "Erreur",
};

export default function StatusBadge({ status }) {
  return (
    <span
      className={`text-[11px] font-medium px-2 py-1 rounded-full ${STATUS_STYLES[status] ?? STATUS_STYLES.running}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
