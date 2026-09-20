const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Statuts HTTP considérés comme transitoires : ça vaut le coup de réessayer.
// 429 = rate limit, 5xx = problème temporaire côté Groq. Tout le reste (401, 400...)
// est une erreur durable — réessayer ne changerait rien, donc on ne retente jamais 4xx
// en dehors de 429.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calcule le délai avant la prochaine tentative. Respecte l'en-tête Retry-After
 * si Groq le fournit (typiquement sur un 429) ; sinon backoff exponentiel simple.
 */
function retryDelayMs(attempt, response) {
  const retryAfterHeader = response?.headers?.get?.("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }
  return BASE_DELAY_MS * 2 ** attempt;
}

const STEP_TYPES = [
  "navigate",
  "click",
  "fill",
  "select",
  "assert_visible",
  "assert_enabled",
  "assert_text",
  "go_back",
];

/**
 * Construit le prompt système : les règles STRICTES que l'IA doit respecter.
 * Le point le plus important : elle n'a le droit d'utiliser QUE les sélecteurs
 * fournis dans la liste d'éléments — jamais en inventer un.
 */
function buildSystemPrompt() {
  return `Tu es un générateur de scénarios de test E2E pour une équipe QA.

On te donne :
1. Le texte d'un ticket décrivant ce qu'il faut vérifier.
2. La liste EXACTE des éléments interactifs réellement présents sur la page (avec leur sélecteur).

Ta mission : produire un scénario de test structuré en JSON, qui utilise UNIQUEMENT les
sélecteurs listés. Tu n'as PAS le droit d'inventer un sélecteur qui n'est pas dans la liste.
Si le ticket demande une action pour laquelle aucun élément ne correspond dans la liste,
signale-le dans le champ "warnings" plutôt que d'inventer.

Réponds STRICTEMENT en JSON valide, sans aucun texte autour, selon ce format :

Règle importante sur les éléments marqués "disabledLooking": true dans la liste fournie :
ils sont visuellement désactivés au chargement de la page. N'ajoute une étape "assert_enabled"
sur un tel élément QUE si les deux conditions suivantes sont vraies :
  1. le scénario contient, juste avant, une action (fill/select/click sur un AUTRE sélecteur)
     dont le ticket dit explicitement qu'elle doit réactiver cet élément ;
  2. le scénario contient, juste après, un "click" sur ce MÊME sélecteur.
N'ajoute JAMAIS "assert_enabled" isolé, sans action d'activation avant ni clic après : dans ce
cas, vérifie simplement "assert_visible" si le ticket ne demande rien de plus. Si le ticket ne
mentionne aucune action susceptible d'activer l'élément, ne suppose pas qu'il faut en choisir une —
contente-toi de ce que le ticket demande explicitement.
{
  "ticketSummary": "résumé court du ticket en une phrase",
  "warnings": ["éventuel avertissement si le ticket demande quelque chose d'introuvable"],
  "steps": [
    {
      "type": "navigate|click|fill|select|assert_visible|assert_text|go_back",
      "selector": "le sélecteur EXACT copié depuis la liste fournie (ou null pour navigate/go_back)",
      "value": "valeur à saisir/sélectionner, uniquement pour fill/select/assert_text, sinon null",
      "description": "description courte et humaine de l'étape, en français"
    }
  ]
}

Types d'étapes disponibles : ${STEP_TYPES.join(", ")}.`;
}

function buildUserPrompt(ticketText, crawlResult) {
  const simplifiedElements = crawlResult.elements.map((el) => ({
    selector: el.selector,
    tag: el.tag,
    accessibleName: el.accessibleName,
    type: el.type,
    detectedBy: el.detectedBy,
    disabledLooking: el.disabledLooking,
  }));

  return `TICKET :
"""
${ticketText}
"""

PAGE ANALYSÉE : ${crawlResult.url}

ÉLÉMENTS INTERACTIFS DISPONIBLES (liste fermée — n'utilise que ces sélecteurs) :
${JSON.stringify(simplifiedElements, null, 2)}`;
}

/**
 * Prompt de la relecture (2e passe) : demande à l'IA de juger sémantiquement son
 * propre scénario, pas juste sa forme. validateScenario ne peut voir qu'un scénario
 * mécaniquement invalide (sélecteur inconnu, type inconnu) ; il ne peut pas voir un
 * scénario mécaniquement PARFAIT qui ne teste pourtant pas ce que demande le ticket
 * (ex. le ticket demande de vérifier un message d'erreur, et aucune étape ne vérifie
 * de texte). C'est ce trou que cette relecture comble.
 */
function buildReviewSystemPrompt() {
  return `Tu es un relecteur QA senior. On te donne un ticket et un scénario de test déjà
généré pour ce ticket. Ta seule tâche : juger si ce scénario teste vraiment ce que le
ticket demande — pas de le régénérer, pas de le corriger, juste le juger.

Cherche en particulier :
- une vérification explicitement demandée par le ticket qui n'a pas d'étape correspondante
  (ex. le ticket parle d'un message, d'un texte, d'une couleur, d'une redirection... et
  aucune étape "assert_*" ne le vérifie) ;
- une étape qui ne sert clairement à rien par rapport au ticket ;
- un ordre d'étapes qui ne peut pas fonctionner (ex. vérifier un élément avant l'action qui
  le fait apparaître).

Ne signale PAS de problème sur la validité technique des sélecteurs ou des types d'étapes :
c'est déjà vérifié ailleurs, ce n'est pas ton rôle.

Réponds STRICTEMENT en JSON valide, sans texte autour :
{
  "isCoherent": true|false,
  "issues": ["description courte et concrète de chaque problème trouvé, en français"]
}
Si tout va bien, renvoie "issues": [].`;
}

function buildReviewUserPrompt(ticketText, scenario) {
  const simplifiedSteps = scenario.steps.map((s) => ({
    type: s.type,
    selector: s.selector,
    value: s.value,
    description: s.description,
  }));

  return `TICKET :
"""
${ticketText}
"""

SCÉNARIO GÉNÉRÉ POUR CE TICKET :
${JSON.stringify(simplifiedSteps, null, 2)}`;
}

/**
 * Appelle Groq avec retry sur les erreurs transitoires (429, 5xx, coupure réseau).
 * Ne retente jamais une erreur "durable" (401 clé invalide, 400 requête malformée...) :
 * ça échouerait de la même façon à chaque tentative, autant échouer vite et clairement.
 */
export async function callGroqWithRetry(apiKey, body) {
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      // fetch qui rejette (DNS, timeout, coupure réseau...) : c'est bien souvent transitoire.
      lastError = new Error(`Erreur réseau vers Groq : ${networkErr.message}`);
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(retryDelayMs(attempt, null));
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      return response;
    }

    const errorBody = await response.text();
    lastError = new Error(`Erreur API Groq (${response.status}) : ${errorBody}`);

    const isRetryable = RETRYABLE_STATUSES.has(response.status);
    if (!isRetryable || attempt === MAX_ATTEMPTS - 1) {
      throw lastError;
    }
    await sleep(retryDelayMs(attempt, response));
  }

  throw lastError;
}

