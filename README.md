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
│   │   ├── exploration.js       # Exploration après clic : choix des clics, fusion de la page suivante (pur)
│   │   ├── report-export.js     # Export d'un run en JUnit XML et en JSON (fonctions pures)
│   │   ├── report-cli.js        # Logique de la commande export-report (testée)
│   │   ├── export-report.js     # Point d'entrée : npm run export-report
│   │   ├── step-errors.js       # Erreurs d'étape structurées : catégorie, code stable, attendu/trouvé/piste
│   │   ├── run-executor.js      # Orchestration d'un run en arrière-plan (startRun/startReplay) + limite de runs
│   │   ├── run-analysis.js      # Analyses optionnelles après un run (RTL, diff visuel)
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

`node:test` natif, aucune dépendance supplémentaire — 213 tests. Couvre les garde-fous de
`planner.js` (sélecteur halluciné, incohérence `assert_enabled`, validation structurelle, score
de confiance, retry Groq, relecture IA double-passe, `assert_text` vide), `visual-diff.js`
(comparaison identique/régression/dimensions différentes/scénarios non comparables), le runner
(étapes à sélecteur halluciné), `url-guard.js` (SSRF), le stockage des runs et des notes, la
détection du bouton de langue, et l'API HTTP complète (auth, 400/401/404/429, CORS, en-têtes).

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

## Exploration après un clic

Le crawl normal ne voit que la page affichée à l'ouverture. Quand le scénario de l'IA commence par des
clics (choisir un profil, puis « Continuer »), le programme refait ces clics dans un navigateur, lit la
page atteinte (champs, boutons, textes) puis redemande un scénario à l'IA en lui donnant ces éléments en plus.
Les étapes sur le formulaire de la 2ᵉ page sont alors validées comme les autres : un sélecteur inventé
reste refusé.

- Seuls des **clics** sont faits pendant l'exploration (jamais de saisie ni d'envoi), 3 au plus, tant que le
  scénario ne contient pas encore de saisie.
- Si rien de nouveau n'apparaît, l'IA n'est pas rappelée. Si l'exploration échoue, le run continue avec
  le premier scénario et un avertissement.
- Le rapport indique la page explorée : « Page explorée après « ... » puis « ... » : N élément(s) en plus ».
- Un coût : un 2ᵉ appel à l'IA (et un 2ᵉ chargement de la page) quand l'exploration trouve du nouveau.

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
  (optionnel), timeout, toggles RTL/diff visuel/relecture IA approfondie.
- **Live Run** (`/live-runs/:id`) — suivi en direct d'un run (captures d'écran réelles au fil de
  l'exécution).
- **Visual & RTL** (`/visual-rtl`) — comparateur de deux runs (côte à côte ou diff overlay) +
  vérification i18n.
- **Rapport** (`/reports/:id`) — résumé du ticket + lien vers le ticket externe, score de
  confiance, étapes détaillées, notes manuelles libres, bouton "Relancer ce scénario", export PDF
  (`jspdf`, chargé en import dynamique pour ne pas alourdir le bundle principal).
- **Rapports** (`/reports`) — liste de tous les runs, avec recherche par ticket ou URL.

```bash
cd frontend
npm install
npm run dev
```

## Prochaines pistes

- Capture prise au moment de l'échec avec l'élément concerné encadré
- Nettoyage automatique des vieux runs et screenshots (aucune limite de rétention pour l'instant)
- Exploration après une saisie (aujourd'hui seuls les clics sont rejoués pendant l'exploration)
- Historique du score de confiance dans le temps, par ticket