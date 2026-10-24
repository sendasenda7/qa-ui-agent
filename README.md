# QA-UI Agent

Projet personnel complémentaire au stage QA (DevWise) : génération et exécution automatique
de tests E2E à partir d'un ticket en langage naturel, avec diff visuel, vérification FR/AR/RTL
et un dashboard React.

## Structure

```
qa-ui-agent/
├── backend/
│   ├── src/
│   │   ├── crawler.js           # Étape 1 : crawl d'une page, détection des éléments interactifs
│   │   ├── planner.js           # Étape 2 : génération du scénario par l'IA (Groq) + garde-fous
│   │   ├── runner.js            # Étape 3 : exécution réelle du scénario (Playwright)
│   │   ├── visual-diff.js       # Étape 4 : diff visuel pixel par pixel entre deux runs
│   │   ├── localization-check.js# Étape 5 : vérification FR/AR + RTL
│   │   ├── run-store.js         # Sauvegarde/lecture des runs (backend/runs/<runId>.json) + notes séparées
│   │   ├── accessibility.js     # Audit d'accessibilité (axe-core) pendant le scénario : résumé par page, enregistreur
│   │   ├── performance.js       # Contrôle de performance : TTFB, FCP, LCP, CLS, poids et requêtes de chaque page (seuils Google)
│   │   ├── links.js             # Contrôle des liens, ancres et images cassés (requêtes serveur sans session, protégées contre le SSRF)
│   │   ├── responsive.js        # Contrôle responsive : chaque page rejouée en mobile / tablette / bureau (défilement horizontal, cibles tactiles, viewport)
│   │   ├── run-history.js       # Historique et tendances : regroupement par ticket, tendance, erreurs fréquentes (pur)
│   │   ├── failure-capture.js   # Capture d'échec : élément visé encadré en rouge + bandeau (code et cause)
│   │   ├── exploration.js       # Exploration après clic : choix des clics, fusion de la page suivante (pur)
│   │   ├── diagnose-page.js     # Diagnostic : pourquoi une page s'ouvre lentement (requêtes bloquées)
│   │   ├── secrets.js           # Variables secrètes QA_SECRET_* : résolution à l'exécution et masquage
│   │   ├── report-export.js     # Export d'un run en JUnit XML et en JSON (fonctions pures)
│   │   ├── report-cli.js        # Logique de la commande export-report (testée)
│   │   ├── export-report.js     # Point d'entrée : npm run export-report
│   │   ├── step-errors.js       # Erreurs d'étape structurées : catégorie, code stable, attendu/trouvé/piste
│   │   ├── run-executor.js      # Orchestration d'un run en arrière-plan (startRun/startReplay) + limite de runs
│   │   ├── run-analysis.js      # Analyses optionnelles après un run (RTL, diff visuel) ; l'accessibilité est auditée pendant le run (accessibility.js)
│   │   ├── auth.js              # Mot de passe d'équipe, JWT, anti-bruteforce
│   │   ├── url-guard.js         # Garde-fou SSRF : quelles URLs le serveur accepte d'ouvrir
│   │   ├── app.js               # Routes Express (createApp, testable)
│   │   ├── bootstrap.js         # Se place dans backend/ (dossiers de données toujours au bon endroit)
│   │   └── server.js            # Démarre l'API sur un port
│   └── test/                    # Tests unitaires (node:test)
└── frontend/                    # UI React (Vite + Tailwind)
    └── src/
        ├── pages/                # Dashboard, Explore, NewRun, LiveRunDetail, VisualRtl, ReportDetail...
        ├── components/
        └── lib/                  # api.js, pdf-export.js
```

## Le pipeline (backend)

### 1. Crawl (`crawler.js`)

Ouvre une URL avec Playwright, attend le réseau stable (`networkidle`), puis liste tous les
éléments interactifs visibles (boutons, liens, inputs, selects, éléments avec `role`, ainsi que
les éléments cliquables sans sémantique HTML détectés par heuristique de curseur) et calcule pour
chacun le sélecteur le plus stable possible : `data-testid` > `id` > `name` > CSS de secours
(signalé comme fragile). C'est cette liste, jamais l'IA seule, qui décide des sélecteurs
utilisables ensuite. Timeout de navigation configurable (`navigationTimeoutMs`, défaut 30s).

```bash
cd backend
npm install
npx playwright install chromium   # une seule fois (ajoute firefox et webkit pour le sélecteur de navigateur)
npm run crawl -- https://the-internet.herokuapp.com/login
```

### 2. Génération du scénario par l'IA (`planner.js`)

Prend le texte d'un ticket + le résultat du crawl, et appelle Groq (mode JSON strict) pour
générer un scénario structuré : une liste d'étapes (`navigate`, `click`, `fill`, `select`,
`assert_visible`, `assert_enabled`, `assert_text`, `assert_url`, `go_back`), chacune avec un sélecteur.

**Garde-fous mécaniques** (`validateScenario`, testés dans `test/planner.test.js`) :
- **Anti-hallucination** : tout sélecteur utilisé par l'IA qui n'existe pas dans la liste fournie
  par le crawl est neutralisé (`selectorValid: false`) et un avertissement est ajouté.
- **Anti-incohérence** : une étape `assert_enabled` n'est conservée que si elle est précédée d'une
  action d'activation (fill/select/click sur un autre sélecteur) *et* suivie d'un clic sur le même
  élément — sinon elle est retirée. Corrige un bug réel rencontré (run TR-0248) où l'IA ajoutait
  cette vérification sans qu'aucune action ne soit censée activer l'élément.
- **Validation structurelle** : un `steps` qui n'est pas un tableau, une étape qui n'est pas un
  objet, ou un type d'étape halluciné (hors de la liste connue) sont neutralisés avec un
  avertissement clair, plutôt que de planter plus tard dans `runner.js`.
- **Ouverture de la page garantie** : si le scénario de l'IA ne commence pas par une étape `navigate`
  (le navigateur démarre sur une page blanche et échouerait sur la première saisie), une étape « Ouvrir la
  page » est ajoutée au début, avec un avertissement. Si un échec survient quand même sur `about:blank`, le
  rapport l'explique (« la page n'a jamais été ouverte ») au lieu de parler d'un affichage trop lent.
