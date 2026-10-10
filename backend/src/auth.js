import jwt from "jsonwebtoken";
import { timingSafeEqual } from "crypto";

// Durée de validité d'une session, réglable via JWT_LIFETIME (ex. "12h") dans backend/.env.
const DEFAULT_TOKEN_LIFETIME = "7d";
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 60_000; // 1 minute de blocage après trop d'essais

/**
 * Auth volontairement simple : un seul mot de passe partagé par toute l'équipe
 * (pas de comptes individuels — cet outil ne distingue pas "qui" a lancé un run).
 * Suffisant pour protéger l'accès une fois déployé ; pas pour des permissions fines.
 */
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET manquant dans backend/.env — génère une valeur aléatoire et ajoute-la."
    );
  }
  return secret;
}

/**
 * Compare deux chaînes en temps constant (résiste à une attaque par mesure de temps),
 * plutôt que "a === b" qui s'arrête dès le premier caractère différent. `timingSafeEqual`
 * exige deux buffers de MÊME longueur : on compare d'abord la longueur (une fuite sans
 * conséquence ici, la longueur d'un mot de passe n'aide pas à le deviner), puis complète
 * le plus court pour ne jamais lui faire lever une exception.
 */
function timingSafeStringEqual(a, b) {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    timingSafeEqual(bufferA, Buffer.alloc(bufferA.length)); // occupe un temps comparable
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export function checkPassword(password) {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected) {
    throw new Error(
      "AUTH_PASSWORD manquant dans backend/.env — définis le mot de passe d'équipe."
    );
  }
  return typeof password === "string" && timingSafeStringEqual(password, expected);
}

export function issueToken() {
  return jwt.sign({ role: "team" }, getSecret(), {
    algorithm: "HS256",
    expiresIn: process.env.JWT_LIFETIME || DEFAULT_TOKEN_LIFETIME,
  });
}

/**
 * Anti-bruteforce très simple pour /api/login : après MAX_LOGIN_ATTEMPTS échecs
 * consécutifs pour une même IP, on la bloque pendant LOGIN_LOCKOUT_MS.
 *
 * Volontairement en mémoire (pas de base de données) : cet outil tourne pour une
 * seule équipe sur un seul processus, donc un simple Map suffit. À reconsidérer si
 * le backend tourne un jour derrière plusieurs instances (le compteur ne serait
 * plus partagé entre elles).
 */
const loginAttemptsByIp = new Map();
const MAX_TRACKED_IPS = 10_000;
let lastPurgeAt = 0;

/**
 * Supprime les compteurs devenus inutiles (blocage expiré) : sans cela, la Map grossissait
 * indéfiniment, une entrée par IP ayant déjà échoué une fois. Une IP non bloquée et sans échec
 * récent ne coûte rien à oublier ; en cas de saturation, on repart de zéro plutôt que de
 * consommer toute la mémoire.
 */
function purgeLoginAttempts(now = Date.now()) {
  if (now - lastPurgeAt < LOGIN_LOCKOUT_MS && loginAttemptsByIp.size < MAX_TRACKED_IPS) return;
  lastPurgeAt = now;
  for (const [ip, entry] of loginAttemptsByIp) {
    const lockExpired = entry.lockedUntil && entry.lockedUntil <= now;
    const staleFailures = !entry.lockedUntil && now - (entry.lastFailureAt || 0) > LOGIN_LOCKOUT_MS * 10;
    if (lockExpired || staleFailures) loginAttemptsByIp.delete(ip);
  }
  if (loginAttemptsByIp.size >= MAX_TRACKED_IPS) loginAttemptsByIp.clear();
}

/** Pour les tests. */
export function resetLoginAttempts() {
  loginAttemptsByIp.clear();
  lastPurgeAt = 0;
}

function getLoginAttempts(ip) {
  const entry = loginAttemptsByIp.get(ip);
  if (!entry) return { count: 0, lockedUntil: 0 };
  // Le blocage est expiré : on repart sur une ardoise vierge plutôt que de garder
  // un vieux compteur qui bloquerait à nouveau au premier échec.
  if (entry.lockedUntil && entry.lockedUntil <= Date.now()) return { count: 0, lockedUntil: 0 };
  return entry;
}

