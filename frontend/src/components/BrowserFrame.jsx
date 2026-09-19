import { screenshotUrl } from "../lib/api.js";

/**
 * Fenêtre de navigateur montrant la dernière capture d'écran du run.
 * Tant que le run tourne, la capture change à chaque étape terminée.
 */
export default function BrowserFrame({ url, screenshot, caption, isLive }) {
  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="flex gap-1.5 shrink-0" aria-hidden="true">
          <span className="w-2.5 h-2.5 rounded-full bg-danger/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-warning/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-success/70" />
        </span>
        <span className="flex-1 min-w-0 truncate text-[11px] font-mono text-text-muted bg-surface-raised rounded-md px-2 py-1">
          {url}
        </span>
        {isLive && (
          <span className="shrink-0 text-[10px] font-medium text-accent-blue bg-accent-blue/15 rounded px-1.5 py-0.5">
            EN DIRECT
          </span>
        )}
      </div>

      <div className="relative aspect-video bg-bg flex items-center justify-center">
        {screenshot ? (
          <img
            src={screenshotUrl(screenshot)}
            alt={caption || "Dernière capture d'écran du test"}
            className="w-full h-full object-contain"
          />
        ) : (
          <span className="text-xs text-text-faint px-6 text-center">
            La première capture apparaîtra dès la fin de la première étape.
          </span>
        )}

        {caption && (
          <span className="absolute left-2 bottom-2 right-2 truncate text-[11px] text-text bg-bg/85 border border-border rounded-md px-2 py-1">
            {caption}
          </span>
        )}
      </div>
    </div>
  );
}
