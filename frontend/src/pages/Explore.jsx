import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Search, ArrowRight } from "lucide-react";
import PipelineTabs from "../components/PipelineTabs.jsx";
import { crawlOnly, screenshotUrl } from "../lib/api.js";

/** Badge résumant comment un sélecteur a été trouvé, dans le même esprit que planner.js. */
function ElementBadges({ el }) {
  const isHeuristic = el.detectedBy?.startsWith("heuristique");
  return (
    <div className="flex flex-wrap gap-1">
      <span className="text-[10px] font-mono text-text-faint bg-surface-raised rounded px-1.5 py-0.5">
        {el.selectorStrategy}
      </span>
      {isHeuristic && (
        <span className="text-[10px] text-warning bg-warning-muted rounded px-1.5 py-0.5">
          heuristique
        </span>
      )}
      {el.disabledLooking && (
        <span className="text-[10px] text-text-faint bg-surface-raised rounded px-1.5 py-0.5">
          désactivé au chargement
        </span>
      )}
    </div>
  );
}

export default function Explore() {
  const [url, setUrl] = useState("https://staging.helpify.tn/auth/login");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function handleExplore() {
    setIsLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await crawlOnly({ url }));
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }

  const heuristicCount = result?.elements.filter((el) => el.detectedBy?.startsWith("heuristique")).length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <PipelineTabs currentStep={2} />

      <header className="flex flex-col gap-1">
        <span className="text-xs text-accent-blue font-medium">Étape 2 sur 6</span>
        <h1 className="text-xl font-semibold">Explorer une page</h1>
        <p className="text-sm text-text-muted">
          Lance le crawler seul, avant de générer un scénario, pour vérifier quels éléments
          interactifs il détecte réellement et avec quel sélecteur.
        </p>
      </header>

      <section className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Search size={14} />
          URL À EXPLORER
        </div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://staging.exemple.com"
          className="bg-surface-raised border border-border rounded-lg px-3 py-2 text-sm font-mono text-text placeholder:text-text-faint focus:outline-none focus:border-accent-blue"
        />
        <button
          type="button"
          onClick={handleExplore}
          disabled={!url || isLoading}
          className="gradient-accent rounded-lg py-2 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {isLoading && <Loader2 size={14} className="animate-spin" />}
          {isLoading ? "Exploration en cours..." : "Explorer"}
        </button>
      </section>

      {error && (
        <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
          {error}
          <div className="text-[11px] text-text-faint mt-1">
            Vérifie que le serveur backend tourne (npm run server dans le dossier backend).
          </div>
        </div>
      )}

      {result && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-surface border border-border rounded-xl p-3 flex flex-col gap-1">
              <span className="text-[11px] text-text-faint">Éléments trouvés</span>
              <span className="text-lg font-semibold">{result.elementCount}</span>
            </div>
            <div className="bg-surface border border-border rounded-xl p-3 flex flex-col gap-1">
              <span className="text-[11px] text-text-faint">Dont heuristiques</span>
              <span className={`text-lg font-semibold ${heuristicCount > 0 ? "text-warning" : "text-text"}`}>
                {heuristicCount}
              </span>
            </div>
            <div className="bg-surface border border-border rounded-xl p-3 flex flex-col gap-1">
              <span className="text-[11px] text-text-faint">Durée</span>
              <span className="text-lg font-semibold">{result.durationMs}ms</span>
            </div>
          </div>

          {result.screenshotPath && (
            <img
              src={screenshotUrl(result.screenshotPath)}
              alt={result.title}
              className="rounded-xl border border-border w-full"
            />
          )}

          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-text-muted">
              Éléments interactifs détectés ({result.elements.length})
            </h2>
            {result.elements.map((el) => (
              <div key={el.index} className="bg-surface border border-border rounded-xl p-3 flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm truncate">
                    {el.accessibleName || <span className="text-text-faint italic">sans libellé</span>}
                  </span>
                  <span className="text-[10px] text-text-faint uppercase shrink-0">{el.tag}</span>
                </div>
                <code className="text-[11px] font-mono text-accent-blue truncate">{el.selector}</code>
                <ElementBadges el={el} />
              </div>
            ))}
          </div>

          <Link
            to="/new-run"
            className="border border-border rounded-xl py-3 text-text font-medium text-center flex items-center justify-center gap-2"
          >
            Passer à la génération du scénario
            <ArrowRight size={16} />
          </Link>
        </>
      )}
    </div>
  );
}