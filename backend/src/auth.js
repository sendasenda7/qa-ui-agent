import jwt from "jsonwebtoken";

const TOKEN_LIFETIME = "7d";

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

export function checkPassword(password) {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected) {
    throw new Error(
      "AUTH_PASSWORD manquant dans backend/.env — définis le mot de passe d'équipe."
    );
  }
  return typeof password === "string" && password === expected;
}

export function issueToken() {
  return jwt.sign({ role: "team" }, getSecret(), { expiresIn: TOKEN_LIFETIME });
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
