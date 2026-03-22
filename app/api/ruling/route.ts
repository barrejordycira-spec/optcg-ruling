import { NextRequest } from 'next/server'
import {
  loadRulesJSON,
  buildCatalog,
  findRelevantCards,
  formatCardDetailed,
  extractCardIds,
  loadAllCards,
} from '@/lib/data-loader'

function buildSystemPrompt(): string {
  const rules = loadRulesJSON()
  const catalog = buildCatalog()
  const totalCards = loadAllCards().length

  return `Tu es un juge officiel du One Piece Card Game (OPTCG) en tournoi compétitif.
Tu fonctionnes comme un SYSTÈME EXPERT basé STRICTEMENT sur les données ci-dessous.

=== SOURCES DE VÉRITÉ (par ordre de priorité) ===
1. Le TEXTE EXACT des cartes (effectText) = source PRINCIPALE. Si une carte dit qu'elle fait quelque chose, cette mécanique EXISTE. Ne dis jamais "ça n'existe pas" si l'effet est écrit sur une carte.
2. Les RÈGLES OFFICIELLES ci-dessous = cadre général du jeu (phases, combat, conditions de défaite, keywords).
3. La LOGIQUE MÉCANIQUE du jeu = pour résoudre les interactions entre cartes et règles.

=== INTERDICTIONS ===
- Ne JAMAIS inventer un effet qui n'est PAS écrit sur une carte.
- Ne JAMAIS inventer une règle qui n'est PAS dans les règles officielles.
- Ne JAMAIS utiliser de connaissance externe, de "pratique courante", ou de "rulings habituels non listés ici".
- Ne JAMAIS contredire le texte d'une carte. Si la carte le dit, c'est vrai.
- Si ni le texte des cartes ni les règles ne couvrent un cas → répondre : "Information indisponible. Vérification auprès d'un head judge nécessaire."

=== MÉTHODE DE RAISONNEMENT OBLIGATOIRE ===
Pour CHAQUE question, tu DOIS :
1. Identifier les cartes impliquées et citer leur WORDING EXACT (copié depuis les données fournies)
2. Analyser ce que le texte de la carte PERMET ou INTERDIT (le texte de la carte fait autorité)
3. Identifier les règles générales qui s'appliquent (citées depuis les RÈGLES OFFICIELLES)
4. Vérifier si le wording de la règle couvre PRÉCISÉMENT le cas décrit (attention aux conditions : "suite à des dégâts", "pendant votre tour", etc.)
5. Si le wording d'une règle ne correspond PAS exactement au scénario, cette règle NE S'APPLIQUE PAS
6. En cas de conflit entre une règle générale et un effet de carte spécifique, l'EFFET DE CARTE prime (les cartes créent des exceptions aux règles)
7. Donner un verdict basé sur les textes cités

=== FORMAT DE RÉPONSE ===
Réponds TOUJOURS en français avec cette structure :
1) **Résumé du scénario**
2) **Cartes impliquées** (ID + effet EXACT copié)
3) **Règles applicables** (citation EXACTE des règles, avec la section d'origine)
4) **Analyse** (raisonnement étape par étape, en confrontant le wording exact de la carte avec le wording exact de la règle)
5) **Verdict** (réponse claire et définitive)

=== PIÈGES FRÉQUENTS ===
- "Ajouter une carte de la Vie à la main" via un EFFET DE CARTE n'est PAS la même chose que "subir des dégâts". Le [Trigger] ne s'active que suite à des DÉGÂTS (voir règle 10-1-5-4).
- Double Attack : la vérification de victoire (7-1-4-1-1-1) ne se fait qu'UNE FOIS avant le premier dégât. La boucle (7-1-4-1-1-3) ne répète que 7-1-4-1-1-2. Double Attack ne peut donc PAS tuer depuis 1+ Vie.

=== MESSAGES DE SUIVI ===
Quand le joueur envoie un message de suivi (précision, reformulation, correction), NE RÉPÈTE PAS l'analyse complète.
- Réponds de manière concise en ciblant uniquement la précision demandée.
- Ne re-cite les cartes et règles que si de NOUVELLES cartes ou règles sont impliquées.
- Si le joueur précise une carte que tu avais déjà analysée, confirme brièvement et ajuste si nécessaire.

=== CARTES NON TROUVÉES ===
Si la description du joueur ne correspond EXACTEMENT à aucune carte dans ta base :
- Dis-le clairement : "Je ne trouve pas de carte correspondant exactement à [description]."
- Indique la carte la plus proche trouvée et précise les différences (coût DON!!, conditions, etc.)
- Base ton analyse sur la carte la plus proche en le signalant explicitement.

Si la question n'est pas liée au OPTCG : "Je suis un juge One Piece Card Game. Je ne peux répondre qu'aux questions de ruling."

=== RÈGLES OFFICIELLES ===
${rules}

=== INDEX DES CARTES (${totalCards} cartes) ===
Ceci est un index léger (ID, nom, type, couleur). Les EFFETS DÉTAILLÉS des cartes pertinentes sont fournis dans le message utilisateur sous "CARTES PERTINENTES".
BASE-TOI EN PRIORITÉ sur les cartes pertinentes pré-recherchées. N'utilise cet index que pour vérifier l'existence d'une carte.
${catalog}`
}

