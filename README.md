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
│   │   ├── run-store.js         # Sauvegarde/lecture des runs (backend/runs/<runId>.json)
│   │   ├── run-executor.js      # Orchestration d'un run en arrière-plan (startRun/startReplay)
│   │   └── server.js            # API Express consommée par le frontend
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
utilisables ensuite.

```bash
cd backend
npm install
npx playwright install chromium   # une seule fois
npm run crawl -- https://the-internet.herokuapp.com/login
```

### 2. Génération du scénario par l'IA (`planner.js`)

Prend le texte d'un ticket + le résultat du crawl, et appelle Groq (mode JSON strict) pour
générer un scénario structuré : une liste d'étapes (`navigate`, `click`, `fill`, `select`,
`assert_visible`, `assert_enabled`, `assert_text`, `go_back`), chacune avec un sélecteur.

**Garde-fous** (`validateScenario`, testés dans `test/planner.test.js`) :
- **Anti-hallucination** : tout sélecteur utilisé par l'IA qui n'existe pas dans la liste fournie
  par le crawl est neutralisé (`selectorValid: false`) et un avertissement est ajouté.
- **Anti-incohérence** : une étape `assert_enabled` n'est conservée que si elle est précédée d'une
  action d'activation (fill/select/click sur un autre sélecteur) *et* suivie d'un clic sur le même
  élément — sinon elle est retirée. Corrige un bug réel rencontré (run TR-0248) où l'IA ajoutait
  cette vérification sans qu'aucune action ne soit censée activer l'élément.
- **Score de confiance** (`scenario.confidence`) : 100% moins 15 points par avertissement réel —
  directement dérivé de `scenario.warnings`, jamais une estimation inventée.
- **Retry automatique** (`callGroqWithRetry`, testé dans `test/planner-retry.test.js`) : jusqu'à 3
  tentatives avec backoff exponentiel sur 429/5xx/erreur réseau ; abandon immédiat sur 401/400.

```bash
cp .env.example .env   # puis colle ta clé GROQ_API_KEY
npm run plan -- https://staging.helpify.tn/auth/login "Vérifier que je peux choisir Je suis un Donateur puis continuer"
```

### 3. Exécution réelle (`runner.js`)

Exécute le scénario dans un vrai Chromium : clic, saisie, sélection, vérifications. Capture un
screenshot après CHAQUE étape (succès ou échec) et s'arrête dès la première étape en échec.
`assert_enabled` vérifie qu'un élément n'est plus désactivé (`disabled`, `aria-disabled`, ou
curseur `not-allowed`).

Timeouts configurables (`stepTimeoutMs` par défaut 10s, `navigationTimeoutMs` par défaut 30s),
utile sur un environnement de staging plus lent — réglable via l'écran "New Test" du frontend ou
le paramètre `timeoutMs` de l'API.

```bash
npm run test-run -- https://staging.helpify.tn/auth/login "Vérifier que je peux choisir Je suis un Donateur puis continuer"
```

**Rejouer un scénario exact** (`run-executor.js` / `startReplay`) : rejoue les mêmes étapes sans
repasser par le crawl ni par l'IA — donne deux runs strictement comparables pour le diff visuel
(bouton "Relancer ce scénario" dans le rapport du frontend).

### 4. Diff visuel entre deux runs (`visual-diff.js`)

Chaque run est sauvegardé dans `backend/runs/<runId>.json`. `compareRuns` compare deux runs
étape par étape (pixel par pixel, via `pixelmatch`) ; une étape est une régression si plus de
**0,5%** des pixels diffèrent (`REGRESSION_THRESHOLD_PERCENT`). Si les dimensions diffèrent, la
comparaison est signalée `comparable: false` plutôt que de donner un résultat trompeur.

`compareRuns` détecte aussi et **signale** (au lieu de comparer en silence) : un nombre d'étapes
différent entre les deux runs, ou des descriptions d'étape différentes au même index — deux
indices que ce n'est probablement pas le même scénario rejoué.

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

`node:test` natif, aucune dépendance supplémentaire. Couvre les garde-fous de `planner.js`
(sélecteur halluciné, incohérence `assert_enabled`, score de confiance, retry Groq) et
`visual-diff.js` (comparaison identique/régression/dimensions différentes/scénarios non
comparables).

## Le frontend

App React (Vite + Tailwind), thème sombre. Écrans principaux :

- **Dashboard** — stats des runs récents (total/réussis/échoués/avertissements), filtres, bandeau
  pipeline cliquable (Ticket → Explore → E2E → Diff → RTL).
- **Explore** (`/explore`) — lance le crawl seul, affiche les éléments détectés avec leur
  sélecteur et stratégie ; bouton pour passer directement à "New Test" avec l'URL pré-remplie.
- **New Test** (`/new-run`) — configuration du run : URL, ticket, timeout, toggles RTL/diff
  visuel.
- **Live Run** (`/live-runs/:id`) — suivi en direct d'un run (captures d'écran réelles au fil de
  l'exécution).
- **Visual & RTL** (`/visual-rtl`) — comparateur de deux runs (côte à côte ou diff overlay) +
  vérification i18n.
- **Rapport** (`/reports/:id`) — résumé du ticket, score de confiance, étapes détaillées, bouton
  "Relancer ce scénario", export PDF (`jspdf`, chargé en import dynamique pour ne pas alourdir le
  bundle principal).

```bash
cd frontend
npm install
npm run dev
```

## Prochaines pistes

- Support multi-page dans un scénario (naviguer vers une 2ᵉ URL en cours de route)
- Historique du score de confiance dans le temps, par ticket