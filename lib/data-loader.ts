import fs from 'fs'
import path from 'path'

export interface Card {
  id: string
  name: string
  type: string
  colors: string[]
  cost: number | null
  power: number | null
  counter: number | null
  life: number | null
  attribute: string | null
  traits: string[]
  set: string
  rarity: string
  effectText: string
  imageUrl: string
}

// Module-level caches (loaded once per cold start)
let cachedCards: Card[] | null = null
let cachedRules: string | null = null
let cachedCatalog: string | null = null

// --- Loaders ---

export function loadAllCards(): Card[] {
  if (cachedCards) return cachedCards

  const cardsDir = path.join(process.cwd(), 'cards')
  const files = fs.readdirSync(cardsDir).filter(f => f.endsWith('.json'))
  const allCards: Card[] = []

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(cardsDir, file), 'utf-8'))
    if (Array.isArray(data)) {
      allCards.push(...data)
    }
  }

  cachedCards = allCards
  return allCards
}

export function loadRulesJSON(): string {
  if (cachedRules) return cachedRules

  const rulesPath = path.join(process.cwd(), 'rules', 'rules.json')
  cachedRules = fs.readFileSync(rulesPath, 'utf-8')
  return cachedRules
}

/** Light catalog: ID + name + type + colors only (saves ~110k tokens vs full) */
export function buildCatalog(): string {
  if (cachedCatalog) return cachedCatalog

  const cards = loadAllCards()
  const lines = cards.map(c =>
    `${c.id} ${c.name} ${c.type} ${c.colors.join('/')}`
  )

  cachedCatalog = lines.join('\n')
  return cachedCatalog
}

// --- Keyword extraction from effectText ---

const KEYWORD_PATTERNS = [
  /\[Rush\]/i, /\[Blocker\]/i, /\[Double Attack\]/i, /\[Banish\]/i,
  /\[On Play\]/i, /\[When Attacking\]/i, /\[On K\.?O\.?\]/i,
  /\[Trigger\]/i, /\[Activate: Main\]/i, /\[On Block\]/i,
  /\[End of Your Turn\]/i, /\[Your Turn\]/i, /\[Opponent's Turn\]/i,
  /\[DON!! x\d+\]/i, /\[Counter\]/i, /\[Main\]/i,
]

function extractKeywords(effectText: string): string[] {
  if (!effectText) return []
  const found: string[] = []
  for (const pattern of KEYWORD_PATTERNS) {
    const match = effectText.match(pattern)
    if (match) found.push(match[0])
  }
  return found
}

// --- Smart card search ---

const COLOR_MAP: Record<string, string> = {
  rouge: 'red', bleu: 'blue', vert: 'green',
  violet: 'purple', noir: 'black', jaune: 'yellow',
}

const TYPE_MAP: Record<string, string> = {
  personnage: 'character', evenement: 'event', lieu: 'stage',
}

const KEYWORD_FR_MAP: Record<string, string> = {
  bloqueur: 'blocker', hate: 'rush', declenchement: 'trigger',
  bannir: 'banish', contre: 'counter',
}

const EFFECT_KEYWORDS = [
  'Rush', 'Blocker', 'Double Attack', 'Banish', 'Trigger',
  'On Play', 'When Attacking', 'On K.O.', 'Counter', 'Main',
  'Activate: Main', 'On Block', 'End of Your Turn',
]

const STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'est',
  'que', 'qui', 'dans', 'sur', 'par', 'pour', 'avec', 'son', 'ses', 'mon',
  'ma', 'ce', 'cette', 'il', 'elle', 'on', 'ne', 'pas', 'plus', 'si',
  'je', 'tu', 'nous', 'vous', 'ils', 'elles', 'se', 'sa', 'au', 'aux',
  'en', 'peut', 'faire', 'quand', 'comment', 'pourquoi', 'carte', 'cartes',
  'effet', 'utiliser', 'jouer', 'adversaire', 'question', 'ruling',
  'the', 'a', 'an', 'is', 'are', 'can', 'do', 'does', 'if', 'when',
  'how', 'what', 'my', 'his', 'her', 'its', 'to', 'of', 'and', 'or',
])

