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

let cachedCards: Card[] | null = null
let cachedRules: object | null = null

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

export function loadRules(): object {
  if (cachedRules) return cachedRules

  const rulesPath = path.join(process.cwd(), 'rules', 'rules.json')
  cachedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'))
  return cachedRules!
}

// Common French/English words to ignore when searching cards
const STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'est',
  'que', 'qui', 'dans', 'sur', 'par', 'pour', 'avec', 'son', 'ses', 'mon',
  'ma', 'ce', 'cette', 'il', 'elle', 'on', 'ne', 'pas', 'plus', 'si',
  'je', 'tu', 'nous', 'vous', 'ils', 'elles', 'se', 'sa', 'au', 'aux',
  'en', 'peut', 'faire', 'quand', 'comment', 'pourquoi',
  'the', 'a', 'an', 'is', 'are', 'can', 'do', 'does', 'if', 'when',
  'how', 'what', 'my', 'his', 'her', 'its', 'to', 'of', 'and', 'or',
])

export function searchCards(query: string): Card[] {
  const cards = loadAllCards()
  const terms = query.toLowerCase().split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t))

  if (terms.length === 0) return []

  // Score cards by number of matching terms
  const scored = cards.map(card => {
    const searchable = [card.id, card.name, ...(card.traits || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    const score = terms.filter(term => searchable.includes(term)).length
    return { card, score }
  })

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.card)
}

export function formatCardForPrompt(card: Card): string {
  const parts = [
    `[${card.id}] ${card.name}`,
    `Type: ${card.type} | Couleurs: ${card.colors.join(', ')}`,
  ]
  if (card.cost !== null) parts.push(`Coût: ${card.cost}`)
  if (card.power !== null) parts.push(`Puissance: ${card.power}`)
  if (card.counter !== null) parts.push(`Contre: +${card.counter}`)
  if (card.life !== null) parts.push(`Vie: ${card.life}`)
  if (card.attribute) parts.push(`Attribut: ${card.attribute}`)
  if (card.traits?.length) parts.push(`Traits: ${card.traits.join(', ')}`)
  parts.push(`Effet: ${card.effectText || 'Aucun'}`)
  parts.push(`Set: ${card.set} (${card.rarity})`)
  return parts.join('\n')
}
