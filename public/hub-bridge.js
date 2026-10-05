/* Opt-in frame bridge. State stays in memory in the owning hub process. */
;(() => {
  const params = new URLSearchParams(location.search)
  if (params.get('hub') !== '1' || window.parent === window) return
  const origin = params.get('parentOrigin')
  if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return
  let adapter = {},
    busy = 0,
    paused = false,
    resolveInitial
  const initial = new Promise((resolve) => {
    resolveInitial = resolve
  })
  const send = (type, extra = {}) =>
    parent.postMessage({ hub: 1, type, ...extra }, origin)
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (...args) => {
    const method =
      args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')
    const mutation = !['GET', 'HEAD'].includes(method.toUpperCase())
    if (mutation && paused)
      throw new Error('Application is moving; retry after it returns.')
    if (mutation) busy++
    try {
      return await originalFetch(...args)
    } finally {
      if (mutation) busy--
      schedule()
    }
  }
  const forms = () =>
    [
      ...document.querySelectorAll('input:not([type=file]),select,textarea'),
    ].map((el, index) => ({
      index,
      value: el.value,
      checked: el.checked,
      type: el.type,
    }))
  const capture = () => ({
    app: adapter.capture?.() || null,
    forms: forms(),
    scroll: [scrollX, scrollY],
  })
  const snapshot = () => {
    if (!paused) send('snapshot', { snapshot: capture(), busy })
  }
  let timer
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(snapshot, 30)
  }
  window.hubIntegration = {
    initial,
    install(value) {
      adapter = value
      snapshot()
      setTimeout(() => send('hydrated'), 100)
    },
    capture,
    publish: snapshot,
    restoreForms(saved) {
      const inputs = [
        ...document.querySelectorAll('input:not([type=file]),select,textarea'),
      ]
      for (const field of saved?.forms || []) {
        const el = inputs[field.index]
        if (!el || el.type !== field.type) continue
        if (
          el.value === field.value &&
          (el.type !== 'checkbox' || el.checked === field.checked)
        )
          continue
        const prototype =
          el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(
          el,
          field.value,
        )
        if (el.type === 'checkbox') el.checked = field.checked
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (saved?.scroll) scrollTo(...saved.scroll)
    },
  }
  addEventListener('message', async (event) => {
    if (
      event.origin !== origin ||
      event.source !== parent ||
      event.data?.hub !== 1
    )
      return
    const message = event.data
    if (message.type === 'probe' && params.get('fixture') === '1') {
      try {
        const element = message.selector
          ? document.querySelector(message.selector)
          : null
        if (message.action === 'input') {
          if (!element) throw new Error('Element not found')
          const prototype =
            element instanceof HTMLSelectElement
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(
            element,
            message.value,
          )
          element.dispatchEvent(new Event('input', { bubbles: true }))
          element.dispatchEvent(new Event('change', { bubbles: true }))
        }
        if (message.action === 'click') {
          if (!element) throw new Error('Element not found')
          element.click()
        }
        send('probed', {
          requestId: message.requestId,
          value:
            message.action === 'snapshot'
              ? capture()
              : (element?.value ?? element?.textContent ?? null),
        })
      } catch (error) {
        send('probed', { requestId: message.requestId, error: error.message })
      }
      return
    }
    if (message.type === 'initial') {
      resolveInitial(message.snapshot || null)
      return
    }
    if (message.type === 'capture') {
      if (!busy) {
        paused = true
        adapter.pause?.()
      }
      send('captured', {
        requestId: message.requestId,
        snapshot: capture(),
        busy,
      })
      return
    }
    if (message.type === 'pause') {
      paused = true
      adapter.pause?.()
    }
    if (message.type === 'resume') {
      paused = false
      adapter.resume?.()
      snapshot()
    }
  })
  addEventListener(
    'keydown',
    (event) => {
      if (
        event.ctrlKey &&
        (event.key.toLowerCase() === 'k' ||
          event.key === 'PageUp' ||
          event.key === 'PageDown')
      ) {
        event.preventDefault()
        send('shortcut', { key: event.key })
      }
    },
    true,
  )
  addEventListener(
    'click',
    (event) => {
      const link = event.target.closest?.('a[target="_blank"]')
      if (link && /^https?:/.test(link.href)) {
        event.preventDefault()
        send('external', { url: link.href })
      }
    },
    true,
  )
  addEventListener('input', schedule, true)
  addEventListener('change', schedule, true)
  addEventListener('click', schedule, true)
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true,
    childList: true,
  })
  send('ready')
  const handshake = setInterval(() => send('ready'), 150)
  initial.then(() => clearInterval(handshake))
  // A standalone frame opened without a responding hub should still be usable.
  setTimeout(() => resolveInitial(null), 3000)
})()
