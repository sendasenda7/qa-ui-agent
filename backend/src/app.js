import { resolve } from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { crawlPage } from "./crawler.js";
import { generateScenario } from "./planner.js";
import { checkLocalization } from "./localization-check.js";
import { compareRuns } from "./visual-diff.js";
import { startRun, startReplay, reserveRunSlot } from "./run-executor.js";
import { listRuns, readRun, saveRun, saveNotes } from "./run-store.js";
import {
  checkPassword,
  issueToken,
  requireAuth,
  requireAuthForFiles,
  rateLimitLogin,
} from "./auth.js";
import { HttpError } from "./http-error.js";
import { assertSafeTargetUrl, isHttpUrl } from "./url-guard.js";
import { isSupportedBrowserEngine, SUPPORTED_BROWSER_ENGINES } from "./browser.js";

// Timeouts par défaut (ms) et bornes acceptées côté API. Le chargement d'une page (crawl,
// navigate) et les étapes d'un scénario (clic, saisie...) n'ont pas le même défaut : le
// premier attend un chargement complet, les secondes une simple interaction.
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
const DEFAULT_STEP_TIMEOUT_MS = 10000;
const MIN_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 120000;
const MAX_NOTES_LENGTH = 5000;

/** Valide et borne un timeout fourni par le client ; renvoie `fallback` si absent/invalide. */
function parseTimeoutMs(value, fallback) {
  const n = Number(value);
  if (!value || !Number.isFinite(n)) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, n));
}

/**
 * Moteur de navigateur demandé par le client : absent → undefined (le backend prendra Chromium).
 * Lève une HttpError(400) si la valeur est inconnue, plutôt que de retomber en silence sur
 * Chromium : l'utilisateur croirait avoir testé sur Firefox.
 */
function parseBrowserEngine(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isSupportedBrowserEngine(value)) {
    throw new HttpError(
      400,
      `browserEngine invalide (attendu : ${SUPPORTED_BROWSER_ENGINES.join(", ")})`
    );
  }
  return value;
}

/**
 * Message d'erreur sûr à renvoyer au client. Les HttpError sont écrites pour lui ; pour les
 * autres, on ne garde que la première ligne (Playwright ajoute un long "Call log" interne),
 * sans chemins du serveur ni clés d'API, et on tronque.
 */
