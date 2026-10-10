// dsh-dotline client half — the lightest possible browser shim.
// The canvas is not any one session's: it lists and mirrors all of them. So
// its entry is a global panel — a row in the sidebar's panel list
// (`sidebar.panellist`) that swaps the centre column (`main`, keyed
// 'dotline') for the canvas, the way the harness's own global panels do;
// opening any session from the sidebar returns the centre to the chat. Hosts
// without global panels (no `layout` service) get the older "对话 | 思维图"
// switch in the session header instead, with the canvas over the window.
//
// The canvas itself is a SAME-ORIGIN iframe at /dotline/ (the SPA is
// served by the host half on the same web server — no CORS, no second
// origin). It lives in one fixed layer this file keeps for the page's life
// and lays over the panel's box: the main slot unmounts a panel that is not
// selected, and an iframe moved or rebuilt reloads the canvas. The canvas
// draws its own way back (td:close); the back pill here is only a fallback
// until the canvas says it is ready.
//
// On the desktop shell the window has no native title bar: the traffic
// lights (macOS) float over the top-left corner, the caption buttons
// (Windows) over the top-right. This file reads those corners from the
// host's own markers (the ones its full-screen layers use) and sends the
// part of them that falls on the canvas (td:chrome), which keeps its top bar
// on the first row beside them. The canvas answers with the rectangles of its empty chrome
// (td:drag) and this file lays transparent drag blocks over them — only
// the main document's elements can be drag regions.
//
// Chromium builds the drag region by walking the document in order: a drag
// element adds its box, a no-drag one cuts its own out, the later one wins.
// The host marks every direct child of <body> but #root no-drag (an
// id-weighted rule), and portals keep arriving after this file runs — any
// of them sitting over the strip would cut the blocks away. So the blocks
// live in their own layer that stays the LAST child of <body> while the
// canvas is shown, and claim drag with !important. All conversation smarts live inside the Dotline app; this file
// only opens the door and forwards the current session id so the canvas can
// offer to mirror it.
//
// Same pattern as dsh-synapse: window.__ModuleLoader__.load with a module
// whose inject lists the client services it reads (sessions, slots) and whose
// apply registers the entry. `layout` is awaited inside apply rather than
// injected, so a host without it still loads the plugin and keeps the switch. react is a platform seed module — the loader's
// require answers it from the module table, so the bundle stays tiny.

