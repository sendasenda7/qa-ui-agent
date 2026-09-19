import { checkLocalization } from "./localization-check.js";

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error("Usage : npm run check-i18n -- <url>");
    process.exit(1);
  }

  console.error(`→ Vérification FR/AR + RTL sur ${url}...`);
  const report = await checkLocalization(url);

  console.error(
    `→ Terminé : ${report.findingsCount} problème(s) détecté(s) sur ${report.elementsComparedCount} éléments comparés.`
  );

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
