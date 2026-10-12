export type Quote = {
  sym: string
  name?: string
  price?: number
  prev?: number
  closes: number[]
  error?: string
}

// 하단 상태 줄: 마지막 성공 시각, 실패 사유, 재시도 간격(초)
export type PollStatus = {
  lastOk?: number
  failed?: string
  retrySec?: number
}

declare module 'claude-code' {
  interface PluginState {
    'stock-pane': { quotes: Quote[]; status: PollStatus }
  }
}
