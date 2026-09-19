import { useState } from "react";
import { Globe, Sparkles, ShieldCheck, Image as ImageIcon, Loader2 } from "lucide-react";
import PipelineTabs from "../components/PipelineTabs.jsx";
import Toggle from "../components/Toggle.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import { runTestPipeline, screenshotUrl } from "../lib/api.js";

const PROMPT_TEMPLATES = [
  "Tester le multi-langue FR/AR",
  "Vérifier la position du bouton de validation",
  "Vérifier la persistance de session",
];

const BROWSER_ENGINES = ["Chromium", "Firefox", "WebKit"];

export default function NewRun() {
  const [url, setUrl] = useState("https://staging.helpify.tn/auth/login");
  const [ticketText, setTicketText] = useState("");
  const [browserEngine, setBrowserEngine] = useState("Chromium");
  const [checkRtl, setCheckRtl] = useState(true);
  const [checkVisualDiff, setCheckVisualDiff] = useState(true);

  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function handleLaunch() {
    setIsRunning(true);
    setError(null);
    setResult(null);
    try {
      const data = await runTestPipeline({ url, ticketText });
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PipelineTabs currentStep={result ? 4 : 1} />

      <header className="flex flex-col gap-1">
        <span className="text-xs text-accent-blue font-medium">
          {result ? "Étape 4 sur 6 — Résultat d'exécution" : "Étape 1 sur 6"}
        </span>
        <h1 className="text-xl font-semibold">Nouvelle configuration de test</h1>
        <p className="text-sm text-text-muted">
          Configure l'URL cible et décris le ticket à tester — le crawler et l'IA
          s'occupent du reste.
        </p>
      </header>

      {/* URL cible */}
      <section className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Globe size={14} />
          URL DE L'ENVIRONNEMENT CIBLE
        </div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://staging.exemple.com"
          className="bg-surface-raised border border-border rounded-lg px-3 py-2 text-sm font-mono text-text placeholder:text-text-faint focus:outline-none focus:border-accent-blue"
        />
        <span className="text-[11px] text-text-faint">Staging</span>
      </section>

      {/* Prompt en langage naturel */}
      <section className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <Sparkles size={14} />
            TICKET / SCÉNARIO EN LANGAGE NATUREL
          </div>
        </div>
        <textarea
          value={ticketText}
          onChange={(e) => setTicketText(e.target.value)}
          rows={4}
          placeholder='Ex : "Vérifier que le bouton Retour conserve le contexte sur les flux Famille/Bénéficiaire"'
          className="bg-surface-raised border border-border rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-faint resize-none focus:outline-none focus:border-accent-blue"
        />
        <div className="flex flex-wrap gap-2">
          {PROMPT_TEMPLATES.map((template) => (
            <button
              key={template}
              type="button"
              onClick={() => setTicketText(template)}
              className="text-[11px] text-text-muted border border-border rounded-full px-3 py-1 hover:border-accent-blue hover:text-text transition-colors"
            >
              + {template}
            </button>
          ))}
        </div>
      </section>

      {/* Pipeline d'exécution */}
      <section className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-4">
        <div className="text-xs text-text-muted">PIPELINE D'EXÉCUTION</div>

        <div className="flex flex-col gap-2">
          <span className="text-sm">Moteur de navigateur</span>
          <div className="grid grid-cols-3 gap-2">
            {BROWSER_ENGINES.map((engine) => (
              <button
                key={engine}
                type="button"
                onClick={() => setBrowserEngine(engine)}
                className={`text-sm rounded-lg py-2 border transition-colors ${
                  browserEngine === engine
                    ? "border-accent-blue bg-accent-blue/10 text-text"
                    : "border-border text-text-muted"
                }`}
              >
                {engine}
              </button>
            ))}
          </div>
          {browserEngine !== "Chromium" && (
            <span className="text-[11px] text-warning">
              Seul Chromium est branché sur le backend pour l'instant.
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-start gap-2">
            <ShieldCheck size={16} className="text-text-muted mt-0.5 shrink-0" />
            <div className="flex flex-col">
              <span className="text-sm">RTL &amp; localisation FR/AR</span>
              <span className="text-[11px] text-text-faint">
                Vérifie la direction RTL et détecte les textes non traduits
              </span>
            </div>
          </div>
          <Toggle checked={checkRtl} onChange={setCheckRtl} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-start gap-2">
            <ImageIcon size={16} className="text-text-muted mt-0.5 shrink-0" />
            <div className="flex flex-col">
              <span className="text-sm">Régression visuelle</span>
              <span className="text-[11px] text-text-faint">
                Compare les captures d'écran entre deux runs (diff pixel)
              </span>
            </div>
          </div>
          <Toggle checked={checkVisualDiff} onChange={setCheckVisualDiff} />
        </div>
      </section>

      <button
        type="button"
        onClick={handleLaunch}
        disabled={!url || !ticketText || isRunning}
        className="gradient-accent rounded-xl py-3 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {isRunning && <Loader2 size={16} className="animate-spin" />}
        {isRunning ? "Crawl + IA + exécution en cours..." : "Lancer le test"}
      </button>

      {error && (
        <div className="bg-danger-muted border border-danger/30 text-danger text-sm rounded-xl p-3">
          {error}
          <div className="text-[11px] text-text-faint mt-1">
            Vérifie que le serveur backend tourne bien (npm run server dans le dossier backend).
          </div>
        </div>
      )}

      {result && (
        <section className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Résultat d'exécution</span>
            <StatusBadge status={result.runResult.status} />
          </div>
          <span className="text-xs text-text-faint">
            {result.runResult.stepsPassed}/{result.runResult.stepsTotal} étapes réussies
          </span>

          <div className="flex flex-col gap-2">
            {result.runResult.results.map((step) => (
              <div
                key={step.index}
                className="flex items-center gap-3 bg-surface-raised border border-border rounded-lg p-2"
              >
                {step.screenshot && (
                  <img
                    src={screenshotUrl(step.screenshot)}
                    alt={step.description}
                    className="w-14 h-10 object-cover rounded-md border border-border shrink-0"
                  />
                )}
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-xs truncate">{step.description}</span>
                  {step.error && (
                    <span className="text-[11px] text-danger truncate">{step.error}</span>
                  )}
                </div>
                <StatusBadge status={step.status === "passed" ? "passed" : "failed"} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
