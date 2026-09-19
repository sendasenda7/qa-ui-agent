const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

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
 * Appelle Groq et génère un scénario de test structuré à partir d'un ticket
 * et du résultat d'un crawl (voir crawler.js).
 */
export async function generateScenario(ticketText, crawlResult) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY manquante. Crée un fichier backend/.env avec GROQ_API_KEY=ta_clé"
    );
  }

  const response = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(ticketText, crawlResult) },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Erreur API Groq (${response.status}) : ${errorBody}`);
  }

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

  return validateScenario(scenario, crawlResult);
}

/**
 * Garde-fou anti-hallucination : vérifie que chaque sélecteur utilisé par l'IA
 * existe réellement dans la liste des éléments crawlés. Un scénario qui pointe
 * vers un sélecteur inventé est plus dangereux qu'un scénario incomplet.
 */
function validateScenario(scenario, crawlResult) {
  const knownSelectors = new Set(crawlResult.elements.map((el) => el.selector));
  const validationWarnings = [...(scenario.warnings || [])];

  const withSelectorCheck = (scenario.steps || []).map((step) => {
    const needsSelector = !["navigate", "go_back"].includes(step.type);
    const selectorIsValid = !needsSelector || knownSelectors.has(step.selector);

    if (needsSelector && !selectorIsValid) {
      validationWarnings.push(
        `Sélecteur halluciné détecté et neutralisé : "${step.selector}" (étape "${step.description}")`
      );
    }

    return {
      ...step,
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
    // Score de confiance du PLAN généré (pas de l'exécution) : 100 au départ, pénalisé
    // pour chaque avertissement réel (sélecteur halluciné neutralisé, étape incohérente
    // retirée). Ce n'est pas une estimation "IA" — juste le reflet direct des garde-fous
    // ci-dessus, donc toujours justifiable étape par étape depuis scenario.warnings.
    confidence: steps.length === 0 ? 0 : Math.max(0, 100 - validationWarnings.length * 15),
  };
}