- **Score de confiance** (`scenario.confidence`) : 100% moins 15 points par avertissement réel —
  directement dérivé de `scenario.warnings`, jamais une estimation inventée (`computeConfidence`,
  partagée entre la validation mécanique et la relecture ci-dessous). **Plafonné à 30 %** quand le
  scénario ne contient aucune vérification (`assert_visible`, `assert_text`, `assert_url`,
  `assert_enabled`) : il « réussit » alors dès que ses étapes s'exécutent, sans rien contrôler. Un
  avertissement dédié l'indique, et le run s'affiche « terminé avec avertissements ».
- **Retry automatique** (`callGroqWithRetry`, testé dans `test/planner-retry.test.js`) : jusqu'à 3
  tentatives avec backoff exponentiel sur 429/5xx/erreur réseau ; abandon immédiat sur 401/400.

**Relecture IA optionnelle (double-passe)** (`reviewScenario`, testée dans
`test/planner-review.test.js`) : activable via le toggle "Relecture IA approfondie" (désactivé
par défaut — plus lent, un 2ᵉ appel Groq). Contrairement aux garde-fous mécaniques ci-dessus, qui
ne voient qu'un scénario invalide dans sa forme, cette 2ᵉ passe juge la **cohérence sémantique** :
un scénario peut être mécaniquement parfait (sélecteurs valides, types connus) tout en ne testant
pas ce que le ticket demande (ex. aucune étape ne vérifie un message d'erreur pourtant explicite
dans le ticket). Les problèmes trouvés sont ajoutés à `scenario.warnings` (préfixés
`"Relecture IA : "`) et pèsent sur la confiance comme n'importe quel autre avertissement. Dégrade
proprement si Groq est indisponible : le scénario déjà validé reste utilisable.

```bash
cp .env.example .env   # puis colle ta clé GROQ_API_KEY
npm run plan -- https://staging.helpify.tn/auth/login "Vérifier que je peux choisir Je suis un Donateur puis continuer"
```

### 3. Exécution réelle (`runner.js`)

Exécute le scénario dans un vrai navigateur (Chromium par défaut, ou Firefox / WebKit choisi sur
l'écran "New Run" ; le moteur choisi sert pour tout le run : crawl, exécution, analyse RTL, et
un rejeu reprend celui du run d'origine) : clic, saisie, sélection, vérifications. Capture un
screenshot après CHAQUE étape (succès ou échec) et s'arrête dès la première étape en échec.
`assert_enabled` vérifie qu'un élément n'est plus désactivé (`disabled`, `aria-disabled`, ou
curseur `not-allowed`).

Le diff visuel ne compare que des runs du même moteur (le rendu diffère d'un moteur à l'autre) ;
les anciens runs, sans moteur enregistré, comptent comme Chromium.

Timeouts configurables (`stepTimeoutMs` par défaut 10s, `navigationTimeoutMs` par défaut 30s),
utile sur un environnement de staging plus lent — réglable via l'écran "New Test" du frontend ou
le paramètre `timeoutMs` de l'API.

```bash
npm run test-run -- https://staging.helpify.tn/auth/login "Vérifier que je peux choisir Je suis un Donateur puis continuer"
```

**Rejouer un scénario exact** (`run-executor.js` / `startReplay`) : rejoue les mêmes étapes sans
repasser par le crawl ni par l'IA — donne deux runs strictement comparables pour le diff visuel
(bouton "Relancer ce scénario" dans le rapport du frontend). Conserve le `ticketUrl` du run
d'origine.

**Récupération après crash** (`run-store.js` / `recoverInterruptedRuns`) : au démarrage du
serveur, tout run resté marqué `"running"` sur disque (le process a été interrompu pendant son
exécution) est automatiquement repassé en `"error"`, pour ne jamais rester "en cours"
indéfiniment.

### 4. Diff visuel entre deux runs (`visual-diff.js`)

Chaque run est sauvegardé dans `backend/runs/<runId>.json`. `compareRuns` compare deux runs
étape par étape (pixel par pixel, via `pixelmatch`) ; une étape est une régression si plus de
**0,5%** des pixels diffèrent (`REGRESSION_THRESHOLD_PERCENT`). Si les dimensions diffèrent, la
comparaison est signalée `comparable: false` plutôt que de donner un résultat trompeur.

`compareRuns` détecte aussi et **signale** (au lieu de comparer en silence) : un nombre d'étapes
différent entre les deux runs, ou des descriptions d'étape différentes au même index — deux
indices que ce n'est probablement pas le même scénario rejoué. Une étape dont la description diffère
n'est **pas comparée** (`comparable: false`) : un « diff » entre deux étapes qui ne sont pas le même
test (une page blanche contre la vraie page, par exemple) mesurerait deux pages différentes, pas une
régression. Le rapport indique `comparedStepCount` ; à 0, l'interface affiche « Non comparable » au lieu
d'un faux « Aucune régression ».

```bash
npm run test-run -- <url> "<ticket>"   # une première fois, note le runId
npm run test-run -- <url> "<ticket>"   # une deuxième fois, note le runId
npm run compare -- <runIdA> <runIdB>
```

### 5. FR/AR + RTL (`localization-check.js`)

Charge la page en français, trouve le bouton de langue (repéré via le crawler sur des
mots-clés comme "arabe"), clique dessus, re-crawle en arabe et compare les deux états :
`dir="rtl"` bien appliqué, et aucun texte resté identique dans les deux langues (oubli de
traduction — cf. le bug NOTIF-21 qui a motivé cette vérification).

```bash
npm run check-i18n -- https://staging.helpify.tn/auth/login
```

> Si le script ne trouve pas le bouton de langue, ajoute le libellé exact utilisé par le site à
> `AR_TOGGLE_KEYWORDS` dans `localization-check.js`.

## Tests

```bash
cd backend
npm test
```

`node:test` natif, aucune dépendance supplémentaire — plus de 310 tests. Couvre les garde-fous de
`planner.js` (sélecteur halluciné, incohérence `assert_enabled`, validation structurelle, score
de confiance, retry Groq, relecture IA double-passe, `assert_text` vide), `visual-diff.js`
(comparaison identique/régression/dimensions différentes/scénarios non comparables), le runner
(étapes à sélecteur halluciné), `url-guard.js` (SSRF), le stockage des runs et des notes, la
détection du bouton de langue, et l'API HTTP complète (auth, 400/401/404/429, CORS, en-têtes).

### Couverture du backend

```bash
cd backend
npm run test:coverage    # lance les mêmes tests + vérifie les seuils de couverture
```

La commande affiche, fichier par fichier, la part du code exécutée par les tests, et **échoue** si la
couverture globale passe sous **85 % des lignes, 85 % des branches et 90 % des fonctions** (seuils
réglés dans `backend/package.json`). La CI l'exécute à la place de `npm test` : la couverture ne peut
pas baisser sans que la CI le signale. Mesure au moment de l'ajout : environ 91 % des lignes, 91 % des
branches et 94 % des fonctions. Les fichiers les moins couverts (`crawler.js`, `localization-check.js`,
`runner.js`) pilotent un vrai navigateur : ils seront couverts par un test de bout en bout. Les seuils sont
volontairement un peu sous la mesure actuelle ; relève-les quand la couverture progresse. Une bonne
couverture n'est pas une preuve de qualité : un test peut exécuter du code sans rien vérifier.

### Tests du frontend

```bash
cd frontend
npm test                 # lance les tests (Vitest + Testing Library)
npm run test:coverage    # idem + pourcentage de couverture (rapport HTML dans frontend/coverage/)
```

Les tests sont dans `frontend/test/` : fonctions utilitaires, appels à l'API (avec `fetch`
simulé, dont le cas 401), composants (badge, interrupteur, échec d'étape, trace, audit
d'accessibilité, frise des étapes...), hooks (chronomètre, suivi d'un run) et écrans (connexion,
nouveau test, rapports, historique). Aucun serveur n'est nécessaire. La commande de couverture
échoue si elle passe sous les seuils réglés dans `frontend/vite.config.js` : la couverture ne
peut pas baisser sans que la CI le signale. La CI affiche le pourcentage à chaque push.

