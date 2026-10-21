import "./bootstrap.js";
import { mkdir } from "node:fs/promises";
import { crawlAfterClicks, crawlPage } from "./crawler.js";
import { attachNextPage } from "./exploration.js";

/**
 * Diagnostic : montre ce que l'agent voit APRÈS des clics (même exploration que pendant un run).
 *
 *   npm run explore-clicks -- <url> <clic 1> puis <clic 2> [puis <clic 3>]
 *   ex. npm run explore-clicks -- https://site.tn/login Je suis une Association puis Continuer
 *
 * Les clics sont séparés par le mot « puis » (ou « | »), avec ou sans guillemets : sous Windows, npm
 * perd souvent les guillemets. Un clic s'écrit comme le texte du bouton ou comme un sélecteur
 * Playwright complet (ex. role=button[name="Continuer"], #valider). Une capture de la page atteinte est
 * enregistrée dans backend/debug-screenshots/. Ne remplit ni n'envoie jamais rien.
 */

function toSelector(arg) {
  return /^(text=|role=|css=|xpath=|#|\.|\/\/|\[)/.test(arg) ? arg : `text="${arg.replace(/"/g, '\\"')}"`;
}

const USAGE = "Usage : npm run explore-clicks -- <url> <clic 1> puis <clic 2> [puis <clic 3>]";
const [url, ...rest] = process.argv.slice(2);
const labels = rest
  .join(" ")
  .split(/\s+puis\s+|\s*\|\s*/i)
  .map((label) => label.trim().replace(/^["']|["']$/g, ""))
  .filter(Boolean);
if (!url || labels.length === 0) {
  console.error(USAGE);
  process.exit(2);
}
const NAVIGATION_TIMEOUT_MS = 60000;

try {
  await mkdir("debug-screenshots", { recursive: true });
  const screenshotPath = `debug-screenshots/explore-clicks-${Date.now()}.png`;
  console.log(`Ouverture de ${url} (60 s au plus)...`);
  const base = await crawlPage(url, { navigationTimeoutMs: NAVIGATION_TIMEOUT_MS });
  const clicks = labels.map((label) => ({ selector: toSelector(label), description: label }));
  console.log(`Clics à faire : ${labels.map((l) => `« ${l} »`).join(" puis ")}`);
  const next = await crawlAfterClicks(url, clicks, { screenshotPath, navigationTimeoutMs: NAVIGATION_TIMEOUT_MS });

  console.log(`Page d'ouverture : ${base.elementCount} élément(s) interactif(s), ${base.textElements.length} texte(s).`);
  console.log(`Clics réussis : ${next.clicksDone}/${clicks.length}${next.via.length ? ` (${next.via.join(" puis ")})` : ""}`);
  if (next.clicksDone < clicks.length) {
    console.log(`  -> le clic « ${labels[next.clicksDone]} » n'a pas pu être fait (introuvable, masqué ou non cliquable).`);
  }
  console.log(`Adresse atteinte : ${next.url}`);
  console.log(`Titre : ${next.title || "(vide)"}`);

  const enriched = attachNextPage(base, next);
  const elements = enriched ? enriched.nextPage.elements : [];
  const texts = enriched ? enriched.nextPage.textElements : [];
  console.log(`\nNouveaux éléments interactifs : ${elements.length}`);
  for (const el of elements) console.log(`  - ${el.accessibleName || el.tag} : ${el.selector}`);
  console.log(`Nouveaux textes visibles : ${texts.length}`);
  for (const t of texts) console.log(`  - ${t.kind} : ${t.text.slice(0, 100)}`);
  if (!enriched) console.log("\nRien de nouveau par rapport à la page d'ouverture : l'IA ne serait pas rappelée.");
  console.log(`\nCapture de la page atteinte : backend/${screenshotPath}`);
} catch (err) {
  console.error("Erreur :", err.message.split("\n")[0]);
  process.exit(1);
}
