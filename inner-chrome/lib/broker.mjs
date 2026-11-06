/**
 * In-memory command broker shared by the Host half (`index.js`) and the Client
 * half (`client.js`) of `inner-chrome` over four HTTP routes.
 *
 * The broker owns exactly one browser client at a time:
 *
 * - `hello`   registers a client (or replaces the previous one);
 * - `poll`    is the client's long poll: it hands out one queued command, or
 *             resolves with `command: null` after `waitMs`;
 * - `result`  settles the tool-side promise created by `enqueue` (idempotent:
 *             duplicate and unknown ids are acknowledged, never thrown);
 * - `status`  reports the client heartbeat and the pending command count.
 *
 * Command kinds are the six Agent-tool kinds (`open`/`read`/`click`/
 * `screenshot`/`tabs`/`navigate`) plus the v0.2 page-automation kinds `eval`
 * and `close` (CONTRACT.md §8.1); `open` also accepts the optional
 * `injectScript`/`waitForLoad` arguments.
 *
 * A client that has not sent `hello`/`poll` for 30 s is considered gone: its
 * pending commands reject with `CLIENT_GONE`. Commands waiting longer than the
 * command timeout reject with `TIMEOUT`. `dispose()` rejects everything left
 * (plugin unload / reload clears all process-local state, as CONTRACT.md §3.1
 * requires).
 *
 * Nothing here touches the filesystem or the network: the broker is pure
 * memory, which keeps it trivially testable.
 */

import { randomUUID } from 'node:crypto'

import { assertHttpUrl } from './url.mjs'

/** Wire protocol version exchanged with the browser client. */
export const PROTOCOL = 1

/** Command kinds understood by the client. */
export const COMMAND_KINDS = ['open', 'read', 'click', 'screenshot', 'tabs', 'navigate', 'eval', 'close']

/** `eval.expression` / `open.injectScript` length bound (CONTRACT.md §8.1). */
export const MAX_SCRIPT_CHARS = 262144

/** `eval.timeoutMs` bounds and default (CONTRACT.md §8.1). */
export const MIN_EVAL_TIMEOUT_MS = 100
export const MAX_EVAL_TIMEOUT_MS = 60000
export const DEFAULT_EVAL_TIMEOUT_MS = 15000

/** `screenshot.timeoutMs` bounds; the client applies its own default when omitted (CONTRACT.md §4.4). */
export const MIN_SCREENSHOT_TIMEOUT_MS = 100
export const MAX_SCREENSHOT_TIMEOUT_MS = 30000

/** `poll` wait bound when the request omits `waitMs`. */
export const DEFAULT_POLL_WAIT_MS = 15000

/** Hard lower bound for `poll`'s `waitMs` (CONTRACT.md §3.2). */
export const MIN_POLL_WAIT_MS = 1000

/** Hard upper bound for `poll`'s `waitMs` (CONTRACT.md §3.2). */
export const MAX_POLL_WAIT_MS = 25000

/** Host-side tool wait for a client result (CONTRACT.md §3.3). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 25000

/** A client with no `hello`/`poll` heartbeat for this long is gone. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 30000

/** How often the heartbeat sweep runs. */
export const DEFAULT_SWEEP_INTERVAL_MS = 5000

/** Wording required by CONTRACT.md §3.3 for a timed-out tool wait. */
export const TIMEOUT_MESSAGE = '内置浏览器没有响应：请确认 DSH Desktop 窗口开着，且右侧栏浏览器标签页可打开。'

const NO_CLIENT_MESSAGE = '内置浏览器还没有连接：请确认 DSH Desktop 窗口开着，且右侧栏能打开浏览器标签页。'
const CLIENT_GONE_MESSAGE = '内置浏览器已断开连接：请确认 DSH Desktop 窗口开着，并刷新页面后重试。'
const DISPOSED_MESSAGE = '内置浏览器插件已卸载。'
const ABORTED_MESSAGE = '内置浏览器操作已取消。'

/** Navigation actions accepted by the `navigate` command. */
const NAVIGATE_ACTIONS = ['back', 'forward', 'reload', 'goto']

