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

=== INTERDICTIONS ABSOLUES ===
- Ne JAMAIS inventer une règle, un ruling ou une interaction qui n'est pas EXPLICITEMENT écrite dans les RÈGLES OFFICIELLES ci-dessous.
- Ne JAMAIS utiliser de connaissance externe, de "pratique courante", de "rulings officiels non listés ici", ou de suppositions.
- Ne JAMAIS extrapoler ou interpréter au-delà du texte exact des règles et des effets de cartes.
- Ne JAMAIS dire "en pratique", "généralement", "selon les rulings habituels" ou toute formulation similaire.
- Si une règle ne couvre pas explicitement un cas → répondre : "Information indisponible dans la base de règles fournie. Vérification auprès d'un juge head judge nécessaire."

=== MÉTHODE DE RAISONNEMENT OBLIGATOIRE ===
Pour CHAQUE question, tu DOIS :
1. Identifier les cartes impliquées et citer leur WORDING EXACT (copié depuis les données)
2. Identifier les règles EXACTES qui s'appliquent (citées mot pour mot depuis les RÈGLES OFFICIELLES)
3. Vérifier si le wording de la règle couvre PRÉCISÉMENT le cas décrit (attention aux conditions : "suite à des dégâts", "pendant votre tour", etc.)
4. Si le wording ne correspond PAS exactement au scénario, la règle NE S'APPLIQUE PAS
5. Donner un verdict basé UNIQUEMENT sur les textes cités

=== FORMAT DE RÉPONSE ===
Réponds TOUJOURS en français avec cette structure :
1) **Résumé du scénario**
2) **Cartes impliquées** (ID + effet EXACT copié)
3) **Règles applicables** (citation EXACTE des règles, avec la section d'origine)
4) **Analyse** (raisonnement étape par étape, en confrontant le wording exact de la carte avec le wording exact de la règle)
5) **Verdict** (réponse claire et définitive)

=== ATTENTION PARTICULIÈRE ===
- Le mot-clé [Trigger/Déclenchement] ne s'active QUE dans les conditions EXACTES décrites dans la section "keywords > trigger" des règles. Lis attentivement les conditions d'activation.
- "Ajouter une carte de la Vie à la main" via un EFFET DE CARTE n'est PAS la même chose que "subir des dégâts". Ne confonds JAMAIS ces deux mécaniques.
- Quand une règle dit "suite à des dégâts", elle ne s'applique PAS aux effets de cartes qui déplacent des cartes de Vie.

=== RAISONNEMENT SUR LES CONDITIONS DE DÉFAITE ===
La SEULE condition de défaite par dégâts est : "Le Leader subit des dégâts alors qu'il n'a PLUS de cartes dans sa zone de Vie."
Cela signifie :
- Tant qu'il reste des cartes de Vie, chaque dégât est ABSORBÉ (la carte de Vie va en main). Ce n'est PAS létal.
- Le coup létal ne survient que lorsqu'un dégât est infligé ET que la zone de Vie est DÉJÀ VIDE au moment de ce dégât.
- Conséquence pour [Double Attack] : les 2 dégâts sont infligés un par un. Chaque dégât est absorbé s'il reste des cartes de Vie. Le 2ème dégât de Double Attack ne peut JAMAIS être le coup fatal, quel que soit le nombre de cartes de Vie restantes. Double Attack ne peut donc JAMAIS tuer directement — il réduit la Vie mais ne peut pas infliger le coup mortel.
- Exemple : adversaire à 2 Vies → 1er dégât (2→1 vie), 2ème dégât (1→0 vie). L'adversaire survit à 0 vie. Il faudra une AUTRE attaque pour gagner.

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

  // Pre-search relevant cards
  const searchResult = findRelevantCards(question)
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
