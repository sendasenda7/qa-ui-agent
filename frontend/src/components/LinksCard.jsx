import AnalysisCard from "./AnalysisCard.jsx";

function Message({ children, danger = false }) {
  return <p className={`text-sm ${danger ? "text-danger" : "text-text-faint"}`}>{children}</p>;
}

function pathOf(url) {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

function Row({ primary, secondary, tag }) {
  return (
    <li className="flex flex-col gap-0.5 border-l-2 border-border pl-2 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {tag && <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-danger-muted text-danger whitespace-nowrap">{tag}</span>}
        <code className="text-[11px] font-mono text-accent-blue break-all">{primary}</code>
      </div>
      {secondary && <span className="text-[11px] text-text-faint break-words">{secondary}</span>}
    </li>
  );
}

function PageBlock({ page }) {
  const hasIssue = page.brokenCount > 0 || page.brokenAnchors.length > 0 || page.brokenImages.length > 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium break-words">{page.title || "(page sans titre)"}</span>
        <span className="text-[11px] text-text-faint font-mono truncate">{pathOf(page.url)}</span>
      </div>
      <p className="text-[12px] text-text-muted">
        {page.checked} lien{page.checked > 1 ? "s" : ""} vérifié{page.checked > 1 ? "s" : ""} sur {page.total} trouvé
        {page.total > 1 ? "s" : ""}
        {page.restrictedCount > 0 && <> · {page.restrictedCount} protégé{page.restrictedCount > 1 ? "s" : ""} (connexion requise)</>}
        {page.uncheckedCount + page.skipped > 0 && <> · {page.uncheckedCount + page.skipped} non vérifié{page.uncheckedCount + page.skipped > 1 ? "s" : ""}</>}
      </p>
      {!hasIssue && <p className="text-[12px] text-success">Aucun lien, ancre ni image cassé sur cette page</p>}

      {page.brokenCount > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] text-text-faint">
            Liens cassés ({page.brokenCount}
            {page.brokenCount > page.broken.length ? `, ${page.broken.length} affichés` : ""})
          </span>
          <ul className="flex flex-col gap-1.5">
            {page.broken.map((link) => (
              <Row
                key={link.href}
                tag={link.status ? String(link.status) : "Erreur"}
                primary={link.href}
                secondary={[link.text && `« ${link.text} »`, link.detail, link.external ? "lien externe" : null].filter(Boolean).join(" · ")}
              />
            ))}
          </ul>
        </div>
      )}
      {page.brokenAnchors.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] text-text-faint">Ancres cassées (aucun élément de la page n'a cet identifiant)</span>
          <ul className="flex flex-col gap-1.5">
            {page.brokenAnchors.map((anchor) => (
              <Row key={anchor.href} tag="Ancre" primary={anchor.href} secondary={anchor.text && `« ${anchor.text} »`} />
            ))}
          </ul>
        </div>
      )}
      {page.brokenImages.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] text-text-faint">Images qui ne se chargent pas</span>
          <ul className="flex flex-col gap-1.5">
            {page.brokenImages.map((image) => (
              <Row key={image.src} tag="Image" primary={image.src} secondary={image.alt && `texte alternatif : « ${image.alt} »`} />
            ))}
          </ul>
        </div>
      )}
      {page.uncheckedReasons?.length > 0 && (
        <p className="text-[11px] text-text-faint">Non vérifiés : {page.uncheckedReasons.join(" ; ")}.</p>
      )}
    </div>
  );
}

/** Liens cassés : liens, ancres et images de chaque page rencontrée pendant le test. */
export default function LinksCard({ enabled, links }) {
  const title = "Liens cassés";
  if (!enabled && !links) {
    return (
      <AnalysisCard title={title} badge="Non activé">
        <Message>Interrupteur désactivé au lancement de ce test.</Message>
      </AnalysisCard>
    );
  }
  if (!links) {
    return (
      <AnalysisCard title={title} badge="En attente" tone="warning">
        <Message>Le contrôle n'a pas produit de résultat (run interrompu ?).</Message>
      </AnalysisCard>
    );
  }
  if (links.status === "error") {
    return (
      <AnalysisCard title={title} badge="Contrôle impossible" tone="warning">
        <Message danger>{links.error}</Message>
      </AnalysisCard>
    );
  }
  if (!links.pages?.length) {
    return (
      <AnalysisCard title={title} badge="Aucune page contrôlée" tone="warning">
        <Message>Le test n'a atteint aucune page à contrôler (ouverture de la page échouée ?).</Message>
      </AnalysisCard>
    );
  }

  const { totals } = links;
  const tone = totals.issues > 0 ? "danger" : "success";
  const badge = totals.issues === 0 ? "Aucun lien cassé" : `${totals.issues} problème${totals.issues > 1 ? "s" : ""}`;

  return (
    <AnalysisCard title={title} badge={badge} tone={tone}>
      <p className="text-sm">
        {links.pages.length} page{links.pages.length > 1 ? "s" : ""} contrôlée{links.pages.length > 1 ? "s" : ""} pendant le test.
      </p>
      {links.pages.map((page) => (
        <PageBlock key={page.url} page={page} />
      ))}
      {links.partialError && <p className="text-[11px] text-warning">Une page n'a pas pu être contrôlée : {links.partialError}</p>}
      <p className="text-[11px] text-text-faint">
        Les liens sont testés par le serveur, sans ta session : une page réservée aux connectés répond « protégé » et n'est pas
        jugée cassée. Les liens vers des adresses locales ou des hôtes non autorisés ne sont pas contactés. Un site qui bloque les
        robots peut répondre à tort 403 ou 429 ; un lien cassé reste à confirmer à la main.
      </p>
    </AnalysisCard>
  );
}