## Sélecteurs d'éléments

Pour chaque élément interactif, le crawler choisit le sélecteur le plus stable, dans cet ordre :
`data-testid` > `id` > `name` > **rôle + nom visible** (`role=button[name="Continuer"]`) >
texte visible d'une carte cliquable (`text="Je suis un Donateur"`) > chemin CSS (dernier recours).

Un sélecteur n'est retenu que s'il désigne **exactement** l'élément dans la page (vérifié avec
Playwright). Quand un sélecteur lisible remplace un chemin CSS fragile ou un `id` généré
(`mat-input-0`, `:r0:`), l'ancien est conservé comme **sélecteur de secours** : si le lisible ne
trouve plus rien (par ex. le site vient de passer en arabe, donc le texte des boutons a changé),
le runner essaie automatiquement le secours.

## Vérifier un texte ou un message

Le crawl renvoie aussi `textElements` : les textes **visibles et non cliquables** de la page (titres,
alertes, bannières, messages d'erreur déjà affichés, puis le texte courant : paragraphes, éléments de
liste, citations, légendes — 25 au plus, après les titres et messages, qui passent toujours en premier), chacun avec un sélecteur vérifié unique
(`role=heading[name="Connexion"]`, `text="..."`, ou `p:has-text("...")` pour un paragraphe plus long que les
120 caractères gardés). L'IA les utilise pour `assert_visible` / `assert_text`.

Un message qui n'apparaît **qu'après une action** (erreur après un envoi, confirmation, toast) ne peut
pas être dans le crawl. Pour lui, et seulement pour `assert_visible` / `assert_text`, le scénario peut
utiliser `role=alert`, `role=status` ou `text="texte exact"`. Ces étapes sont marquées
`selectorKind: "dynamic"`. Un texte inventé ne donne jamais un faux « réussi » : l'étape échoue
(élément introuvable). `click`, `fill` et `select` restent limités aux éléments listés par le crawl.

## Vérifier l'adresse de la page (`assert_url`)

L'étape `assert_url` vérifie que l'adresse (URL) de la page **contient** un texte, par exemple
`/association`. Elle attend jusqu'au timeout des étapes : une redirection ou un changement de route
d'une appli monopage arrive quelques instants après le clic. Le ticket doit donner l'adresse attendue
(l'IA n'en invente jamais). Une adresse vide, `/` ou `http` serait vraie sur n'importe quelle page :
ces étapes sont retirées avec un avertissement. En cas d'échec, le rapport affiche l'adresse réellement
atteinte, avec la valeur des paramètres sensibles (`token`, `code`, `session`...) masquée.

## Exporter un rapport pour une CI (JUnit XML et JSON)

Un run terminé s'exporte en **JUnit XML** (lu par GitHub Actions, GitLab CI, Jenkins, Azure DevOps...) ou en
**JSON** (format stable et versionné : `schemaVersion`). Trois façons de l'obtenir :

- **Interface** : boutons « JUnit XML » et « JSON » en haut du rapport d'un run.
- **API** : `GET /api/runs/:id/export?format=junit|json` (token requis ; `409` si le run est encore en cours).
- **Ligne de commande**, sur les runs de `backend/runs/` :

```
npm run export-report -- <runId|latest> [--format junit|json] [--out fichier] [--fail-on-failure]
```

`latest` = le run terminé le plus récent. Sans `--out`, le rapport est écrit sur la sortie standard ;
avec `--out`, le dossier est créé si besoin (chemin relatif à `backend/`). **`--fail-on-failure`** donne le
code de sortie `1` si le test a échoué, pour faire échouer l'étape de la CI (`2` = erreur d'utilisation).

| Dans le run | Dans le rapport JUnit |
|---|---|
| étape réussie | `<testcase>` (durée en secondes) |
| étape en échec | `<failure type="E-ELM-001">` : phrase, code, attendu / trouvé / piste, détails techniques |
| étape jamais exécutée (une étape précédente a échoué) | `<skipped>` |
| erreur qui interrompt le run (site injoignable, page vide, IA sans étape) | un `<testcase>` « Préparation du test » en `<error>` avec le code (`E-NAV-001`, `E-CRW-001`...) : une CI voit un échec, pas un rapport vide |
| étape instable (réussie à la relance) | reste un succès ; l'instabilité est écrite dans `system-out` et dans la propriété `flakySteps` de la suite |

