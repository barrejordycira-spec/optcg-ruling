import { NextRequest } from 'next/server'
import { loadRules, searchCards, formatCardForPrompt } from '@/lib/data-loader'

const SYSTEM_PROMPT = `Tu es un juge officiel du One Piece Card Game (niveau tournoi compétitif avancé).
Tu fonctionnes comme un système expert de ruling basé STRICTEMENT sur les données fournies.

═══════════════════════════════
📚 SOURCES AUTORISÉES
═══════════════════════════════

Tu dois baser tes réponses UNIQUEMENT sur :
1. Les données de cartes fournies dans le contexte
2. Les règles officielles fournies dans le contexte
3. Logique interne du jeu (interactions mécaniques cohérentes)

❗ INTERDICTION ABSOLUE :
- Ne JAMAIS inventer un effet ou une règle
- Ne JAMAIS utiliser de connaissance externe non vérifiable
- Ne JAMAIS deviner

Si une information est absente des données :
→ Réponds : "Information indisponible dans la base. Vérification nécessaire."

═══════════════════════════════
🧠 MÉTHODE DE RAISONNEMENT (OBLIGATOIRE)
═══════════════════════════════

Avant toute réponse, tu dois :
1. Identifier les cartes impliquées
2. Extraire leur wording EXACT depuis les données fournies
3. Identifier les règles applicables
4. Décomposer l'interaction étape par étape
5. Vérifier les conflits ou priorités d'effets
6. Appliquer les règles de timing

═══════════════════════════════
⚖️ FORMAT DE RÉPONSE (STRICT)
═══════════════════════════════

Tu dois TOUJOURS répondre avec :

**[Cartes concernées]**
(liste des cartes utilisées + effet résumé fidèlement)

**[Règles appliquées]**
(règles précises utilisées)

**[Analyse]**
(raisonnement étape par étape, logique et détaillé)

**[Ruling]**
(réponse finale claire, sans ambiguïté)

═══════════════════════════════
🔐 SÉCURITÉ
═══════════════════════════════

Si la question n'est pas liée au One Piece TCG :
→ Réponds STRICTEMENT : "Je suis un juge One Piece Card Game. Je ne peux répondre qu'aux questions de ruling."

Ton comportement doit être équivalent à un juge officiel en événement compétitif.`

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY
  console.log('[RULING] API key present:', !!apiKey)
  console.log('[RULING] API key length:', apiKey?.length ?? 0)
  console.log('[RULING] API key prefix:', apiKey?.substring(0, 8) ?? 'N/A')

  if (!apiKey) {
    console.error('[RULING] GEMINI_API_KEY is not set in environment variables')
    return Response.json({ error: 'GEMINI_API_KEY non configurée' }, { status: 500 })
  }

  const { question, history } = await request.json()
  console.log('[RULING] Question received:', question)
  console.log('[RULING] History length:', history?.length ?? 0)

  if (!question || typeof question !== 'string') {
    return Response.json({ error: 'Question requise' }, { status: 400 })
  }

  // Load rules
  const rules = loadRules()
  console.log('[RULING] Rules loaded successfully')

  // Search for relevant cards mentioned in the question (max 5)
  const relevantCards = searchCards(question)
  const topCards = relevantCards.slice(0, 5)

  // Build context
  const cardsContext = topCards.length > 0
    ? `CARTES:\n${topCards.map(formatCardForPrompt).join('\n---\n')}`
    : ''

  // Send rules as compact JSON (no indentation = ~3x fewer tokens)
  const rulesContext = `RÈGLES:\n${JSON.stringify(rules)}`

  // Build conversation for Gemini
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []

  // Add history if present
  if (history && Array.isArray(history)) {
    for (const msg of history) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      })
    }
  }

  // Add current question with context
  contents.push({
    role: 'user',
    parts: [{
      text: `${cardsContext ? cardsContext + '\n\n' : ''}${rulesContext}\n\nQUESTION: ${question}`,
    }],
  })

  // Call Gemini API with streaming
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`
  console.log('[RULING] Cards found:', topCards.length)
  console.log('[RULING] Calling Gemini API...')

  const geminiResponse = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    }),
  })

  console.log('[RULING] Gemini response status:', geminiResponse.status)

  if (!geminiResponse.ok) {
    const errorText = await geminiResponse.text()
    console.error('[RULING] Gemini API error:', geminiResponse.status, errorText)
    return Response.json(
      { error: 'Erreur API Gemini', details: errorText },
      { status: geminiResponse.status }
    )
  }

  console.log('[RULING] Gemini OK, starting stream...')

  // Stream the response
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const reader = geminiResponse.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (data === '[DONE]') continue

              try {
                const parsed = JSON.parse(data)
                const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text
                if (text) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`))
                }
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }
      } catch (err) {
        console.error('Stream error:', err)
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