/**
 * Build one broker error carrying a contract error code.
 * @param code - one of NO_CLIENT / TIMEOUT / CLIENT_GONE / BAD_ARGS / INTERNAL,
 *   or a client-side code relayed from a result.
 * @param message - model-facing reason.
 * @returns the error.
 */
export function brokerError(code, message) {
  const error = new Error(message)
  error.name = 'InnerChromeBrokerError'
  error.code = code
  return error
}

/**
 * Read an untrusted positive number, falling back to a default.
 * @param value - candidate.
 * @param fallback - value used when the candidate is not a finite positive number.
 * @returns the accepted number.
 */
function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/**
 * Read an untrusted positive integer, returning `undefined` when absent.
 * @param value - candidate.
 * @returns the truncated positive integer, or undefined.
 */
function positiveInteger(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Math.trunc(number)
}

/**
 * Coerce an untrusted string-ish field.
 * @param value - candidate.
 * @param fallback - value used when the candidate is not a non-empty string.
 * @returns the string.
 */
function textOr(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/**
 * Clamp the optional `eval.timeoutMs` into the contract bounds.
 * @param value - untrusted candidate.
 * @returns the timeout handed to the client (defaults to 15 s).
 */
function evalTimeoutMs(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_EVAL_TIMEOUT_MS
  return Math.min(MAX_EVAL_TIMEOUT_MS, Math.max(MIN_EVAL_TIMEOUT_MS, Math.trunc(number)))
}

/**
 * Clamp an optional `screenshot.timeoutMs` into the contract bounds.
 * @param value - untrusted candidate.
 * @returns the timeout handed to the client, or undefined when the caller omitted it.
 */
function screenshotTimeoutMs(value) {
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  return Math.min(MAX_SCREENSHOT_TIMEOUT_MS, Math.max(MIN_SCREENSHOT_TIMEOUT_MS, Math.trunc(number)))
}

/**
 * Validate the optional `open.injectScript` argument.
 * @param value - untrusted candidate.
 * @returns the script, or undefined when the caller omitted it.
 */
function openInjectScript(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value === '') {
    throw brokerError('BAD_ARGS', 'injectScript 必须是非空字符串。')
  }
  if (value.length > MAX_SCRIPT_CHARS) {
    throw brokerError('BAD_ARGS', `injectScript 过长（上限 ${MAX_SCRIPT_CHARS} 字符）。`)
  }
  return value
}

/**
 * Normalize a client-reported error code onto the protocol vocabulary.
 * @param code - untrusted code.
 * @returns the code to relay, defaulting to INTERNAL.
 */
function resultErrorCode(code) {
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return code
  return 'INTERNAL'
}

/**
 * Validate and normalize one command's arguments.
 *
 * `open` and `navigate` URLs are normalized here (CONTRACT.md §3.3: invalid
 * URLs fail immediately with `BAD_ARGS`, before anything reaches the client).
 * The v0.2 `eval`/`close` kinds and the `open` injection options are validated
 * here too (CONTRACT.md §8.1), as is the optional `screenshot.timeoutMs`
 * (CONTRACT.md §4.4).
 *
 * @param kind - command kind.
 * @param args - untrusted tool arguments.
 * @returns the normalized `Command.args` payload.
 */
