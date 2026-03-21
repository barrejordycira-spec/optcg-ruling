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

export function searchCards(query: string): Card[] {
  const cards = loadAllCards()
  const terms = query.toLowerCase().split(/\s+/)

  return cards.filter(card => {
    const searchable = [
      card.id,
      card.name,
      card.effectText,
      ...(card.traits || []),
      card.type,
      ...(card.colors || []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    return terms.some(term => searchable.includes(term))
  })
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
