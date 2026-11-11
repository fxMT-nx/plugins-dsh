/**
 * @local/dsh-mcp-console — Client half.
 *
 * A lazy CommonJS factory: running this file only registers the factory. Every
 * side effect (styles, slot registrations, the Remote mount, the debug seam)
 * happens inside `apply` and is owned by its `ctx.effect`.
 *
 * Two root-scoped slot registrations, both declaration-aware:
 *   - `sidebar.footer.action` → the trigger button (props `{ wide }`).
 *   - `shell.overlay`         → the panel surface (props `{}`; the overlay layer is
 *                               `position:absolute; inset:0; z-index:20`, so the panel
 *                               places itself against the viewport).
 *
 * Evidence from the extracted build (`recon/asar/...`):
 *   - `dsh-client-ui-sidebar/lib/client.js:643-646`   slot `sidebar.footer.action` = list/root
 *   - `dsh-client-ui-sidebar/lib/client.js:515`       `renderSlot("sidebar.footer.action", { wide })`
 *   - `dsh-client-ui-layout/lib/client.js:643-646`    slot `shell.overlay` = list/root
 *   - `dsh-client-ui-layout/lib/client.js:313`        `renderSlot("shell.overlay", {})`
 *   - `dsh-client-ui-cordis/lib/client.js:1411`       first-party consumer of the footer seat
 *   - `dsh-client-ui-renderer/lib/client.js:155-161`  a `hooks.<name>` source → `use<Name>(selector)`
 *   - `dsh-client-locale/lib/client.js:1387-1413`     `ctx.locale.register(ns, { en, es })`
 *   - `dsh-api-gateway/lib/client.browser.js:1669-1717` `ctx.remote.$mount(contribution)` + the
 *     caller-context effect that owns it
 *   - `dsh-api-gateway/lib/client.browser.js:2101-2108` every parameter codec must be `strict`
 *   - `dsh-typert-registry/lib/client.browser.js` `validateInvocation` / `validateCodec` rules
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mcp-console',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useEffect, useId, useMemo, useRef, useState } = React
    const useSyncExternalStore = React.useSyncExternalStore

    // ═════════════════════════════════════════════════════════════════════════
    // 0. Switches, slots and constants
    // ═════════════════════════════════════════════════════════════════════════

    /** Locale namespace owned by this plugin. */
    const NS = 'mcp-console'
    /** Package id; equals the module id registered above. */
    const MODULE_ID = '@local/dsh-mcp-console'
    /** Primary seat: the statistics row under the composer. */
    const DOCK_SLOT = 'conversation.composer.dock'
    /** Plan B seat: the sidebar foot. Off by default; see `SHOW_IN_SIDEBAR_FOOTER`. */
    const TRIGGER_SLOT = 'sidebar.footer.action'
    const OVERLAY_SLOT = 'shell.overlay'
    /**
     * Also register the sidebar-foot button.
     *
     * One line to undo: set it to `true` and the footer seat comes back beside the
     * composer pill. It cannot be a Host `Config` field: the browser half is
     * created with `{ name: id }` only (`dsh-client-modules/lib/client.js:483-491`),
     * so no row config ever reaches `apply` here; a real config field would have
     * to be published by the Host half over the Remote and read before
     * registering, which is a bigger change than this switch warrants.
     */
    const SHOW_IN_SIDEBAR_FOOTER = false
    const PANEL_ID = 'mcp-console-panel'
    const STYLE_ID = `${MODULE_ID}/client.css`
    /** Host service namespace (see `docs/contrato-mcp-console.md` §4). */
    const REMOTE_NAMESPACE = 'mcpConsole'
    /** Injection key of the namespace service; dotted keys are ordinary here. */
    const SERVICE_KEY = `remote.${REMOTE_NAMESPACE}`
    /**
     * How long a read waits for the namespace to activate after a mount.
     *
     * `ctx.remote.<ns>` is only readable once the namespace's own fiber is ACTIVE,
     * so the moment right after `$mount` is legitimately empty; the wait covers
     * that gap and is bounded so a missing namespace still fails fast.
     */
    const NAMESPACE_WAIT_MS = 2000
    /**
     * Print the channel diagnostics in the error box.
     *
     * Off for delivery: the frames above are instrumentation for a channel that
     * refuses to appear, and they are not something a user should read. Flip to
     * `true` to get apply/remote/mount/namespace readings back on screen.
     */
    const SHOW_DIAGNOSTICS = false
    const NAMESPACE_POLL_MS = 75
    /** How often the pill's count re-reads the Host while the page is visible. */
    const LIVE_COUNT_REFRESH_MS = 20000
    /**
     * Sample data while no host channel exists.
     *
     * Off by default now that the channel is proven: a panel that cannot reach
     * the Host must say so, never invent servers. Turn it on from the page
     * console to review the panel's states without a Host half:
     * `__DSH_MCP_CONSOLE__.useSampleServers(true)`. Even when on, a real channel
     * always wins.
     */
    const USE_FAKE = false
    const LIST_TIMEOUT_MS = 20000
    const RELOAD_TIMEOUT_MS = 45000
    /** Minimum gap between two mount attempts, so a boot-time failure warns once. */
    const REMOUNT_THROTTLE_MS = 1500
    const ERROR_TEXT_LIMIT = 400
    /** Every `state` the contract allows; anything else reads as `unknown`. */
    const SERVER_STATES = ['active', 'loading', 'failed', 'disabled', 'pending', 'unloading', 'unknown']

    // ═════════════════════════════════════════════════════════════════════════
    // 1. ADAPTER — the only code that talks to the Host.
    // ═════════════════════════════════════════════════════════════════════════
    //
    // Channel, decided by the Host half: a Typert Remote whose contribution this
    // client half mounts itself (the namespace does not exist until then).
    //
    // Wire names are the Host's: `servers` / `restart` / `restartAll` / `health`,
    // renamed from the contract's `list`/`reload`/`reloadAll`/`ping` so this
    // contribution cannot collide with an older client half that still mounts the
    // retired names into the same `mcpConsole` namespace (the gateway rejects a
    // *method* already mounted, `api-gateway/lib/client.browser.js:1726`). The
    // addressed data is unchanged.
    //
    //     ctx.remote.mcpConsole.servers()      → { ok: true, value: McpServerView[] }
    //     ctx.remote.mcpConsole.restart(id)    → { ok: true, value: ReloadResult }
    //     ctx.remote.mcpConsole.restartAll()   → { ok: true, value: ReloadAllResult }
    //     ctx.remote.mcpConsole.health()       → { ok: true, value: { ok, ts, hostPid, service } }
    //     …or { ok: false, error: RemoteError } for a *channel* failure.
    // Business failures (`unknown-id`, `timeout`) travel inside `value` as a
    // `ReloadResult` with `ok: false`, so both layers are unwrapped here and the
    // rest of the file only ever sees normalised contract objects.

    /** Build an Error carrying a stable machine-readable `code`. */
    function consoleError(code, detail) {
      const error = new Error(detail || code)
      error.code = code
      return error
    }

    /** Race a promise against a deadline so the panel can never spin forever. */
    function withTimeout(promise, ms, code) {
      if (!(ms > 0)) return promise
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(consoleError(code, `timed out after ${ms} ms`)), ms)
        promise.then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }

    /** Clamp a message for display: one line, no control characters, bounded. */
    function clampText(value, limit) {
      if (typeof value !== 'string') return ''
      const flat = value.replace(/\s+/g, ' ').trim()
      if (flat.length <= limit) return flat
      return `${flat.slice(0, limit - 1)}…`
    }

    /** Turn any thrown value into `{ code, message }`, safe to render. */
    function describeError(error) {
      if (!error) return { code: 'error', message: 'unknown error' }
      const code = typeof error.code === 'string' && error.code ? error.code : error.name || 'error'
      const message = error instanceof Error ? error.message : String(error)
      return { code, message: clampText(message, ERROR_TEXT_LIMIT) || code }
    }

    /**
     * `RemoteResult` envelope test.
     *
     * `{ ok: true, value }` always carries `value`; `{ ok: false, error }` never
     * carries `id`/`results`, which is how a business `ReloadResult` that also
     * has an `ok` field is told apart from a channel failure.
     */
    function isRemoteEnvelope(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      if (typeof value.ok !== 'boolean') return false
      if ('value' in value) return true
      if ('id' in value || 'results' in value) return false
      return value.ok === false && 'error' in value
    }

    /** Unwrap one channel answer into its payload, or throw a coded channel error. */
    function unwrapRemote(answer, endpoint) {
      if (!isRemoteEnvelope(answer)) return answer
      if (answer.ok === true) return answer.value
      const failure = answer.error
      const code = failure && typeof failure.code === 'string' ? failure.code : 'channel-failed'
      const message = failure && typeof failure.message === 'string' ? failure.message : String(failure)
      throw consoleError(code, `${endpoint} failed: ${message}`)
    }

    /** One `McpServerView`, defensively normalised (the UI never trusts shapes). */
    function normalizeServer(raw, index) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const serverName = typeof source.serverName === 'string' && source.serverName.trim()
        ? source.serverName.trim()
        : String(source.id || `server-${index}`).replace(/^mcp-/, '')
      const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : `mcp-${serverName}`
      const transport = source.transport === 'stdio' || source.transport === 'streamable-http'
        ? source.transport
        : 'unknown'
      const toolCountRaw = Number(source.toolCount)
      return {
        id,
        serverName,
        transport,
        target: typeof source.target === 'string' ? source.target.trim() : '',
        state: SERVER_STATES.indexOf(source.state) === -1 ? 'unknown' : source.state,
        toolCount: Number.isFinite(toolCountRaw) && toolCountRaw > 0 ? Math.trunc(toolCountRaw) : 0,
        lastError: typeof source.lastError === 'string' && source.lastError.trim()
          ? clampText(source.lastError, ERROR_TEXT_LIMIT)
          : null,
        lastReloadAt: typeof source.lastReloadAt === 'string' ? source.lastReloadAt : null,
      }
    }

    /**
     * Stable ascending order by `serverName` (contract §4 rule 4).
     *
     * The Host already sorts with `localeCompare`, so the same comparator is used
     * here: re-sorting a correctly ordered list must never change it.
     */
    function compareServers(left, right) {
      const byName = left.serverName.localeCompare(right.serverName)
      if (byName !== 0) return byName
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    }

    /** Normalise `servers()`'s payload into a sorted, de-duplicated list. */
    function normalizeList(raw) {
      const rows = Array.isArray(raw) ? raw : raw && Array.isArray(raw.servers) ? raw.servers : []
      const seen = Object.create(null)
      const servers = []
      for (let index = 0; index < rows.length; index += 1) {
        const server = normalizeServer(rows[index], index)
        if (seen[server.id]) continue
        seen[server.id] = true
        servers.push(server)
      }
      servers.sort(compareServers)
      return servers
    }

    /** Normalise one `ReloadResult`. */
    function normalizeReload(raw, id, fallbackName) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const toolCountRaw = Number(source.toolCount)
      const durationRaw = Number(source.durationMs)
      const result = {
        ok: source.ok === true,
        id: typeof source.id === 'string' && source.id ? source.id : id,
        serverName: typeof source.serverName === 'string' && source.serverName
          ? source.serverName
          : fallbackName || id,
        durationMs: Number.isFinite(durationRaw) && durationRaw > 0 ? Math.trunc(durationRaw) : 0,
        toolCount: Number.isFinite(toolCountRaw) && toolCountRaw > 0 ? Math.trunc(toolCountRaw) : 0,
        at: Date.now(),
      }
      if (!result.ok) {
        result.error = clampText(typeof source.error === 'string' ? source.error : 'error', ERROR_TEXT_LIMIT) || 'error'
      }
      return result
    }

    /** Normalise `restartAll()`'s payload, keeping any per-server detail it carries. */
    function normalizeReloadAll(raw, ids, nameOf) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const results = []
      for (const entry of Array.isArray(source.results) ? source.results : []) {
        const id = entry && typeof entry.id === 'string' ? entry.id : ''
        results.push(normalizeReload(entry, id, nameOf(id)))
      }
      if (!results.length) {
        for (const id of ids) {
          const result = {
            ok: source.ok === true,
            id,
            serverName: nameOf(id),
            durationMs: 0,
            toolCount: 0,
            at: Date.now(),
          }
          if (!result.ok) result.error = 'unknown'
          results.push(result)
        }
      }
      const okCount = results.filter((result) => result.ok).length
      return { ok: results.length > 0 && okCount === results.length, total: results.length, okCount, results }
    }

    /** Sample rows used only while no host channel answers (see `USE_FAKE`). */
    function sampleServers() {
      const row = (serverName, transport, state, toolCount, extra) => Object.assign({
        id: `mcp-${serverName}`,
        serverName,
        transport,
        target: transport === 'stdio' ? `${serverName}-cli.exe` : `http://127.0.0.1:0/${serverName}/mcp`,
        state,
        toolCount,
        lastError: null,
        lastReloadAt: null,
      }, extra)
      return [
        row('browseros-neo', 'stdio', 'active', 9),
        row('cadcraft', 'stdio', 'active', 8),
        row('deckcraft', 'stdio', 'active', 17),
        row('effectcraft', 'stdio', 'active', 31),
        row('figcraft', 'stdio', 'active', 13),
        row('filmcraft', 'stdio', 'loading', 0),
        row('gridcraft', 'stdio', 'active', 0),
        row('materialcraft', 'stdio', 'active', 12),
        row('pdfcraft', 'stdio', 'active', 7, { lastError: 'connection closed by the server while listing tools' }),
        row('photocraft', 'streamable-http', 'failed', 0, { lastError: 'HTTP 503 from the streamable endpoint after 3 attempts' }),
        row('solidcraft', 'stdio', 'active', 22),
        row('soundcraft', 'stdio', 'active', 14),
        row('texturecraft', 'stdio', 'active', 9),
        row('vectorcraft', 'stdio', 'active', 18),
        row('wordcraft', 'stdio', 'disabled', 0),
        row('workspace-files', 'stdio', 'active', 4),
      ]
    }

    /** A stand-in channel over an in-memory list, shaped like the wire. */
    function createFakeChannel(rows) {
      const servers = rows.map((entry) => ({ ...entry }))
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const find = (id) => servers.find((entry) => entry.id === id)
      const channel = {
        async health() {
          return { ok: true, value: { ok: true, ts: Date.now(), sample: true } }
        },
        async servers() {
          await wait(220)
          return { ok: true, value: servers.map((entry) => ({ ...entry })) }
        },
        async restart(id) {
          await wait(900)
          const server = find(id)
          if (!server) {
            return { ok: false, id, serverName: id, durationMs: 900, toolCount: 0, error: 'unknown-id' }
          }
          if (server.state === 'failed') {
            return {
              ok: false,
              id: server.id,
              serverName: server.serverName,
              durationMs: 900,
              toolCount: server.toolCount,
              error: 'still failing: the sample endpoint never answers',
            }
          }
          server.state = 'active'
          server.lastError = null
          if (server.toolCount === 0) server.toolCount = 6
          return {
            ok: true,
            id: server.id,
            serverName: server.serverName,
            durationMs: 900,
            toolCount: server.toolCount,
          }
        },
        async restartAll() {
          const results = []
          for (const server of servers) results.push(await channel.restart(server.id))
          const okCount = results.filter((result) => result.ok).length
          return { ok: true, value: { ok: okCount === results.length, total: results.length, okCount, results } }
        },
      }
      return channel
    }

    /**
     * The Typert Remote contribution this client half mounts.
     *
     * Data only, on purpose: `@deepseek-ai/dsh-typert-protocol` is not in the
     * shell's module table, so nothing here may import it. `zod` *is* in the
     * table, and only `restart(id)` needs a codec: every declared parameter must
     * be `mode: 'strict'` with a `create()` factory, or `$mount` throws
     * (`api-gateway/lib/client.browser.js:2101-2108`). Direct calls never invoke
     * `create()`: values go to the wire unparsed
     * (`api-gateway/lib/client.browser.js:1859-1873`).
     *
     * The wire names (`servers` / `restart` / `restartAll` / `health`) are the
     * Host half's, renamed from the contract's `list`/`reload`/`reloadAll`/`ping`
     * so they cannot collide with a stale client half still mounting the old
     * names into the same `mcpConsole` namespace. The namespace itself is
     * unchanged, and so is everything the UI consumes.
     */
    function buildContribution() {
      const zod = require('zod')
      const method = (name, description, parameters) => ({
        id: `${MODULE_ID}#${REMOTE_NAMESPACE}/${name}`,
        service: REMOTE_NAMESPACE,
        namespace: REMOTE_NAMESPACE,
        method: name,
        description,
        invocation: { kind: 'direct' },
        parameters,
        result: { mode: 'src-json' },
      })
      return {
        package: MODULE_ID,
        descriptors: [
          method(
            'servers',
            'Every MCP client row of the active profile with its transport, state and tool count.',
            [],
          ),
          method(
            'restart',
            'Cycle one MCP server row and answer with the re-counted tool count.',
            [{
              name: 'id',
              wire: 'id',
              source: 'json',
              codec: {
                mode: 'strict',
                typeSymbol: `${MODULE_ID}/types#ServerId`,
                create: () => zod.string(),
              },
            }],
          ),
          method(
            'restartAll',
            'Cycle every MCP server row serially and answer with one result per server.',
            [],
          ),
          method('health', 'Answer with the host service time so the client can prove the channel.', []),
        ],
      }
    }

    /**
     * Evidence for the panel's error box (temporary, clearly labelled).
     *
     * The app ships without DevTools, so the panel is the only window we have. Every
     * step that could fail is recorded here as a plain string, and the error state
     * prints the lot. Nothing here influences behaviour.
     */
    const diagnostics = {
      applyAt: 0,
      remoteTypeof: 'not read',
      remoteKeys: [],
      probe: 'not read',
      mountAttempts: 0,
      mountState: 'not attempted',
      mountError: null,
      namespaceAfterMount: 'not read',
      namespaceAfterWait: 'not read',
      getReading: 'not read',
      propertyReading: 'not read',
      namespaceVia: 'not read',
      getError: null,
      injectSupported: false,
      injected: false,
      waitMs: NAMESPACE_WAIT_MS,
      reads: 0,
      lastChannel: null,
    }

    /** `typeof` plus a compact value for a slot in the diagnostics. */
    function describeValue(value) {
      if (value === undefined) return 'undefined'
      if (value === null) return 'null'
      const kind = typeof value
      if (kind === 'object' || kind === 'function') return kind
      return `${kind} ${String(value)}`
    }

    /** Non-function own keys of the remote service, bounded. */
    function remoteKeysOf(remotes) {
      try {
        const keys = []
        for (const key of Object.keys(remotes || {})) {
          let kind
          try {
            kind = typeof remotes[key]
          } catch (error) {
            kind = 'threw'
          }
          if (kind !== 'function') keys.push(key)
          if (keys.length >= 8) break
        }
        return keys
      } catch (error) {
        return []
      }
    }

    /** How a few known namespaces read right now: the shape of the whole channel. */
    function probeNamespaces(remotes) {
      const names = [REMOTE_NAMESPACE, 'pluginManager', 'pluginInventory']
      const parts = []
      for (const name of names) {
        let reading
        try {
          reading = describeValue(remotes ? remotes[name] : undefined)
        } catch (error) {
          reading = `threw ${error && error.message ? error.message : String(error)}`
        }
        parts.push(`${name}=${reading}`)
      }
      return parts.join(' ')
    }

    function timeOf(timestamp) {
      try {
        return new Date(timestamp).toLocaleTimeString()
      } catch (error) {
        return String(timestamp)
      }
    }

    /**
     * The Host-facing API — the only place the wire is touched.
     *
     * Resolution order per call, so a real channel always wins over samples:
     *   1. the mounted Remote namespace `ctx.get('remote').mcpConsole`;
     *   2. `USE_FAKE` sample rows, clearly labelled in the panel;
     *   3. otherwise a `channel-unavailable` error the panel renders with a retry.
     */
    function createApi() {
      const state = {
        ctx: null,
        fixture: null,
        fixtureChannel: null,
        mountPromise: null,
        mountError: null,
        injectError: null,
        injectedService: null,
        namespaceReady: null,
        injectRegistered: false,
        namespaceReadyHandler: null,
        lastMountAttemptAt: 0,
        lastServers: [],
      }

      function readRemotes() {
        try {
          const ctx = state.ctx
          if (!ctx || typeof ctx.get !== 'function') return null
          const remotes = ctx.get('remote')
          return remotes && typeof remotes === 'object' ? remotes : null
        } catch (error) {
          console.warn('[mcp-console] the remote service is unavailable:', error)
          return null
        }
      }

      /**
       * The mounted namespace object, whatever it exports.
       *
       * `ctx.remote.<ns>` only reads once the namespace's own fiber is ACTIVE
       * (`cordis/src/reflect.ts:233-243`: `get()` returns nothing while the
       * providing fiber is not `ACTIVE`), and `$mount` creates that fiber with
       * `ownerCtx.plugin({ name: 'remote.' + ns, apply })`
       * (`api-gateway/lib/client.browser.js:1755-1800`). So the namespace may be
       * absent for a moment after a successful mount, and a plain read right after
       * `await $mount` is not proof of anything.
       */
      function namespaceNow() {
        const ctx = state.ctx
        let viaGet
        if (ctx && typeof ctx.get === 'function') {
          try {
            viaGet = ctx.get(SERVICE_KEY) || undefined
          } catch (error) {
            diagnostics.getError = `${error && error.name ? error.name : 'Error'}: ${error && error.message ? error.message : String(error)}`
            viaGet = undefined
          }
        }
        let viaProperty
        const remotes = readRemotes()
        if (remotes) {
          try {
            viaProperty = remotes[REMOTE_NAMESPACE] || undefined
          } catch (error) {
            viaProperty = undefined
          }
        }
        diagnostics.getReading = describeValue(viaGet)
        diagnostics.propertyReading = describeValue(viaProperty)
        if (viaGet) {
          diagnostics.namespaceVia = 'ctx.get'
          return viaGet
        }
        if (viaProperty) {
          diagnostics.namespaceVia = 'ctx.remote[ns]'
          return viaProperty
        }
        diagnostics.namespaceVia = 'absent'
        return undefined
      }

      /**
       * The mounted namespace, if it also exports the wire this UI speaks.
       *
       * `servers` is the probe: a namespace carrying only the retired
       * `list`/`ping` (a stale client half still mounted into `mcpConsole`) must
       * NOT count as a channel, because it answers nothing we can use. Only
       * `servers` is required, so a Host half that ships reading before
       * restarting still shows real rows and answers `restart-unavailable` per row.
       */
      function serviceOf() {
        const live = namespaceNow()
        if (live && typeof live.servers === 'function') return live
        const injected = state.injectedService
        if (injected && typeof injected.servers === 'function') return injected
        return null
      }

      /**
       * Wait for the namespace service to activate; bounded by `timeoutMs`.
       *
       * Two mechanisms, and the poll is the one that decides:
       *   - `ctx.inject(['remote.mcpConsole'], cb)` is the framework-native wait: the
       *     fiber stays PENDING until the service is provided and ACTIVE, and the
       *     wake-up is event-driven (`cordis/src/registry.ts:296-301`;
       *     `cordis/src/reflect.ts:323,333`; prescribed in
       *     `skills/cordis-plugin-development/references/practices.md:20`). It is
       *     registered once, by `awaitNamespace`, and it only *short-circuits* the
       *     wait — resolving a fiber promise without the dependency must not be read
       *     as "the namespace is absent".
       *   - a short poll of `ctx.remote.<ns>` covers a context without `inject`, and
       *     guarantees the wait ends even when the service never appears.
       */
      function pollNamespace(timeoutMs) {
        return new Promise((resolve) => {
          let poll = null
          const timer = setTimeout(() => {
            if (poll) clearInterval(poll)
            resolve(namespaceNow())
          }, timeoutMs)
          poll = setInterval(() => {
            const found = namespaceNow()
            if (!found) return
            clearInterval(poll)
            clearTimeout(timer)
            resolve(found)
          }, NAMESPACE_POLL_MS)
        })
      }

      function waitForNamespace(timeoutMs) {
        const present = namespaceNow()
        if (present) return Promise.resolve(present)
        const polled = pollNamespace(timeoutMs)
        const injected = state.namespaceReady || Promise.resolve(undefined)
        return Promise.race([polled, injected])
          .then((found) => found || namespaceNow(), () => namespaceNow())
      }

      /**
       * Mount the contribution; the promise never rejects (the error is kept).
       *
       * Called once from `apply`, and again from `resolveChannel` only after a
       * failed attempt, so the panel's Retry can recover from a mount that lost a
       * race — e.g. a stale client half still holding a method of this namespace.
       * The failed attempt disposes its own registration
       * (`api-gateway/lib/client.browser.js:1706-1712`), so a retry is legal.
       */
      function mount() {
        state.lastMountAttemptAt = Date.now()
        diagnostics.mountAttempts += 1
        diagnostics.mountState = 'attempting'
        diagnostics.remoteKeys = remoteKeysOf(readRemotes())
        diagnostics.probe = probeNamespaces(readRemotes())
        const remotes = readRemotes()
        if (!remotes || typeof remotes.$mount !== 'function') {
          state.mountError = describeError(consoleError('channel-unavailable', 'the remote service cannot mount a contribution'))
          diagnostics.mountState = 'no $mount'
          diagnostics.mountError = `no $mount: remote is ${describeValue(remotes)}`
          state.mountPromise = Promise.resolve()
          return state.mountPromise
        }
        let pending
        try {
          pending = Promise.resolve(remotes.$mount(buildContribution()))
        } catch (error) {
          state.mountError = describeError(error)
          diagnostics.mountState = 'threw'
          diagnostics.mountError = `${error && error.name ? error.name : 'Error'}: ${error && error.message ? error.message : String(error)}`
          pending = Promise.resolve()
        }
        state.mountPromise = pending.then(
          () => {
            state.mountError = null
            diagnostics.mountState = 'resolved'
            diagnostics.mountError = null
          },
          (error) => {
            state.mountError = describeError(error)
            diagnostics.mountState = 'rejected'
            diagnostics.mountError = `${error && error.name ? error.name : 'Error'}: ${error && error.message ? error.message : String(error)}`
            console.warn('[mcp-console] the Remote contribution did not mount:', error)
          },
        )
        return state.mountPromise
      }

      function sampleService() {
        if (!state.fixture) return null
        if (!state.fixtureChannel) state.fixtureChannel = createFakeChannel(state.fixture)
        return state.fixtureChannel
      }

      async function resolveChannel() {
        diagnostics.reads += 1
        if (!state.injectRegistered) {
          // Retry re-runs the injection step, not just the read: an earlier attempt
          // may have failed before `ctx.inject` was even registered.
          api.awaitNamespace(state.namespaceReadyHandler)
        }
        if (state.mountPromise) {
          await state.mountPromise
          if (diagnostics.namespaceAfterMount === 'not read') {
            diagnostics.namespaceAfterMount = describeValue(namespaceNow())
          }
        }
        let service = serviceOf()
        if (!service) {
          const remountDue = state.mountError !== null
            && Date.now() - state.lastMountAttemptAt > REMOUNT_THROTTLE_MS
          if (remountDue) {
            // A mount failure is usually transient (a stale client half releasing
            // the namespace), so an explicit read retries it instead of leaving
            // the panel dead until a page reload. The throttle keeps activation
            // quiet: the boot read right after `apply` does not repeat the same
            // warning.
            state.mountPromise = null
            await mount()
            service = serviceOf()
          }
          if (!service && state.mountError === null) {
            // The mount succeeded, so the namespace is on its way; it becomes
            // readable only once its own fiber is ACTIVE.
            const arrived = await waitForNamespace(NAMESPACE_WAIT_MS)
            diagnostics.namespaceAfterWait = describeValue(namespaceNow())
            if (arrived) {
              if (typeof arrived.servers === 'function') service = arrived
              else {
                throw consoleError(
                  'channel-methods-missing',
                  'the mcpConsole namespace is mounted but exports no servers(); '
                  + 'the Host half may still be running the retired names (list/reload/reloadAll/ping)',
                )
              }
            }
          }
        }
        if (service) {
          diagnostics.lastChannel = 'remote'
          return { kind: 'remote', service }
        }
        const sample = sampleService()
        if (sample) {
          diagnostics.lastChannel = 'fake'
          return { kind: 'fake', service: sample }
        }
        diagnostics.lastChannel = 'unavailable'
        const mountNote = state.mountError
          ? `mount failed: ${state.mountError.message}`
          : `the contribution mounted but no ${REMOTE_NAMESPACE} namespace appeared within ${String(NAMESPACE_WAIT_MS)} ms`
        throw consoleError('channel-unavailable', `no mcpConsole channel (${mountNote})`)
      }

      function nameOf(id) {
        const found = state.lastServers.find((server) => server.id === id)
        return found ? found.serverName : id
      }

      const api = {
        /** Called once from `apply`, before anything else. */
        bind(ctx) {
          state.ctx = ctx
          let remotes
          try {
            remotes = typeof ctx.get === 'function' ? ctx.get('remote') : undefined
          } catch (error) {
            remotes = undefined
          }
          diagnostics.remoteTypeof = describeValue(remotes)
          diagnostics.remoteKeys = remoteKeysOf(remotes)
          diagnostics.probe = probeNamespaces(remotes)
          diagnostics.injectSupported = typeof ctx.inject === 'function'
        },
        /** Mount the Remote contribution; `apply` calls this synchronously. */
        mount,
        /**
         * Bind to the namespace the canonical way: `ctx.inject(['remote.<ns>'], …)`.
         *
         * The callback runs when the service is provided and ACTIVE — not before —
         * and again if its provider is replaced (`cordis/src/registry.ts:296-301`,
         * `cordis/src/fiber.ts:611-639`). `onReady` therefore fires exactly when a
         * read would start working, which is what lets the panel recover on its own
         * instead of sitting in an error state until someone presses Retry.
         */
        awaitNamespace(onReady) {
          const ctx = state.ctx
          if (!ctx || typeof ctx.inject !== 'function') {
            diagnostics.injectSupported = false
            return false
          }
          diagnostics.injectSupported = true
          if (state.injectRegistered) {
            if (typeof onReady === 'function') state.namespaceReadyHandler = onReady
            return true
          }
          let settle = null
          state.namespaceReady = new Promise((resolve) => {
            settle = resolve
          })
          try {
            state.injectRegistered = true
            ctx.inject([SERVICE_KEY], (scope) => {
              let service = null
              try {
                service = typeof scope.get === 'function' ? scope.get(SERVICE_KEY) : null
              } catch (error) {
                service = null
              }
              if (!service) service = namespaceNow()
              state.injectedService = service || null
              if (service && settle) settle(service)
              if (service && typeof onReady === 'function') {
                try {
                  onReady(service)
                } catch (error) {
                  console.error('[mcp-console] namespace-ready handler crashed:', error)
                }
              }
            })
            return true
          } catch (error) {
            state.injectError = describeError(error)
            diagnostics.injectSupported = false
            console.warn('[mcp-console] ctx.inject could not wait for the namespace:', error)
            return false
          }
        },
        /** The diagnostic lines the error box prints. Read-only snapshot of `diagnostics`. */
        diagnostics() {
          if (!SHOW_DIAGNOSTICS) return []
          const injectedNow = !!state.injectedService
          diagnostics.injected = injectedNow
          const lines = [
            `apply reached: ${diagnostics.applyAt ? 'yes ' + timeOf(diagnostics.applyAt) : 'no'}`,
            `remote: ${diagnostics.remoteTypeof}`,
            `remoteKeys: ${diagnostics.remoteKeys.length ? diagnostics.remoteKeys.join(', ') : '(none)'}`,
            `mountAttempts: ${diagnostics.mountAttempts} (${diagnostics.mountState})`,
            `mountError: ${state.mountError ? state.mountError.code + ': ' + state.mountError.message : diagnostics.mountError || '(none)'}`,
            `namespace after mount: ${diagnostics.namespaceAfterMount}`,
            `namespace after wait (${diagnostics.waitMs} ms): ${diagnostics.namespaceAfterWait}`,
            `get(${SERVICE_KEY}): ${diagnostics.getReading}${diagnostics.getError ? ' (' + diagnostics.getError + ')' : ''}`,
            `remote.mcpConsole: ${diagnostics.propertyReading}`,
            `namespace via: ${diagnostics.namespaceVia}`,
            `probe: ${diagnostics.probe}`,
            `inject wait: ${diagnostics.injectSupported ? 'supported' : 'unavailable'}, injected=${injectedNow}`,
            `reads: ${diagnostics.reads}${diagnostics.lastChannel ? ', last=' + diagnostics.lastChannel : ''}`,
          ]
          return lines.map((line) => clampText(line, 200))
        },
        /** Enable or disable the labelled sample list (see `USE_FAKE`). */
        useSampleServers(enabled) {
          state.fixture = enabled === false ? null : sampleServers()
          state.fixtureChannel = null
          return api
        },
        /**
         * Synchronous channel description, for diagnostics and the error box.
         *
         * `mountError` is the mount failure itself, `namespaceWaiting` says the
         * namespace object is not readable yet, and `injectError` records a wait
         * that could not even be set up — together they replace the DevTools panel
         * this app does not give us.
         */
        describe() {
          const namespace = namespaceNow()
          const service = serviceOf()
          return {
            mode: service ? 'remote' : state.fixture ? 'fake' : 'none',
            namespace: REMOTE_NAMESPACE,
            mounted: namespace !== undefined,
            hasServers: !!namespace && typeof namespace.servers === 'function',
            injected: !!state.injectedService,
            namespaceWaiting: namespace === undefined && state.mountError === null,
            mountError: state.mountError,
            injectError: state.injectError,
          }
        },
        /** `health()` — optional probe; a wire without it is not a failure. */
        async health() {
          const channel = await resolveChannel()
          if (typeof channel.service.health !== 'function') {
            return { ok: true, kind: channel.kind, ts: Date.now() }
          }
          const answer = await withTimeout(Promise.resolve(channel.service.health()), LIST_TIMEOUT_MS, 'timeout')
          return { ok: true, kind: channel.kind, ts: Date.now(), answer: unwrapRemote(answer, 'mcpConsole/health') }
        },
        /** `servers()` → `{ servers, source }` with normalised, sorted rows. */
        async servers() {
          const channel = await resolveChannel()
          const answer = await withTimeout(Promise.resolve(channel.service.servers()), LIST_TIMEOUT_MS, 'timeout')
          const payload = unwrapRemote(answer, 'mcpConsole/servers')
          const servers = normalizeList(payload)
          state.lastServers = servers
          return { servers, source: channel.kind }
        },
        /**
         * `restart(id)` → `ReloadResult`; an unknown id, a transport fault or a
         * host half without restarting yet answers `ok: false`, so one server can
         * never break the list.
         */
        async restart(id, serverName) {
          const key = String(id)
          try {
            const channel = await resolveChannel()
            if (typeof channel.service.restart !== 'function') {
              throw consoleError('restart-unavailable', 'this host half does not expose restart(id) yet')
            }
            const answer = await withTimeout(
              Promise.resolve(channel.service.restart(key)),
              RELOAD_TIMEOUT_MS,
              'timeout',
            )
            return normalizeReload(unwrapRemote(answer, 'mcpConsole/restart'), key, serverName || nameOf(key))
          } catch (error) {
            const info = describeError(error)
            return {
              ok: false,
              id: key,
              serverName: serverName || nameOf(key),
              durationMs: 0,
              toolCount: 0,
              at: Date.now(),
              error: info.message,
            }
          }
        },
        /**
         * `restartAll(ids, onProgress)` → `ReloadAllResult`.
         *
         * Per-server `restart` is preferred so the header can show honest `n/total`
         * progress and each row shows its own outcome as it lands; the Host's
         * batch form is the fallback for a channel that only publishes it. Both
         * paths are serial: sixteen subprocesses must never start at once.
         */
        async restartAll(ids, onProgress) {
          const channel = await resolveChannel()
          if (typeof channel.service.restart === 'function' && ids.length > 0) {
            const results = []
            for (let index = 0; index < ids.length; index += 1) {
              const result = await api.restart(ids[index], nameOf(ids[index]))
              results.push(result)
              if (typeof onProgress === 'function') {
                onProgress({ done: index + 1, total: ids.length, result })
              }
            }
            const okCount = results.filter((result) => result.ok).length
            return { ok: okCount === results.length, total: results.length, okCount, results }
          }
          if (typeof channel.service.restart !== 'function' && typeof channel.service.restartAll !== 'function') {
            throw consoleError('restart-unavailable', 'this host half does not expose restarting yet')
          }
          const answer = await withTimeout(
            Promise.resolve(typeof channel.service.restartAll === 'function' ? channel.service.restartAll() : []),
            RELOAD_TIMEOUT_MS * Math.max(1, ids.length),
            'timeout',
          )
          const summary = normalizeReloadAll(unwrapRemote(answer, 'mcpConsole/restartAll'), ids, nameOf)
          if (typeof onProgress === 'function') onProgress({ done: summary.total, total: summary.total, result: null })
          return summary
        },
      }

      return api
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 2. MODEL — the state both registrations share
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * A tiny observable store; the button and the overlay read the same snapshot,
     * which is how they stay in sync without involving the Host. Its shape is the
     * one the renderer's `use<Name>` seat expects
     * (`dsh-client-ui-renderer/lib/client.js:155-161`); here it is consumed
     * directly through `React.useSyncExternalStore`.
     */
    function createModel(api) {
      let snapshot = {
        open: false,
        phase: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
        servers: [],
        source: 'none', // 'remote' | 'fake' | 'none'
        error: null,
        updatedAt: 0,
        refreshing: false,
        reloading: [],
        bulk: null,
        results: {},
        announce: null,
      }
      const listeners = new Set()
      /** Every mounted trigger element (composer pill, optional sidebar foot). */
      const triggerElements = new Set()
      /** The trigger that opened the panel: the anchor and the focus-return target. */
      let lastTrigger = null
      /**
       * The trigger's box measured at the moment it was clicked.
       *
       * Measured once, synchronously, in the click handler: some views (Trajectory)
       * re-render the composer right after the click, so a later measurement can
       * find a detached node and leave the panel without a position.
       */
      let openRect = null
      let listInFlight = null

      function resolveTrigger() {
        if (lastTrigger && lastTrigger.isConnected) return lastTrigger
        for (const element of triggerElements) {
          if (element && element.isConnected) return element
        }
        return null
      }

      function publish(patch) {
        snapshot = Object.freeze({ ...snapshot, ...patch })
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[mcp-console] store listener crashed:', error)
          }
        }
      }

      function announce(key, params) {
        publish({ announce: { key, params: params || {} } })
      }

      function nameOf(id) {
        const found = snapshot.servers.find((server) => server.id === id)
        return found ? found.serverName : id
      }

      async function refresh(options) {
        const silent = options && options.silent === true
        if (listInFlight) return listInFlight
        // A previous error stays on screen while its retry runs, so the retry
        // never blanks the panel; only a successful read clears it.
        publish({
          refreshing: true,
          phase: snapshot.servers.length > 0 || silent ? snapshot.phase : 'loading',
        })
        listInFlight = (async () => {
          try {
            const answer = await api.servers()
            publish({
              servers: answer.servers,
              source: answer.source,
              phase: 'ready',
              error: null,
              refreshing: false,
              updatedAt: Date.now(),
            })
          } catch (error) {
            // Rows read from the real host stay on screen behind a retryable
            // banner; rows that came from somewhere else (samples) are dropped,
            // because they are not this profile's servers and must never look
            // like current data.
            const keepRows = snapshot.servers.length > 0 && snapshot.source === 'remote'
            publish({
              phase: keepRows ? 'ready' : 'error',
              servers: keepRows ? snapshot.servers : [],
              source: keepRows ? 'remote' : 'none',
              error: describeError(error),
              refreshing: false,
            })
          } finally {
            listInFlight = null
          }
        })()
        return listInFlight
      }

      async function reloadOne(id) {
        if (snapshot.reloading.indexOf(id) !== -1 || snapshot.bulk) return
        const pending = { ...snapshot.results }
        delete pending[id]
        publish({ reloading: [...snapshot.reloading, id], results: pending })
        const result = await api.restart(id, nameOf(id))
        publish({
          reloading: snapshot.reloading.filter((entry) => entry !== id),
          results: { ...snapshot.results, [result.id]: result },
        })
        if (result.ok) {
          announce(result.toolCount === 1 ? 'result.okOne' : 'result.ok', {
            server: result.serverName,
            count: result.toolCount,
          })
        } else {
          announce('result.failed', { server: result.serverName, message: result.error })
        }
        await refresh({ silent: true })
      }

      async function reloadAll() {
        if (snapshot.bulk) return
        const ids = snapshot.servers.map((server) => server.id)
        if (!ids.length) return
        publish({ bulk: { done: 0, total: ids.length }, results: {}, reloading: [] })
        let summary
        try {
          summary = await api.restartAll(ids, (progress) => {
            const patch = { bulk: { done: progress.done, total: progress.total } }
            if (progress.result) patch.results = { ...snapshot.results, [progress.result.id]: progress.result }
            publish(patch)
          })
        } catch (error) {
          const info = describeError(error)
          publish({ bulk: null, reloading: [] })
          announce('result.failed', { server: '', message: info.message })
          return
        }
        if (summary.okCount === summary.total) {
          announce(summary.total === 1 ? 'result.allOkOne' : 'result.allOk', { count: summary.total })
        } else if (summary.okCount === 0) {
          announce('result.allFailed', {})
        } else {
          announce('result.allPartial', { ok: summary.okCount, total: summary.total })
        }
        const merged = { ...snapshot.results }
        for (const result of summary.results) merged[result.id] = result
        publish({ bulk: null, results: merged, reloading: [] })
        await refresh({ silent: true })
      }

      const model = {
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        getSnapshot() {
          return snapshot
        },
        /**
         * Register a trigger element.
         *
         * There can be two seats (the composer pill and, when enabled, the sidebar
         * foot). `open(el)` records *which* one was used, so the panel anchors to
         * that pill and focus goes back to it; the set is only the fallback for a
         * panel opened from elsewhere (the debug seam).
         */
        registerTrigger(element) {
          if (element) triggerElements.add(element)
        },
        unregisterTrigger(element) {
          if (element) triggerElements.delete(element)
          if (lastTrigger === element) lastTrigger = null
        },
        triggerRect() {
          const element = resolveTrigger()
          if (!element) return null
          try {
            const rect = element.getBoundingClientRect()
            if (!rect || rect.width <= 0 || rect.height <= 0) return null
            return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }
          } catch (error) {
            return null
          }
        },
        /** The rect to anchor the panel to: the click-time snapshot wins. */
        anchorRect() {
          if (openRect) return openRect
          return model.triggerRect()
        },
        isOpen() {
          return snapshot.open
        },
        isBusy() {
          return snapshot.bulk !== null || snapshot.reloading.length > 0 || snapshot.refreshing
        },
        focusTrigger() {
          const element = resolveTrigger()
          if (!element) return
          try {
            element.focus({ preventScroll: true })
          } catch (error) {
            /* a detached or hidden trigger simply keeps focus where it is */
          }
        },
        open(fromElement) {
          if (fromElement) {
            lastTrigger = fromElement
            try {
              const rect = fromElement.getBoundingClientRect()
              openRect = rect && rect.width > 0 && rect.height > 0
                ? { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }
                : null
            } catch (error) {
              openRect = null
            }
          }
          const wasOpen = snapshot.open
          publish({ open: true, results: {} })
          refresh({ silent: wasOpen || snapshot.phase !== 'idle' })
        },
        close(options) {
          if (!snapshot.open) return
          openRect = null
          publish({ open: false })
          if (!options || options.restoreFocus !== false) model.focusTrigger()
        },
        toggle(fromElement) {
          if (snapshot.open) model.close()
          else model.open(fromElement)
        },
        refresh,
        reloadOne,
        reloadAll,
        /** Diagnostic lines for the error box (temporary instrumentation). */
        diagnostics() {
          return api.diagnostics()
        },
        /** Read once at activation so the triggers can show how many servers there are. */
        prime() {
          refresh({ silent: true })
        },
      }

      return model
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 3. STYLES — theme tokens only, prefixed classes, installed from `apply`
    // ═════════════════════════════════════════════════════════════════════════
    //
    // Type sizes, row patterns and control metrics are copied from the host's
    // management list (`dsh-client-ui-plugin-manager` `.V7pFBG_card*`,
    // `.iconButton`, `.reason`) and from the first-party footer-action popover
    // (`dsh-client-ui-cordis` `.Fu0XRq_layer|badge|panel`), with renamed classes
    // and `--dsw-alias-*` colour tokens only.

    const CSS = [
      /* ══ Composer pill (primary seat) ═══════════════════════════════════════
         Metrics copied from the host statistics pill in the same row
         (`dsh-client-ui-chat` StatsPills.module.css, `.anchor|.pill|.label`):
         the row keeps its own type scale and rhythm. */
      '.mcpc_pillAnchor{min-width:0;display:inline-flex;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.mcpc_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      '.mcpc_pill svg{flex:none;width:14px;height:14px}',
      '.mcpc_pill:hover,.mcpc_pill[data-active]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.mcpc_pill:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.mcpc_pillLabel{min-width:0;text-overflow:ellipsis;overflow:hidden}',
      '@media (max-width:640px){.mcpc_pillLabel{display:none}}',

      /* ══ Sidebar-foot seat (behind SHOW_IN_SIDEBAR_FOOTER) ═════════════════ */
      '.mcpc_layer{flex:none;align-items:center;width:100%;height:42px;margin:8px 0 0;display:flex;position:relative}',
      '.mcpc_footerButtons{align-items:center;width:100%;display:flex}',
      '.mcpc_trigger{width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}',
      '.mcpc_trigger:hover,.mcpc_trigger[data-active]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mcpc_trigger:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.mcpc_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.mcpc_triggerCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}',
      '.mcpc_layer.mcpc_rail{width:36px;height:36px;margin:0}',
      '.mcpc_rail .mcpc_trigger{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}',
      '.mcpc_rail .mcpc_footerButtons{flex-direction:column;gap:2px}',

      /* ══ Panel surface ═════════════════════════════════════════════════════
         Solid raised surface, hairline border, panel radius and the shell's
         panel elevation (same trio first-party popovers use: ui-conversation
         TodoPanel `.DXuOLW_root`, ui-plugin-manager `.V7pFBG_registry`). */
      '.mcpc_panel{position:fixed;z-index:30;display:flex;flex-direction:column;width:420px;max-width:calc(100vw - 24px);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-panel);overflow:hidden;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.mcpc_panel:focus{outline:none}',
      '.mcpc_panel:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:2px}',

      /* ══ Header: title 14/22 + count 12/18 + ghost control ═════════════════
         Type scale and separator from ui-theme AppearanceRow `.Iwzhua_group`
         (14/22 regular, 22px title, `.5px` divider) and the permission-row
         pattern below. */
      '.mcpc_header{box-sizing:border-box;flex:none;align-items:center;gap:8px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex}',
      '.mcpc_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px;white-space:nowrap}',
      '.mcpc_count{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.mcpc_headerActions{margin-left:auto;align-items:center;gap:8px;display:inline-flex;flex:none}',
      '.mcpc_ghost{border:0;border-radius:var(--dsw-radius-md);background:0 0;height:32px;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:14px;font-weight:400;line-height:22px;white-space:nowrap;align-items:center;gap:6px;padding:0 10px;display:inline-flex}',
      '.mcpc_ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.mcpc_ghost:disabled{cursor:default;opacity:.5}',
      '.mcpc_ghost:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.mcpc_progress{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;font-variant-numeric:tabular-nums}',

      /* ══ Body and rows ═════════════════════════════════════════════════════
         Dense list, not cards: every row is `.5px`-separated with 12px vertical
         padding and no frame of its own — the shape of a settings row in this
         app (`dsh-client-ui-permission-presets` PermissionRow.module.css:
         `.row{border-bottom:.5px solid var(--dsw-alias-border-l2);gap:8px;
         padding:16px 0}` with `.title` 14/22 regular and `.desc` 12/18
         tertiary; vertical padding tuned down to 12px for a management list). */
      '.mcpc_body{flex:1;min-height:0;padding:0 16px;overflow-y:auto}',
      '.mcpc_rows{flex-direction:column;margin:0;padding:0;list-style:none;display:flex}',
      '.mcpc_row{align-items:center;gap:8px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex}',
      '.mcpc_row:last-child{border-bottom:0}',
      '.mcpc_rowText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}',
      '.mcpc_titleLine{align-items:center;gap:6px;min-width:0;display:flex}',
      '.mcpc_name{min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.mcpc_desc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;overflow-wrap:anywhere;display:block}',
      '.mcpc_desc[data-tone=error]{color:var(--dsw-alias-state-error-primary)}',
      '.mcpc_state{font-size:inherit;line-height:inherit;white-space:nowrap}',
      '.mcpc_state[data-tone=warn]{color:var(--dsw-alias-state-warn-label)}',
      '.mcpc_state[data-tone=error]{color:var(--dsw-alias-state-error-primary)}',
      '.mcpc_state[data-tone=muted]{color:var(--dsw-alias-label-caption)}',
      '.mcpc_row[data-mcp-disabled] .mcpc_name,.mcpc_row[data-mcp-disabled] .mcpc_desc{color:var(--dsw-alias-label-tertiary)}',

      /* 24px control that only gains a surface on hover/focus — the icon-button
         shape of this app (`dsh-client-ui-plugin-manager` `.V7pFBG_iconButton`,
         `dsh-client-ui-cordis` `.Fu0XRq_actionButton`). */
      '.mcpc_iconButton{width:24px;height:24px;border:0;border-radius:var(--dsw-radius-xs);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}',
      '.mcpc_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.mcpc_iconButton:disabled{cursor:default;opacity:.4}',
      '.mcpc_iconButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}',

      /* ══ Notes, empty and error states (no frames; text + dot only) ════════ */
      '.mcpc_note{margin:8px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
      '.mcpc_empty{flex-direction:column;gap:4px;padding:24px 0;display:flex}',
      '.mcpc_emptyTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.mcpc_emptyHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
      '.mcpc_error{flex-direction:column;gap:4px;padding:16px 0;display:flex}',
      '.mcpc_errorTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.mcpc_errorMessage{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;overflow-wrap:anywhere}',
      '.mcpc_errorCode{margin:0;color:var(--dsw-alias-label-caption);font-family:var(--dsh-font-mono,monospace);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.mcpc_diagnostics{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:2px;margin-top:8px;padding-top:8px;display:flex}',
      '.mcpc_diagnosticsTitle{margin:0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}',
      '.mcpc_diagnosticLine{margin:0;color:var(--dsw-alias-label-tertiary);font-family:var(--dsh-font-mono,monospace);font-size:11px;line-height:16px;overflow-wrap:anywhere}',
      '.mcpc_retry{align-self:flex-start;align-items:center;display:inline-flex;margin-top:4px;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;font-weight:400;line-height:22px;cursor:pointer}',
      '.mcpc_retry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.mcpc_retry:disabled{cursor:default;opacity:.5}',
      '.mcpc_retry:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}',

      /* ══ Skeleton (first read): row-shaped placeholders, no card ═══════════ */
      '.mcpc_skeletonRow{align-items:center;gap:8px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex}',
      '.mcpc_skeletonBar{background:var(--dsw-alias-bg-skeleton);border-radius:var(--dsw-radius-xs);height:12px;width:100%;animation:mcpc-pulse 2s cubic-bezier(.36,0,.64,1) infinite}',
      '.mcpc_skeletonBar.mcpc_short{width:48%}',

      /* ══ Footer: tertiary meta line ════════════════════════════════════════ */
      '.mcpc_footer{align-items:center;gap:8px;padding:8px 16px;border-top:.5px solid var(--dsw-alias-border-l2);display:flex}',
      '.mcpc_footerText{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.mcpc_statusLine{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;line-height:18px;overflow-wrap:anywhere}',

      /* ══ Status dot (6 px) and spinner ═════════════════════════════════════ */
      '.mcpc_dot{flex:none;border-radius:50%;width:6px;height:6px;background:currentColor;display:inline-block}',
      '.mcpc_dot[data-state=done]{color:color-mix(in srgb, var(--dsw-alias-state-success-secondary) 65%, var(--dsw-alias-label-tertiary))}',
      '.mcpc_dot[data-state=warning]{color:var(--dsw-alias-state-warn-primary)}',
      '.mcpc_dot[data-state=error]{color:var(--dsw-alias-state-error-primary)}',
      '.mcpc_dot[data-state=idle]{color:var(--dsw-alias-state-idle-primary)}',
      '.mcpc_spinner{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.mcpc_spinnerMotion{transform-origin:center;animation:mcpc-spin 1.5s linear infinite}',
      '.mcpc_spinnerTrack,.mcpc_spinnerArc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}',
      '.mcpc_spinnerTrack{opacity:.25}',
      '.mcpc_spinnerArc{stroke-dasharray:12 150;animation:mcpc-dash 1.5s ease-in-out infinite}',
      '@keyframes mcpc-spin{to{transform:rotate(360deg)}}',
      '@keyframes mcpc-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}to{stroke-dasharray:12 150;stroke-dashoffset:0}}',
      '@keyframes mcpc-pulse{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.mcpc_spinnerMotion,.mcpc_spinnerArc,.mcpc_skeletonBar{animation:none}}',
    ].join('')

    /** Installed from `apply`, removed by its cleanup; same guard the host uses. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
      if (existing) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = MODULE_ID
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 4. PRESENTATION
    // ═════════════════════════════════════════════════════════════════════════

    const CX = {
      /* composer pill */
      pillAnchor: 'mcpc_pillAnchor',
      pill: 'mcpc_pill',
      pillLabel: 'mcpc_pillLabel',
      /* sidebar foot */
      layer: 'mcpc_layer',
      rail: 'mcpc_rail',
      footerButtons: 'mcpc_footerButtons',
      trigger: 'mcpc_trigger',
      triggerLabel: 'mcpc_triggerLabel',
      triggerCount: 'mcpc_triggerCount',
      /* panel */
      panel: 'mcpc_panel',
      header: 'mcpc_header',
      title: 'mcpc_title',
      count: 'mcpc_count',
      headerActions: 'mcpc_headerActions',
      ghost: 'mcpc_ghost',
      progress: 'mcpc_progress',
      body: 'mcpc_body',
      rows: 'mcpc_rows',
      row: 'mcpc_row',
      rowText: 'mcpc_rowText',
      titleLine: 'mcpc_titleLine',
      name: 'mcpc_name',
      desc: 'mcpc_desc',
      state: 'mcpc_state',
      iconButton: 'mcpc_iconButton',
      /* states */
      note: 'mcpc_note',
      empty: 'mcpc_empty',
      emptyTitle: 'mcpc_emptyTitle',
      emptyHint: 'mcpc_emptyHint',
      error: 'mcpc_error',
      errorTitle: 'mcpc_errorTitle',
      errorMessage: 'mcpc_errorMessage',
      errorCode: 'mcpc_errorCode',
      diagnostics: 'mcpc_diagnostics',
      diagnosticsTitle: 'mcpc_diagnosticsTitle',
      diagnosticLine: 'mcpc_diagnosticLine',
      retry: 'mcpc_retry',
      skeletonRow: 'mcpc_skeletonRow',
      skeletonBar: 'mcpc_skeletonBar',
      short: 'mcpc_short',
      footer: 'mcpc_footer',
      footerText: 'mcpc_footerText',
      statusLine: 'mcpc_statusLine',
      dot: 'mcpc_dot',
      spinner: 'mcpc_spinner',
      spinnerMotion: 'mcpc_spinnerMotion',
      spinnerTrack: 'mcpc_spinnerTrack',
      spinnerArc: 'mcpc_spinnerArc',
    }

    /** Own artwork: two server units, monochrome so it inherits the row colour. */
    function IconServers({ size }) {
      const dimension = size || 16
      return h('svg', {
        viewBox: '0 0 24 24',
        width: dimension,
        height: dimension,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('rect', { x: 2.6, y: 3.4, width: 18.8, height: 7.2, rx: 2.4 }),
        h('circle', { cx: 6.6, cy: 7, r: 1.05, fill: 'currentColor', stroke: 'none' }),
        h('rect', { x: 2.6, y: 13.4, width: 18.8, height: 7.2, rx: 2.4 }),
        h('circle', { cx: 6.6, cy: 17, r: 1.05, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function IconRefresh({ size }) {
      const dimension = size || 14
      return h('svg', {
        viewBox: '0 0 24 24',
        width: dimension,
        height: dimension,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
        h('path', { d: 'M20 4v4.5h-4.5' }),
      )
    }

    /**
     * The status marker: a 6 px dot, and a 12 px spinner while a row is working.
     *
     * A small coloured dot beside plain text is how this app reports state — never
     * a coloured frame (see the row pattern in `dsh-client-ui-permission-presets`).
     */
    function StateDot({ state, size }) {
      if (state === 'ongoing') {
        const dimension = size || 12
        return h('svg', {
          className: CX.spinner,
          'data-state': 'ongoing',
          width: dimension,
          height: dimension,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          focusable: 'false',
        },
          h('g', { className: CX.spinnerMotion },
            h('circle', { className: CX.spinnerTrack, cx: 12, cy: 12, r: 9.5 }),
            h('circle', { className: CX.spinnerArc, cx: 12, cy: 12, r: 9.5 }),
          ),
        )
      }
      const dimension = size || 6
      return h('span', {
        className: CX.dot,
        'data-state': state,
        style: { width: dimension, height: dimension },
        'aria-hidden': 'true',
      })
    }

    /** `state` + `toolCount` → marker state; 0 tools on an active row is degraded, not failed. */
    function markerFor(server, busy) {
      if (busy) return 'ongoing'
      if (server.state === 'failed') return 'error'
      if (server.state === 'active') return server.toolCount > 0 ? 'done' : 'warning'
      if (server.state === 'loading' || server.state === 'pending' || server.state === 'unloading') return 'ongoing'
      return 'idle'
    }

    /**
     * Tone of the status word in the description line: colour carries the warning,
     * never a border. `active` stays neutral; only the degraded case tints.
     */
    function toneFor(server, busy) {
      if (busy) return 'muted'
      if (server.state === 'failed') return 'error'
      if (server.state === 'active') return server.toolCount > 0 ? undefined : 'warn'
      if (server.state === 'unknown' || server.state === 'disabled') return 'muted'
      return undefined
    }

    function statusKeyFor(server, busy) {
      if (busy) return 'state.reloading'
      if (server.state === 'active') return server.toolCount > 0 ? 'state.active' : 'state.degraded'
      return `state.${server.state}`
    }

    function transportKeyFor(transport) {
      if (transport === 'stdio') return 'transport.stdio'
      if (transport === 'streamable-http') return 'transport.streamable-http'
      return 'transport.unknown'
    }

    function toolsLabel(t, count) {
      return t(count === 1 ? 'row.toolsOne' : 'row.tools', { count })
    }

    /** The description line: transport, target and catalogue size, `·`-joined. */
    function describeRow(t, server) {
      const parts = [t(transportKeyFor(server.transport))]
      if (server.target) parts.push(server.target)
      parts.push(toolsLabel(t, server.toolCount))
      return parts.join(' · ')
    }

    function formatTime(timestamp) {
      if (!timestamp) return ''
      try {
        return new Date(timestamp).toLocaleTimeString()
      } catch (error) {
        return ''
      }
    }

    // ── components ───────────────────────────────────────────────────────────

    /**
     * `conversation.composer.dock` occupant — the primary seat, in the statistics
     * row under the composer, left of the `activity` pill (`1 turns 76 steps ·
     * 135 tok/s`). Metrics copied from the host statistics pill so the row keeps
     * its rhythm (`dsh-client-ui-chat` StatsPills.module.css).
     */
    function ComposerPill({ t, model }) {
      const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
      const buttonRef = useRef(null)

      useEffect(() => {
        model.registerTrigger(buttonRef.current)
        const element = buttonRef.current
        return () => model.unregisterTrigger(element)
      }, [model])

      const count = state.phase === 'ready' ? state.servers.length : null
      const compact = count === null ? t('trigger.label') : t('trigger.compact', { count })
      const ariaLabel = count === null ? t('trigger.label') : t('trigger.labelCount', { count })
      const buttonProps = {
        type: 'button',
        ref: buttonRef,
        className: CX.pill,
        title: ariaLabel,
        'aria-label': ariaLabel,
        'aria-haspopup': 'dialog',
        'aria-expanded': state.open,
        'aria-busy': state.refreshing || undefined,
        'data-active': state.open || undefined,
        'data-mcp-console-trigger': true,
        onClick: () => model.toggle(buttonRef.current),
      }
      if (state.open) buttonProps['aria-controls'] = PANEL_ID

      return h('span', { className: CX.pillAnchor, 'data-mcp-composer-stat': true },
        h('button', buttonProps,
          h(IconServers, { size: 14 }),
          h('span', { className: CX.pillLabel }, compact),
        ),
      )
    }

    /** `sidebar.footer.action` occupant (behind `SHOW_IN_SIDEBAR_FOOTER`). */
    function TriggerButton({ wide, t, model }) {
      const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
      const buttonRef = useRef(null)

      useEffect(() => {
        model.registerTrigger(buttonRef.current)
        const element = buttonRef.current
        return () => model.unregisterTrigger(element)
      }, [model])

      const count = state.servers.length > 0 ? state.servers.length : null
      const buttonProps = {
        type: 'button',
        ref: buttonRef,
        className: CX.trigger,
        'aria-label': t('trigger.label'),
        'aria-haspopup': 'dialog',
        'aria-expanded': state.open,
        'data-active': state.open || undefined,
        'aria-busy': state.refreshing || undefined,
        onClick: () => model.toggle(buttonRef.current),
      }
      if (state.open) buttonProps['aria-controls'] = PANEL_ID

      return h('div', {
        className: wide ? CX.layer : `${CX.layer} ${CX.rail}`,
        'data-mcp-console-trigger': true,
      },
        h('div', { className: CX.footerButtons },
          h('button', buttonProps,
            h(IconServers, { size: wide ? 16 : 18 }),
            wide ? h('span', { className: CX.triggerLabel }, t('trigger.label')) : null,
            wide && count !== null ? h('span', { className: CX.triggerCount }, String(count)) : null,
          ),
        ),
      )
    }

    function SkeletonBody({ t }) {
      const rows = []
      for (let index = 0; index < 3; index += 1) {
        rows.push(h('li', { key: `skeleton-${index}`, className: CX.skeletonRow, 'aria-hidden': 'true' },
          h('div', { className: CX.skeletonBar }),
          h('div', { className: `${CX.skeletonBar} ${CX.short}` }),
        ))
      }
      return h('div', null,
        h('p', { className: CX.note }, t('panel.loading')),
        h('ul', { className: CX.rows }, rows),
      )
    }

    function ChannelError({ error, t, onRetry, busy, diagnostics }) {
      const lines = Array.isArray(diagnostics) ? diagnostics : []
      return h('div', { className: CX.error },
        h('p', { className: CX.errorTitle }, t('panel.errorTitle')),
        h('p', { className: CX.errorMessage }, error && error.message ? error.message : t('panel.errorHint')),
        error && error.code ? h('p', { className: CX.errorCode }, t('panel.errorCode', { code: error.code })) : null,
        h('button', { type: 'button', className: CX.retry, onClick: onRetry, disabled: busy }, t('panel.retry')),
        lines.length > 0
          ? h('div', { className: CX.diagnostics, 'data-mcp-diagnostics': true },
            h('p', { className: CX.diagnosticsTitle }, t('panel.diagnostics')),
            lines.map((line, index) => h('p', {
              key: `diagnostic-${index}`,
              className: CX.diagnosticLine,
              'data-mcp-diagnostic': index,
            }, line)),
          )
          : null,
      )
    }

    /**
     * One server, drawn as a settings row: hairline separator, 14/22 title with a
     * 6 px dot, 12/18 tertiary description, and a 24 px control that only gains a
     * surface on hover — the pattern of `dsh-client-ui-permission-presets`
     * (PermissionRow.module.css) rather than a stack of cards.
     */
    function ServerRow({ server, t, model, busy, locked, result }) {
      const marker = markerFor(server, busy)
      const tone = toneFor(server, busy)
      const degraded = !busy && server.state === 'active' && server.toolCount === 0
      const failed = !busy && server.state === 'failed'
      const reloadLabel = t('row.reload', { server: server.serverName })
      return h('li', {
        className: CX.row,
        'data-mcp-row': server.id,
        'data-mcp-status': busy ? 'ongoing' : server.state,
        'data-mcp-degraded': degraded || undefined,
        'data-mcp-failed': failed || undefined,
        'data-mcp-disabled': server.state === 'disabled' || undefined,
        'aria-busy': busy || undefined,
      },
        h('div', { className: CX.rowText },
          h('span', { className: CX.titleLine },
            h(StateDot, { state: marker }),
            h('span', { className: CX.name, title: server.serverName }, server.serverName),
          ),
          h('span', { className: CX.desc, title: server.target || undefined },
            describeRow(t, server),
            ' · ',
            h('span', { className: CX.state, 'data-tone': tone }, t(statusKeyFor(server, busy))),
          ),
          server.lastError
            ? h('span', {
              className: CX.desc,
              'data-tone': 'error',
              'data-mcp-last-error': true,
              title: server.lastError,
            }, server.lastError)
            : null,
          result && result.ok
            ? h('span', { className: CX.desc, 'data-mcp-result': 'ok' }, t(result.toolCount === 1 ? 'result.rowOkOne' : 'result.rowOk', {
              count: result.toolCount,
              duration: result.durationMs,
            }))
            : null,
          result && !result.ok
            ? h('span', {
              className: CX.desc,
              'data-tone': 'error',
              'data-mcp-reload-error': true,
              title: result.error,
            }, t('result.rowFailed', { message: result.error }))
            : null,
        ),
        h('button', {
          type: 'button',
          className: CX.iconButton,
          'aria-label': reloadLabel,
          title: reloadLabel,
          disabled: busy || locked,
          onClick: () => model.reloadOne(server.id),
        }, busy ? h(StateDot, { state: 'ongoing', size: 12 }) : h(IconRefresh, { size: 14 })),
      )
    }

    /**
     * `shell.overlay` occupant: the panel.
     *
     * Anchored to the rect captured when it was opened, so a trigger that the host
     * re-renders or replaces a moment after the click (the Trajectory view does
     * exactly that) cannot leave the panel without a position.
     */
    function ConsolePanel({ t, model }) {
      const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
      const panelRef = useRef(null)
      const [viewportTick, setViewportTick] = useState(0)
      const headingId = useId()

      const anchor = useMemo(() => {
        if (!state.open) return null
        if (typeof window === 'undefined') return { left: 12, bottom: 96 }
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const panelWidth = Math.min(420, viewportWidth - 24)
        const left = (rect) => Math.max(12, Math.min(rect.left, viewportWidth - panelWidth - 12))
        const cap = (space) => Math.max(180, Math.min(viewportHeight * 0.7, 640, space))
        const rect = model.anchorRect()
        if (!rect) {
          // Nothing to anchor to: centre it, so an open panel is never off-screen.
          const height = Math.min(viewportHeight * 0.7, 640, 480)
          return {
            left: Math.max(12, (viewportWidth - panelWidth) / 2),
            bottom: Math.max(12, (viewportHeight - height) / 2),
            maxHeight: height,
          }
        }
        const spaceAbove = rect.top - 12
        const spaceBelow = viewportHeight - rect.bottom - 12
        if (spaceAbove < 180 && spaceBelow > spaceAbove) {
          const top = rect.bottom + 8
          // A rect that is itself off-screen (a composer rendered outside the
          // viewport, as some views lay it out) must not drag the panel with it.
          if (top >= 12 && top <= viewportHeight - 120) {
            return { left: left(rect), top, maxHeight: cap(spaceBelow) }
          }
        } else {
          const bottom = Math.max(12, viewportHeight - rect.top + 8)
          if (bottom <= viewportHeight - 120) {
            return { left: left(rect), bottom, maxHeight: cap(spaceAbove) }
          }
        }
        // Off-screen trigger: centre the panel instead of following it out.
        const centredHeight = Math.min(viewportHeight * 0.7, 640, 480)
        return {
          left: Math.max(12, (viewportWidth - panelWidth) / 2),
          bottom: Math.max(12, (viewportHeight - centredHeight) / 2),
          maxHeight: centredHeight,
        }
        // viewportTick re-places the panel on resize; state.open on open/close.
      }, [state.open, model, viewportTick])

      useEffect(() => {
        if (!state.open) return undefined
        const onResize = () => setViewportTick((value) => value + 1)
        const onPointerDown = (event) => {
          const panel = panelRef.current
          const target = event.target
          if (panel && target instanceof Node && panel.contains(target)) return
          if (target instanceof Element && typeof target.closest === 'function'
            && target.closest('[data-mcp-console-trigger]')) return
          model.close({ restoreFocus: false })
        }
        window.addEventListener('resize', onResize)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          window.removeEventListener('resize', onResize)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [state.open, model])

      useEffect(() => {
        if (!state.open) {
          model.focusTrigger()
          return undefined
        }
        const panel = panelRef.current
        if (panel) {
          try {
            panel.focus({ preventScroll: true })
          } catch (error) {
            /* focus is an enhancement; the panel still renders */
          }
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            model.close()
            return
          }
          if (event.key !== 'Tab' || !panelRef.current) return
          const focusables = panelRef.current.querySelectorAll(
            'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
          )
          if (focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [state.open, model])

      if (!state.open || anchor === null) return null

      const bulk = state.bulk
      const count = state.servers.length
      const anyReload = bulk !== null || state.reloading.length > 0
      const announceText = state.announce ? t(state.announce.key, state.announce.params) : ''
      const updatedText = state.updatedAt
        ? t('panel.updatedAt', { time: formatTime(state.updatedAt) })
        : t('panel.neverUpdated')
      const showError = state.error !== null
      const showSkeleton = !showError && count === 0 && (state.phase === 'loading' || state.phase === 'idle')
      const showEmpty = !showError && count === 0 && state.phase === 'ready'
      const channelNote = state.source === 'fake' ? t('panel.demoHint') : null

      return h('section', {
        id: PANEL_ID,
        ref: panelRef,
        className: CX.panel,
        style: anchor,
        role: 'dialog',
        'aria-modal': 'false',
        'aria-label': t('panel.dialogLabel'),
        'aria-labelledby': headingId,
        tabIndex: -1,
        'data-mcp-panel': true,
      },
        h('header', { className: CX.header },
          h('span', { className: CX.title, id: headingId }, t('panel.title')),
          h('span', { className: CX.count }, count === 1 ? t('panel.countOne') : t('panel.count', { count })),
          h('div', { className: CX.headerActions },
            bulk ? h('span', { className: CX.progress }, t('panel.progress', { done: bulk.done, total: bulk.total })) : null,
            h('button', {
              type: 'button',
              className: CX.ghost,
              onClick: () => model.reloadAll(),
              disabled: count === 0 || anyReload,
              'aria-label': t('panel.reloadAllAria'),
            },
              anyReload ? h(StateDot, { state: 'ongoing', size: 12 }) : h(IconRefresh, { size: 14 }),
              h('span', null, t('panel.reloadAll')),
            ),
          ),
        ),
        h('div', { className: CX.body },
          channelNote ? h('p', { className: CX.note, 'data-mcp-sample': true }, channelNote) : null,
          showError
            ? h(ChannelError, {
              error: state.error,
              t,
              busy: state.refreshing,
              diagnostics: model.diagnostics(),
              onRetry: () => model.refresh({}),
            })
            : null,
          showSkeleton ? h(SkeletonBody, { t }) : null,
          showEmpty
            ? h('div', { className: CX.empty },
              h('p', { className: CX.emptyTitle }, t('panel.emptyTitle')),
              h('p', { className: CX.emptyHint }, t('panel.emptyHint')),
              h('button', { type: 'button', className: CX.retry, onClick: () => model.refresh({}) }, t('panel.retry')),
            )
            : null,
          count > 0
            ? h('ul', { className: CX.rows, 'aria-busy': bulk !== null || undefined },
              state.servers.map((server) => h(ServerRow, {
                key: server.id,
                server,
                t,
                model,
                busy: state.reloading.indexOf(server.id) !== -1,
                locked: bulk !== null,
                result: state.results[server.id] || null,
              })),
            )
            : null,
        ),
        h('footer', { className: CX.footer },
          h('span', { className: CX.footerText }, updatedText),
          h('button', {
            type: 'button',
            className: CX.iconButton,
            onClick: () => model.refresh({}),
            disabled: state.refreshing,
            'aria-label': t('panel.refresh'),
            title: t('panel.refresh'),
          }, state.refreshing ? h(StateDot, { state: 'ongoing', size: 12 }) : h(IconRefresh, { size: 14 })),
          h('div', {
            className: CX.statusLine,
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
          }, announceText),
        ),
      )
    }
    // ═════════════════════════════════════════════════════════════════════════
    // 5. DICTIONARIES
    // ═════════════════════════════════════════════════════════════════════════
    //
    // This build ships `en` and `zh` as UI languages. `es` is registered as well
    // so a Spanish language pack renders translated copy instead of falling back
    // to English. Registering a language pack itself is deliberately not done
    // here: that would add an entry to Settings → General for one plugin.

    const en = {
      'trigger.label': 'MCP servers',
      'trigger.compact': 'MCP {count}',
      'trigger.labelCount': 'MCP servers: {count}',
      'panel.title': 'MCP servers',
      'panel.countOne': '1 MCP',
      'panel.count': '{count} MCPs',
      'panel.demo': 'Sample data',
      'panel.demoHint': 'No host channel yet, so these rows are samples, not the servers loaded in this profile.',
      'panel.reloadAll': 'Reload all',
      'panel.reloadAllAria': 'Reload every MCP server',
      'panel.progress': '{done}/{total}',
      'panel.loading': 'Reading the MCP servers…',
      'panel.emptyTitle': 'No MCP servers configured',
      'panel.emptyHint': 'Servers appear here once this profile has mcp-client rows.',
      'panel.errorTitle': 'No channel to the plugin host',
      'panel.errorHint': 'The host half of this panel is not answering yet.',
      'panel.errorCode': 'code: {code}',
      'panel.diagnostics': 'diagnostics',
      'panel.retry': 'Retry',
      'panel.updatedAt': 'Updated at {time}',
      'panel.neverUpdated': 'Not read yet',
      'panel.refresh': 'Refresh list',
      'panel.dialogLabel': 'MCP servers panel',
      'row.reload': 'Reload {server}',
      'row.toolsOne': '1 tool',
      'row.tools': '{count} tools',
      'transport.stdio': 'stdio',
      'transport.streamable-http': 'HTTP',
      'transport.unknown': 'unknown',
      'state.active': 'Active',
      'state.degraded': 'No catalogue',
      'state.failed': 'Failed',
      'state.loading': 'Starting…',
      'state.pending': 'Pending',
      'state.unloading': 'Stopping…',
      'state.disabled': 'Disabled',
      'state.reloading': 'Reloading…',
      'state.unknown': 'Unknown',
      'result.okOne': '{server} reloaded with 1 tool',
      'result.ok': '{server} reloaded with {count} tools',
      'result.failed': '{server} could not be reloaded: {message}',
      'result.allOkOne': 'Reloaded 1 server',
      'result.allOk': 'Reloaded {count} servers',
      'result.allPartial': '{ok} of {total} servers reloaded',
      'result.allFailed': 'No server could be reloaded',
      'result.rowOkOne': 'Reloaded in {duration} ms with 1 tool',
      'result.rowOk': 'Reloaded in {duration} ms with {count} tools',
      'result.rowFailed': 'Reload failed: {message}',
    }

    const es = {
      'trigger.label': 'Servidores MCP',
      'trigger.compact': 'MCP {count}',
      'trigger.labelCount': 'Servidores MCP: {count}',
      'panel.title': 'Servidores MCP',
      'panel.countOne': '1 MCP',
      'panel.count': '{count} MCP',
      'panel.demo': 'Datos de ejemplo',
      'panel.demoHint': 'Todavía no hay canal con el host: estas filas son ejemplos, no los servidores cargados en este perfil.',
      'panel.reloadAll': 'Recargar todos',
      'panel.reloadAllAria': 'Recargar todos los servidores MCP',
      'panel.progress': '{done}/{total}',
      'panel.loading': 'Leyendo los servidores MCP…',
      'panel.emptyTitle': 'No hay servidores MCP configurados',
      'panel.emptyHint': 'Aquí aparecerán los servidores cuando este perfil tenga filas de mcp-client.',
      'panel.errorTitle': 'Sin canal con el host del plugin',
      'panel.errorHint': 'La mitad host de este panel aún no responde.',
      'panel.errorCode': 'código: {code}',
      'panel.diagnostics': 'diagnóstico',
      'panel.retry': 'Reintentar',
      'panel.updatedAt': 'Actualizado a las {time}',
      'panel.neverUpdated': 'Sin lectura todavía',
      'panel.refresh': 'Actualizar lista',
      'panel.dialogLabel': 'Panel de servidores MCP',
      'row.reload': 'Recargar {server}',
      'row.toolsOne': '1 herramienta',
      'row.tools': '{count} herramientas',
      'transport.stdio': 'stdio',
      'transport.streamable-http': 'HTTP',
      'transport.unknown': 'desconocido',
      'state.active': 'Activo',
      'state.degraded': 'Sin catálogo',
      'state.failed': 'Con error',
      'state.loading': 'Arrancando…',
      'state.pending': 'Pendiente',
      'state.unloading': 'Deteniendo…',
      'state.disabled': 'Desactivado',
      'state.reloading': 'Recargando…',
      'state.unknown': 'Desconocido',
      'result.okOne': '{server} recargado con 1 herramienta',
      'result.ok': '{server} recargado con {count} herramientas',
      'result.failed': 'No se pudo recargar {server}: {message}',
      'result.allOkOne': '1 servidor recargado',
      'result.allOk': '{count} servidores recargados',
      'result.allPartial': '{ok} de {total} servidores recargados',
      'result.allFailed': 'No se pudo recargar ningún servidor',
      'result.rowOkOne': 'Recargado en {duration} ms con 1 herramienta',
      'result.rowOk': 'Recargado en {duration} ms con {count} herramientas',
      'result.rowFailed': 'La recarga falló: {message}',
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 6. PLUGIN BODY
    // ═════════════════════════════════════════════════════════════════════════

    return {
      inject: ['slots', 'remote', 'locale'],
      apply(ctx) {
        // First statement: proves `apply` ran (the fibers waiting on `inject` are
        // the other candidate for "nothing works").
        diagnostics.applyAt = Date.now()
        const api = createApi()
        api.bind(ctx)
        if (USE_FAKE) api.useSampleServers(true)
        // Mounted synchronously so the Remote effect belongs to this fiber; the
        // promise never rejects (a failed mount leaves the panel in its error or
        // sample state instead of breaking the plugin).
        api.mount()

        ctx.effect(() => ctx.locale.register(NS, { en, es }), 'mcp-console: dictionaries')
        ctx.effect(installStyles, 'mcp-console: styles')

        const model = createModel(api)

        // Debug seam: review every panel state from the page console without the
        // Host half. Removed with the plugin, so it never outlives it.
        ctx.effect(() => {
          if (typeof window === 'undefined') return () => {}
          const seam = {
            api,
            model,
            open: () => model.open(),
            close: () => model.close(),
            refresh: () => model.refresh({}),
            reloadAll: () => model.reloadAll(),
            describe: () => api.describe(),
            health: () => api.health(),
            useSampleServers: (enabled) => {
              api.useSampleServers(enabled !== false)
              return model.refresh({})
            },
          }
          window.__DSH_MCP_CONSOLE__ = seam
          return () => {
            if (window.__DSH_MCP_CONSOLE__ === seam) delete window.__DSH_MCP_CONSOLE__
          }
        }, 'mcp-console: debug seam')

        ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({
          name: DOCK_SLOT,
          // A new id adds a control; `activity` (order 0) and `usage` (order 1)
          // keep theirs, so a lower order puts this pill to their left.
          id: 'mcp-console',
          order: -10,
          locale: NS,
          inject: () => ({ model }),
        }, ComposerPill))

        // Plan B, kept behind one switch: the sidebar foot seat.
        if (SHOW_IN_SIDEBAR_FOOTER) {
          ctx.slots.inject(TRIGGER_SLOT, () => ctx.slots.register({
            name: TRIGGER_SLOT,
            id: 'mcp-console',
            order: 20,
            locale: NS,
            inject: () => ({ model }),
          }, TriggerButton))
        }

        ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
          name: OVERLAY_SLOT,
          id: 'mcp-console.panel',
          order: 20,
          locale: NS,
          inject: () => ({ model }),
        }, ConsolePanel))

        // Canonical wait for the namespace the canvas creates: `ctx.inject` keeps a
        // fiber PENDING until `remote.mcpConsole` is provided and ACTIVE, and runs
        // it again if the provider is replaced (`cordis/src/registry.ts:296-301`).
        // The panel therefore recovers the moment the channel exists, without a
        // reload and without anyone pressing Retry.
        api.awaitNamespace(() => {
          model.prime()
        })

        // The pill's count must not go stale when the profile gains or loses an MCP
        // row: the Host owns that list, and no client event reports it. A slow
        // silent read while the page is visible, plus an immediate one when it comes
        // back into view, keeps it honest without touching behaviour.
        ctx.effect(() => {
          const tick = () => {
            if (typeof document !== 'undefined' && document.hidden) return
            if (model.isBusy()) return
            model.refresh({ silent: true })
          }
          const timer = setInterval(tick, LIVE_COUNT_REFRESH_MS)
          const onVisible = () => {
            if (typeof document === 'undefined' || !document.hidden) tick()
          }
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
          if (typeof window !== 'undefined') window.addEventListener('focus', onVisible)
          return () => {
            clearInterval(timer)
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
            if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible)
          }
        }, 'mcp-console: live count')

        model.prime()
      },
    }
  },
})