const CARD_ID_REGEX = /[A-Z]{2,3}\d{2}-\d{3}/gi

export interface SearchResult {
  cards: Card[]
  cardIds: string[]
}

export function findRelevantCards(query: string): SearchResult {
  const cards = loadAllCards()
  const foundIds: string[] = []
  const foundCards: Card[] = []

  const addCard = (card: Card) => {
    if (!foundIds.includes(card.id)) {
      foundIds.push(card.id)
      foundCards.push(card)
    }
  }

  // 1. Match by card ID (e.g., OP01-024, ST10-001)
  const idMatches = query.match(CARD_ID_REGEX) || []
  for (const idMatch of idMatches) {
    const card = cards.find(c => c.id.toLowerCase() === idMatch.toLowerCase())
    if (card) addCard(card)
  }

  // 2. Prepare search terms (translate FR→EN, filter stop words)
  const rawTerms = query.toLowerCase().split(/\s+/)
  const terms = rawTerms
    .map(t => COLOR_MAP[t] || TYPE_MAP[t] || KEYWORD_FR_MAP[t] || t)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t))

  if (terms.length === 0) return { cards: foundCards, cardIds: foundIds }

  // 3. Score remaining cards by name/trait/keyword match
  const scored: Array<{ card: Card; score: number }> = []
  for (const card of cards) {
    if (foundIds.includes(card.id)) continue

    const nameLower = card.name.toLowerCase()
    const traitsLower = (card.traits || []).join(' ').toLowerCase()
    const typeLower = card.type.toLowerCase()
    const colorsLower = card.colors.join(' ').toLowerCase()
    const effectLower = (card.effectText || '').toLowerCase()

    let score = 0
    for (const term of terms) {
      // Name match is highest priority
      if (nameLower.includes(term)) score += 5
      // Keyword match in effect text (Blocker, Rush, Trigger, etc.)
      else if (effectLower.includes(`[${term}]`)) score += 3
      // Partial effect keyword match (e.g. "blocker" in "[Blocker]")
      else if (EFFECT_KEYWORDS.some((kw: string) => kw.toLowerCase().includes(term) && effectLower.includes(kw.toLowerCase()))) score += 3
      // Type/color match
      else if (typeLower === term || colorsLower.includes(term)) score += 1
      // Trait match
      else if (traitsLower.includes(term)) score += 2
    }

    if (score > 0) scored.push({ card, score })
  }

  // Sort by score descending, take top results
  scored.sort((a, b) => b.score - a.score)
  const limit = 20 - foundCards.length
  for (const s of scored.slice(0, limit)) {
    addCard(s.card)
  }

  return { cards: foundCards, cardIds: foundIds }
}

// --- Formatters ---

export function formatCardDetailed(card: Card): string {
  const parts = [
    `>>> ${card.id} "${card.name}"`,
    `    Type: ${card.type} | Couleurs: ${card.colors.join(', ')} | Coût: ${card.cost ?? '-'} | Puissance: ${card.power ?? '-'} | Contre: ${card.counter ?? '-'}`,
  ]
  if (card.traits?.length) parts.push(`    Traits: ${card.traits.join(', ')}`)
  const kw = extractKeywords(card.effectText)
  if (kw.length) parts.push(`    Keywords: ${kw.join(', ')}`)
  parts.push(`    Effet: ${card.effectText || 'Aucun'}`)
  return parts.join('\n')
}

/** Extract card IDs from any text */
export function extractCardIds(text: string): string[] {
  const matches = text.match(CARD_ID_REGEX) || []
  const unique: string[] = []
  for (const m of matches) {
    const upper = m.toUpperCase()
    if (!unique.includes(upper)) unique.push(upper)
  }
  return unique
}
