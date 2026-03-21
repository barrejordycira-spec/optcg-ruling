import { NextRequest } from 'next/server'
import { searchCards, formatCardForPrompt, getRelevantRules } from '@/lib/data-loader'

const BASE_PROMPT = `Tu es juge officiel OPTCG (tournoi compétitif).
Réponds UNIQUEMENT avec les données fournies. Ne jamais inventer.
Si info absente: "Information indisponible dans la base."
Si hors-sujet OPTCG: "Je suis un juge One Piece Card Game. Je ne peux répondre qu'aux questions de ruling."

Format OBLIGATOIRE:
**[Cartes concernées]** (carte + effet exact)
**[Règles appliquées]** (règles utilisées)
**[Analyse]** (raisonnement étape par étape)
**[Ruling]** (réponse finale)`

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

  // Get only relevant rule sections based on question keywords
  const rulesContext = getRelevantRules(question)
  console.log('[RULING] Rules context length:', rulesContext.length)

  // Search for relevant cards (max 5)
  const relevantCards = searchCards(question)
  const topCards = relevantCards.slice(0, 5)
  console.log('[RULING] Cards found:', topCards.length)

  // Build conversation for Gemini
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []

  // Add history (last 4 messages max to save tokens)
  if (history && Array.isArray(history)) {
    for (const msg of history.slice(-4)) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      })
    }
  }

  // Add current question with card context
  const cardsText = topCards.length > 0
    ? `CARTES:\n${topCards.map(formatCardForPrompt).join('\n---\n')}\n\n`
    : ''

  contents.push({
    role: 'user',
    parts: [{
      text: `${cardsText}QUESTION: ${question}`,
    }],
  })

  // Call Gemini API with streaming
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`
  console.log('[RULING] Calling Gemini API...')

  const geminiResponse = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: `${BASE_PROMPT}\n\nRÈGLES:\n${rulesContext}` }],
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