Le XML est vérifié par un vrai parseur sur du texte hostile (balises, `&`, guillemets, caractères de
contrôle, retours à la ligne). L'adresse, le navigateur, la confiance, le ticket et les avertissements du
scénario sont des `<property>` de la suite.

**Exemple de workflow GitHub Actions** (non fourni dans le dépôt : il demande un secret `GROQ_API_KEY` et une
URL à tester ; vérifie la version actuelle de l'action sur sa page du Marketplace) :

```yaml
name: QA-UI Agent
on: workflow_dispatch
jobs:
  qa:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      checks: write        # nécessaire pour publier le rapport comme « check »
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test-run -- "https://exemple.tn/login" "Vérifier que le message d'erreur s'affiche"
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
      - run: npm run export-report -- latest --out reports/qa-ui-agent.xml --fail-on-failure
        if: always()
      - uses: mikepenz/action-junit-report@v6
        if: always()
        with:
          report_paths: backend/reports/qa-ui-agent.xml
```

## Relance automatique et tests instables

Une page qui se met à jour, un réseau lent ou un élément qui apparaît une demi-seconde trop tard font
échouer un test qui passerait une seconde plus tard. Une étape en échec est donc **relancée** (1 fois par
défaut, réglable avec `STEP_RETRIES`), avec une attente plus courte que la première tentative
(`STEP_RETRY_TIMEOUT_MS`).

- **Relance sûre seulement** (`isRetryable`) : cible pas encore affichée, texte ou adresse qui s'affiche
  à l'instant, navigation expirée. **Jamais** une erreur déterministe (étape invalide, sélecteur inventé
  ou ambigu, DNS, certificat), ni un clic ou un retour arrière qui a pu s'exécuter avant de planter :
  le refaire pourrait agir deux fois (ajouter deux fois au panier, reculer de deux pages).
- **« Instable »** : une étape réussie seulement à la relance garde son statut `passed`, mais elle porte
  `attempts` et `firstFailure` (le code et la phrase du premier échec). Le run reçoit `flakySteps`. Le
  rapport affiche un bandeau « Test instable », un badge sur l'étape et la ligne correspondante dans le PDF.
- Un échec confirmé après relances n'est pas masqué : l'erreur affichée est celle de la **dernière**
  tentative, avec le nombre d'essais.

**Voir la relance en action** (depuis `backend/`) : `node src/demo-instable.js`. Le script lance un vrai test
sur une page locale dont le message n'apparaît qu'au bout de 4,5 s, alors que chaque étape n'attend que 2 s :
la première tentative échoue, la relance réussit. Pas d'IA, le scénario est écrit à la main, donc le résultat
est reproductible. Le run est enregistré comme les autres (ouvre « Reports »).

## Erreurs d'étape lisibles

Une étape en échec n'affiche plus le message brut de Playwright. Chaque échec est classé
(`step-errors.js`) et enregistré dans `result.failure` avec :

- un **code stable** (`E-URL-001`...), pour retrouver et regrouper les échecs ;
- une **phrase lisible** (aussi dans `result.error`) ;
- **Attendu / Trouvé** : par exemple le texte attendu et les textes réellement visibles sur la page
  (lus au moment de l'échec, jamais la valeur d'un champ de saisie) ;
- une **piste d'action** (« une action manque peut-être avant cette vérification — boutons visibles :
  « Continuer » ») ;
- le **message technique d'origine**, replié dans « Détails techniques » (interface web).

| Code | Catégorie | Cas typique |
|---|---|---|
| `E-SEL-001` | `SELECTOR_HALLUCINATED` | sélecteur inventé par l'IA, absent du crawl |
| `E-STP-001` | `INVALID_STEP` | étape sans sélecteur, type inconnu, assertion vide |
| `E-ELM-001` | `ELEMENT_NOT_FOUND` | aucun élément ne correspond au sélecteur |
| `E-ELM-002` | `ELEMENT_NOT_VISIBLE` | élément présent mais caché |
| `E-ELM-003` | `ELEMENT_DISABLED` | élément désactivé |
| `E-ELM-004` | `ELEMENT_OBSCURED` | un bandeau ou une fenêtre recouvre la cible |
| `E-ELM-005` | `ELEMENT_AMBIGUOUS` | le sélecteur désigne plusieurs éléments |
| `E-TXT-001` | `TEXT_MISMATCH` | le texte affiché diffère du texte attendu |
| `E-URL-001` | `URL_MISMATCH` | l'adresse atteinte ne contient pas l'adresse attendue |
| `E-NAV-001` | `NAVIGATION_ERROR` | DNS, connexion refusée, certificat |
| `E-TMO-001` | `TIMEOUT` | chargement ou action trop lents |
| `E-CRW-001` | `CRAWL_EMPTY` | l'exploration n'a trouvé aucun élément ni texte sur la page |
| `E-PLN-001` | `PLAN_EMPTY` | l'IA n'a généré aucune étape exécutable |
| `E-UNK-001` | `UNKNOWN` | non reconnue (le détail technique est conservé) |

Les anciens runs, enregistrés avant ce format, n'ont que `error` et s'affichent comme avant.

**Erreurs qui interrompent tout le run** (`result.failure` au niveau du run, affichée sous la frise des
phases) : un site injoignable pendant l'exploration (`E-NAV-001`), une **page vide** (`E-CRW-001`) ou une IA
sans étape (`E-PLN-001`). Sur une page vide, le run s'arrête tout de suite : l'IA n'est pas appelée (elle
n'aurait aucun élément à utiliser) et la phase « Exploration » apparaît en échec au lieu d'un faux vert.
Une page qui n'a que du texte (sans champ ni bouton) reste testable avec `assert_text`. Les chemins du
serveur et les clés d'API sont masqués dans tous les messages enregistrés.

## Capture au moment de l'échec

Quand une étape échoue, le runner prend une **seconde capture** (`run-screenshots/<runId>-step<N>-failure.png`),
en plus de la capture normale de l'étape (celle-là reste inchangée : c'est elle que compare le diff visuel).
Sur cette capture d'échec :

