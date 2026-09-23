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

/** Middleware Express : exige un header "Authorization: Bearer <token>" valide. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

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