export function publicErrorMessage(err) {
  if (err instanceof HttpError) return err.message;
  const firstLine = String(err?.message || "Erreur interne").split("\n")[0];
  return firstLine
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "[chemin masqué]")
    .replace(/\/(?:home|Users|root|var|tmp|opt|app|usr|etc|mnt)\/[^\s'"]+/g, "[chemin masqué]")
    .replace(/gsk_[A-Za-z0-9]+/g, "[clé masquée]")
    .slice(0, 300);
}

/**
 * Construit l'application Express. Séparée de server.js (qui ne fait que l'écouter sur un port)
 * pour pouvoir la tester avec de vraies requêtes HTTP. L'environnement est lu ICI, à l'appel,
 * donc après le chargement du fichier .env.
 */
export function createApp({ env = process.env } = {}) {
  const app = express();
  const maxConcurrentRuns = Number(env.MAX_CONCURRENT_RUNS) || 2;

  // Derrière un reverse proxy (Nginx, Render, Railway...), req.ip serait l'IP du proxy : tout le
  // monde partagerait le même compteur anti-bruteforce. TRUST_PROXY=1 (nombre de proxys) règle ça.
  if (env.TRUST_PROXY) {
    const value = env.TRUST_PROXY;
    app.set("trust proxy", value === "true" ? true : Number.isNaN(Number(value)) ? value : Number(value));
  }

  // "cross-origin" : le frontend (autre origine que l'API) doit pouvoir afficher les captures.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

  // Seul le frontend est autorisé à appeler l'API depuis un navigateur. À adapter en production
  // avec CORS_ORIGIN (liste séparée par des virgules).
  const allowedOrigins = (env.CORS_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json());

  /** Enveloppe une route async : toute erreur devient une réponse JSON propre. */
  function asyncRoute(handler) {
    return (req, res) => {
      handler(req, res).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (status >= 500) console.error(err);
        res.status(status).json({ error: publicErrorMessage(err) });
      });
    };
  }

  // Connexion : seule route (avec /api/health) accessible sans token.
  app.post("/api/login", rateLimitLogin, (req, res) => {
    const { password } = req.body ?? {};
    try {
      if (!checkPassword(password)) {
        req.recordLoginFailure();
        return res.status(401).json({ error: "Mot de passe incorrect" });
      }
      req.recordLoginSuccess();
      res.json({ token: issueToken() });
    } catch (err) {
      // AUTH_PASSWORD / JWT_SECRET manquant côté serveur — erreur de config, pas de l'utilisateur.
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/health", (req, res) => res.json({ status: "ok" }));

  // Tout ce qui suit exige un token valide dans le header Authorization.
  app.use("/api", requireAuth);

  // Captures d'écran : protégées aussi (elles viennent de staging et peuvent contenir des
  // données réelles). ?token= accepté ici seulement, car une balise <img> n'envoie pas de header.
  app.use("/screenshots", requireAuthForFiles, express.static(resolve("run-screenshots")));
  app.use("/debug-screenshots", requireAuthForFiles, express.static(resolve("debug-screenshots")));
  app.use("/diff-screenshots", requireAuthForFiles, express.static(resolve("diff-screenshots")));

  // Crawl seul (écran "Explore").
  app.post(
    "/api/crawl",
    asyncRoute(async (req, res) => {
      const { url, timeoutMs, browserEngine } = req.body;
      if (!url) throw new HttpError(400, "url manquante");
      await assertSafeTargetUrl(url, { env });
      const engine = parseBrowserEngine(browserEngine);

      const crawlResult = await crawlPage(url, {
        navigationTimeoutMs: parseTimeoutMs(timeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS),
        browserEngine: engine,
      });
      res.json(crawlResult);
    })
  );

  // Crawl + génération du scénario par l'IA (écran "AI Plan").
  app.post(
    "/api/plan",
    asyncRoute(async (req, res) => {
      const { url, ticketText, timeoutMs, deepReview, browserEngine } = req.body;
      if (!url || !ticketText) throw new HttpError(400, "url et ticketText requis");
      await assertSafeTargetUrl(url, { env });
      const engine = parseBrowserEngine(browserEngine);

      const crawlResult = await crawlPage(url, {
        navigationTimeoutMs: parseTimeoutMs(timeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS),
        browserEngine: engine,
      });
      const scenario = await generateScenario(ticketText, crawlResult, { deepReview: !!deepReview });
      res.json({ crawlResult, scenario });
    })
  );

  // Pipeline complet en arrière-plan : on répond tout de suite (202) avec l'identifiant du run,
  // le frontend suit la progression via GET /api/runs/:id.
  app.post(
    "/api/test-run",
    asyncRoute(async (req, res) => {
      const {
        url,
        ticketText,
        timeoutMs,
        navigationTimeoutMs,
        ticketUrl,
        deepReview,
        checkRtl,
        checkVisualDiff,
        browserEngine,
      } = req.body;
      if (!url || !ticketText) throw new HttpError(400, "url et ticketText requis");
      await assertSafeTargetUrl(url, { env });
      if (ticketUrl && !isHttpUrl(ticketUrl)) {
        throw new HttpError(400, "ticketUrl invalide (http:// ou https:// attendu)");
      }
      const engine = parseBrowserEngine(browserEngine);

      // Place réservée de façon synchrone : deux requêtes simultanées ne peuvent plus dépasser la limite.
      const reservation = reserveRunSlot(maxConcurrentRuns);
      if (!reservation) {
        throw new HttpError(
          429,
          `Déjà ${maxConcurrentRuns} runs en cours : attends qu'un run se termine avant d'en lancer un autre.`
        );
      }

      try {
        const stepTimeoutMs = parseTimeoutMs(timeoutMs, DEFAULT_STEP_TIMEOUT_MS);
        const { runId } = await startRun(
          {
            url,
            ticketText,
            timeoutMs: stepTimeoutMs,
            // Chargement de page : 30 s au minimum, ou davantage si l'utilisateur a relevé le timeout des étapes.
            navigationTimeoutMs: parseTimeoutMs(
              navigationTimeoutMs,
              Math.max(DEFAULT_NAVIGATION_TIMEOUT_MS, stepTimeoutMs)
            ),
            ticketUrl: ticketUrl || null,
            deepReview: !!deepReview,
            // Booleans stricts : la chaîne "false" ne doit pas activer l'analyse.
            checkRtl: checkRtl === true,
            checkVisualDiff: checkVisualDiff === true,
            browserEngine: engine,
          },
          {},
          reservation
        );
        res.status(202).json({ runId });
      } finally {
        reservation.release(); // idempotent : libère la place si le démarrage a échoué
      }
    })
  );

  // Rejoue le scénario EXACT d'un run existant (sans crawl ni IA).
  app.post(
    "/api/runs/:id/replay",
    asyncRoute(async (req, res) => {
      const reservation = reserveRunSlot(maxConcurrentRuns);
      if (!reservation) {
        throw new HttpError(
          429,
          `Déjà ${maxConcurrentRuns} runs en cours : attends qu'un run se termine avant d'en lancer un autre.`
        );
      }
      try {
        const { runId } = await startReplay(req.params.id, {}, reservation);
        res.status(202).json({ runId });
      } finally {
        reservation.release();
      }
    })
  );

  // Vérification FR/AR + RTL (écran "Visual & RTL").
  app.post(
    "/api/check-i18n",
    asyncRoute(async (req, res) => {
      const { url, timeoutMs, browserEngine } = req.body;
      if (!url) throw new HttpError(400, "url manquante");
      await assertSafeTargetUrl(url, { env });
      const engine = parseBrowserEngine(browserEngine);

      const report = await checkLocalization(url, {
        navigationTimeoutMs: parseTimeoutMs(timeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS),
        browserEngine: engine,
      });
      res.json(report);
    })
  );

  // Liste des runs, du plus récent au plus ancien. Filtre optionnel : ?status=running
  app.get(
    "/api/runs",
    asyncRoute(async (req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      res.json(await listRuns({ status }));
    })
  );

  // Détail complet d'un run (relu régulièrement par le frontend pendant l'exécution).
  app.get(
    "/api/runs/:id",
    asyncRoute(async (req, res) => {
      const content = await readRun(req.params.id);
      if (!content) throw new HttpError(404, "Run introuvable");
      res.json(content);
    })
  );

  // Notes manuelles libres sur un run : remplacent entièrement les notes existantes. Stockées
  // dans un fichier séparé (voir run-store.js) : plus aucun risque d'écraser l'état du run.
  app.patch(
    "/api/runs/:id/notes",
    asyncRoute(async (req, res) => {
      const { notes } = req.body;
      if (typeof notes !== "string") {
        throw new HttpError(400, "notes doit être une chaîne de caractères");
      }
      if (notes.length > MAX_NOTES_LENGTH) {
        throw new HttpError(400, `notes trop longues (max ${MAX_NOTES_LENGTH} caractères)`);
      }

      const content = await readRun(req.params.id);
      if (!content) throw new HttpError(404, "Run introuvable");

      await saveNotes(req.params.id, notes);
      res.json({ notes });
    })
  );

  // Diff visuel entre deux runs sauvegardés.
  app.post(
    "/api/compare",
    asyncRoute(async (req, res) => {
      const { runIdA, runIdB } = req.body;
      if (!runIdA || !runIdB) throw new HttpError(400, "runIdA et runIdB requis");

      const runA = await readRun(runIdA);
      const runB = await readRun(runIdB);
      if (!runA || !runB) throw new HttpError(404, "Run introuvable");

      res.json(await compareRuns(runA, runB));
    })
  );

  // Route /api inconnue : JSON propre plutôt que la page HTML par défaut d'Express.
  app.use("/api", (req, res) => res.status(404).json({ error: "Route introuvable" }));

  // JSON malformé, corps trop gros... : réponse JSON, sans stack trace.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Erreur interne" : "Requête invalide" });
  });

  return app;
}