- un **cadre rouge** entoure l'élément visé quand il est trouvé et visible (bouton désactivé, texte attendu, champ...) ;
- un **bandeau rouge** en haut de la page rappelle l'étape, le code d'erreur (`E-ELM-001`...) et la cause ;
- si l'élément est **introuvable** ou **présent mais invisible**, il n'y a pas de cadre : le bandeau le dit ;
- pour une étape sans élément (adresse attendue, ouverture de la page), il n'y a que le bandeau.

Le repère est un calque posé par la page puis retiré aussitôt : il ne modifie pas le site testé. La capture est dans le
rapport (cliquer pour agrandir), dans le JSON exporté (`failureScreenshot`) et dans le JUnit XML. Elle est bornée dans le
temps et ne peut jamais faire échouer ou bloquer un run. Les valeurs secrètes ne figurent pas dans le bandeau
(il reprend la cause déjà masquée) ; un champ visible de la page, lui, apparaît comme sur n'importe quelle capture.

## Trace Playwright rejouable sur échec

Quand un run **échoue**, le runner garde une **trace Playwright** (`run-traces/<runId>.zip`) : un enregistrement du test qu'on
rejoue action par action, avec les captures avant/après chaque action, l'état de la page (DOM), les requêtes réseau et la
console. C'est l'outil le plus rapide pour comprendre *pourquoi* une étape a échoué, surtout quand le test est instable.

- **Où la trouver** : dans le rapport du run, bloc « Trace Playwright rejouable » (bouton de téléchargement), et dans le JSON
  exporté (`tracePath`).
- **La rejouer** : `npx playwright show-trace <runId>.zip` depuis le dossier du fichier téléchargé, ou glisser le zip dans
  [trace.playwright.dev](https://trace.playwright.dev) (tout se passe dans le navigateur, rien n'est envoyé).
- **Run réussi** : aucune trace n'est conservée (elle pèse plusieurs Mo pour rien).
- **Identifiants secrets** : une trace enregistre chaque action *avec ses valeurs*. Si le scénario utilise une variable
  `{{QA_SECRET_*}}`, aucune trace n'est enregistrée (le rapport l'explique, `traceSkipped: "secrets"`), pour ne jamais écrire un
  mot de passe en clair dans un fichier. Même règle si un mot de passe est **écrit en clair** dans le scénario (champ de mot
  de passe repéré : le planner marque l'étape `sensitive`, et les scénarios plus anciens sont reconnus à leur sélecteur ou
  leur description) : le rapport affiche alors le même message, et l'avertissement « Mot de passe écrit en clair » reste là
  pour te pousser à utiliser une variable `QA_SECRET_*`.
- **Sécurité** : le zip contient des captures et le DOM de la page testée ; la route `/traces` exige donc le même token que
  les captures d'écran et sert le fichier en téléchargement.
- La trace est une aide au diagnostic : si elle ne peut pas être démarrée ou écrite, le run continue normalement.

## Accessibilité (axe-core)

Sur l'écran « New Run », l'interrupteur **Accessibilité** (activé par défaut) fait auditer les pages du test avec
[axe-core](https://github.com/dequelabs/axe-core), le moteur de référence pour les règles WCAG 2.0 / 2.1 (niveaux A et AA) :
contraste insuffisant, champ de formulaire sans étiquette, bouton sans nom, image sans texte alternatif, titres ou langue
de page manquants...

- **Quelles pages ?** Chaque **nouvelle page rencontrée** pendant le scénario (adresse sans `?requête` ni `#ancre`) est auditée une
  fois, 4 au plus : l'audit suit le parcours du test (page de connexion, formulaire, page après connexion...). Il se fait une fois la page affichée.
- **Dans le rapport** : bloc « Accessibilité » avec, par page, les règles non respectées classées par gravité (**critique, grave,
  modéré, mineur**), le nombre d'éléments concernés, leurs sélecteurs et un extrait de leur code, le message de correction (en
  français) et le lien vers la règle. Les points qu'axe ne peut pas trancher sont comptés « à vérifier à la main ».
- **Le statut du test ne change jamais** : un test vert reste vert, même avec des problèmes d'accessibilité (comme l'analyse RTL).
  Une erreur d'audit est notée dans le rapport, sans faire échouer le run.
