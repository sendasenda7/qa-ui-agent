/**
 * Moteurs de navigateur proposés sur l'écran "New Run". Les `id` sont ceux attendus par le
 * backend (identifiants Playwright, voir backend/src/browser.js) ; `label` sert à l'affichage.
 */
export const BROWSER_ENGINES = [
  { id: "chromium", label: "Chromium" },
  { id: "firefox", label: "Firefox" },
  { id: "webkit", label: "WebKit" },
];

export const DEFAULT_BROWSER_ENGINE = "chromium";

/**
 * Libellé d'un moteur à partir de son id. Les anciens runs, enregistrés avant l'existence
 * du sélecteur, n'ont pas de moteur : ils ont tous tourné sur Chromium.
 */
export function browserEngineLabel(id) {
  const engine = BROWSER_ENGINES.find((e) => e.id === (id || DEFAULT_BROWSER_ENGINE));
  return engine ? engine.label : id;
}
