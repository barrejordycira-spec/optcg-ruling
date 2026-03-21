'use client'

import { useState, useRef, useEffect, useCallback, FormEvent, KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  cardsUsed?: string[]
}

const EXAMPLES = [
  "Est-ce qu'un Blocker peut bloquer une attaque ciblant un personnage ?",
  "Comment fonctionne Double Attack avec OP01-024 si l'adversaire a 1 vie ?",
  "Peut-on jouer un événement [Contre] pendant la phase principale ?",
]

let msgCounter = 0
function genId() {
  return `msg-${Date.now()}-${++msgCounter}`
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
    }
  }, [input])

  const sendMessage = async (question: string) => {
    if (!question.trim() || loading) return

    const userMsg: Message = { id: genId(), role: 'user', content: question.trim() }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)
    setError('')

    try {
      // Build history for API (exclude current question)
      const history = messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        content: m.content,
      }))

      const response = await fetch('/api/ruling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          history: history.slice(-20),
        }),
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error || `Erreur ${response.status}`)
      }

      const data = await response.json()
      const botMsg: Message = {
        id: genId(),
        role: 'assistant',
        content: data.answer || 'Aucune réponse reçue.',
        cardsUsed: data.cardsUsed,
      }

      setMessages([...newMessages, botMsg])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue')
      // Remove the loading state without adding a bot message
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
          <p>Juge expert One Piece Card Game &bull; Rulings comp&eacute;titifs</p>
        </div>
      </header>

      <div className="messages">
        {messages.length === 0 ? (
          <div className="welcome">
            <div className="welcome-icon">&#9878;</div>
            <h2>Ruling OPTCG</h2>
            <p>
              Posez vos questions de ruling et obtenez une analyse pr&eacute;cise
              bas&eacute;e sur les r&egrave;gles officielles et les effets exacts des cartes.
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
          <>
            {messages.map(msg => (
              <div key={msg.id} className={`message ${msg.role}`}>
                <div className="message-avatar">
                  {msg.role === 'user' ? '\u{1F3B4}' : '\u2696'}
                </div>
                <div className="message-content">
                  {msg.role === 'assistant' ? (
                    <>
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                      {msg.cardsUsed && msg.cardsUsed.length > 0 && (
                        <div className="cards-used">
                          Cartes analys&eacute;es : {msg.cardsUsed.join(', ')}
                        </div>
                      )}
                    </>
                  ) : (
                    <p>{msg.content}</p>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="message assistant">
                <div className="message-avatar">&#9878;</div>
                <div className="message-content">
                  <div className="loading-text">Analyse du sc&eacute;nario...</div>
                </div>
              </div>
            )}
            {error && (
              <div className="error-banner">
                {error}
              </div>
            )}
          </>
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
        <div className="input-hint">
          Mentionnez les IDs de cartes (ex: OP01-024) pour une analyse pr&eacute;cise
        </div>
      </div>
    </div>
  )
}