// Cache the system prompt (built once per cold start)
let cachedSystemPrompt: string | null = null

function getSystemPrompt(): string {
  if (!cachedSystemPrompt) {
    cachedSystemPrompt = buildSystemPrompt()
  }
  return cachedSystemPrompt
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return Response.json(
      { error: 'GEMINI_API_KEY non configurée. Obtenez une clé gratuite sur https://aistudio.google.com/apikey' },
      { status: 503 }
    )
  }

  let body: { question?: string; history?: Array<{ role: string; content: string }> }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Body JSON invalide' }, { status: 400 })
  }

  const { question, history } = body
  if (!question || typeof question !== 'string' || question.length < 3 || question.length > 2000) {
    return Response.json({ error: 'Question requise (3-2000 caractères)' }, { status: 400 })
  }

  // Build search query from current question + recent user messages for context
  const historyContext = (history || [])
    .filter(msg => msg.role === 'user')
    .slice(-3)
    .map(msg => msg.content)
    .join(' ')
  const searchQuery = historyContext ? `${historyContext} ${question}` : question

  // Pre-search relevant cards using full context
  const searchResult = findRelevantCards(searchQuery)
  console.log('[RULING] Question:', question.substring(0, 80))
  console.log('[RULING] Pre-searched cards:', searchResult.cardIds.length)

  // Build the pre-searched cards section for the user message
  const preSearchedSection = searchResult.cards.length > 0
    ? `\n=== CARTES PERTINENTES À LA QUESTION (effets complets) ===\n${searchResult.cards.map(formatCardDetailed).join('\n\n')}\n\n`
    : ''

  // Build conversation contents
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []

  // Add history (max 20 messages)
  if (history && Array.isArray(history)) {
    for (const msg of history.slice(-20)) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      })
    }
  }

  // Add current question with pre-searched cards
  contents.push({
    role: 'user',
    parts: [{ text: `${preSearchedSection}QUESTION: ${question}` }],
  })

  // Call Gemini 2.5 Flash
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`

  try {
    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: getSystemPrompt() }],
        },
        contents,
      }),
    })

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text()
      console.error('[RULING] Gemini error:', geminiResponse.status, errorText)
      return Response.json(
        { error: 'Erreur API Gemini', details: errorText },
        { status: 500 }
      )
    }

    const data = await geminiResponse.json()
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

    if (!answer) {
      console.error('[RULING] Empty response from Gemini:', JSON.stringify(data).substring(0, 500))
      return Response.json(
        { error: 'Réponse vide de Gemini' },
        { status: 500 }
      )
    }

    // Extract card IDs from both question and answer
    const questionIds = extractCardIds(question)
    const answerIds = extractCardIds(answer)
    const preSearchIds = searchResult.cardIds
    const allIds: string[] = []
    for (const id of [...preSearchIds, ...questionIds, ...answerIds]) {
      if (!allIds.includes(id)) allIds.push(id)
    }

    console.log('[RULING] Response length:', answer.length, '| Cards used:', allIds.length)

    return Response.json({ answer, cardsUsed: allIds })
  } catch (err) {
    console.error('[RULING] Fetch error:', err)
    return Response.json(
      { error: 'Erreur de connexion à Gemini' },
      { status: 500 }
    )
  }
}
