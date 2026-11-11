/**
 * Host half of `@local/dsh-mcp-console`.
 *
 * Exposes the `mcpConsole` Cordis service with four wire methods:
 *
 * | wire method   | contract operation | returns            |
 * |---------------|--------------------|--------------------|
 * | `servers()`   | `list`             | `McpServerView[]`  |
 * | `restart(id)` | `reload`           | `ReloadResult`     |
 * | `restartAll()`| `reloadAll`        | `ReloadAllResult`  |
 * | `health()`    | —                  | liveness probe     |
 *
 * The names are deliberately not `list`/`reload`/`ping`: a Client namespace is
 * owned by whoever mounts a contribution first and a second contribution that
 * repeats a method is rejected outright
 * (`recon/asar/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.browser.js:1726`),
 * so distinct method names keep this namespace usable even if another package
 * ever mounts `mcpConsole` too.
 *
 * The Web UI reaches these through the Host's Typert Gateway over the
 * authenticated `/api` carrier, so nothing here opens a port, reads a cookie, or
 * serves a route of its own.
 *
 * Wire channel: Service methods marked with a Typert direct-invocation marker.
 * The Gateway resolves each endpoint through its source-claim fallback, which
 * needs no generated `./typert` artifact: `resolveSrcDescriptor()` derives the
 * endpoint from the live Service and its markers
 * (`dsh-api-gateway/lib/index.js:1224-1301`) and `claimsEndpoint()` accepts it
 * (`:876-883`). The Client half mounts the matching descriptors with
 * `ctx.remote.$mount()`.
 *
 * Nothing here reads or writes configuration: a restart cycles a fiber, it never
 * persists anything.
 */
import { Service } from '@deepseek-ai/cordis'

import { REMOTE_METHOD_DESCRIPTOR, declareRemoteMethods } from './lib/remote-methods.js'

/** Loader module specifier of one MCP server instance. */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Fiber states Cordis reports, mirrored from `dsh-host-plugin-inventory`. */
const FIBER_PHASE = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 5: 'unloading' }

/** Longest error text the wire carries; keeps a stack out of the UI. */
const MAX_ERROR = 400

/** Per-server reload budget when the row's config names none. */
const DEFAULT_RELOAD_TIMEOUT_MS = 30000

/**
 * Reduce a transport config to something safe to display.
 *
 * Never returns `args`, `env`, or `headers`: the first can carry a token and the
 * last two are secrets by definition (contract §4, rule 1).
 *
 * @param config - the row's `config` object.
 * @param transport - the normalized transport name.
 * @returns the executable's basename, or the URL without credentials.
 */
function describeTarget(config, transport) {
  if (transport === 'streamable-http') {
    try {
      const url = new URL(String(config.url))
      return `${url.origin}${url.pathname}`
    } catch {
      return 'unknown'
    }
  }
  if (typeof config.command === 'string' && config.command.length > 0) {
    const parts = config.command.split(/[\\/]/)
    return parts[parts.length - 1] || config.command
  }
  return 'unknown'
}

/**
 * Normalize the configured transport.
 * @param config - the row's `config` object.
 * @returns `stdio`, `streamable-http`, or `unknown`.
 */
function normalizeTransport(config) {
  if (config.transport === 'stdio' || config.transport === 'streamable-http') return config.transport
  // `dsh-mcp-client` defaults to stdio when a command is present.
  if (typeof config.command === 'string') return 'stdio'
  return 'unknown'
}

/**
 * Count visible tool names that carry one server's prefix.
 *
 * `dsh-mcp-client` publishes no status: the honest "connected" signal is its
 * tool catalog. Names are `mcp__<serverName>__<rawName>`
 * (`recon/asar/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js:96-102`).
 *
 * @param names - the visible tool names.
 * @param serverName - the server's `config.serverName`.
 * @returns how many names carry this server's prefix.
 */
function countWithPrefix(names, serverName) {
  const prefix = `mcp__${serverName}__`
  let total = 0
  for (const name of names) if (name.startsWith(prefix)) total += 1
  return total
}

/**
 * The plugin's public service surface.
 *
 * A class plugin is constructed with `(ctx, config)`
 * (`recon/asar/dsh/node_modules/@deepseek-ai/cordis/src/fiber.ts:251-253`), and
 * `Service` registers the instance under its name for the fiber's lifetime
 * (`recon/asar/dsh/node_modules/@deepseek-ai/cordis/src/service.ts:42-59`).
 */
export default class McpConsoleService extends Service {
  /** Needed before any loader read; the Gateway reads it again on every call. */
  static inject = ['loader']

