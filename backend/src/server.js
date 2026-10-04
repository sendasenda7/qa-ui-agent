import "./bootstrap.js"; // doit rester le premier import : voir bootstrap.js
import { loadEnvFile } from "./env.js";
loadEnvFile(".env");

import { createApp } from "./app.js";
import { recoverInterruptedRuns } from "./run-store.js";
import { getAuthConfigWarnings } from "./auth.js";

const PORT = process.env.PORT || 4000;

// Un rejet de promesse oublié quelque part ne doit pas faire tomber tout le serveur (et les runs
// en cours avec) : on le journalise.
process.on("unhandledRejection", (reason) => {
  console.error("Promesse rejetée non gérée :", reason);
});

for (const warning of getAuthConfigWarnings()) {
  console.warn(`⚠ Configuration : ${warning}`);
}

// Les runs restés "running" sur disque après un arrêt brutal sont marqués en erreur.
try {
  const interruptedCount = await recoverInterruptedRuns();
  if (interruptedCount > 0) {
    console.log(`→ ${interruptedCount} run(s) interrompu(s) marqué(s) en erreur`);
  }
} catch (err) {
  console.error("Impossible de vérifier les runs interrompus :", err.message);
}

createApp().listen(PORT, () => {
  console.log(`→ API QA-UI Agent démarrée sur http://localhost:${PORT}`);
});
