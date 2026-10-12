export type Quote = {
  sym: string
  name?: string
  price?: number
  prev?: number
  closes: number[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'stock-pane': { quotes: Quote[] }
  }
}
