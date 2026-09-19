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
ils sont visuellement désactivés au chargement de la page. Si le ticket implique de cliquer
dessus après une autre action (ex. après avoir sélectionné une option), ajoute une étape
"assert_enabled" juste avant le clic pour vérifier qu'il est redevenu actif — ne clique jamais
directement dessus sans cette vérification intermédiaire quand il partait désactivé.
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

  const steps = (scenario.steps || []).map((step) => {
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

  return {
    ...scenario,
    steps,
    warnings: validationWarnings,
  };
}