export function normalizeCommandArgs(kind, args) {
  const input = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}
  switch (kind) {
    case 'open': {
      const output = {
        url: assertHttpUrl(input.url),
        newTab: input.newTab === true,
        waitForLoad: input.waitForLoad !== false,
      }
      const injectScript = openInjectScript(input.injectScript)
      if (injectScript !== undefined) output.injectScript = injectScript
      return output
    }
    case 'read': {
      const output = {}
      const maxChars = positiveInteger(input.maxChars)
      if (maxChars !== undefined) output.maxChars = maxChars
      return output
    }
    case 'click': {
      const selector = typeof input.selector === 'string' ? input.selector.trim() : ''
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      if (selector === '' && text === '') {
        throw brokerError('BAD_ARGS', 'selector 和 text 至少需要一个。')
      }
      const output = {}
      if (selector !== '') output.selector = selector
      if (text !== '') output.text = text
      return output
    }
    case 'screenshot': {
      const output = {}
      const maxWidth = positiveInteger(input.maxWidth)
      if (maxWidth !== undefined) output.maxWidth = maxWidth
      const timeoutMs = screenshotTimeoutMs(input.timeoutMs)
      if (timeoutMs !== undefined) output.timeoutMs = timeoutMs
      return output
    }
    case 'tabs': {
      return {}
    }
    case 'navigate': {
      const action = typeof input.action === 'string' ? input.action : ''
      if (!NAVIGATE_ACTIONS.includes(action)) {
        throw brokerError('BAD_ARGS', `action 必须是 ${NAVIGATE_ACTIONS.join('/')} 之一。`)
      }
      if (action === 'goto') return { action, url: assertHttpUrl(input.url) }
      return { action }
    }
    case 'eval': {
      const expression = typeof input.expression === 'string' ? input.expression : ''
      if (expression === '') throw brokerError('BAD_ARGS', 'eval 命令需要非空的 expression。')
      if (expression.length > MAX_SCRIPT_CHARS) {
        throw brokerError('BAD_ARGS', `expression 过长（上限 ${MAX_SCRIPT_CHARS} 字符）。`)
      }
      return { expression, timeoutMs: evalTimeoutMs(input.timeoutMs) }
    }
    case 'close': {
      const tabId = typeof input.tabId === 'string' ? input.tabId.trim() : ''
      if (tabId === '') throw brokerError('BAD_ARGS', 'close 命令需要 tabId。')
      return { tabId }
    }
    default: {
      throw brokerError('BAD_ARGS', `不支持的命令类型：${String(kind)}`)
    }
  }
}

/**
 * Create the in-memory command broker.
 *
 * The extra options beyond the contract-mandated `protocol`/`version`/
 * `screenshotsDir` exist for tests and leave the production defaults in place.
 *
 * @param options - broker options.
 * @returns the broker API used by `index.js`.
 */
