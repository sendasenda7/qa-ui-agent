/**
 * Valeurs secrètes d'un test (identifiants d'un compte de test, mot de passe...).
 *
 * Principe : elles restent dans backend/.env sous des noms qui commencent par QA_SECRET_ (ex.
 * QA_SECRET_EMAIL). L'IA ne reçoit que les NOMS ; elle écrit dans une étape la variable `{{QA_SECRET_EMAIL}}`,
 * et la vraie valeur n'est insérée qu'au moment de saisir dans le navigateur. Résultat : ni le ticket, ni le
 * scénario enregistré, ni les rapports, exports ou messages d'erreur ne contiennent la valeur.
 *
 * Seuls les noms QA_SECRET_* sont utilisables : une étape ne peut jamais lire GROQ_API_KEY, JWT_SECRET...
 */

export const SECRET_PREFIX = "QA_SECRET_";

// Valeurs plus courtes que ça : pas masquées dans les messages (on abîmerait n'importe quel texte).
const MIN_MASKED_LENGTH = 4;

const placeholderPattern = () => /\{\{\s*(QA_SECRET_[A-Za-z0-9_]+)\s*\}\}/g;

/** Noms (jamais les valeurs) des variables secrètes définies et non vides. */
export function listSecretNames(env = process.env) {
  return Object.keys(env)
    .filter((name) => name.startsWith(SECRET_PREFIX) && String(env[name] ?? "") !== "")
    .sort();
}

/** Noms des variables `{{QA_SECRET_...}}` citées dans un texte. */
export function findPlaceholders(text) {
  if (typeof text !== "string") return [];
  return [...text.matchAll(placeholderPattern())].map((match) => match[1]);
}

export function hasPlaceholder(text) {
  return findPlaceholders(text).length > 0;
}

/**
 * Remplace chaque `{{QA_SECRET_X}}` par sa valeur. Renvoie { value, missing } : `missing` liste les noms
 * absents (ou vides) du .env, laissés tels quels dans `value`.
 */
export function resolveSecrets(text, env = process.env) {
  if (typeof text !== "string") return { value: text, missing: [] };
  const missing = [];
  const value = text.replace(placeholderPattern(), (whole, name) => {
    const secret = env[name];
    if (secret === undefined || String(secret) === "") {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return String(secret);
  });
  return { value, missing };
}

function secretValues(env) {
  return Object.keys(env)
    .filter((name) => name.startsWith(SECRET_PREFIX))
    .map((name) => String(env[name] ?? ""))
    .filter((secret) => secret.length >= MIN_MASKED_LENGTH)
    .sort((a, b) => b.length - a.length); // la plus longue d'abord : « abcd » avant « abc »
}

/** Remplace toute valeur secrète par *** dans un texte. */
export function maskSecrets(text, env = process.env) {
  if (typeof text !== "string" || text === "") return text;
  let masked = text;
  for (const secret of secretValues(env)) masked = masked.split(secret).join("***");
  return masked;
}

/**
 * Masque les secrets dans toute une structure JSON (messages d'erreur, attendu/trouvé/piste...), y compris
 * quand la valeur est échappée dans une chaîne JSON. Ne modifie pas l'original.
 */
export function maskSecretsDeep(value, env = process.env) {
  if (value === null || value === undefined) return value;
  if (secretValues(env).length === 0) return value;
  if (typeof value === "string") return maskSecrets(value, env);
  let json = JSON.stringify(value);
  for (const secret of secretValues(env)) {
    json = json.split(JSON.stringify(secret).slice(1, -1)).join("***");
  }
  return JSON.parse(json);
}
