import { Lightbulb } from "lucide-react";
import { screenshotUrl } from "../lib/api.js";
import { hideBrokenImage } from "../lib/images.js";

function Row({ label, children }) {
  return (
    <p className="text-[11px] text-text-muted break-words">
      <span className="text-text-faint">{label} : </span>
      {children}
    </p>
  );
}

/**
 * Affiche l'échec d'une étape : code stable, phrase lisible, attendu / trouvé, piste d'action, et le
 * message technique d'origine (Playwright) replié. Les anciens runs, enregistrés avant ce format,
 * n'ont que `error` : on l'affiche tel quel.
 */
export default function StepFailure({ result }) {
  if (!result?.error && !result?.failure) return null;

  const failure = result.failure;
  if (!failure) {
    return <span className="text-[11px] text-danger break-words">{result.error}</span>;
  }

  return (
    <div className="flex flex-col gap-1.5 bg-danger-muted border border-danger/30 rounded-lg p-2.5">
      <div className="flex items-start gap-2">
        <code
          title={failure.label}
          className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded bg-danger/15 text-danger"
        >
          {failure.code}
        </code>
        <span className="text-[12px] font-medium text-danger break-words">{result.error}</span>
      </div>

      {failure.expected && <Row label="Attendu">{failure.expected}</Row>}
      {failure.found && <Row label="Trouvé">{failure.found}</Row>}

      {failure.hint && (
        <p className="flex items-start gap-1.5 text-[11px] text-text break-words">
          <Lightbulb size={12} className="mt-0.5 shrink-0 text-warning" />
          <span>{failure.hint}</span>
        </p>
      )}

      {result.failureScreenshot && screenshotUrl(result.failureScreenshot) && (
        <a
          href={screenshotUrl(result.failureScreenshot)}
          target="_blank"
          rel="noreferrer"
          className="flex flex-col gap-1 text-[11px] text-text-faint"
        >
          <span>Capture au moment de l'échec (élément visé encadré en rouge) — cliquer pour agrandir</span>
          <img
            src={screenshotUrl(result.failureScreenshot)}
            alt="Page au moment de l'échec, élément visé encadré en rouge"
            onError={hideBrokenImage}
            className="w-full max-w-xl rounded-lg border border-danger/30"
          />
        </a>
      )}

      {failure.technical && (
        <details className="text-[11px] text-text-faint">
          <summary className="cursor-pointer select-none">Détails techniques</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] text-text-faint">
            {failure.technical}
          </pre>
        </details>
      )}
    </div>
  );
}
