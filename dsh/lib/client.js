// dsh-thoughtdag client half — the lightest possible browser shim.
// It renders a "对话 | 思维图" switch in the harness session header (slot
// `conversation.session.header.actions`, so it flows with the native layout
// on desktop and mobile web instead of floating over the title bar) and, on
// "思维图", shows a full-screen SAME-ORIGIN iframe at /thoughtdag/ (the SPA
// is served by the host half on the same web server — no CORS, no second
// origin). The overlay covers the header, so the canvas draws its own way
// back (td:close); the floating back pill here is only a fallback until the
// canvas says it is ready.
//
// On the desktop shell the window has no native title bar: the traffic
// lights (macOS) float over the top-left corner, the caption buttons
// (Windows) over the top-right. This file reads those corners from the
// host's own markers (the ones its full-screen layers use) and sends them
// to the canvas (td:chrome), which keeps its top bar on the first row beside
// them. The canvas answers with the rectangles of its empty chrome
// (td:drag) and this file lays transparent drag blocks over them — only
// the main document's elements can be drag regions.
//
// Chromium builds the drag region by walking the document in order: a drag
// element adds its box, a no-drag one cuts its own out, the later one wins.
// The host marks every direct child of <body> but #root no-drag (an
// id-weighted rule), and portals keep arriving after this file runs — any
// of them sitting over the strip would cut the blocks away. So the blocks
// live in their own layer that stays the LAST child of <body> while the
// canvas is shown, and claim drag with !important. All conversation smarts live inside the ThoughtDAG app; this file
// only opens the door and forwards the current session id so the canvas can
// offer to mirror it.
//
// Same pattern as dsh-synapse: window.__ModuleLoader__.load with a module
// whose inject lists the client services it reads (sessions, slots) and whose
// apply registers the switch. react is a platform seed module — the loader's
// require answers it from the module table, so the bundle stays tiny.