/** Middleware Express : bloque une IP après trop d'échecs de mot de passe. */
export function rateLimitLogin(req, res, next) {
  purgeLoginAttempts();
  const ip = req.ip;
  const { count, lockedUntil } = getLoginAttempts(ip);

  if (lockedUntil > Date.now()) {
    const retryAfterSeconds = Math.ceil((lockedUntil - Date.now()) / 1000);
    res.set("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      error: `Trop de tentatives. Réessaie dans ${retryAfterSeconds} secondes.`,
    });
  }

  req.recordLoginFailure = () => {
    const attempts = count + 1;
    const lockedUntilNext = attempts >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOGIN_LOCKOUT_MS : 0;
    loginAttemptsByIp.set(ip, {
      count: attempts,
      lockedUntil: lockedUntilNext,
      lastFailureAt: Date.now(),
    });
  };
  req.recordLoginSuccess = () => loginAttemptsByIp.delete(ip);

  next();
}

/**
 * Récupère le token envoyé par le client :
 *  - header "Authorization: Bearer <token>" (tous les appels à l'API, via lib/api.js) ;
 *  - paramètre d'URL "?token=" UNIQUEMENT si `allowQuery` est vrai, c'est-à-dire pour les
 *    fichiers statiques (captures d'écran) : une balise <img src="..."> ne peut pas envoyer
 *    de header. Un token dans l'URL finit dans les logs, l'historique du navigateur et les
 *    en-têtes Referer : on ne l'accepte donc plus sur les routes /api/*.
 */
function extractToken(req, { allowQuery }) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  if (allowQuery && typeof req.query.token === "string") return req.query.token;
  return null;
}

function makeAuthMiddleware({ allowQuery }) {
  return function authMiddleware(req, res, next) {
    const token = extractToken(req, { allowQuery });

    if (!token) {
      return res.status(401).json({ error: "Authentification requise" });
    }

    try {
      jwt.verify(token, getSecret(), { algorithms: ["HS256"] });
      next();
    } catch (err) {
      // Une erreur de configuration (secret manquant) n'est pas un problème de session.
      if (err.message?.includes("JWT_SECRET manquant")) {
        return res.status(500).json({ error: err.message });
      }
      return res.status(401).json({ error: "Session expirée ou invalide, reconnecte-toi" });
    }
  };
}

/** Middleware Express : exige un token valide dans le header Authorization (routes /api/*). */
export const requireAuth = makeAuthMiddleware({ allowQuery: false });

/** Idem, mais accepte aussi ?token= (fichiers statiques affichés dans des balises <img>). */
export const requireAuthForFiles = makeAuthMiddleware({ allowQuery: true });

const PLACEHOLDER_VALUES = new Set([
  "colle_ta_clé_ici",
  "choisis_un_mot_de_passe",
  "colle_une_valeur_aleatoire_generee_ici",
]);

/**
 * Avertissements de configuration à afficher au démarrage (liste vide = tout va bien).
 * On ne bloque pas le démarrage : on rend juste le problème impossible à rater.
 */
export function getAuthConfigWarnings(env = process.env) {
  const warnings = [];
  if (!env.AUTH_PASSWORD) warnings.push("AUTH_PASSWORD manquant : plus personne ne pourra se connecter.");
  else if (PLACEHOLDER_VALUES.has(env.AUTH_PASSWORD)) {
    warnings.push("AUTH_PASSWORD a encore la valeur d'exemple de .env.example : choisis-en un vrai.");
  }
  if (!env.JWT_SECRET) warnings.push("JWT_SECRET manquant : aucune session ne peut être créée.");
  else if (PLACEHOLDER_VALUES.has(env.JWT_SECRET) || env.JWT_SECRET.length < 32) {
    warnings.push("JWT_SECRET est trop court ou a la valeur d'exemple : génère une chaîne aléatoire de 32+ caractères.");
  }
  return warnings;
}
