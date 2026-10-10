import { lookup as dnsLookup } from "dns/promises";
import { isIP } from "net";
import { HttpError } from "./http-error.js";

/**
 * Garde-fou sur les URLs que le serveur accepte d'ouvrir dans Chromium.
 *
 * Sans lui, n'importe quel utilisateur connecté pouvait faire ouvrir `file:///etc/passwd`,
 * `http://localhost:xxxx` ou `http://169.254.169.254/` (métadonnées cloud) par le serveur,
 * puis récupérer la capture d'écran via /debug-screenshots (SSRF).
 *
 * Règles :
 *  - seules les URLs http(s) sont acceptées ;
 *  - les hôtes locaux / privés (localhost, 10.x, 192.168.x, 169.254.x, ::1, .local, .internal...)
 *    sont refusés, SAUF si ALLOW_PRIVATE_TARGETS=true (pour tester une appli locale en dev) ;
 *  - si ALLOWED_TARGET_HOSTS est défini (ex. "staging.helpify.tn,*.devwise.tn"), seuls ces
 *    hôtes sont acceptés.
 */

export function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Adresse IP (v4 ou v6) locale, privée, link-local ou réservée ? */
export function isPrivateIp(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    // IPv4 embarquée dans une IPv6 (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d). Le parseur
    // d'URL de Node les réécrit en hexadécimal ("::ffff:7f00:1" pour 127.0.0.1) : il faut donc
    // gérer les deux écritures, sinon http://[::ffff:127.0.0.1]/ contournerait le garde-fou.
    const embedded = lower.match(/^(?:::ffff:|::|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (embedded) {
      if (embedded[1]) return isPrivateIp(embedded[1]);
      const high = parseInt(embedded[2], 16);
      const low = parseInt(embedded[3], 16);
      return isPrivateIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower); // ULA fc00::/7, link-local fe80::/10
  }
  return false;
}

function hostMatches(hostname, pattern) {
  if (pattern.startsWith("*.")) return hostname.endsWith(pattern.slice(1));
  return hostname === pattern;
}

/**
 * Vérifie qu'une URL cible est acceptable. Renvoie l'URL, ou lève une HttpError(400).
 * `deps.lookup` et `deps.env` sont injectables pour les tests.
 */
export async function assertSafeTargetUrl(value, deps = {}) {
  const { lookup = dnsLookup, env = process.env } = deps;

  if (!isHttpUrl(value)) {
    throw new HttpError(400, "url invalide (http:// ou https:// attendu)");
  }
  const { hostname: rawHostname } = new URL(value);
  const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();

  const allowedHosts = (env.ALLOWED_TARGET_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length > 0 && !allowedHosts.some((p) => hostMatches(hostname, p))) {
    throw new HttpError(400, "hôte non autorisé (voir ALLOWED_TARGET_HOSTS)");
  }

  if (env.ALLOW_PRIVATE_TARGETS === "true") return value;

  const looksLocal =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal");
  if (looksLocal || isPrivateIp(hostname)) {
    throw new HttpError(
      400,
      "adresse locale ou privée refusée (ALLOW_PRIVATE_TARGETS=true pour tester une appli locale)"
    );
  }

  // Nom de domaine : on vérifie aussi vers quelles IP il pointe (un DNS public peut
  // renvoyer 127.0.0.1). Un échec de résolution n'est pas bloquant ici : la navigation
  // échouera de toute façon avec un message clair.
  if (!isIP(hostname)) {
    try {
      const addresses = await lookup(hostname, { all: true });
      if (addresses.some(({ address }) => isPrivateIp(address))) {
        throw new HttpError(400, "ce domaine pointe vers une adresse locale ou privée : refusé");
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
    }
  }
  return value;
}
