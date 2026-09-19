<<<<<<< HEAD
# QA-UI Agent

Projet personnel complémentaire au stage QA (DevWise) : génération et exécution automatique de tests E2E à partir d'un ticket en langage naturel.

## Structure

```
qa-ui-agent/
├── backend/          # API + moteur Playwright (Node.js)
│   └── src/
│       └── crawler.js   # Étape 1 : crawl d'une page, détection des éléments interactifs
└── frontend/         # UI React (à venir)
```

## Étape 1 — Le crawler (fait)

`backend/src/crawler.js` ouvre une URL avec Playwright, attend le réseau stable (`networkidle`),
puis liste tous les éléments interactifs visibles (boutons, liens, inputs, selects, éléments
avec `role`, etc.) et calcule pour chacun le sélecteur le plus stable possible, dans cet ordre :

1. `data-testid` / `data-test-id`
2. `id`
3. `name`
4. sélecteur CSS de secours (chemin dans le DOM — signalé comme fragile)

C'est cette liste qui sera ensuite donnée à l'IA (avec le texte du ticket) pour générer le
scénario de test, plutôt que de laisser l'IA deviner des sélecteurs à l'aveugle.

### Lancer le crawl

```bash
cd backend
npm install
npx playwright install chromium   # télécharge le binaire du navigateur (une seule fois)
npm run crawl -- https://the-internet.herokuapp.com/login
```

> Note : dans l'environnement où ce projet a été généré, le téléchargement du binaire Chromium
> par `npx playwright install` a été bloqué par les restrictions réseau du sandbox
> (`cdn.playwright.dev` n'est pas autorisé). Le code est syntaxiquement validé mais n'a pas pu
> être exécuté de bout en bout ici — à tester chez toi où l'accès réseau est complet.

Le script affiche un JSON avec, pour chaque élément : tag, type, rôle, nom accessible,
sélecteur recommandé, et la stratégie utilisée pour le trouver.

## Étape 2 — Le module IA (fait)

`backend/src/planner.js` prend en entrée le texte d'un ticket + le résultat du crawler, et
appelle Groq (`llama-3.3-70b-versatile`, mode JSON strict) pour générer un scénario de test
structuré : une liste d'étapes (`navigate`, `click`, `fill`, `select`, `assert_visible`,
`assert_text`, `go_back`), chacune avec un sélecteur.

**Garde-fou anti-hallucination** : après la réponse de l'IA, `validateScenario()` vérifie que
chaque sélecteur utilisé existe réellement dans la liste fournie. Si l'IA invente un sélecteur
qui n'existe pas, l'étape est marquée `"selectorValid": false` et un avertissement est ajouté
— plutôt que de laisser passer un sélecteur qui ferait planter l'exécution plus tard.

### Configuration

```bash
cd backend
cp .env.example .env
# puis édite .env et colle ta clé Groq à la place de "colle_ta_clé_ici"
```

### Lancer crawl + génération IA en une commande

```bash
npm run plan -- https://staging.helpify.tn/auth/login "Vérifier que je peux choisir Je suis un Donateur puis continuer"
```

Le script affiche le scénario JSON généré, avec un résumé du ticket, la liste des étapes,
et d'éventuels avertissements.

## Étape 3 — L'exécution réelle (fait)

`backend/src/runner.js` prend un scénario généré (voir étape 2) et l'exécute réellement dans
un vrai navigateur Playwright : clic, saisie, sélection, vérifications. Une capture d'écran
est prise après CHAQUE étape (succès ou échec) — c'est souvent l'échec qui est le plus utile
à voir visuellement. Le scénario s'arrête dès qu'une étape échoue.

Nouveau type d'étape ajouté suite à un cas réel rencontré sur Helpify : `assert_enabled`
vérifie qu'un élément n'est plus désactivé (attribut `disabled`, `aria-disabled`, ou curseur
`not-allowed`) — utile pour les boutons qui ne s'activent qu'après une autre action.

### Lancer le pipeline complet (crawl + IA + exécution réelle)

```bash
npm run test-run -- https://staging.helpify.tn/auth/login "Vérifier que je peux choisir Je suis un Donateur puis continuer"
```

Le script affiche le statut global (`PASSED`/`FAILED`), le détail de chaque étape, et le
chemin vers les captures d'écran dans `backend/run-screenshots/`.

## Étape 4 — Diff visuel entre deux runs (fait)

Chaque run est maintenant sauvegardé dans `backend/runs/<runId>.json` (fait automatiquement
par `npm run test-run`). `backend/src/visual-diff.js` compare deux runs sauvegardés,
étape par étape, en comparant leurs screenshots pixel par pixel (librairie `pixelmatch`).

Une étape est signalée comme régression visuelle si plus de **0,5% des pixels** diffèrent
entre les deux runs (seuil réglable dans `REGRESSION_THRESHOLD_PERCENT`, `visual-diff.js`).
Si les deux screenshots n'ont pas les mêmes dimensions (mise en page changée), la comparaison
est signalée `"comparable": false` plutôt que de donner un résultat trompeur.

### Comparer deux runs

```bash
# 1. Lance le pipeline deux fois (à des moments différents, ou après un changement de code)
npm run test-run -- https://staging.helpify.tn/auth/login "Vérifier que je peux choisir Je suis un Donateur puis continuer"
# note le runId affiché (ex: runs/1789775621266.json)

npm run test-run -- https://staging.helpify.tn/auth/login "Vérifier que je peux choisir Je suis un Donateur puis continuer"
# note le deuxième runId

# 2. Compare les deux
npm run compare -- 1789775621266 1789776xxxxxx
```

Le rapport affiche, pour chaque étape, le pourcentage de pixels différents et si c'est jugé
une régression. Les images de diff (zones différentes surlignées) sont dans
`backend/diff-screenshots/`.

## Étape 5 — FR/AR + RTL (fait)

`backend/src/localization-check.js` charge la page en français, cherche automatiquement le
bouton de changement de langue (repéré via le crawler, sur des mots-clés comme "arabe"), clique
dessus, puis re-crawle la page en arabe et compare les deux états :

1. **RTL appliqué ?** Vérifie que `dir="rtl"` (ou la direction calculée) est bien actif après
   le passage en arabe.
2. **Oubli de traduction ?** Associe les éléments FR/AR par leur sélecteur (stable d'une langue
   à l'autre puisqu'il est basé sur la structure du DOM, pas sur le texte) et signale tout texte
   strictement identique dans les deux langues — exactement le type de bug qu'on cherchait à
   automatiser (cf. NOTIF-21).

### Lancer la vérification

```bash
npm run check-i18n -- https://staging.helpify.tn/auth/login
```

Le rapport liste chaque problème trouvé (`rtl-not-applied`, `untranslated-text`) avec le
sélecteur concerné.

> Si le script ne trouve pas le bouton de langue, le libellé exact utilisé sur Helpify n'est
> peut-être pas dans la liste `AR_TOGGLE_KEYWORDS` (`localization-check.js`) — ajoute-le.

## Prochaine étape

Le frontend React (dashboard, écrans de configuration/run/rapport, d'après les maquettes).
=======
# qa-ui-agent
>>>>>>> 6c1cf1dc6efe21da618926b804742cc01358842c
