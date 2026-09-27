import jwt from "jsonwebtoken";
import { timingSafeEqual } from "crypto";

const TOKEN_LIFETIME = "7d";
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
  return jwt.sign({ role: "team" }, getSecret(), { expiresIn: TOKEN_LIFETIME });
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
    loginAttemptsByIp.set(ip, { count: attempts, lockedUntil: lockedUntilNext });
  };
  req.recordLoginSuccess = () => loginAttemptsByIp.delete(ip);

  next();
}


/**
 * Récupère le token envoyé par le client, sous l'une des deux formes possibles :
 *  - header "Authorization: Bearer <token>" (tous les appels à l'API, via lib/api.js) ;
 *  - paramètre d'URL "?token=" (uniquement pour les fichiers statiques — captures
 *    d'écran, diffs — car une balise <img src="..."> ne peut pas envoyer de header
 *    personnalisé ; c'est la seule façon de les protéger sans réécrire tout l'affichage
 *    des captures en fetch+blob côté frontend).
 */
function extractToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  if (typeof req.query.token === "string") return req.query.token;
  return null;
}

/** Middleware Express : exige un token valide (header Authorization ou ?token=). */
export function requireAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: "Authentification requise" });
  }

  try {
    jwt.verify(token, getSecret());
    next();
  } catch {
    return res.status(401).json({ error: "Session expirée ou invalide, reconnecte-toi" });
  }
}