- **Export JSON** : `analyses.accessibility` (totaux, pages, règles, sélecteurs).
- **Rejeu** : « Relancer ce scénario » reprend le choix du run d'origine.
- **Limite importante** : l'audit automatique ne trouve qu'une partie des problèmes (environ un tiers). « Aucun problème
  détecté » ne prouve pas que la page est accessible : complète avec un test manuel (navigation au clavier seul, lecteur d'écran, zoom 200 %).
- Coût : environ 1 à 2 secondes par page auditée. Le code d'axe-core est lu dans `node_modules` et injecté dans la page par le
  navigateur (la politique de sécurité du site n'y change rien) ; aucune donnée n'est envoyée à un service externe.

## Performance (Core Web Vitals)

Sur l'écran « New Run », l'interrupteur **Performance** (activé par défaut) mesure chaque **nouvelle page rencontrée** pendant le test
(même règle que l'accessibilité : adresse sans `?requête` ni `#ancre`, 4 pages au plus), avec les API standard du navigateur :

| Indicateur | Ce qu'il mesure | Bon | Mauvais |
|---|---|---|---|
| **TTFB** | délai avant le premier octet reçu | ≤ 800 ms | > 1 800 ms |
| **FCP** | premier affichage de contenu | ≤ 1 800 ms | > 3 000 ms |
| **LCP** | affichage du plus gros élément visible | ≤ 2 500 ms | > 4 000 ms |
| **CLS** | décalages de mise en page (sans unité) | ≤ 0,1 | > 0,25 |

S'y ajoutent le **poids transféré** (alerte au-delà de 3 Mo), le **nombre de requêtes** (alerte au-delà de 100) et les 3 ressources les plus lentes.
Les seuils sont ceux de Google. Chaque point faible est un défaut `P-TTFB`, `P-FCP`, `P-LCP`, `P-CLS`, `P-WEIGHT` ou `P-REQUESTS`
(gravité importante si l'indicateur est « mauvais », moyenne s'il est « à améliorer »).

- **Le statut du test ne change jamais** (comme l'accessibilité, le RTL et le responsive). Export JSON : `analyses.performance`.
- **C'est une mesure de laboratoire** : un seul chargement, depuis la machine qui exécute l'outil et son réseau. Elle varie d'un test à
  l'autre et ne remplace pas une mesure sur de vrais utilisateurs.
- **LCP et CLS n'existent que sur Chromium** : sur Firefox et WebKit ils sont affichés « non mesuré ».
- **Application monopage** : une page atteinte sans rechargement n'a pas de chronométrage propre (le navigateur ne décrit que le premier
  document chargé). Elle est signalée « non notée » plutôt que de se voir attribuer de fausses mesures.
- Le poids des ressources d'un autre domaine sans en-tête `Timing-Allow-Origin` est inconnu : le total est alors une approximation basse.

## Liens cassés

L'interrupteur **Liens cassés** (activé par défaut) lit, sur chaque nouvelle page (4 au plus), les liens, les ancres et les images, puis le
**serveur** vérifie les liens (40 au plus par page, ceux du même site en premier) :

- **Lien cassé** : 404 / 410, erreur serveur (5xx), nom de domaine introuvable, connexion refusée, certificat invalide ou délai de 6 s dépassé.
- **Ancre cassée** : un lien `#section` dont aucun élément de la page n'a cet identifiant.
- **Image cassée** : une image qui n'a pas pu se charger (les SVG sont ignorés).
- **Protégé** (401, 403, 429) : compté à part, jamais « cassé » : un visiteur non connecté ne peut pas juger ces pages, et certains sites
  répondent 403 ou 429 aux robots.
- **Non vérifié** : adresses locales ou hôtes non autorisés, liens au-delà de la limite, délai global (30 s par page) dépassé.

**Sécurité** : le serveur ne fait des requêtes que vers des adresses lues dans une page, donc :
- chaque adresse **et chaque étape d'une redirection** passe par `assertSafeTargetUrl` : une page ne peut pas faire contacter `localhost`,
  un réseau privé ou une adresse de métadonnées cloud, ni directement ni par redirection ; `ALLOWED_TARGET_HOSTS` est respecté
  (les liens vers d'autres hôtes sont alors « non vérifiés ») ;
- les requêtes partent **sans cookies ni session** : un lien « Déconnexion » ou « Supprimer » ne peut rien déclencher ;
- `HEAD` d'abord, puis un `GET` limité à 1 octet si le serveur refuse `HEAD` ; aucun contenu n'est conservé.

Les vérifications tournent en arrière-plan pendant le scénario et sont attendues à la fin du run. Le statut du test ne change jamais.
Export JSON : `analyses.links`. Un lien signalé cassé reste à confirmer à la main.

## Responsive (mobile, tablette, bureau)

Sur l'écran « New Run », l'interrupteur **Responsive** (activé par défaut) fait voir chaque page du test à trois tailles
d'écran : **mobile** (375 × 812), **tablette** (768 × 1024) et **bureau** (1440 × 900).

- **Quelles pages ?** Comme pour l'accessibilité : chaque **nouvelle page rencontrée** pendant le scénario (adresse sans `?requête`
  ni `#ancre`), 4 au plus. La **même page** est redimensionnée puis remise à sa taille d'origine : la session, la connexion et
  l'état du test sont conservés, aucun clic n'est rejoué.
- **Ce qui est contrôlé :**
  - `R-OVERFLOW` : la page défile horizontalement, avec les éléments qui dépassent de l'écran (gravité importante sur mobile
    et tablette, moyenne sur bureau) ;
  - `R-NO-VIEWPORT-META` : pas de balise `<meta name="viewport">` (mobile seulement) : un vrai téléphone afficherait la version
    bureau réduite ;
  - `R-SMALL-TARGET` : boutons, liens ou champs de moins de 24 × 24 px sur mobile et tablette (WCAG 2.2, critère 2.5.8 ; les liens
    placés dans une phrase sont exemptés).
- **Dans le rapport** : bloc « Responsive » avec, par page et par taille d'écran, une **capture** (cliquer pour agrandir)
  et la liste des défauts. Les captures sont des fichiers `run-screenshots/<runId>-responsive-p<N>-<taille>.png`, séparés des
  captures d'étape : elles n'entrent pas dans le diff visuel.
- **Le statut du test ne change jamais** : un test vert reste vert, même avec des défauts d'affichage (comme l'accessibilité et le RTL).
  Une erreur de contrôle est notée dans le rapport, sans faire échouer le run.
- **Export JSON** : `analyses.responsive` (totaux, pages, tailles, défauts, chemin des captures). **Rejeu** : « Relancer ce scénario »
  reprend le choix du run d'origine.
- **Limites** : on redimensionne la fenêtre, on n'émule pas un vrai téléphone (écran tactile, user-agent, densité de pixels) ; un site qui
  sert une autre page selon le navigateur n'est donc pas vu comme sur mobile. Le contrôle repère des défauts mesurables, pas un affichage
  « peu soigné » : regarde les captures et complète par un essai sur un vrai appareil. Un site qui réagit mal à un redimensionnement
  en cours de route peut, dans de rares cas, changer d'état : désactive alors l'interrupteur pour ce test.

## Historique et tendances

L'écran **Historique** (`/history`, menu « Historique », ou le lien en haut de « Reports ») répond à « mes tests
vont-ils mieux ou moins bien avec le temps ? » à partir des runs déjà enregistrés (rien de plus à configurer) :

- **Chiffres globaux** : runs terminés, taux de réussite, durée moyenne, runs instables (étape réussie seulement après relance).
- **Derniers runs** : une barre par run (couleur = résultat, hauteur = durée), cliquable vers son rapport.
- **Par ticket** : les runs de la même URL + même ticket + même navigateur sont regroupés (même règle que le diff visuel ;
  espaces et majuscules ignorés). Chaque ticket affiche sa **tendance** :
  *Régression* (vient de casser), *Échoue de façon répétée*, *Instable* (résultats qui alternent ou réussite après relance),
  *Rétabli*, *Stable*, plus « De plus en plus lent » quand les 3 derniers runs durent 30 % de plus que les 3 d'avant.
  Les tests à regarder d'abord (régression, échecs répétés) sont en haut.
- **Erreurs les plus fréquentes** : les codes d'erreur (`E-ELM-001`...) qui reviennent le plus, avec leur libellé.

Règles : seuls les runs **terminés** comptent (« en cours » est ignoré) ; une erreur du pipeline (site injoignable, page vide)
compte comme un échec ; au plus 20 runs par ticket sont affichés et les 300 runs les plus récents sont lus.
Les anciens runs enregistrés avant les codes d'erreur comptent dans les taux, mais sans code.

- **API** : `GET /api/history` (token requis) — le calcul est dans `backend/src/run-history.js`, testé sans navigateur.

## Exploration après un clic

Le crawl normal ne voit que la page affichée à l'ouverture. Quand le scénario de l'IA commence par des
clics (choisir un profil, puis « Continuer »), le programme refait ces clics dans un navigateur, lit la
page atteinte (champs, boutons, textes) puis redemande un scénario à l'IA en lui donnant ces éléments en plus.
Les étapes sur le formulaire de la 2ᵉ page sont alors validées comme les autres : un sélecteur inventé
reste refusé.

- Seuls des **clics** sont faits pendant l'exploration (jamais de saisie ni d'envoi), 3 au plus, tant que le
  scénario ne contient pas encore de saisie.