/** Score de confiance : 100 au départ, -15 par avertissement réel. Partagé entre la
 * validation mécanique (validateScenario) et la relecture sémantique (reviewScenario),
 * pour que les deux passes pèsent de la même façon sur le score final. */
function computeConfidence(stepCount, warningCount) {
  return stepCount === 0 ? 0 : Math.max(0, 100 - warningCount * 15);
}

/**
 * Appelle Groq et génère un scénario de test structuré à partir d'un ticket
 * et du résultat d'un crawl (voir crawler.js).
 *
 * Options :
 *  - deepReview : si vrai, ajoute une 2e passe Groq qui relit sémantiquement le
 *    scénario généré (voir reviewScenario) — plus lent et plus coûteux (double le
 *    nombre d'appels), mais attrape des scénarios mécaniquement valides qui ne
 *    testent pourtant pas ce que demande le ticket.
 */
export async function generateScenario(ticketText, crawlResult, options = {}) {
  const { deepReview = false } = options;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY manquante. Crée un fichier backend/.env avec GROQ_API_KEY=ta_clé"
    );
  }

  const response = await callGroqWithRetry(apiKey, {
    model: GROQ_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(ticketText, crawlResult) },
    ],
  });

  const data = await response.json();
  const rawContent = data.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error("Réponse Groq vide ou inattendue : " + JSON.stringify(data));
  }

  let scenario;
  try {
    scenario = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(
      "L'IA n'a pas renvoyé un JSON valide. Réponse brute : " + rawContent
    );
  }

  if (typeof scenario !== "object" || scenario === null || Array.isArray(scenario)) {
    throw new Error(
      "L'IA n'a pas renvoyé un objet JSON (attendu : { ticketSummary, warnings, steps }). Réponse brute : " +
        rawContent
    );
  }

  const validated = validateScenario(scenario, crawlResult);
  if (!deepReview || validated.steps.length === 0) {
    return validated;
  }

  return reviewScenario(ticketText, validated, apiKey);
}

/**
 * 2e passe optionnelle (voir buildReviewSystemPrompt) : demande à l'IA de juger
 * sémantiquement le scénario déjà validé mécaniquement. Les problèmes trouvés sont
 * ajoutés à scenario.warnings (préfixés "Relecture IA :" pour les distinguer des
 * avertissements mécaniques) et pèsent sur la confiance via computeConfidence — pas
 * de score séparé inventé, même logique que le reste.
 *
 * Une relecture qui échoue (Groq indisponible, JSON invalide) ne fait PAS échouer tout
 * le run : le scénario mécaniquement validé reste utilisable, avec un avertissement
 * signalant que la relecture n'a pas pu avoir lieu.
 */
