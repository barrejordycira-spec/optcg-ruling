'use client'

import { useState, useRef, useEffect, useCallback, FormEvent, KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'

interface Message {
  role: 'user' | 'bot'
  content: string
}

const EXAMPLES = [
  "Est-ce qu'un Blocker peut bloquer une attaque ciblant un personnage ?",
  "Comment fonctionne Double Attack si l'adversaire a 1 vie ?",
  "Peut-on jouer un événement [Contre] pendant la phase principale ?",
  "Que se passe-t-il si mon deck est vide pendant la phase de pioche ?",
]

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
    }
  }, [input])

  const sendMessage = async (question: string) => {
    if (!question.trim() || loading) return

    const userMessage: Message = { role: 'user', content: question.trim() }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    // Add empty bot message for streaming
    const botMessage: Message = { role: 'bot', content: '' }
    setMessages([...newMessages, botMessage])

    try {
      // Build history (last 10 messages for context)
      const history = newMessages.slice(-10).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      }))

      const response = await fetch('/api/ruling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          history: history.slice(0, -1), // Exclude current question (sent separately)
        }),
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error || 'Erreur serveur')
      }

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue

            try {
              const parsed = JSON.parse(data)
              if (parsed.text) {
                accumulated += parsed.text
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = { role: 'bot', content: accumulated }
                  return updated
                })
              }
            } catch {
              // Skip malformed
            }
          }
        }
      }

      // If no content received
      if (!accumulated) {
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            role: 'bot',
            content: 'Erreur: aucune réponse reçue. Vérifiez la clé API Gemini.',
          }
          return updated
        })
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = {
          role: 'bot',
          content: `Erreur: ${err instanceof Error ? err.message : 'Erreur inconnue'}`,
        }
        return updated
      })
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    sendMessage(input)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-logo">&#9878;</div>
        <div className="header-info">
          <h1>OPTCG JUDGE</h1>
          <p>Juge officiel One Piece Card Game &bull; Rulings comp&eacute;titifs</p>
        </div>
      </header>

      <div className="messages">
        {messages.length === 0 ? (
          <div className="welcome">
            <div className="welcome-icon">&#9878;</div>
            <h2>Bienvenue, joueur !</h2>
            <p>
              Je suis un juge officiel OPTCG. Posez-moi vos questions de ruling
              et j&apos;analyserai les cartes et r&egrave;gles pour vous fournir une
              r&eacute;ponse pr&eacute;cise et fiable.
            </p>
            <div className="examples">
              {EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  className="example-btn"
                  onClick={() => sendMessage(ex)}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role === 'user' ? 'user' : 'bot'}`}>
              <div className="message-avatar">
                {msg.role === 'user' ? '\u{1F3B4}' : '\u2696'}
              </div>
              <div className="message-content">
                {msg.role === 'bot' && !msg.content && loading ? (
                  <div className="loading-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : msg.role === 'bot' ? (
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                ) : (
                  <p>{msg.content}</p>
                )}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        <form className="input-form" onSubmit={handleSubmit}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Posez votre question de ruling..."
            rows={1}
            disabled={loading}
          />
          <button type="submit" className="send-btn" disabled={loading || !input.trim()}>
            &#10148;
          </button>
        </form>
      </div>
    </div>
  )
}
