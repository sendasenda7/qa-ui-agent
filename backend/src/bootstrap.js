import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * À importer EN PREMIER dans chaque point d'entrée (server.js, scripts npm...).
 *
 * Les dossiers de données (runs/, run-screenshots/, debug-screenshots/, diff-screenshots/) sont
 * relatifs au dossier courant. Lancer `node backend/src/server.js` depuis la racine du dépôt
 * créait donc (ou lisait) ces dossiers au mauvais endroit. On se place dans backend/ une fois
 * pour toutes ; les chemins déjà enregistrés dans les runs restent valides.
 */
process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));
