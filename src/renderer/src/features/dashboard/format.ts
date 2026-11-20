const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

export function formatCost(usd: number) {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en')}`
}

export const formatTokens = (tokens: number) => compact.format(tokens)