export async function reviewScenario(ticketText, scenario, apiKey) {
  let issues;
  try {
    const response = await callGroqWithRetry(apiKey, {
      model: GROQ_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildReviewSystemPrompt() },
        { role: "user", content: buildReviewUserPrompt(ticketText, scenario) },
      ],
    });

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;
    const parsed = rawContent ? JSON.parse(rawContent) : null;
    issues = Array.isArray(parsed?.issues) ? parsed.issues.filter((i) => typeof i === "string") : [];
  } catch (err) {
    const warnings = [
      ...scenario.warnings,
      `Relecture IA indisponible, scénario non re-vérifié sémantiquement : ${err.message}`,
    ];
    return { ...scenario, warnings, confidence: computeConfidence(scenario.steps.length, warnings.length) };
  }

  if (issues.length === 0) {
    return scenario;
  }

  const warnings = [...scenario.warnings, ...issues.map((issue) => `Relecture IA : ${issue}`)];
  return { ...scenario, warnings, confidence: computeConfidence(scenario.steps.length, warnings.length) };
}

/**
 * Garde-fou anti-hallucination + validation structurelle : vérifie que chaque
 * sélecteur utilisé par l'IA existe réellement dans la liste des éléments crawlés,
 * ET que la réponse de l'IA a globalement la forme attendue (l'IA peut renvoyer un
 * JSON syntaxiquement valide mais structurellement n'importe quoi : "steps" qui
 * n'est pas un tableau, un type d'étape halluciné qui n'existe pas dans STEP_TYPES,
 * une étape qui n'est même pas un objet...). Un scénario mal formé est plus
 * dangereux qu'un scénario incomplet : il vaut mieux le nettoyer ici, avec un
 * avertissement clair, que le laisser planter plus tard dans runner.js avec un
 * message moins parlant pour l'utilisateur.
 */
export function validateScenario(scenario, crawlResult) {
  const knownSelectors = new Set(crawlResult.elements.map((el) => el.selector));
  const validationWarnings = [...(scenario.warnings || [])];

  if (!Array.isArray(scenario.steps)) {
    validationWarnings.push(
      `L'IA n'a pas renvoyé un tableau d'étapes valide (reçu : ${typeof scenario.steps}).`
    );
  }
  const rawSteps = Array.isArray(scenario.steps) ? scenario.steps : [];

  const wellFormedSteps = rawSteps.filter((step, index) => {
    if (typeof step !== "object" || step === null) {
      validationWarnings.push(`Étape ${index} ignorée : ce n'est pas un objet valide.`);
      return false;
    }
    if (!STEP_TYPES.includes(step.type)) {
      validationWarnings.push(
        `Étape ${index} ignorée : type d'étape inconnu "${step.type}" (attendu : ${STEP_TYPES.join(", ")}).`
      );
      return false;
    }
    return true;
  });

  const withSelectorCheck = wellFormedSteps.map((step) => {
    const needsSelector = !["navigate", "go_back"].includes(step.type);
    const selectorIsValid = !needsSelector || knownSelectors.has(step.selector);
    const description = step.description || "(étape sans description)";

    if (needsSelector && !selectorIsValid) {
      const selectorLabel = step.selector ? `"${step.selector}"` : "manquant";
      validationWarnings.push(
        `Sélecteur halluciné détecté et neutralisé : ${selectorLabel} (étape "${description}")`
      );
    }

    return {
      ...step,
      description,
      selectorValid: selectorIsValid,
    };
  });

  // Garde-fou anti-incohérence : un "assert_enabled" n'a de sens que s'il vérifie
  // l'effet d'une action antérieure sur un AUTRE sélecteur, et s'il est suivi d'un
  // clic sur ce même élément. Sinon il ne teste rien que le ticket ait demandé
  // (c'est le bug repéré sur TR-0248 : assert_enabled ajouté sans raison).
  const steps = withSelectorCheck.filter((step, index) => {
    if (step.type !== "assert_enabled") return true;

    const hasPriorEnablingAction = withSelectorCheck
      .slice(0, index)
      .some(
        (prev) =>
          ["fill", "select", "click"].includes(prev.type) &&
          prev.selector !== step.selector
      );
    const isFollowedByClickOnSameElement = withSelectorCheck
      .slice(index + 1)
      .some((next) => next.type === "click" && next.selector === step.selector);

    const isCoherent = hasPriorEnablingAction && isFollowedByClickOnSameElement;

    if (!isCoherent) {
      validationWarnings.push(
        `Étape incohérente retirée : "assert_enabled" sur "${step.selector}" sans action d'activation avant ni clic après (étape "${step.description}")`
      );
    }

    return isCoherent;
  });

  return {
    ...scenario,
    steps,
    warnings: validationWarnings,
    // Score de confiance du PLAN généré (pas de l'exécution) : voir computeConfidence.
    // Ce n'est pas une estimation "IA" — juste le reflet direct des garde-fous
    // ci-dessus, donc toujours justifiable étape par étape depuis scenario.warnings.
    confidence: computeConfidence(steps.length, validationWarnings.length),
  };
}