window.__ModuleLoader__.load({
  id: 'dsh-thoughtdag',
  factory: require => {
    const module = { exports: {} }
    const React = require('react')

    module.exports.inject = ['sessions', 'slots']
    module.exports.apply = ctx => {
      const currentSession = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        const id = snapshot.current
        if (id === undefined) return null
        const session = snapshot.byId[id]
        return session === undefined ? null : { id, title: session.displayTitle ?? null, cwd: session.cwd ?? null }
      }

      const style = document.createElement('style')
      style.textContent = '.dsh-td-switch{display:inline-flex;gap:2px;border:1px solid #d1d5db;border-radius:999px;background:rgba(255,255,255,.96);padding:3px;backdrop-filter:blur(10px)}.dsh-td-switch button{height:26px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:#6b7280;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}.dsh-td-switch button:hover{background:#f3f4f6;color:#111827}.dsh-td-switch button.active{background:#111827;color:#fff}.dsh-td-back{position:fixed;z-index:130;top:calc(var(--dsh-td-band,0px) + 12px);left:50%;-webkit-app-region:no-drag;transform:translateX(-50%);border:1px solid #d1d5db;border-radius:999px;background:rgba(255,255,255,.96);padding:5px 14px;color:#374151;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;backdrop-filter:blur(10px)}.dsh-td-back:hover{background:#f3f4f6;color:#111827}.dsh-td-overlay{position:fixed;z-index:100;inset:0;background:#f5f6f7}body[data-ds-dark-theme] .dsh-td-overlay{background:#353638}.dsh-td-overlay[hidden],.dsh-td-back[hidden]{display:none}.dsh-td-drag-layer{position:fixed;z-index:101;top:0;left:0;width:0;height:0}.dsh-td-drag-layer[hidden]{display:none}.dsh-td-drag-layer>div{position:fixed;-webkit-app-region:drag!important}.dsh-td-overlay iframe{display:block;width:100%;height:100%;border:0}'
      document.head.append(style)

      const overlayHost = document.createElement('div')
      overlayHost.innerHTML = '<section class="dsh-td-overlay" hidden><button type="button" class="dsh-td-back">对话</button><iframe title="ThoughtDAG" data-src="/thoughtdag/"></iframe></section>'
      document.body.append(overlayHost)
      const overlay = overlayHost.querySelector('.dsh-td-overlay')
      const frame = overlayHost.querySelector('iframe')
      const backBtn = overlayHost.querySelector('.dsh-td-back')

      // the plugin's version, for the canvas's update dialog and release history
      let pluginVersion = null
      fetch('/thoughtdag/api/version').then(r => (r.ok ? r.json() : null)).then(j => { if (j && typeof j.version === 'string') pluginVersion = j.version }).catch(() => {})

      // store 由本文件自行维护：setMap 是唯一写入口，既切 overlay（命令式
      // DOM），也通知 Switch 组件重渲染 active 态。不走 slots 的 store/inject
      // 契约——session 作用域槽位的 inject 首参是 sessionKey，签名因槽位而异。
      let mapState = false
      const mapSubscribers = new Set()

      const send = (type, payload) => frame.contentWindow?.postMessage({ source: 'dsh-thoughtdag', type, ...payload }, location.origin)

      // The window's corner controls, in page pixels: `left` / `right` is
      // how far in from each side the canvas's top bar must keep clear,
      // `center` the line the controls sit on (the bar centres on it),
      // `band` their strip's height. Nothing in native fullscreen or in a
      // plain browser tab (no desktop markers on <html>).
      const chromeMetrics = () => {
        const root = document.documentElement
        const none = { left: 0, right: 0, center: 0, band: 0 }
        if (root.hasAttribute('data-fullscreen')) return none
        if (root.hasAttribute('data-windows-titlebar')) {
          const h = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-windows-titlebar-height'))
          const band = Number.isFinite(h) ? h : 40
          // the caption buttons' width: the overlay API knows it where the
          // shell enables it; three standard 46px buttons otherwise
          const wco = navigator.windowControlsOverlay
          const area = wco && wco.visible ? wco.getTitlebarAreaRect() : null
          const right = area && area.width > 0 ? Math.max(0, window.innerWidth - (area.x + area.width)) : 138
          return { left: 0, right, center: band / 2, band }
        }
        // the shell places the traffic lights at (16, 18): three 14px
        // buttons end near x=74, their centre line is y=25
        if (root.dataset.platform === 'darwin') return { left: 84, right: 0, center: 25, band: 36 }
        return none
      }

      // the drag blocks, in a layer kept last in <body> (see the header)
      const dragLayer = document.createElement('div')
      dragLayer.className = 'dsh-td-drag-layer'
      dragLayer.hidden = true
      dragLayer.setAttribute('aria-hidden', 'true')
      let dragRects = null // null until the canvas reports: a plain band meanwhile
      const renderDrag = () => {
        const m = chromeMetrics()
        const rects = dragRects ?? (m.band > 0 ? [{ x: 0, y: 0, w: window.innerWidth - m.right, h: m.band }] : [])
        dragLayer.replaceChildren(...rects.map(r => {
          const el = document.createElement('div')
          el.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`
          return el
        }))
      }
      const keepLast = () => {
        if (!dragLayer.hidden && document.body.lastElementChild !== dragLayer) document.body.append(dragLayer)
      }
      new MutationObserver(keepLast).observe(document.body, { childList: true })
      document.body.append(dragLayer)

      let lastMetrics = ''
      const syncChrome = () => {
        const m = chromeMetrics()
        lastMetrics = JSON.stringify(m)
        overlay.style.setProperty('--dsh-td-band', m.band + 'px')
        renderDrag()
        send('td:chrome', m)
      }
      // <html>'s style also carries the host's layout variables, which move
      // while a sidebar is dragged: only changed corners are worth a message
      const onHostChange = () => { if (JSON.stringify(chromeMetrics()) !== lastMetrics) syncChrome() }
      new MutationObserver(onHostChange).observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-fullscreen', 'data-platform', 'data-windows-titlebar', 'style'],
      })
      window.addEventListener('resize', onHostChange)
      navigator.windowControlsOverlay?.addEventListener?.('geometrychange', onHostChange)
      syncChrome()

      const syncCurrent = () => {
        const session = currentSession()
        send('td:current-session', { session })
      }

      const setMap = map => {
        mapState = map
        overlay.hidden = !map
        dragLayer.hidden = !map
        keepLast()
        for (const notify of mapSubscribers) notify(map)
        if (!map) { send('td:view', { shown: false }); return }
        // the SPA boots on first open, never while hidden: a canvas that
        // measures itself inside a display:none frame fits its view to a 0×0
        // box and shows nothing when revealed
        if (!frame.src) frame.src = frame.dataset.src + (pluginVersion ? (frame.dataset.src.includes('?') ? '&' : '?') + 'dv=' + encodeURIComponent(pluginVersion) : '')
        syncCurrent()
        syncChrome()
        send('td:view', { shown: true })
        // let the SPA boot, then re-sync so its listener is ready
        window.setTimeout(() => { syncCurrent(); syncChrome(); send('td:view', { shown: true }) }, 400)
      }

      const Switch = () => {
        const [map, setMapState] = React.useState(mapState)
        React.useEffect(() => {
          const notify = m => setMapState(m)
          mapSubscribers.add(notify)
          return () => { mapSubscribers.delete(notify) }
        }, [])
        return React.createElement('div', { className: 'dsh-td-switch', role: 'group', 'aria-label': 'view switch' },
          React.createElement('button', {
            type: 'button', 'data-view': 'dialog', className: map ? '' : 'active', 'aria-pressed': String(!map),
            onClick: () => setMap(false),
          }, '对话'),
          React.createElement('button', {
            type: 'button', 'data-view': 'map', className: map ? 'active' : '', 'aria-pressed': String(map),
            onClick: () => setMap(true),
          }, '思维图'),
        )
      }

      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'thoughtdag-view-switch',
          order: 90,
        }, Switch),
      )

      backBtn.addEventListener('click', () => setMap(false))

      window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.data?.source !== 'dsh-thoughtdag') return
        if (event.data.type === 'td:close') return setMap(false)
        // the canvas is up and draws its own back button: the pill retires
        if (event.data.type === 'td:ready') { backBtn.hidden = true; return syncChrome() }
        // the canvas's empty chrome, where the window is dragged from
        if (event.data.type === 'td:drag' && Array.isArray(event.data.rects)) {
          dragRects = event.data.rects
            .filter(r => r && [r.x, r.y, r.w, r.h].every(Number.isFinite))
            .slice(0, 8)
          return renderDrag()
        }
        if (event.data.type === 'td:request-current') return syncCurrent()
        // the canvas forked or continued a session: stage it and go back to the
        // chat, which now shows exactly the context the canvas produced
        if (event.data.type === 'td:select-session' && typeof event.data.session === 'string') {
          // 0.1.2 renamed the selector: the ISessions contract exposes open(id);
          // older runtimes (0.1.1) still call it select
          const select = ctx.sessions.open ?? ctx.sessions.select
          select.call(ctx.sessions, event.data.session)
          if (event.data.close !== false) setMap(false)
          syncCurrent()
        }
      })
    }

    return module.exports
  },
})
