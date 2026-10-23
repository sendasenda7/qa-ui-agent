import { useState } from "react";
import { Download, Copy, Check, Film } from "lucide-react";
import { traceUrl } from "../lib/api.js";

const SHOW_TRACE_COMMAND = "npx playwright show-trace";

/**
 * Trace Playwright d'un run en échec : un zip qu'on rejoue pas à pas (actions, captures avant/après,
 * DOM, réseau, console). Deux cas particuliers sont expliqués plutôt que de laisser un trou :
 * pas de trace parce que le scénario utilise des identifiants secrets, ou aucune trace (run réussi
 * ou run enregistré avant cette fonction : on n'affiche alors rien).
 */
export default function TraceNote({ runResult }) {
  const [copied, setCopied] = useState(false);

  if (runResult.traceSkipped === "secrets" && runResult.status === "failed") {
    return (
      <div className="flex items-start gap-2 bg-surface border border-border rounded-xl p-3 text-[11px] text-text-faint">
        <Film size={14} className="mt-0.5 shrink-0" />
        <span>
          Pas de trace Playwright pour ce run : le scénario utilise des identifiants secrets, et une trace les
          contiendrait en clair.
        </span>
      </div>
    );
  }

  const url = traceUrl(runResult.tracePath);
  if (!url) return null;

  const fileName = `${runResult.runId}.zip`;
  const command = `${SHOW_TRACE_COMMAND} ${fileName}`;

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Presse-papiers indisponible (page non sécurisée) : la commande reste affichée, on la copie à la main.
    }
  }

  return (
    <div className="flex flex-col gap-2 bg-surface border border-border rounded-xl p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="flex items-center gap-2 text-sm">
          <Film size={14} className="text-text-muted" />
          Trace Playwright rejouable
        </span>
        <a
          href={url}
          download={fileName}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-surface-raised"
        >
          <Download size={13} />
          Télécharger la trace
        </a>
      </div>
      <p className="text-[11px] text-text-faint">
        Rejoue le test action par action (captures avant/après, page, réseau, console). Depuis le dossier où
        tu as téléchargé le fichier :
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate text-[11px] font-mono bg-bg rounded-lg px-2 py-1.5 border border-border">
          {command}
        </code>
        <button
          type="button"
          onClick={copyCommand}
          title="Copier la commande"
          className="shrink-0 p-1.5 rounded-lg border border-border hover:bg-surface-raised"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <p className="text-[11px] text-text-faint">
        Ou glisse le fichier dans trace.playwright.dev (tout se passe dans ton navigateur, rien n'est envoyé).
      </p>
    </div>
  );
}
