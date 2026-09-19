import { readFileSync, existsSync } from "fs";

/**
 * Charge un fichier .env minimal (KEY=VALEUR par ligne) dans process.env,
 * sans ajouter de dépendance externe. Ignore les lignes vides et les commentaires (#).
 */
export function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return;

  const content = readFileSync(path, "utf-8");
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