export function createBroker({
  protocol = PROTOCOL,
  version = '0.1.0',
  screenshotsDir = '',
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  clientTimeoutMs = DEFAULT_CLIENT_TIMEOUT_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  minPollWaitMs = MIN_POLL_WAIT_MS,
  maxPollWaitMs = MAX_POLL_WAIT_MS,
  now = Date.now,
} = {}) {
  /** Commands queued for the next poll, oldest first. */
  const queued = []
  /** id -> waiter for one in-flight tool command. */
  const waiters = new Map()
  /** Long-poll promises currently suspended. */
  const pollers = new Set()

  /** The one connected browser client, if any. */
  let client
  /** Set by `dispose`; the broker never serves commands afterwards. */
  let disposed = false
  /** Heartbeat sweep timer, created on first use. */
  let sweepTimer

  /**
   * Stop the heartbeat sweep.
   */
  function stopSweep() {
    if (sweepTimer === undefined) return
    clearInterval(sweepTimer)
    sweepTimer = undefined
  }

  /**
   * Start the heartbeat sweep once.
   */
  function ensureSweep() {
    if (sweepTimer !== undefined || disposed) return
    sweepTimer = setInterval(() => sweep(), sweepIntervalMs)
  }

  /**
   * Settle one waiter exactly once: clear its timer and abort listener, drop it
   * from the waiters table and from the pending queue, then resolve/reject.
   * @param id - command id.
   * @param error - rejection reason, or undefined for success.
   * @param value - resolved value when `error` is undefined.
   */
  function settleWaiter(id, error, value) {
    const waiter = waiters.get(id)
    if (waiter === undefined) return
    waiters.delete(id)
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    const index = queued.indexOf(waiter.command)
    if (index !== -1) queued.splice(index, 1)
    if (error === undefined) waiter.resolve(value)
    else waiter.reject(error)
  }

  /**
   * Reject every pending command with one error.
   * @param error - rejection reason.
   */
  function rejectAll(error) {
    for (const id of [...waiters.keys()]) settleWaiter(id, error, undefined)
  }

  /**
   * Resolve every suspended long poll with one command (or null).
   * @param command - command to hand out, or null.
   */
  function settlePollers(command) {
    for (const poller of [...pollers]) {
      pollers.delete(poller)
      clearTimeout(poller.timer)
      poller.resolve({ command, serverTime: now() })
    }
  }

  /**
   * Forget the current client: drop queued commands, reject in-flight commands
   * with `CLIENT_GONE`, and let suspended polls answer `command: null`.
   */
  function dropClient() {
    client = undefined
    queued.length = 0
    rejectAll(brokerError('CLIENT_GONE', CLIENT_GONE_MESSAGE))
    settlePollers(null)
  }

  /**
   * Record one heartbeat and, when a different client id shows up, replace the
   * previous client (its pending work can no longer be delivered).
   * @param clientId - client identity.
   * @param extra - hello metadata (`platform`, `capabilities`, `version`).
   */
  function touchClient(clientId, extra = {}) {
    const timestamp = now()
    if (client !== undefined && client.clientId !== clientId) dropClient()
    if (client === undefined) {
      client = {
        clientId,
        platform: extra.platform ?? '',
        capabilities: extra.capabilities ?? [],
        version: extra.version ?? '',
        lastSeen: timestamp,
      }
      return
    }
    client.lastSeen = timestamp
    if (extra.platform !== undefined) client.platform = extra.platform
    if (extra.capabilities !== undefined) client.capabilities = extra.capabilities
    if (extra.version !== undefined) client.version = extra.version
  }

  /**
   * Reap a client whose heartbeat is older than the client timeout.
   */
  function sweep() {
    if (disposed || client === undefined) return
    if (now() - client.lastSeen <= clientTimeoutMs) return
    dropClient()
  }

  /**
   * Hand queued commands to suspended long polls.
   */
  function dispatch() {
    while (client !== undefined && pollers.size > 0 && queued.length > 0) {
      const command = queued.shift()
      const poller = pollers.values().next().value
      pollers.delete(poller)
      clearTimeout(poller.timer)
      poller.resolve({ command, serverTime: now() })
    }
  }

  /**
   * Read and validate a client id from a route body.
   * @param body - parsed request body.
   * @returns the client id.
   */
  function requireClientId(body) {
    if (typeof body?.clientId === 'string' && body.clientId.trim() !== '') return body.clientId.trim()
    throw brokerError('BAD_ARGS', '缺少 clientId。')
  }

  /**
   * Register or refresh the browser client (route `/api/inner-chrome.hello`).
   * @param body - `{ clientId, protocol, platform, capabilities, version }`.
   * @returns the handshake response payload.
   */
  function hello(body) {
    if (disposed) throw brokerError('CLIENT_GONE', DISPOSED_MESSAGE)
    const clientId = requireClientId(body)
    if (body?.protocol !== undefined && Number(body.protocol) !== protocol) {
      throw brokerError('BAD_ARGS', `协议版本不匹配：期望 ${protocol}，收到 ${String(body.protocol)}。`)
    }
    touchClient(clientId, {
      platform: textOr(body?.platform, ''),
      capabilities: Array.isArray(body?.capabilities)
        ? body.capabilities.filter((item) => typeof item === 'string')
        : [],
      version: textOr(body?.version, ''),
    })
    ensureSweep()
    return { protocol, version, screenshotsDir }
  }

  /**
   * Long poll for the next command (route `/api/inner-chrome.poll`).
   * @param body - `{ clientId, waitMs? }`.
   * @returns `{ command: Command | null, serverTime }`.
   */
  async function poll(body) {
    if (disposed) return { command: null, serverTime: now() }
    const clientId = requireClientId(body)
    touchClient(clientId)
    ensureSweep()
    const waitMs = Math.min(
      maxPollWaitMs,
      Math.max(minPollWaitMs, positiveNumber(body?.waitMs, DEFAULT_POLL_WAIT_MS)),
    )
    if (queued.length > 0) {
      return { command: queued.shift(), serverTime: now() }
    }
    return await new Promise((resolve) => {
      const poller = { resolve, timer: undefined }
      poller.timer = setTimeout(() => {
        pollers.delete(poller)
        resolve({ command: null, serverTime: now() })
      }, waitMs)
      pollers.add(poller)
    })
  }

  /**
   * Accept one command result (route `/api/inner-chrome.result`).
   *
   * Idempotent by contract: an already-settled or unknown id is acknowledged
   * without an error so a retried POST cannot break the client loop.
   *
   * @param body - `{ clientId, id, ok, value?, error? }`.
   * @returns `{ ok: true }`.
   */
  function result(body) {
    if (disposed) return { ok: true }
    const id = typeof body?.id === 'string' ? body.id : ''
    if (id === '') throw brokerError('BAD_ARGS', '缺少命令 id。')
    const waiter = waiters.get(id)
    if (waiter === undefined) return { ok: true }
    if (body?.ok === true) {
      settleWaiter(id, undefined, body?.value ?? null)
    } else {
      const code = resultErrorCode(body?.error?.code)
      const message = textOr(body?.error?.message, '内置浏览器执行失败。')
      settleWaiter(id, brokerError(code, message), undefined)
    }
    return { ok: true }
  }

  /**
   * Report the connection state (route `/api/inner-chrome.status`).
   * @returns the status payload from CONTRACT.md §3.2.
   */
  function status() {
    const timestamp = now()
    const pendingCommands = waiters.size
    if (client === undefined) {
      return {
        client: { connected: false, clientId: null, platform: null, capabilities: [], lastSeenAgoMs: null },
        pendingCommands,
        protocol,
        version,
        screenshotsDir,
      }
    }
    const lastSeenAgoMs = Math.max(0, timestamp - client.lastSeen)
    return {
      client: {
        connected: !disposed && lastSeenAgoMs <= clientTimeoutMs,
        clientId: client.clientId,
        platform: client.platform === '' ? null : client.platform,
        capabilities: [...client.capabilities],
        lastSeenAgoMs,
      },
      pendingCommands,
      protocol,
      version,
      screenshotsDir,
    }
  }

  /**
   * Queue one command and wait for its result.
   *
   * @param kind - one of `COMMAND_KINDS`.
   * @param args - tool arguments; normalized/validated here.
   * @param options - `{ sessionId?, tabId?, timeoutMs?, signal? }`.
   * @returns the command `value` sent back by the client.
   */
  async function enqueue(kind, args, options = {}) {
    if (disposed) throw brokerError('CLIENT_GONE', DISPOSED_MESSAGE)
    if (typeof kind !== 'string' || !COMMAND_KINDS.includes(kind)) {
      throw brokerError('BAD_ARGS', `不支持的命令类型：${String(kind)}`)
    }
    const normalizedArgs = normalizeCommandArgs(kind, args)
    if (client === undefined || now() - client.lastSeen > clientTimeoutMs) {
      sweep()
      throw brokerError('NO_CLIENT', NO_CLIENT_MESSAGE)
    }
    if (options.signal?.aborted === true) throw brokerError('INTERNAL', ABORTED_MESSAGE)

    const command = {
      id: randomUUID(),
      kind,
      args: normalizedArgs,
      createdAt: now(),
    }
    if (typeof options.sessionId === 'string' && options.sessionId !== '') {
      command.sessionId = options.sessionId
    }
    if (typeof options.tabId === 'string' && options.tabId !== '') {
      command.tabId = options.tabId
    }
    const timeoutMs = positiveNumber(options.timeoutMs, commandTimeoutMs)

    return await new Promise((resolve, reject) => {
      const waiter = {
        command,
        resolve,
        reject,
        timer: undefined,
        signal: options.signal,
        onAbort: undefined,
      }
      waiter.timer = setTimeout(() => {
        settleWaiter(command.id, brokerError('TIMEOUT', TIMEOUT_MESSAGE), undefined)
      }, timeoutMs)
      waiters.set(command.id, waiter)
      queued.push(command)
      if (options.signal !== undefined && typeof options.signal.addEventListener === 'function') {
        waiter.onAbort = () => {
          settleWaiter(command.id, brokerError('INTERNAL', ABORTED_MESSAGE), undefined)
        }
        options.signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      dispatch()
    })
  }

  /**
   * Release every timer and reject any outstanding promise.
   */
  function dispose() {
    if (disposed) return
    disposed = true
    stopSweep()
    queued.length = 0
    rejectAll(brokerError('CLIENT_GONE', DISPOSED_MESSAGE))
    settlePollers(null)
    client = undefined
  }

  return { hello, poll, result, status, enqueue, dispose }
}