  /**
   * Validate the row's `config`.
   *
   * A plain Standard Schema object: Cordis only calls `['~standard'].validate`
   * (`recon/asar/dsh/node_modules/@deepseek-ai/cordis/src/fiber.ts`, `resolveConfig`),
   * so this package needs no schema library and no build step. Unknown keys are
   * dropped on purpose — a typo in the patch should not travel into the service.
   */
  static Config = {
    '~standard': {
      version: 1,
      vendor: 'dsh-mcp-console',
      /**
       * @param value - the raw `config` object from the Loader row.
       * @returns `{ value }` with the two supported settings, normalized.
       */
      validate(value) {
        const input = value !== null && typeof value === 'object' ? value : {}
        const requested = Number(input.reloadTimeoutMs)
        const onlyServers = Array.isArray(input.onlyServers)
          ? input.onlyServers.filter((entry) => typeof entry === 'string' && entry.length > 0)
          : []
        return {
          value: {
            reloadTimeoutMs: Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_RELOAD_TIMEOUT_MS,
            onlyServers,
          },
        }
      },
    },
  }

  /** Errors this plugin observed itself, by row id; never invented from logs. */
  lastErrors = new Map()

  /** Timestamps of successful reloads, by row id. */
  lastReloads = new Map()

  /**
   * @param ctx - owning fiber context.
   * @param config - the row's `config`, already validated by {@link McpConsoleService.Config}.
   */
  constructor(ctx, config) {
    super(ctx, 'mcpConsole')
    this.config = config ?? { reloadTimeoutMs: DEFAULT_RELOAD_TIMEOUT_MS, onlyServers: [] }
    // The Gateway finds a Remote Service by its `typertRemote` binding and
    // rejects an inconsistent one: readBinding() requires the exact service
    // instance, key, and namespace
    // (`recon/asar/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js:1290-1296`).
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: 'mcpConsole',
      namespace: 'mcpConsole',
    })
  }

  /** @returns liveness of the Host service, with the Host's pid. */
  async health() {
    return { ok: true, ts: new Date().toISOString(), hostPid: process.pid, service: 'mcpConsole' }
  }

  /**
   * Every MCP server row of this profile, sorted by server name.
   *
   * Reads `ctx.loader.entries()` on every call and caches nothing: Cordis's own
   * plugin/status events already maintain `Entry.fiber` and `Fiber.state`
   * (`recon/asar/dsh/node_modules/@deepseek-ai/dsh-host-plugin-inventory/lib/index.js:100-135`).
   *
   * @returns one `McpServerView` per row; an empty list rather than a throw.
   */
  async servers() {
    try {
      // One projection for the whole list: `schemas()` clones every visible
      // definition, so calling it once per row would be quadratic.
      const names = this.toolNames()
      const rows = this.serverRows().map((entry) => {
        const config = entry.options.config ?? {}
        const transport = normalizeTransport(config)
        const id = entry.options.id ?? entry.id
        const serverName = typeof config.serverName === 'string' ? config.serverName : id
        return {
          id,
          serverName,
          transport,
          target: describeTarget(config, transport),
          state: this.stateOf(entry),
          toolCount: countWithPrefix(names, serverName),
          lastError: this.lastErrors.get(id) ?? null,
          lastReloadAt: this.lastReloads.get(id) ?? null,
        }
      })
      rows.sort((left, right) => left.serverName.localeCompare(right.serverName))
      return rows
    } catch {
      // The contract's list operation has no failure branch; an empty list keeps the
      // Host alive and the UI honest about having nothing to show.
      return []
    }
  }

  /**
   * Cycle one MCP server's Loader fiber.
   *
   * `fiber.restart()` is the documented "dispose and immediately reload this
   * plugin with its current config"
   * (`recon/asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1410`; the
   * TypeScript source with its JSDoc is `.../cordis/src/fiber.ts:712-723`). It
   * does not touch the patch file, so nothing is persisted and no other row is
   * affected. A row with no fiber (disabled, or failed before activation) is
   * started with `entry.update({})`.
   *
   * @param id - the row id as the patch declares it, e.g. `mcp-filmcraft`.
   * @returns the contract's `ReloadResult`; never throws.
   */
  async restart(id) {
    const started = Date.now()
    const timeoutMs = this.config.reloadTimeoutMs
    let rowId = typeof id === 'string' ? id : ''
    let serverName = ''
    try {
      const entry = this.findEntry(rowId)
      if (entry === undefined) {
        return { ok: false, id: rowId, serverName: '', durationMs: 0, toolCount: 0, error: 'unknown-id' }
      }
      rowId = entry.options.id ?? entry.id
      serverName = entry.options.config?.serverName ?? rowId
      if (entry.disabled === true) {
        this.lastErrors.set(rowId, 'disabled')
        return { ok: false, id: rowId, serverName, durationMs: 0, toolCount: 0, error: 'disabled' }
      }
      const fiber = entry.fiber
      // `restart()` throws INACTIVE_EFFECT on a disposed fiber
      // (`cordis/src/fiber.ts:351-354`); a row with no fiber is started instead.
      const work = fiber !== undefined && fiber.uid !== null ? fiber.restart() : entry.update({})
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      })
      const outcome = await Promise.race([
        Promise.resolve(work).then(() => 'done', (error) => error),
        timeout,
      ])
      clearTimeout(timer)
      const durationMs = Date.now() - started
      if (outcome === 'timeout') {
        // The cycle keeps running in the background: `restart()` is not
        // cancellable, and the row recovers on its own (docs/spike.md §4.5).
        const error = `timeout after ${timeoutMs} ms`
        this.lastErrors.set(rowId, error)
        return { ok: false, id: rowId, serverName, durationMs, toolCount: this.countTools(serverName), error }
      }
      if (outcome !== 'done') {
        const error = String(outcome && outcome.message ? outcome.message : outcome).slice(0, MAX_ERROR)
        this.lastErrors.set(rowId, error)
        return { ok: false, id: rowId, serverName, durationMs, toolCount: this.countTools(serverName), error }
      }
      const toolCount = this.countTools(serverName)
      this.lastErrors.delete(rowId)
      this.lastReloads.set(rowId, new Date().toISOString())
      return { ok: true, id: rowId, serverName, durationMs, toolCount }
    } catch (error) {
      const message = String(error && error.message ? error.message : error).slice(0, MAX_ERROR)
      if (rowId.length > 0) this.lastErrors.set(rowId, message)
      return { ok: false, id: rowId, serverName, durationMs: Date.now() - started, toolCount: 0, error: message }
    }
  }

  /**
   * Reload every server, one after another.
   *
   * Serial on purpose: sixteen stdio servers starting at once saturates the
   * machine and makes the output unreadable (contract §3.2). One failure never
   * aborts the rest.
   *
   * @returns the contract's `ReloadAllResult` plus the total elapsed time.
   */
  async restartAll() {
    const started = Date.now()
    const allow = this.config.onlyServers.length > 0 ? new Set(this.config.onlyServers) : undefined
    const selected = this.serverRows()
      .map((entry) => entry.options.id ?? entry.id)
      .filter((id) => allow === undefined || allow.has(id))
    const results = []
    for (const id of selected) results.push(await this.restart(id))
    const okCount = results.filter((result) => result.ok === true).length
    return { ok: okCount === results.length, total: results.length, okCount, results, durationMs: Date.now() - started }
  }

  /**
   * Every Loader row that is one MCP server.
   * @returns the rows, in Loader order.
   */
  serverRows() {
    const rows = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.name === MCP_CLIENT_MODULE) rows.push(entry)
    }
    return rows
  }

  /**
   * Look up one row.
   *
   * `Entry.id` is the tree-qualified id (`<ancestor>:<own id>`, see
   * `recon/asar/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/config/entry.ts:67-73`),
   * while the id a patch declares is `options.id`. Accept either, and accept the
   * `include:`-qualified form the runtime actually carries.
   *
   * @param id - row id as declared, or the runtime id.
   * @returns the entry, or `undefined` when no MCP row owns that id.
   */
  findEntry(id) {
    for (const entry of this.serverRows()) {
      if (entry.options.id === id || entry.id === id || entry.id.endsWith(`:${id}`)) return entry
    }
    return undefined
  }

  /**
   * The contract's `state` for one row.
   * @param entry - a Loader entry.
   * @returns `active`, `loading`, `failed`, `disabled`, `pending`, `unloading`, or `unknown`.
   */
  stateOf(entry) {
    if (entry.disabled === true) return 'disabled'
    if (entry.fiber === undefined) return 'pending'
    return FIBER_PHASE[entry.fiber.state] ?? 'unknown'
  }

  /**
   * Count the tools one MCP server has registered right now.
   * @param serverName - the server's `config.serverName`.
   * @returns how many visible tools carry this server's prefix.
   */
  countTools(serverName) {
    return countWithPrefix(this.toolNames(), serverName)
  }

  /**
   * The visible tool names, once.
   *
   * `ctx.tools.schemas()` is the documented projection of the visible set
   * (`recon/asar/dsh/node_modules/@deepseek-ai/dsh-tools/README.md:85`;
   * `lib/index.js:3114-3121`); with no scope it is the global view
   * (`lib/index.js:3052-3081`).
   *
   * @returns the projected names, or none when the service is absent.
   */
  toolNames() {
    const tools = this.ctx.get('tools')
    if (tools === undefined) return []
    const schemas = tools.schemas()
    return schemas.map((schema) => (typeof schema?.name === 'string' ? schema.name : ''))
  }
}

declareRemoteMethods(McpConsoleService, ['health', 'servers', 'restart', 'restartAll'])

export { REMOTE_METHOD_DESCRIPTOR }