- Un clic dont le bouton n'existe pas encore sur la page de départ (ex. « Continuer », visible seulement après le choix
  du profil) est quand même tenté **à partir du 2ᵉ clic** ; s'il échoue vraiment, l'exploration s'arrête et le rapport le dit.
- Si rien de nouveau n'apparaît, l'IA n'est pas rappelée. Si l'exploration échoue, le run continue avec
  le premier scénario et un avertissement.
- Le rapport indique toujours le bilan : « Page explorée après « ... » puis « ... » : N élément(s) en plus », ou « rien de nouveau sur la page atteinte », ou « le clic « ... » n'a pas pu être fait (raison) ». Le terminal du serveur affiche aussi une ligne `exploration après clic : 2/2 clic(s)...` à chaque run.
- Un coût : un 2ᵉ appel à l'IA (et un 2ᵉ chargement de la page) quand l'exploration trouve du nouveau.

Pour voir ce que l'agent découvre après tes clics (diagnostic, sans IA ni run) :

```
cd backend
npm run explore-clicks -- https://staging.helpify.tn/auth/login Je suis une Association puis Continuer
```

Les clics sont séparés par le mot « puis » (sous Windows, npm perd souvent les guillemets). La commande affiche les clics réussis, l'adresse atteinte, les nouveaux champs et textes, et enregistre une
capture de la page atteinte dans `backend/debug-screenshots/`.

## Une page qui s'ouvre trop lentement dans l'outil

L'outil n'exige plus que la page ait fini de charger tous ses scripts : seule la réponse du serveur est
attendue, puis l'outil attend « au mieux » (un script externe bloqué ne fait plus échouer le test). Si une
page s'ouvre dans ton navigateur mais dépasse le délai dans l'outil :

```
cd backend
npm run diagnose-page -- https://staging.helpify.tn/auth/login
```

La commande ouvre la page 25 s et affiche l'état du chargement, les requêtes restées sans réponse (souvent
un script ou une police externe), les requêtes échouées et les erreurs de la console.

## Se connecter avec un compte de test (variables secrètes)

Pour tester les pages qui sont derrière une connexion, l'outil peut saisir les identifiants d'un **compte de
test dédié à l'environnement de staging**, sans que l'IA ni les rapports ne les voient jamais.

1. Dans `backend/.env`, ajoute des variables dont le nom commence par `QA_SECRET_` (exemple pour Helpify) :

```
QA_SECRET_ASSOCIATION=identifiant-de-l-association-de-test
QA_SECRET_EMAIL=email-du-compte-de-test@exemple.tn
QA_SECRET_PASSWORD=mot-de-passe-du-compte-de-test
```

2. Redémarre le serveur. L'IA reçoit seulement les **noms** de ces variables. Dans le ticket, écris simplement
   « se connecter avec le compte de test » (jamais l'email ni le mot de passe).
3. L'IA écrit dans les étapes `{{QA_SECRET_EMAIL}}` ; la vraie valeur n'est insérée qu'au moment de saisir dans
   le navigateur.

Ce que l'outil garantit :

- les valeurs ne sont écrites ni dans le scénario enregistré, ni dans `runs/*.json`, ni dans les exports JUnit/JSON, ni
  dans les messages d'erreur (toute valeur qui y apparaîtrait est remplacée par `***`) ;
- seules les variables `QA_SECRET_*` sont lisibles : une étape ne peut pas lire `GROQ_API_KEY` ou `JWT_SECRET` ;
- une variable absente du `.env` donne l'erreur lisible `E-SEC-001` (sans relance) et un avertissement à la génération ;
- un mot de passe écrit en clair dans un scénario déclenche un avertissement.

À savoir : les captures d'écran montrent ce qui est affiché. Le mot de passe y est masqué par le navigateur, mais
pas l'email ni l'identifiant : utilise un compte de test, jamais un vrai compte. Ne mets jamais d'identifiants dans le
texte d'un ticket : ils seraient enregistrés avec le run. Le fichier `.env` ne doit jamais être envoyé sur GitHub.

## Configuration (`backend/.env`)

Copie `.env.example` en `.env`. Variables obligatoires : `GROQ_API_KEY`, `AUTH_PASSWORD`, `JWT_SECRET`
(32 caractères aléatoires minimum — le serveur affiche un avertissement au démarrage sinon).

Variables optionnelles :

| Variable | Rôle | Défaut |
|---|---|---|
| `ALLOWED_TARGET_HOSTS` | Liste (virgules, jokers `*.`) des seuls sites que le serveur peut tester | tous les sites publics |
| `ALLOW_PRIVATE_TARGETS` | `true` pour tester une appli sur `localhost`/réseau privé (dev uniquement) | refusé |
| `CORS_ORIGIN` | Origines autorisées à appeler l'API depuis un navigateur | `http://localhost:5173` |
| `TRUST_PROXY` | Nombre de reverse proxys devant l'API (pour que l'anti-bruteforce voie la vraie IP) | désactivé |
| `NETWORK_SETTLE_TIMEOUT_MS` | Attente max (ms) du « réseau calme » après chargement (les sites à carrousel/analytics ne se calment jamais : on continue ensuite) | `5000` |
| `RENDER_TIMEOUT_MS` | Attente max (ms) qu'une appli monopage (Angular, React...) affiche son contenu avant de le lire/capturer (`0` = ne pas attendre) | `10000` |
| `STEP_RETRIES` | Relances automatiques d'une étape en échec (`0` à `2`, `0` = aucune) | `1` |
| `STEP_RETRY_TIMEOUT_MS` | Attente max (ms) lors d'une relance, plus courte que la première tentative | `3000` |
| `JWT_LIFETIME` | Durée d'une session (`12h`, `7d`...) | `7d` |
| `MAX_CONCURRENT_RUNS` | Nombre de runs (donc de Chromium) simultanés | `2` |
| `VISUAL_DIFF_THRESHOLD_PERCENT` | % de pixels différents au-delà duquel une étape est une régression | `0.5` |
| `AR_TOGGLE_KEYWORDS` | Libellés supplémentaires du bouton « passer en arabe » | arabe, arabic, AR, العربية, عربي |
| `I18N_IGNORE_TEXTS` | Textes identiques FR/AR à ne pas signaler (marques...) | e-mails et URLs seulement |

