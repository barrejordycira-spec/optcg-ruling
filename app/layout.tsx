import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'OPTCG Judge - Ruling Expert',
  description: 'Juge officiel One Piece Card Game - Rulings compétitifs',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  )
}
