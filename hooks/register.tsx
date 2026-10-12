import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PollStatus, Quote } from '../types'

const PANE = 'stocks'
const POLL_MS = 10_000
// 나스닥 · S&P500 · 코스피 · 다우존스
const DEFAULT_SYMS = ['^IXIC', '^GSPC', '^KS11', '^DJI']
const DEFAULT_LABELS: Record<string, string> = { '^IXIC': '나스닥', '^GSPC': 'S&P 500', '^KS11': '코스피', '^DJI': '다우존스' }
const KRX = /\.(KS|KQ)$/

// 지수 이름 → Yahoo 코드. 네이버 종목 검색은 「나스닥」을 나스닥 회사 주식(NDAQ)으로 찾아서 먼저 가로챈다
const INDEX: Record<string, [string, string]> = {
  나스닥: ['^IXIC', '나스닥'],
  나스닥100: ['^NDX', '나스닥100'],
  'S&P500': ['^GSPC', 'S&P 500'],
  에스앤피500: ['^GSPC', 'S&P 500'],
  다우: ['^DJI', '다우존스'],
  다우존스: ['^DJI', '다우존스'],
  코스피: ['^KS11', '코스피'],
  코스피200: ['^KS200', '코스피200'],
  코스닥: ['^KQ11', '코스닥'],
  필라델피아반도체: ['^SOX', '필라델피아반도체'],
}

// 「나스닥100지수」 「s&p 500」도 받는다
export const findIndex = (t: string) => INDEX[t.replace(/지수$/, '').replace(/\s/g, '').toUpperCase()]
const BARS = '▁▂▃▄▅▆▇█'
const quotes = atom({ plugin: 'stock-pane', key: 'quotes' } as const, [])
const status = atom({ plugin: 'stock-pane', key: 'status' } as const, {} as PollStatus)

// ponytail: 비공식 Yahoo spark API — 전 종목을 요청 1번에. 막히면 다른 시세 API로 교체
const sparkUrl = (syms: string[]) =>
  `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${syms.map(encodeURIComponent).join(',')}&range=1d&interval=5m`

const UA = { 'User-Agent': 'Mozilla/5.0' }

// 한글 이름이나 6자리 숫자는 네이버 자동완성으로 코드를 찾는다
const NEEDS_LOOKUP = /[가-힣]|^\d{6}$/

let timer: Timer | undefined
let fails = 0 // 연속 실패(429 등) 횟수
let skip = 0 // 쉬어 갈 남은 틱 수

// 실패가 이어지면 10초 → 20초 → 40초 → 최대 60초로 늘린다
export const backoffSkips = (n: number) => Math.min(2 ** n, 6) - 1

type NaverItem = { code: string; name: string; typeCode: string; nationCode: string }

// ponytail: 한국(코스피/코스닥)·미국만. 다른 나라는 코드로 직접 입력
export const toYahoo = (item: NaverItem): string | undefined =>
  item.nationCode === 'KOR'
    ? `${item.code}.${item.typeCode === 'KOSDAQ' ? 'KQ' : 'KS'}`
    : item.nationCode === 'USA'
      ? item.code
      : undefined

const lookup = async ($: EngineInterface, q: string): Promise<{ sym: string; label?: string } | undefined> => {
  try {
    const res = await $.http.fetch(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`, { headers: UA })
    if (!res.ok) return undefined
    const items: NaverItem[] = JSON.parse(res.text).items ?? []
    const item = items.find(i => i.name === q) ?? items[0]
    const sym = item && toYahoo(item)
    return sym ? { sym, label: item.name } : undefined
  } catch {
    return undefined
  }
}

// 각 구간의 마지막 값으로 폭을 맞춘다 — 마지막 칸이 항상 최신가
export const spark = (xs: number[], width: number): string => {
  const w = Math.min(width, xs.length)
  if (w <= 0) return ''
  const picked = Array.from({ length: w }, (_, i) => xs[Math.floor(((i + 1) * xs.length) / w) - 1]!)
  const lo = Math.min(...picked)
  const hi = Math.max(...picked)
  return picked.map(x => BARS[hi === lo ? 3 : Math.round(((x - lo) / (hi - lo)) * 7)]).join('')
}

// spark의 마지막 종가가 현재가다. 없는 종목은 응답에서 빠진다
export const parseSpark = (syms: string[], text: string): Quote[] => {
  const d = JSON.parse(text) ?? {}
  return syms.map(sym => {
    const r = d[sym]
    const closes: number[] = (r?.close ?? []).filter((x: unknown) => typeof x === 'number')
    if (closes.length === 0) return { sym, closes, error: '종목 없음' }
    return { sym, price: closes.at(-1), prev: r.chartPreviousClose ?? r.previousClose, closes }
  })
}

// 문자열 = 일시 실패(429 등)의 사유 — 직전 시세를 그대로 둔다
const fetchQuotes = async ($: EngineInterface, syms: string[]): Promise<Quote[] | string> => {
  try {
    // UA 없으면 429
    const res = await $.http.fetch(sparkUrl(syms), { headers: UA })
    if (res.ok) return parseSpark(syms, res.text)
    return res.status === 404 ? parseSpark(syms, '{}') : `HTTP ${res.status}`
  } catch {
    return '네트워크 오류'
  }
}

// Yahoo의 한국 시세는 지연돼서, 한국 종목 현재가는 네이버 실시간으로 덮는다
const fetchKrLive = async ($: EngineInterface, syms: string[]): Promise<Record<string, number>> => {
  const codes = syms.filter(sym => KRX.test(sym)).map(sym => sym.slice(0, -3))
  if (codes.length === 0) return {}
  try {
    const res = await $.http.fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`, { headers: UA })
    const datas: { itemCode: string; closePrice: string }[] = res.ok ? (JSON.parse(res.text).datas ?? []) : []
    return Object.fromEntries(datas.map(d => [d.itemCode, Number(d.closePrice.replace(/,/g, ''))]))
  } catch {
    return {}
  }
}

