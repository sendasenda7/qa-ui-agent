import "./bootstrap.js";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser.js";

/**
 * Diagnostic d'ouverture de page : montre ce qui bloque quand une page met trop de temps à s'ouvrir
 * dans l'outil alors qu'elle s'ouvre dans ton navigateur.
 *
 *   npm run diagnose-page -- <url>
 *
 * Ouvre la page 25 s, puis affiche : l'état du chargement toutes les 5 s, les requêtes restées sans
 * réponse (souvent un script ou une police externe bloqués), celles qui ont échoué, les erreurs de la
 * console et ce que la page affiche. Une capture est enregistrée dans backend/debug-screenshots/.
 */

const url = process.argv[2];
if (!url) {
  console.error("Usage : npm run diagnose-page -- <url>");
  process.exit(2);
}

const short = (u) => (u.length > 110 ? `${u.slice(0, 109)}…` : u);
const pending = new Map();
const failed = [];
const consoleErrors = [];
const started = Date.now();
const sec = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  page.on("request", (r) => pending.set(r, { url: r.url(), at: sec() }));
  page.on("requestfinished", (r) => pending.delete(r));
  page.on("requestfailed", (r) => {
    pending.delete(r);
    failed.push(`${short(r.url())} — ${r.failure()?.errorText ?? "échec"}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && consoleErrors.length < 5) consoleErrors.push(m.text().slice(0, 160));
  });

  console.log(`Ouverture de ${url} ...`);
  try {
    await page.goto(url, { waitUntil: "commit", timeout: 30000 });
    console.log(`[${sec()}] le serveur a répondu (commit)`);
  } catch (err) {
    console.log(`[${sec()}] AUCUNE réponse du serveur à Chromium : ${err.message.split("\n")[0]}`);
    console.log("  -> Chromium n'arrive pas à joindre le site alors que curl y arrive : antivirus, pare-feu, proxy ou VPN ?");
  }

  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(5000);
    const state = await page.evaluate(() => ({
      readyState: document.readyState,
      elements: document.querySelectorAll("input, button, a[href], select, textarea").length,
      textLength: (document.body?.innerText || "").trim().length,
    })).catch(() => null);
    console.log(
      `[${sec()}] ${state ? `chargement : ${state.readyState} | éléments : ${state.elements} | texte : ${state.textLength} caractères` : "page non lisible"} | requêtes en attente : ${pending.size}`
    );
  }

  console.log(`\nRequêtes restées sans réponse (${pending.size}) :`);
  for (const r of [...pending.values()].slice(0, 12)) console.log(`  - depuis ${r.at} : ${short(r.url)}`);
  console.log(`Requêtes échouées (${failed.length}) :`);
  for (const f of failed.slice(0, 10)) console.log(`  - ${f}`);
  console.log(`Erreurs de la console (${consoleErrors.length}) :`);
  for (const e of consoleErrors) console.log(`  - ${e}`);

  await mkdir("debug-screenshots", { recursive: true });
  const shot = `debug-screenshots/diagnose-page-${Date.now()}.png`;
  await page.screenshot({ path: shot }).catch(() => {});
  console.log(`\nCapture : backend/${shot}`);
} finally {
  await browser.close();
}
