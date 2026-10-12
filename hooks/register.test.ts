import { expect, test } from 'claude-code/testing'

import { findIndex, parseSpark, spark, toYahoo } from './register'

test('spark: 폭에 맞추고 마지막 칸은 최신가', async () => {
  expect(spark([1, 2, 3, 4, 5, 6, 7, 8], 8)).toBe('▁▂▃▄▅▆▇█')
  expect(spark([5, 1, 9, 9], 2)).toBe('▁█')
  expect(spark([], 10)).toBe('')
  expect(spark([3, 3], 5)).toBe('▄▄')
})

test('parseSpark: 마지막 종가가 현재가, null 빼고, 빠진 종목은 에러', async () => {
  const body = JSON.stringify({ X: { close: [1, null, 2], chartPreviousClose: 8 } })
  expect(parseSpark(['X', 'Z'], body)).toEqual([
    { sym: 'X', price: 2, prev: 8, closes: [1, 2] },
    { sym: 'Z', closes: [], error: '종목 없음' },
  ])
})

test('toYahoo: 코스피 .KS, 코스닥 .KQ, 미국 그대로, 그 외 없음', async () => {
  const item = (code: string, typeCode: string, nationCode: string) => ({ code, name: '', typeCode, nationCode })
  expect(toYahoo(item('005930', 'KOSPI', 'KOR'))).toBe('005930.KS')
  expect(toYahoo(item('247540', 'KOSDAQ', 'KOR'))).toBe('247540.KQ')
  expect(toYahoo(item('NVDA', 'NASDAQ', 'USA'))).toBe('NVDA')
  expect(toYahoo(item('7203', 'TSE', 'JPN'))).toBeUndefined()
})

test('findIndex: 지수 이름은 NDAQ 같은 회사 주식이 아니라 지수 코드로', async () => {
  expect(findIndex('나스닥')?.[0]).toBe('^IXIC')
  expect(findIndex('나스닥100지수')?.[0]).toBe('^NDX')
  expect(findIndex('s&p 500')?.[0]).toBe('^GSPC')
  expect(findIndex('삼성전자')).toBeUndefined()
})
