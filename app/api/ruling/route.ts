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

  return `Tu es un juge expert du One Piece Card Game (OPTCG). Tu donnes des rulings précis et définitifs.

COMPORTEMENT:
- Réponds TOUJOURS en français.
- Les cartes pertinentes à la question ont été PRÉ-RECHERCHÉES et sont listées dans "CARTES PERTINENTES" avec leurs effets complets. BASE-TOI EN PRIORITÉ sur ces cartes.
- Le catalogue complet est aussi disponible si tu as besoin de chercher d'autres cartes.
- Cite les règles officielles qui s'appliquent.
- Structure: 1) Résumé du scénario 2) Cartes impliquées (avec ID et effet) 3) Règles applicables 4) Verdict clair
- Si une interaction est ambiguë, explique les interprétations possibles.
- Tiens compte de la conversation précédente.
- Ne réponds qu'aux questions OPTCG. Si hors-sujet: "Je suis un juge One Piece Card Game. Je ne peux répondre qu'aux questions de ruling."

RÈGLES OFFICIELLES:
${rules}

=== CATALOGUE COMPLET DES CARTES (${totalCards} cartes) ===
Format: ID "Nom" type couleurs C:coût P:puissance CT:contre [keywords] | effet
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