> Le serveur peut être lancé depuis n'importe quel dossier : `runs/`, `run-screenshots/`, etc.
> sont toujours créés sous `backend/`.

## Le frontend

App React (Vite + Tailwind), thème sombre. Écrans principaux :

- **Dashboard** — stats des runs récents (total/réussis/échoués/avertissements), filtres de
  statut + recherche par ticket ou URL, bandeau pipeline cliquable (Ticket → Explore → E2E → Diff
  → RTL).
- **Explore** (`/explore`) — lance le crawl seul, affiche les éléments détectés avec leur
  sélecteur et stratégie ; bouton pour passer directement à "New Test" avec l'URL pré-remplie.
- **New Test** (`/new-run`) — configuration du run : URL, ticket, lien du ticket Jira/Linear
  (optionnel), timeout, toggles RTL/diff visuel/accessibilité/relecture IA approfondie.
- **Live Run** (`/live-runs/:id`) — suivi en direct d'un run (captures d'écran réelles au fil de
  l'exécution).
- **Visual & RTL** (`/visual-rtl`) — comparateur de deux runs (côte à côte ou diff overlay) +
  vérification i18n.
- **Historique** (`/history`) — taux de réussite, durées, tendances par ticket, erreurs fréquentes.
- **Rapport** (`/reports/:id`) — résumé du ticket + lien vers le ticket externe, score de
  confiance, étapes détaillées, notes manuelles libres, bouton "Relancer ce scénario", export PDF
  (`jspdf`, chargé en import dynamique pour ne pas alourdir le bundle principal).
- **Rapports** (`/reports`) — liste de tous les runs, avec recherche par ticket ou URL.

```bash
cd frontend
npm install
npm run dev
```

## Limites connues

Ce que l'outil ne sait pas (encore) faire, pour ne pas lui faire dire plus qu'il ne prouve :

- **L'IA peut varier.** Le scénario est généré par un modèle (Groq) : deux runs du même ticket peuvent donner des étapes un peu
  différentes. Les garde-fous retirent les sélecteurs inventés et les vérifications qui réussiraient toujours, et la « confiance »
  baisse quand le scénario ne vérifie rien, mais un ticket flou donne un test flou. Cite les libellés exacts et les adresses attendues.
- **Les pages suivantes ne sont connues que pour les clics.** L'exploration rejoue au plus 3 clics du début du scénario. Après une
  saisie ou une connexion, la page atteinte n'est pas explorée à l'avance : pour la vérifier, donne dans le ticket l'adresse
  (`assert_url`) ou un texte exact qui doit apparaître.
- **Un test « réussi » ne prouve que ce qu'il vérifie.** Sans étape `assert_*`, le rapport l'avertit et plafonne la confiance à 30 %.
- **Réseau instable.** Si la connexion au site expire (`ERR_CONNECTION_TIMED_OUT`), l'ouverture de la page est réessayée une fois ;
  si elle échoue encore, le rapport l'indique clairement (« Connexion au site impossible », code `E-NAV-001`) au lieu d'une page vide.
  Dans ce cas teste depuis un autre réseau (ex. partage de connexion du téléphone) pour savoir si le problème vient de ta connexion.
- **Sélecteurs.** Un élément sans nom accessible, sans id ni attribut stable reçoit un sélecteur de position (fragile si la page change).
- **Régression visuelle.** Elle compare des captures pixel à pixel : une date, un compteur de notifications ou une animation qui
  change donne un écart. Deux runs ne se comparent que s'ils ont le même ticket, la même URL et le même navigateur.
- **RTL / traduction FR-AR.** La détection de textes non traduits est une heuristique : les noms propres et marques (« Powered by »)
  peuvent être signalés à tort (liste `I18N_IGNORE_TEXTS` pour les ignorer).
- **Comptes de test.** Une connexion automatique utilise `QA_SECRET_*` ; les captures montrent l'email et l'identifiant (pas le mot
  de passe). Pas de double authentification ni de captcha. L'accès à l'outil lui-même repose sur un mot de passe d'équipe unique.
- **Pas encore couverts :** iframes et pages derrière une double authentification (non testés).
- **Stockage.** Les runs, les captures et les traces sont des fichiers dans `backend/` (pas de base de données, pas de nettoyage automatique).

## Prochaines pistes

- Nettoyage automatique des vieux runs et screenshots (aucune limite de rétention pour l'instant)
- Exploration après une saisie (aujourd'hui seuls les clics sont rejoués pendant l'exploration)
- Courbe du score de confiance dans le temps, par ticket (l'Historique montre déjà réussite, durée et instabilité)