window.__ModuleLoader__.load({
  id: 'dsh-dotline',
  factory: require => {
    const module = { exports: {} }
    const React = require('react')

    module.exports.inject = ['sessions', 'slots']
    module.exports.apply = ctx => {
      const lookup = name => { try { return ctx.get(name) ?? undefined } catch { return undefined } }
      // 0.2 moved the chat's session out of the sessions service: the
      // workspace UI (`uiWorkspace`) opens one and remembers which is shown
      const workspaceUi = () => {
        const ui = lookup('uiWorkspace')
        return typeof ui?.openSession === 'function' ? ui : undefined
      }
      const currentSession = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        const id = snapshot.current ?? workspaceUi()?.selection?.getSnapshot?.()?.sessionId
        if (id === undefined) return null
        const session = snapshot.byId[id]
        return session === undefined ? null : { id, title: session.displayTitle ?? null, cwd: session.cwd ?? null }
      }

      const style = document.createElement('style')
      style.textContent = '.dsh-td-switch{display:inline-flex;gap:2px;border:1px solid #d1d5db;border-radius:999px;background:rgba(255,255,255,.96);padding:3px;backdrop-filter:blur(10px)}.dsh-td-switch button{height:26px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:#6b7280;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}.dsh-td-switch button:hover{background:#f3f4f6;color:#111827}.dsh-td-switch button.active{background:#111827;color:#fff}.dsh-td-back{position:absolute;z-index:1;top:calc(var(--dsh-td-band,0px) + 12px);left:50%;-webkit-app-region:no-drag;transform:translateX(-50%);border:1px solid #d1d5db;border-radius:999px;background:rgba(255,255,255,.96);padding:5px 14px;color:#374151;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;backdrop-filter:blur(10px)}.dsh-td-back:hover{background:#f3f4f6;color:#111827}.dsh-td-overlay{position:fixed;z-index:100;inset:0;background:#f5f6f7}.dsh-td-overlay.dsh-td-docked{z-index:10}.dsh-td-panel{flex:1;min-height:0}.dsh-td-glyph{display:block}body[data-ds-dark-theme] .dsh-td-overlay{background:#353638}.dsh-td-overlay[hidden],.dsh-td-back[hidden]{display:none}.dsh-td-drag-layer{position:fixed;z-index:101;top:0;left:0;width:0;height:0}.dsh-td-drag-layer[hidden]{display:none}.dsh-td-drag-layer>div{position:fixed;-webkit-app-region:drag!important}.dsh-td-overlay iframe{display:block;width:100%;height:100%;border:0}'
      document.head.append(style)

      const overlayHost = document.createElement('div')
      overlayHost.innerHTML = '<section class="dsh-td-overlay" hidden><button type="button" class="dsh-td-back">对话</button><iframe title="Dotline" data-src="/dotline/"></iframe></section>'
      document.body.append(overlayHost)
      const overlay = overlayHost.querySelector('.dsh-td-overlay')
      const frame = overlayHost.querySelector('iframe')
      const backBtn = overlayHost.querySelector('.dsh-td-back')

      // the plugin's version, for the canvas's update dialog and release history
      let pluginVersion = null
      fetch('/dotline/api/version').then(r => (r.ok ? r.json() : null)).then(j => { if (j && typeof j.version === 'string') pluginVersion = j.version }).catch(() => {})

      // store 由本文件自行维护：setMap 是唯一写入口，既切 overlay（命令式
      // DOM），也通知 Switch 组件重渲染 active 态。不走 slots 的 store/inject
      // 契约——session 作用域槽位的 inject 首参是 sessionKey，签名因槽位而异。
      let mapState = false
      const mapSubscribers = new Set()

      const send = (type, payload) => frame.contentWindow?.postMessage({ source: 'dsh-dotline', type, ...payload }, location.origin)

      // The window's corner controls, in page pixels: `left` / `right` is
      // how far in from each side the canvas's top bar must keep clear,
      // `center` the line the controls sit on (the bar centres on it),
      // `band` their strip's height. Nothing in native fullscreen or in a
      // plain browser tab (no desktop markers on <html>).
      const windowMetrics = () => {
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

      // Where the canvas sits, in page pixels: the whole window over the
      // header switch, the centre column's box as a global panel (`docked`,
      // kept current by the panel while it is mounted).
      let docked = null
      let canvasReady = false
      const canvasBox = () => docked ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
      // The harness's own controls over a panel's top-left corner: on macOS
      // with the sidebar hidden, the frame's \`shell.leading\` seat (reopen the
      // sidebar, New Session) floats beside the traffic lights over every
      // main panel, in fullscreen too.
      const leadingSeat = () => {
        const r = document.querySelector('[data-shell-leading]')?.getBoundingClientRect()
        return r && r.width > 0 && r.height > 0 ? r : null
      }
      // The window's corners as the canvas sees them: what of each falls on
      // its box. A docked canvas beside an open sidebar meets neither, nor
      // one below a title bar the harness reserves over its columns
      // (Windows), and then has no strip to keep clear or drag the window
      // from. \`back\`: over the whole window the canvas draws its own way
      // back to the chat; as a panel the sidebar is the way back.
      const chromeMetrics = () => {
        const m = windowMetrics()
        const box = canvasBox()
        const back = docked === null
        const meets = m.band > box.y
        let left = meets ? Math.max(0, m.left - box.x) : 0
        const right = meets ? Math.max(0, m.right - (window.innerWidth - (box.x + box.w))) : 0
        let center = m.center - box.y
        let band = m.band - box.y
        const seat = docked === null ? null : leadingSeat()
        if (seat && seat.bottom > box.y && seat.right > box.x) {
          left = Math.max(left, Math.round(seat.right + 8 - box.x))
          center = Math.round((seat.top + seat.bottom) / 2 - box.y)
          // as much room under the seat as above it
          band = Math.max(band, Math.round(seat.bottom + seat.top - box.y))
        }
        if (left === 0 && right === 0) return { left: 0, right: 0, center: 0, band: 0, back }
        return { left, right, center: Math.max(0, center), band: Math.max(0, band), back }
      }

      // a drag block over the seat would swallow its clicks (the layer is
      // last in <body> and claims drag): cut the seat out of each block
      const cut = (r, s) => {
        if (!s || r.x >= s.right || s.left >= r.x + r.w || r.y >= s.bottom || s.top >= r.y + r.h) return [r]
        const bottom = r.y + r.h
        const right = r.x + r.w
        const top = Math.max(r.y, s.top)
        const low = Math.min(bottom, s.bottom)
        return [
          { x: r.x, y: r.y, w: r.w, h: s.top - r.y },
          { x: r.x, y: s.bottom, w: r.w, h: bottom - s.bottom },
          { x: r.x, y: top, w: s.left - r.x, h: low - top },
          { x: s.right, y: top, w: right - s.right, h: low - top },
        ].filter(p => p.w > 0 && p.h > 0)
      }

      // the drag blocks, in a layer kept last in <body> (see the header)
      const dragLayer = document.createElement('div')
      dragLayer.className = 'dsh-td-drag-layer'
      dragLayer.hidden = true
      dragLayer.setAttribute('aria-hidden', 'true')
      let dragRects = null // null until the canvas reports: a plain band meanwhile
      const renderDrag = () => {
        const m = chromeMetrics()
        const box = canvasBox()
        // the canvas reports in its own viewport: shift by where it sits
        const rects = dragRects ?? (m.band > 0 ? [{ x: 0, y: 0, w: box.w - m.right, h: m.band }] : [])
        const seat = docked === null ? null : leadingSeat()
        const hole = seat && { left: seat.left - 4, top: seat.top - 4, right: seat.right + 4, bottom: seat.bottom + 4 }
        const page = rects.flatMap(r => cut({ x: box.x + r.x, y: box.y + r.y, w: r.w, h: r.h }, hole))
        dragLayer.replaceChildren(...page.map(r => {
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

      // the docked canvas follows the panel's box (sidebar drags and folds
      // resize the centre column; the window resizing moves it)
      const dock = box => {
        docked = box
        // a panel's way back is the sidebar: no pill there
        backBtn.hidden = box !== null || canvasReady
        overlay.classList.toggle('dsh-td-docked', box !== null)
        const s = overlay.style
        if (box === null) { s.left = s.top = s.width = s.height = ''; s.inset = '' }
        else { s.inset = 'auto'; s.left = box.x + 'px'; s.top = box.y + 'px'; s.width = box.w + 'px'; s.height = box.h + 'px' }
        onHostChange()
        renderDrag()
      }

      const PANEL_ID = 'dotline'
      // the host's global panels, while its layout service is there
      let layout = null
      const backToChat = () => (layout ? layout.selectPanel(null) : setMap(false))

      // the panel only holds the canvas's place; the layer above it is the canvas
      const Panel = () => {
        const ref = React.useRef(null)
        React.useLayoutEffect(() => {
          const el = ref.current
          const place = () => {
            const r = el.getBoundingClientRect()
            const box = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
            if (docked && docked.x === box.x && docked.y === box.y && docked.w === box.w && docked.h === box.h) return
            dock(box)
          }
          const observer = new ResizeObserver(place)
          observer.observe(el)
          window.addEventListener('resize', place)
          place()
          setMap(true)
          return () => {
            observer.disconnect()
            window.removeEventListener('resize', place)
            setMap(false)
            dock(null)
          }
        }, [])
        return React.createElement('div', { ref, className: 'dsh-td-panel' })
      }

      // a small graph: three nodes, the context flowing down
      const Glyph = ({ size }) => React.createElement('svg', {
        className: 'dsh-td-glyph', width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': 'true',
      },
      React.createElement('rect', { x: 5.5, y: 1.5, width: 5, height: 3.5, rx: 1 }),
      React.createElement('rect', { x: 1.5, y: 11, width: 5, height: 3.5, rx: 1 }),
      React.createElement('rect', { x: 9.5, y: 11, width: 5, height: 3.5, rx: 1 }),
      React.createElement('path', { d: 'M8 5v2.5M8 7.5 4 11M8 7.5l4 3.5' }),
      )

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

      // The entry follows the layout service, not what was there when this
      // file ran: at boot the layout plugin may provide it after this one is
      // applied, and a one-time look then found nothing and left the canvas
      // without its sidebar row until the plugin was reloaded. The header
      // switch stands in while no layout service is there.
      let disposeSwitch = null
      const showSwitch = () => {
        disposeSwitch ??= ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register({
            name: 'conversation.session.header.actions',
            id: 'dotline-view-switch',
            order: 90,
          }, Switch),
        )
      }
      showSwitch()
      ctx.inject(['layout'], scope => {
        if (typeof scope.layout?.selectPanel !== 'function') return
        disposeSwitch?.()
        disposeSwitch = null
        if (mapState) setMap(false)
        layout = scope.layout
        scope.slots.inject('main', () =>
          scope.slots.register({ name: 'main', key: PANEL_ID }, Panel),
        )
        scope.slots.inject('sidebar.panellist', () =>
          scope.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: '思维图' }, Glyph),
        )
        scope.effect(() => () => {
          layout = null
          showSwitch()
        }, 'dotline: global panel')
      })

      backBtn.addEventListener('click', backToChat)

      window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.data?.source !== 'dsh-dotline') return
        if (event.data.type === 'td:close') return backToChat()
        // the canvas is up and draws its own back button: the pill retires
        if (event.data.type === 'td:ready') { canvasReady = true; backBtn.hidden = true; return syncChrome() }
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
          // 0.2 opens it through the workspace UI; before that the ISessions
          // contract did (open(id) since 0.1.2, select(id) in 0.1.1)
          try {
            const ui = workspaceUi()
            if (ui) ui.openSession(event.data.session)
            else (ctx.sessions.open ?? ctx.sessions.select).call(ctx.sessions, event.data.session)
          } catch (error) {
            console.warn('[dsh-dotline] could not open session', event.data.session, error)
          }
          if (event.data.close !== false) backToChat()
          syncCurrent()
        }
      })
    }

    return module.exports
  },
})