// 실패하면(429 등) 사유를, 성공하면 undefined를 돌려준다
const refresh = async ($: EngineInterface): Promise<string | undefined> => {
  const syms = ((await $.store.get('symbols')) as string[] | undefined) ?? DEFAULT_SYMS
  const labels = { ...DEFAULT_LABELS, ...((await $.store.get('labels')) as Record<string, string> | undefined) }
  const [list, kr] = await Promise.all([fetchQuotes($, syms), fetchKrLive($, syms)])
  if (typeof list === 'string') {
    await update($, quotes, old => (old.length > 0 ? old : syms.map(sym => ({ sym, closes: [], error: '시세 서버 응답 없음' }))))
    return list
  }
  await update($, quotes, () =>
    list.map(q => {
      const live = KRX.test(q.sym) ? kr[q.sym.slice(0, -3)] : undefined
      const merged = live && !q.error ? { ...q, price: live, closes: [...q.closes, live] } : q
      return { ...merged, name: labels[q.sym] ?? q.sym }
    }),
  )
  return undefined
}

// 한 번 갱신하고 백오프와 상태 줄을 맞춘다
const poll = async ($: EngineInterface) => {
  const failed = await refresh($)
  fails = failed ? fails + 1 : 0
  skip = backoffSkips(fails)
  const now = await $.clock.now()
  await update($, status, s => (failed ? { ...s, failed, retrySec: ((skip + 1) * POLL_MS) / 1000 } : { lastOk: now }))
}

export const hms = (ms: number) => {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// 패널이 닫히면 다음 틱에서 폴링을 멈춘다
const startPolling = ($: EngineInterface) => {
  if (timer) return
  timer = $.clock.every(POLL_MS, async () => {
    if (!(await $.ui.panes()).some(pane => pane.id === PANE)) {
      timer?.cancel()
      timer = undefined
      return
    }
    if (skip > 0) {
      skip--
      return
    }
    await poll($)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'stock',
      description: '실시간 주식 패널. 종목명/지수명/코드로 관심종목 교체, reset이면 기본 지수로, close면 닫기 (예: /stock 삼성전자 엔비디아 나스닥100)',
      argumentHint: '[종목명·코드... | reset | close]',
    })
    // 핫 리로드 뒤 패널이 떠 있으면 폴링 재개
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) startPolling($)

    return next(e)
  })

  on('command.run', { command: 'stock' }, async ($, e) => {
    // 쉼표가 있으면 쉼표로 나눈다 — "KODEX 200"처럼 띄어쓰기 있는 이름용
    const tokens = (e.args.includes(',') ? e.args.split(',') : e.args.split(/\s+/)).map(s => s.trim()).filter(Boolean)
    if (tokens[0]?.toLowerCase() === 'close') {
      timer?.cancel()
      timer = undefined
      await $.ui.close({ id: PANE })
      return { text: '주식 패널을 닫았어요.' }
    }
    let missed: string[] = []
    if (tokens[0]?.toLowerCase() === 'reset') {
      await $.store.delete('symbols')
      await $.store.delete('labels')
    } else if (tokens.length > 0) {
      const found = await Promise.all(
        tokens.map(t => {
          const idx = findIndex(t)
          if (idx) return Promise.resolve({ sym: idx[0], label: idx[1] })
          return NEEDS_LOOKUP.test(t) ? lookup($, t) : Promise.resolve({ sym: t.toUpperCase(), label: undefined })
        }),
      )
      missed = tokens.filter((_, i) => !found[i])
      const ok = found.filter(f => f !== undefined)
      if (ok.length > 0) {
        await $.store.set('symbols', ok.map(f => f.sym))
        await $.store.set('labels', Object.fromEntries(ok.flatMap(f => (f.label ? [[f.sym, f.label]] : []))))
      }
    }
    const opened = await $.ui.open({ id: PANE, title: '주식' })
    await poll($)
    startPolling($)

    const note = missed.length > 0 ? ` 못 찾은 종목: ${missed.join(', ')}` : ''
    return { text: (opened.isPlaced ? '주식 패널을 열었어요.' : '터미널을 넓히면 패널이 보여요.') + note }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, quotes)
    const st = await read($, status)
    const width = Math.max(10, e.props.bodyColumns)

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>불러오는 중…</Text>}
        {list.map(q => {
          if (q.error || q.price === undefined || q.prev === undefined) {
            return <Text color="error">{q.sym} {q.error ?? '데이터 없음'}</Text>
          }
          const pct = ((q.price - q.prev) / q.prev) * 100
          // 한국식: 상승 빨강, 하락 파랑
          const color = pct > 0 ? 'red' : pct < 0 ? 'blue' : undefined
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Text wrap="truncate">
                <Text bold>{q.name}</Text> {q.price.toLocaleString()}{' '}
                <Text color={color}>{pct > 0 ? '+' : ''}{pct.toFixed(2)}%</Text>
              </Text>
              <Text color={color}>{spark(q.closes, width)}</Text>
            </Box>
          )
        })}
        {st.failed ? (
          <Text color="warning">
            ⚠ 갱신 실패({st.failed}) · {st.retrySec}초 간격 재시도{st.lastOk ? ` · 마지막 성공 ${hms(st.lastOk)}` : ''}
          </Text>
        ) : (
          <Text dimColor>
            {POLL_MS / 1000}초마다 갱신{st.lastOk ? ` · 마지막 ${hms(st.lastOk)}` : ''}
          </Text>
        )}
      </Box>
    )
  })
}
