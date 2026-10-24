import "./bootstrap.js";
import { createServer } from "node:http";
import { runScenario } from "./runner.js";

/**
 * Démonstration des contrôles « performance » et « liens cassés » : ouvre dans un VRAI navigateur une page locale qui
 * cumule les défauts classiques, et affiche ce que les contrôles en disent.
 *
 *   Performance : un gros bloc de texte qui n'apparaît qu'après 4,2 s (LCP lent), une grande image servie avec
 *                 4,8 s de retard (poids, et elle retarde la fin du chargement), et une bannière insérée à 2 s,
 *                 APRÈS le premier affichage, qui pousse le contenu vers le bas (décalage de mise en page, CLS).
 *                 (Chromium ignore pour le LCP les images trop pauvres en détails et les décalages qui précèdent
 *                 le premier affichage : d'où ce montage.)
 *   Liens       : /absent (404), /erreur (500), https://example.invalid/ (domaine introuvable) -> 3 liens cassés ;
 *                 /prive (403) -> 1 protégé ; /redirige -> /ok -> ok ; une ancre #absent sans cible ; une image /manquante.png.
 *
 * Usage (depuis backend/) :  node src/demo-performance-liens.js
 * Attendu : liens -> 5 problèmes (3 liens cassés, 1 ancre, 1 image) et 1 lien protégé ;
 *           performance -> LCP « mauvais » (autour de 4,2 s) ; CLS au-dessus de 0,1 (valeur variable selon l'écran).
 * Les mesures de performance varient d'une exécution à l'autre : seuls les liens ont un résultat exact.
 */

const PORT = 8126;
// Les liens vers 127.0.0.1 ne sont vérifiés que si les adresses locales sont autorisées (garde-fou SSRF).
process.env.ALLOW_PRIVATE_TARGETS = "true";

// Image riche en détails (centaines de cercles) : un aplat de couleur serait ignoré par le LCP de Chromium.
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const circles = Array.from({ length: 400 }, () =>
  `<circle cx="${Math.round(random() * 900)}" cy="${Math.round(random() * 400)}" r="${Math.round(5 + random() * 40)}" fill="hsl(${Math.round(random() * 360)},70%,55%)" fill-opacity="0.6"/>`
).join("");
const HERO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400"><rect width="900" height="400" fill="#1e3a8a"/>${circles}</svg>`;

const PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Démo performance et liens</title></head>
<body style="font-family:sans-serif;margin:0;padding:1rem">
  <h1>Page de démo</h1>
  <p id="intro">Cette page a volontairement un affichage lent, un décalage de mise en page et des liens cassés.</p>
  <img src="/hero.svg" width="900" height="400" alt="Image lente">
  <nav>
    <a href="/ok">Page qui marche</a> |
    <a href="/absent">Page supprimée</a> |
    <a href="/erreur">Page en erreur</a> |
    <a href="/prive">Espace privé</a> |
    <a href="/redirige">Ancienne adresse</a> |
    <a href="https://example.invalid/">Site disparu</a> |
    <a href="#absent">Aller aux tarifs</a> |
    <a href="#present">Aller au bas de page</a>
  </nav>
  <img src="/manquante.png" width="120" height="60" alt="Logo manquant">
  <p id="present">Bas de page</p>
  <script>
    // Bannière à 2 s (après le premier affichage) : elle pousse tout le contenu vers le bas -> CLS.
    setTimeout(() => {
      const banner = document.createElement("div");
      banner.style.cssText = "height:260px;background:#fde68a;padding:1rem";
      banner.textContent = "Bannière insérée en retard : elle pousse tout le contenu vers le bas.";
      document.body.prepend(banner);
    }, 2000);
    // Gros bloc de texte à 4,2 s : il devient le plus gros élément visible -> LCP d'environ 4,2 s (mauvais, au-delà de 4 s).
    setTimeout(() => {
      const hero = document.createElement("p");
      hero.style.cssText = "font-size:4rem;line-height:1.2;margin:1rem 0";
      hero.textContent = "Contenu principal affiché très tard : le plus gros élément de la page arrive après quatre secondes.";
      document.body.append(hero);
    }, 4200);
  </script>
</body></html>`;

const ROUTES = {
  "/": { status: 200, type: "text/html; charset=utf-8", body: PAGE },
  "/ok": { status: 200, type: "text/plain", body: "ok" },
  "/prive": { status: 403, type: "text/plain", body: "interdit" },
  "/erreur": { status: 500, type: "text/plain", body: "erreur" },
  "/redirige": { status: 302, headers: { location: "/ok" }, body: "" },
  "/hero.svg": { status: 200, type: "image/svg+xml", body: HERO_SVG, delayMs: 4800 },
};

const server = createServer((req, res) => {
  const route = ROUTES[new URL(req.url, "http://x").pathname] ?? { status: 404, type: "text/plain", body: "introuvable" };
  setTimeout(() => {
    res.writeHead(route.status, { "content-type": route.type ?? "text/plain", ...(route.headers ?? {}) });
    res.end(route.body);
  }, route.delayMs ?? 0);
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

try {
  const url = `http://127.0.0.1:${PORT}/`;
  const scenario = {
    ticketSummary: "Démo performance et liens",
    warnings: [],
    steps: [{ type: "navigate", selector: null, value: null, description: "Ouvrir la page de démo", selectorValid: true }],
  };
  const result = await runScenario(url, scenario, { checkPerformance: true, checkLinks: true, trace: false });
  console.log(`Run ${result.runId} : ${result.status}\n`);

  const perf = result.performance;
  console.log("=== PERFORMANCE ===");
  if (perf.status !== "done") console.log(perf.status, perf.error ?? "");
  else {
    for (const page of perf.pages) {
      console.log(`Métriques : ${JSON.stringify(page.metrics)}`);
      console.log(`Notes     : ${JSON.stringify(page.ratings)}`);
      for (const issue of page.issues) console.log(`  - [${issue.severity}] ${issue.code} : ${issue.message}`);
    }
  }

  const links = result.links;
  console.log("\n=== LIENS CASSÉS ===");
  if (links.status !== "done") console.log(links.status, links.error ?? "");
  else {
    for (const page of links.pages) {
      console.log(`${page.checked} liens vérifiés sur ${page.total}`);
      for (const link of page.broken) console.log(`  - CASSÉ  ${link.href} (${link.status ?? link.detail})`);
      for (const link of page.restricted) console.log(`  - PROTÉGÉ ${link.href} (${link.status})`);
      for (const anchor of page.brokenAnchors) console.log(`  - ANCRE CASSÉE ${anchor.href}`);
      for (const image of page.brokenImages) console.log(`  - IMAGE CASSÉE ${image.src}`);
    }
    console.log("Totaux :", links.totals);
  }
} finally {
  server.close();
}