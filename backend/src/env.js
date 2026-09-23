import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, isAbsolute, join } from "path";

// Dossier backend/ (un niveau au-dessus de src/, où vit ce fichier env.js).
const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Charge un fichier .env minimal (KEY=VALEUR par ligne) dans process.env,
 * sans ajouter de dépendance externe. Ignore les lignes vides et les commentaires (#).
 *
 * Un chemin relatif (ex. ".env") est résolu par rapport au dossier backend/, PAS au
 * dossier courant du processus (process.cwd()) : sinon `node src/server.js` ne trouve
 * le fichier que si on l'a lancé depuis backend/, et échoue silencieusement sinon
 * (le serveur démarre alors sans mot de passe ni clé Groq, sans message clair).
 * Un chemin déjà absolu est utilisé tel quel.
 */
export function loadEnvFile(path = ".env") {
  const resolvedPath = isAbsolute(path) ? path : join(BACKEND_ROOT, path);
  if (!existsSync(resolvedPath)) return;

  const content = readFileSync(resolvedPath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    // Retire des guillemets simples/doubles si présents autour de la valeur.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}