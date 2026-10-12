import { expect, mock, test } from 'claude-code/testing'

test('갱신 실패(429)면 하단에 경고 줄', async ($, on) => {
  on('http.fetch', () => ({ value: { status: 429, ok: false, headers: {}, text: '' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  mock.store(on)
  mock.clock(on)
  await $.command.run({ command: 'stock', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'stock-pane',
      surface,
      component: 'Pane',
      requestId: 'stocks',
      props: { title: '주식', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /갱신 실패\(HTTP 429\)/ })).toBeDefined()
    await ui.unmount()
  }
})
