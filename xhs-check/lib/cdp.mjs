/**
 * Minimal Chrome DevTools Protocol client for dsh-xhs-check.
 *
 * The Host half runs inside the DSH Electron main process (Node 24) and keeps a
 * hard zero-dependency rule, so this module speaks the browser-level CDP
 * WebSocket directly instead of using puppeteer/playwright:
 *
 * - one browser-level `WebSocket` per Browser, JSON frames shaped
 *   `{ id, method, params, sessionId? }`;
 * - one flat session per Page (`Target.attachToTarget({ flatten: true })`),
 *   every Page/Runtime command carries that `sessionId`;
 * - one promise per command with a timeout, and an event fan-out for page
 *   listeners (`load`, `domContentLoaded`, `dialog`, `close`);
 * - never `--enable-automation` and never `--headless` unless explicitly asked,
 *   so the driven Chrome looks like a normal human browser to Xiaohongshu.
 *
 * Handles are idempotent: closing a Page twice or closing an already closed
 * Browser is a no-op. A dead socket rejects every pending command with
 * `CDP_DISCONNECTED`, so callers never hang on a page that went away.
 *
 * Every browser still gets its own `--user-data-dir` (Chrome 136+ refuses
 * remote debugging on the default profile), which is also where the Xiaohongshu
 * login lives: no cookie or token is ever hard-coded here.
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

/** Default macOS Chrome binary, overridable through the plugin settings. */
export const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Default CDP port, aligned with the plugin's `chromePort` setting. */
export const DEFAULT_CHROME_PORT = 9333

/** Error codes carried by `CdpError#code`; consumers may branch on these. */
export const CDP_ERROR_CODES = Object.freeze({
	/** A command, socket handshake, launch probe or wait timed out. */
	TIMEOUT: 'CDP_TIMEOUT',
	/** The WebSocket closed (or never opened); every pending command was rejected. */
	DISCONNECTED: 'CDP_DISCONNECTED',
	/** Chrome could not be started or never exposed its CDP endpoint. */
	LAUNCH_FAILED: 'CDP_LAUNCH_FAILED',
	/** An existing CDP endpoint could not be reached or connected to. */
	CONNECT_FAILED: 'CDP_CONNECT_FAILED',
	/** The endpoint answered with a JSON-RPC error or an invalid frame. */
	PROTOCOL_ERROR: 'CDP_PROTOCOL_ERROR',
	/** `Page.navigate` refused the URL or reported `errorText`. */
	NAVIGATION_FAILED: 'CDP_NAVIGATION_FAILED',
	/** `Runtime.evaluate` returned `exceptionDetails` (the page threw). */
	EVALUATION_ERROR: 'CDP_EVALUATION_ERROR',
	/** Bad argument supplied by the caller (port, userDataDir, expression, ...). */
	INVALID_ARGUMENT: 'CDP_INVALID_ARGUMENT'
})

/** Internal shorthand, so the code below reads `CODES.TIMEOUT` instead of long keys. */
const CODES = CDP_ERROR_CODES

/**
 * Chrome flags shared by every launch. `--enable-automation` is deliberately
 * absent: it flips `navigator.webdriver` and Xiaohongshu reacts to that.
 */
const CHROME_FLAGS = Object.freeze([
	'--no-first-run',
	'--no-default-browser-check',
	'--window-size=1440,900',
	'--disable-background-timer-throttling',
	'--disable-renderer-backgrounding'
])

/** Only added when `options.headless` is true (headless is detectable, so default off). */
const CHROME_HEADLESS_FLAG = '--headless=new'

/** Page opened when `newPage()` gets no URL. */
const DEFAULT_START_URL = 'about:blank'

/** Default budget for detecting an already running Chrome before spawning one. */
const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000

/** Default budget for one CDP command. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

/** Default budget for `goto` (the readyState fallback gets its own budget too). */
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000

/** Default polling budget for `waitFor`. */
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 15_000

/** Default polling interval for `waitFor` and the readyState fallback. */
const DEFAULT_WAIT_FOR_INTERVAL_MS = 250

/** Defaults mirroring the collector's scroll settings. */
const DEFAULT_SCROLL_TIMES = 3
const DEFAULT_SCROLL_DISTANCE = 1200
const DEFAULT_SCROLL_DELAY_MS = 1200

/** `waitForIdle` defaults: a quiet window plus an overall budget. */
const DEFAULT_IDLE_QUIET_MS = 800
const DEFAULT_IDLE_TIMEOUT_MS = 15_000

/** How often the idle sampler checks whether the page is still changing. */
const IDLE_POLL_INTERVAL_MS = 200

/** How often `goto`'s fallback polls `document.readyState`. */
const READY_STATE_POLL_INTERVAL_MS = 150

/** Budget for one `GET /json/version` probe. */
const HTTP_PROBE_TIMEOUT_MS = 1_500

/** Delay between two CDP endpoint probes while Chrome starts up. */
const LAUNCH_POLL_INTERVAL_MS = 250

/** Budget for the browser WebSocket handshake. */
const WS_OPEN_TIMEOUT_MS = 10_000

/** How long a launched Chrome gets after SIGTERM before SIGKILL. */
const CHILD_EXIT_GRACE_MS = 3_000

/** `WebSocket.readyState` value once the handshake completed (browser API constant). */
const SOCKET_OPEN = 1

/** Smallest timer used by poll loops, so `delay` never asks for a negative wait. */
const MIN_TIMER_MS = 1

/** Trivial callback returned when a listener can never fire. */
const NOOP = () => {}

/** Shared decoder for binary CDP frames (Node normally delivers strings). */
const TEXT_DECODER = new TextDecoder()

/**
 * Sampled to decide whether a page is "quiet": readyState, DOM size and scroll
 * height. Any of them changing means the page (or its feed) is still working.
 */
const IDLE_SIGNATURE_EXPRESSION =
	'JSON.stringify([document.readyState, document.documentElement ? document.documentElement.outerHTML.length : 0, document.body ? document.body.scrollHeight : 0])'

/**
 * Error raised by every failure path in this module. Always carries a stable
 * `code` (see `CDP_ERROR_CODES`) so the collector can decide whether to retry.
 */
export class CdpError extends Error {
	/**
	 * @param {string} code - one of `CDP_ERROR_CODES`.
	 * @param {string} message - human readable description.
	 * @param {{ cause?: unknown, details?: unknown }} [options] - original cause and raw details.
	 */
	constructor(code, message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause })
		this.name = 'CdpError'
		this.code = code
		if (options.details !== undefined) this.details = options.details
	}
}

/**
 * Whether an already running Chrome exposes a CDP endpoint on `127.0.0.1:port`.
 *
 * @param {number|string} port - remote debugging port to probe.
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options] - test hooks.
 * @returns {Promise<boolean>} true when `/json/version` returned a `webSocketDebuggerUrl`.
 */
export async function isChromeListening(port, options = {}) {
	const portNumber = assertPort(port)
	const version = await probeChrome(portNumber, {
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs ?? HTTP_PROBE_TIMEOUT_MS
	})
	return Boolean(version?.webSocketDebuggerUrl)
}

/**
 * Connect to a Chrome that is already listening on `port`; never starts one.
 *
 * @param {number|string} port - remote debugging port of the running Chrome.
 * @param {{ fetchImpl?: typeof fetch, WebSocketImpl?: typeof WebSocket, timeoutMs?: number, commandTimeoutMs?: number, socketOpenTimeoutMs?: number }} [options] - test hooks.
 * @returns {Promise<object>} the Browser handle described in CONTRACT.md §2.
 * @throws {CdpError} `CDP_CONNECT_FAILED` when no endpoint answers, `CDP_TIMEOUT`
 *   when the WebSocket handshake stalls.
 */
export async function connectChrome(port, options = {}) {
	const portNumber = assertPort(port)
	const version = await probeChrome(portNumber, {
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs ?? HTTP_PROBE_TIMEOUT_MS
	})
	if (!version?.webSocketDebuggerUrl) {
		throw new CdpError(CODES.CONNECT_FAILED, `no CDP endpoint at http://127.0.0.1:${portNumber}/json/version`)
	}
	return createBrowser({
		port: portNumber,
		wsUrl: version.webSocketDebuggerUrl,
		launched: false,
		WebSocketImpl: options.WebSocketImpl,
		commandTimeoutMs: options.commandTimeoutMs,
		socketOpenTimeoutMs: options.socketOpenTimeoutMs
	})
}

/**
 * Start Chrome with an isolated profile, or reuse a Chrome already listening on
 * the requested port. Reuse is what lets the user keep one logged-in window
 * across plugin restarts.
 *
 * @param {object} options - launch options.
 * @param {string} options.userDataDir - required isolated Chrome profile directory.
 * @param {string} [options.chromePath] - Chrome binary; defaults to `DEFAULT_CHROME_PATH`.
 * @param {number|string} [options.port] - remote debugging port; defaults to `DEFAULT_CHROME_PORT`.
 * @param {boolean} [options.headless] - start headless; defaults to false.
 * @param {string} [options.startUrl] - URL opened on launch; defaults to `about:blank`.
 * @param {number} [options.launchTimeoutMs] - budget for the CDP endpoint to appear.
 * @param {Function} [options.spawnImpl] - test hook replacing `child_process.spawn`.
 * @param {Function} [options.fetchImpl] - test hook replacing global `fetch`.
 * @param {Function} [options.WebSocketImpl] - test hook replacing global `WebSocket`.
 * @param {number} [options.commandTimeoutMs] - default per-command timeout.
 * @param {number} [options.pollIntervalMs] - test hook for the launch probe interval.
 * @param {number} [options.socketOpenTimeoutMs] - budget for the WebSocket handshake.
 * @returns {Promise<object>} the Browser handle described in CONTRACT.md §2.
 * @throws {CdpError} `CDP_LAUNCH_FAILED` when Chrome cannot start or never becomes ready.
 */
export async function launchChrome(options = {}) {
	const port = assertPort(options.port)
	const userDataDir = options.userDataDir
	if (typeof userDataDir !== 'string' || userDataDir.trim() === '') {
		throw new CdpError(CODES.INVALID_ARGUMENT, 'launchChrome requires a non-empty userDataDir')
	}
	const headless = options.headless === true
	const startUrl = typeof options.startUrl === 'string' ? options.startUrl : DEFAULT_START_URL
	const launchTimeoutMs = normalizeBudget(options.launchTimeoutMs, DEFAULT_LAUNCH_TIMEOUT_MS)
	const pollIntervalMs = normalizeBudget(options.pollIntervalMs, LAUNCH_POLL_INTERVAL_MS)
	const fetchImpl = options.fetchImpl
	const spawnImpl = options.spawnImpl ?? spawn
	const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket
	const commandTimeoutMs = options.commandTimeoutMs
	const socketOpenTimeoutMs = options.socketOpenTimeoutMs

	const existing = await probeChrome(port, { fetchImpl })
	if (existing?.webSocketDebuggerUrl) {
		return createBrowser({
			port,
			wsUrl: existing.webSocketDebuggerUrl,
			launched: false,
			WebSocketImpl,
			commandTimeoutMs,
			socketOpenTimeoutMs
		})
	}

	try {
		await mkdir(userDataDir, { recursive: true })
	} catch (error) {
		throw new CdpError(CODES.LAUNCH_FAILED, `could not create userDataDir ${userDataDir}: ${error?.message ?? error}`, {
			cause: error
		})
	}

	if (typeof spawnImpl !== 'function') {
		throw new CdpError(CODES.LAUNCH_FAILED, 'launchChrome requires child_process.spawn')
	}

	const chromePath = typeof options.chromePath === 'string' && options.chromePath !== '' ? options.chromePath : DEFAULT_CHROME_PATH
	const args = buildChromeArgs({ port, userDataDir, headless, startUrl })
	let child
	try {
		child = spawnImpl(chromePath, args, { detached: false, stdio: 'ignore' })
	} catch (error) {
		throw new CdpError(CODES.LAUNCH_FAILED, `could not start Chrome at ${chromePath}: ${error?.message ?? error}`, { cause: error })
	}
	if (!child) {
		throw new CdpError(CODES.LAUNCH_FAILED, `spawn returned no child process for ${chromePath}`)
	}

	const lifecycle = monitorChild(child)
	const deadline = Date.now() + launchTimeoutMs
	let version
	for (;;) {
		if (lifecycle.error) {
			await stopChildProcess(child)
			throw new CdpError(CODES.LAUNCH_FAILED, `Chrome failed to start: ${lifecycle.error?.message ?? lifecycle.error}`, {
				cause: lifecycle.error
			})
		}
		if (lifecycle.exit) {
			await stopChildProcess(child)
			throw new CdpError(CODES.LAUNCH_FAILED, describeUnexpectedExit(lifecycle.exit))
		}
		version = await probeChrome(port, { fetchImpl })
		if (version?.webSocketDebuggerUrl) break
		const now = Date.now()
		if (now >= deadline) {
			await stopChildProcess(child)
			throw new CdpError(CODES.LAUNCH_FAILED, `Chrome did not expose CDP on 127.0.0.1:${port} within ${launchTimeoutMs}ms`)
		}
		await delay(Math.min(pollIntervalMs, Math.max(MIN_TIMER_MS, deadline - now)))
	}

	try {
		return await createBrowser({
			port,
			wsUrl: version.webSocketDebuggerUrl,
			launched: true,
			pid: child.pid,
			child,
			WebSocketImpl,
			commandTimeoutMs,
			socketOpenTimeoutMs
		})
	} catch (error) {
		await stopChildProcess(child)
		throw error
	}
}

/**
 * Open the browser-level WebSocket and wrap it in a Browser handle.
 *
 * @param {object} options - already resolved connection facts.
 * @returns {Promise<object>} Browser handle.
 */
async function createBrowser(options) {
	const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket
	if (typeof WebSocketImpl !== 'function') {
		throw new CdpError(CODES.CONNECT_FAILED, 'no WebSocket implementation is available in this runtime')
	}
	let socket
	try {
		socket = new WebSocketImpl(options.wsUrl)
	} catch (error) {
		throw new CdpError(CODES.CONNECT_FAILED, `could not open CDP WebSocket ${options.wsUrl}: ${error?.message ?? error}`, {
			cause: error
		})
	}
	try {
		await waitForSocketOpen(socket, normalizeBudget(options.socketOpenTimeoutMs, WS_OPEN_TIMEOUT_MS))
	} catch (error) {
		try {
			socket.close()
		} catch {
			// The socket never reached OPEN; closing is best effort.
		}
		throw error
	}
	const connection = new CdpConnection(socket, { commandTimeoutMs: options.commandTimeoutMs })
	return new BrowserHandle({
		connection,
		port: options.port,
		wsUrl: options.wsUrl,
		pid: options.pid,
		launched: options.launched === true,
		child: options.child
	})
}

/**
 * One browser-level CDP WebSocket: command promises, event fan-out and a single
 * shutdown path that rejects everything pending.
 */
class CdpConnection {
	#socket
	#commandTimeoutMs
	#nextId = 1
	#pending = new Map()
	#listeners = new Map()
	#unsubscribers = []
	#closed = false
	#closeReason = ''

	/**
	 * @param {WebSocket} socket - socket in OPEN state.
	 * @param {{ commandTimeoutMs?: number }} [options] - defaults.
	 */
	constructor(socket, options = {}) {
		this.#socket = socket
		this.#commandTimeoutMs = normalizeBudget(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
		this.#unsubscribers = [
			addSocketListener(socket, 'message', (event) => {
				void this.#onMessage(event)
			}),
			addSocketListener(socket, 'close', (event) => {
				this.#shutdown(`socket closed (${describeCloseEvent(event)})`)
			}),
			addSocketListener(socket, 'error', (event) => {
				this.#shutdown(`socket error: ${describeSocketError(event)}`)
			})
		]
	}

	/** @returns {boolean} true once the socket is gone. */
	get closed() {
		return this.#closed
	}

	/**
	 * Send one command and resolve with its raw `result`.
	 *
	 * @param {string} method - CDP method name, e.g. `Runtime.evaluate`.
	 * @param {object} [params] - method parameters.
	 * @param {{ sessionId?: string, timeoutMs?: number }} [options] - flat session and timeout.
	 * @returns {Promise<object>} the command result.
	 */
	send(method, params = {}, options = {}) {
		if (this.#closed) {
			return Promise.reject(
				new CdpError(CODES.DISCONNECTED, `cannot send ${method}: CDP connection is closed (${this.#closeReason})`)
			)
		}
		const id = this.#nextId
		this.#nextId += 1
		const payload = { id, method, params: params ?? {} }
		if (typeof options.sessionId === 'string' && options.sessionId !== '') payload.sessionId = options.sessionId
		const timeoutMs = normalizeBudget(options.timeoutMs, this.#commandTimeoutMs)

		return new Promise((resolve, reject) => {
			let timer = null
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					this.#pending.delete(id)
					reject(new CdpError(CODES.TIMEOUT, `CDP command ${method} timed out after ${timeoutMs}ms`))
				}, timeoutMs)
			}
			this.#pending.set(id, { method, resolve, reject, timer })
			try {
				this.#socket.send(JSON.stringify(payload))
			} catch (error) {
				this.#pending.delete(id)
				if (timer !== null) clearTimeout(timer)
				reject(
					new CdpError(CODES.DISCONNECTED, `could not send ${method}: ${error?.message ?? error}`, { cause: error })
				)
			}
		})
	}

	/**
	 * Subscribe to one CDP event name. `'disconnected'` is synthetic and fires
	 * exactly once when the socket dies.
	 *
	 * @param {string} method - event name, e.g. `Page.loadEventFired`.
	 * @param {(params: object, meta: { sessionId?: string }) => void} listener - handler.
	 * @returns {() => void} unsubscribe function.
	 */
	on(method, listener) {
		if (this.#closed) return NOOP
		let listeners = this.#listeners.get(method)
		if (!listeners) {
			listeners = new Set()
			this.#listeners.set(method, listeners)
		}
		listeners.add(listener)
		return () => {
			listeners.delete(listener)
		}
	}

	/** Close the socket and reject every pending command (idempotent). */
	async close() {
		if (this.#closed) return
		this.#shutdown('client closed the connection')
		try {
			this.#socket.close()
		} catch {
			// The socket may already be dead; there is nothing left to do.
		}
	}

	/**
	 * Parse one socket frame. Responses resolve their pending promise by `id`;
	 * everything else is dispatched as an event.
	 *
	 * @param {MessageEvent|string|ArrayBuffer} event - raw frame.
	 */
	async #onMessage(event) {
		const data = event && typeof event === 'object' && 'data' in event ? event.data : event
		const text = typeof data === 'string' ? data : await decodeFrame(data)
		if (typeof text !== 'string' || text === '') return
		let message
		try {
			message = JSON.parse(text)
		} catch {
			return
		}
		if (message === null || typeof message !== 'object') return
		if (typeof message.id === 'number') {
			this.#settle(message)
			return
		}
		if (typeof message.method !== 'string') return
		this.#emit(message.method, message.params ?? {}, {
			sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined
		})
	}

	/**
	 * Resolve or reject the pending command matching a response frame.
	 *
	 * @param {{ id: number, result?: object, error?: { code?: number, message?: string } }} message - response frame.
	 */
	#settle(message) {
		const pending = this.#pending.get(message.id)
		if (!pending) return
		this.#pending.delete(message.id)
		if (pending.timer !== null) clearTimeout(pending.timer)
		if (message.error) {
			const protocolCode = message.error.code
			const suffix = protocolCode === undefined ? '' : ` (protocol code ${protocolCode})`
			pending.reject(
				new CdpError(CODES.PROTOCOL_ERROR, `${pending.method} failed${suffix}: ${message.error.message ?? 'unknown error'}`, {
					details: message.error
				})
			)
			return
		}
		pending.resolve(message.result ?? {})
	}

	/**
	 * Dispatch one event to its listeners; listener errors never break the socket loop.
	 *
	 * @param {string} method - event name.
	 * @param {object} params - event payload.
	 * @param {{ sessionId?: string }} meta - flat session of the event, when any.
	 */
	#emit(method, params, meta) {
		const listeners = this.#listeners.get(method)
		if (!listeners) return
		for (const listener of [...listeners]) {
			try {
				listener(params, meta)
			} catch {
				// A broken listener must not poison protocol dispatch.
			}
		}
	}

	/**
	 * Single shutdown path: reject all pending commands, emit `disconnected`,
	 * then drop every listener and socket subscription. Idempotent.
	 *
	 * @param {string} reason - why the connection ended.
	 * @returns {boolean} true when this call performed the shutdown.
	 */
	#shutdown(reason) {
		if (this.#closed) return false
		this.#closed = true
		this.#closeReason = reason
		for (const pending of this.#pending.values()) {
			if (pending.timer !== null) clearTimeout(pending.timer)
			pending.reject(
				new CdpError(CODES.DISCONNECTED, `CDP connection closed before ${pending.method} completed (${reason})`)
			)
		}
		this.#pending.clear()
		this.#emit('disconnected', { reason }, {})
		for (const unsubscribe of this.#unsubscribers) {
			try {
				unsubscribe()
			} catch {
				// Removing an already detached listener is harmless.
			}
		}
		this.#unsubscribers = []
		this.#listeners.clear()
		return true
	}
}

/**
 * Browser handle: owns the CDP connection, creates flat page sessions and owns
 * the Chrome process when this module started it.
 */
class BrowserHandle {
	#connection
	#child
	#pages = new Set()
	#closed = false

	/**
	 * @param {object} options - resolved connection facts.
	 */
	constructor(options) {
		this.#connection = options.connection
		this.#child = options.child
		/** @type {number} remote debugging port. */
		this.port = options.port
		/** @type {string} browser-level WebSocket URL. */
		this.wsUrl = options.wsUrl
		/** @type {number|undefined} pid of the Chrome this module started. */
		this.pid = options.pid
		/** @type {boolean} whether this module started the Chrome. */
		this.launched = options.launched === true
	}

	/**
	 * Create a page, attach a flat session to it and enable Page/Runtime.
	 *
	 * @param {string} [url] - initial URL; defaults to `about:blank`.
	 * @returns {Promise<object>} Page handle described in CONTRACT.md §2.
	 */
	async newPage(url = DEFAULT_START_URL) {
		this.#assertOpen()
		const targetUrl = typeof url === 'string' && url !== '' ? url : DEFAULT_START_URL
		const created = await this.#send('Target.createTarget', { url: targetUrl })
		const targetId = created?.targetId
		if (typeof targetId !== 'string' || targetId === '') {
			throw new CdpError(CODES.PROTOCOL_ERROR, 'Target.createTarget returned no targetId')
		}
		const attached = await this.#send('Target.attachToTarget', { targetId, flatten: true })
		const sessionId = attached?.sessionId
		if (typeof sessionId !== 'string' || sessionId === '') {
			throw new CdpError(CODES.PROTOCOL_ERROR, `Target.attachToTarget returned no sessionId for ${targetId}`)
		}
		const page = new PageHandle({ connection: this.#connection, targetId, sessionId })
		this.#pages.add(page)
		page.on('close', () => {
			this.#pages.delete(page)
		})
		try {
			await enablePageDomains(this.#connection, sessionId)
		} catch (error) {
			await page.close()
			throw error
		}
		return page
	}

	/**
	 * List page targets.
	 *
	 * @returns {Promise<Array<{ targetId: string, url: string, title: string }>>} page targets.
	 */
	async pages() {
		this.#assertOpen()
		const result = await this.#send('Target.getTargets')
		const targetInfos = Array.isArray(result?.targetInfos) ? result.targetInfos : []
		return targetInfos
			.filter((info) => info?.type === 'page')
			.map((info) => ({ targetId: info.targetId, url: info.url ?? '', title: info.title ?? '' }))
	}

	/**
	 * Close one page target. Closing an already gone page is a no-op.
	 *
	 * @param {string} targetId - target to close.
	 * @returns {Promise<void>} resolves even when the target no longer exists.
	 */
	async closePage(targetId) {
		if (this.#closed) return
		if (typeof targetId !== 'string' || targetId === '') {
			throw new CdpError(CODES.INVALID_ARGUMENT, 'closePage(targetId) requires a non-empty target id')
		}
		try {
			await this.#send('Target.closeTarget', { targetId })
		} catch (error) {
			// A closing browser or a vanished target must not break lifecycle cleanup.
			if (!(error instanceof CdpError) || error.code !== CODES.DISCONNECTED) throw error
		}
	}

	/**
	 * Disconnect the CDP WebSocket and, when this module launched Chrome, end
	 * the Chrome process. Pages are left alone: for a reused Chrome they are the
	 * user's own tabs. Idempotent.
	 *
	 * @returns {Promise<void>} resolves once the socket and child are gone.
	 */
	async close() {
		if (this.#closed) return
		this.#closed = true
		try {
			await this.#connection.close()
		} catch {
			// Closing a dead socket is already the desired end state.
		}
		const child = this.#child
		this.#child = undefined
		if (this.launched && child) await stopChildProcess(child)
	}

	/**
	 * Send one browser-level command (no session id).
	 *
	 * @param {string} method - CDP method.
	 * @param {object} [params] - parameters.
	 * @param {{ timeoutMs?: number }} [options] - timeout override.
	 * @returns {Promise<object>} command result.
	 */
	#send(method, params = {}, options = {}) {
		return this.#connection.send(method, params, options)
	}

	/** @throws {CdpError} when the handle is already closed. */
	#assertOpen() {
		if (this.#closed) {
			throw new CdpError(CODES.DISCONNECTED, `browser on port ${this.port} is closed`)
		}
	}
}

/**
 * Page handle: one flat CDP session plus the convenience operations the
 * collector needs (navigation, evaluation, polling, scrolling, idle, cookies).
 */
class PageHandle {
	#connection
	#listeners = new Map()
	#unsubscribers = []
	#closed = false
	#closedReason = 'unknown reason'
	#networkEnabled = false

	/**
	 * @param {{ connection: CdpConnection, targetId: string, sessionId: string }} options - session facts.
	 */
	constructor(options) {
		this.#connection = options.connection
		/** @type {string} CDP target id of the page. */
		this.targetId = options.targetId
		/** @type {string} flat CDP session id used by every Page/Runtime command. */
		this.sessionId = options.sessionId
		const session = this.sessionId
		this.#unsubscribers = [
			this.#connection.on('Page.loadEventFired', (params, meta) => {
				if (meta.sessionId === session) this.#emit('load', params)
			}),
			this.#connection.on('Page.domContentEventFired', (params, meta) => {
				if (meta.sessionId === session) this.#emit('domContentLoaded', params)
			}),
			this.#connection.on('Page.javascriptDialogOpening', (params, meta) => {
				if (meta.sessionId === session) this.#emit('dialog', params)
			}),
			this.#connection.on('Target.detachedFromTarget', (params) => {
				if (params?.sessionId === session) this.#markClosed('session detached')
			}),
			this.#connection.on('Target.targetDestroyed', (params) => {
				if (params?.targetId === this.targetId) this.#markClosed('target destroyed')
			}),
			this.#connection.on('Inspector.detached', (params, meta) => {
				if (meta.sessionId === session) this.#markClosed(`inspector detached (${params?.reason ?? 'unknown'})`)
			}),
			this.#connection.on('disconnected', (params) => {
				this.#markClosed(params?.reason ?? 'connection closed')
			})
		]
	}

	/**
	 * Navigate and wait for the requested lifecycle event.
	 *
	 * When `Page.navigate` succeeds but the requested event never arrives (e.g. a
	 * page whose load event was already dispatched), the wait degrades to polling
	 * `document.readyState` for another `timeoutMs`, then throws `CDP_TIMEOUT`.
	 *
	 * @param {string} url - absolute URL to open.
	 * @param {{ waitUntil?: 'load'|'domcontentloaded'|'none', timeoutMs?: number }} [options] - wait target and budget.
	 * @returns {Promise<void>} resolves once the page is considered loaded.
	 */
	async goto(url, options = {}) {
		this.#assertOpen()
		if (typeof url !== 'string' || url.trim() === '') {
			throw new CdpError(CODES.INVALID_ARGUMENT, 'goto(url) requires a non-empty URL string')
		}
		const waitUntil = options.waitUntil ?? 'load'
		const timeoutMs = normalizeBudget(options.timeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS)
		const event = waitUntil === 'domcontentloaded' ? 'domContentLoaded' : waitUntil === 'load' ? 'load' : undefined
		const loadWait = event && timeoutMs > 0 ? this.#waitForEvent(event, timeoutMs) : undefined
		let navigation
		try {
			navigation = await this.#send('Page.navigate', { url }, { timeoutMs })
		} catch (error) {
			loadWait?.cancel()
			throw error
		}
		if (navigation?.errorText) {
			loadWait?.cancel()
			throw new CdpError(CODES.NAVIGATION_FAILED, `Page.navigate failed for ${url}: ${navigation.errorText}`)
		}
		if (!event) return
		if (loadWait && (await loadWait.promise)) return
		if (await this.#waitForReadyState(timeoutMs)) return
		throw new CdpError(CODES.TIMEOUT, `page load timed out after ${timeoutMs}ms: ${url}`)
	}

	/**
	 * Evaluate JavaScript in the page main world.
	 *
	 * Strings are sent verbatim (the caller owns any `(${fn})` wrapping); an
	 * actual function argument is wrapped and invoked as `(${fn})()`. A thrown
	 * page error surfaces as `CDP_EVALUATION_ERROR` with the exception text and
	 * the raw `exceptionDetails` on `error.details`.
	 *
	 * @param {string|Function} expression - expression/function to evaluate.
	 * @param {{ awaitPromise?: boolean, returnByValue?: boolean, timeoutMs?: number }} [options] - evaluation flags.
	 * @returns {Promise<unknown>} by value result (or the raw RemoteObject when `returnByValue` is false).
	 */
	async evaluate(expression, options = {}) {
		this.#assertOpen()
		const source = toExpressionSource(expression)
		const awaitPromise = options.awaitPromise !== false
		const returnByValue = options.returnByValue !== false
		const timeoutMs = normalizeBudget(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
		const response = await this.#send(
			'Runtime.evaluate',
			{ expression: source, awaitPromise, returnByValue },
			{ timeoutMs }
		)
		if (response?.exceptionDetails) {
			throw new CdpError(CODES.EVALUATION_ERROR, describeException(response.exceptionDetails), {
				details: response.exceptionDetails
			})
		}
		if (!response?.result) return undefined
		return returnByValue ? response.result.value : response.result
	}

	/**
	 * Run `source` in every new document of this page, before page scripts.
	 * Used for the network recorder.
	 *
	 * @param {string} source - JavaScript source registered on the session.
	 * @returns {Promise<void>} resolves once the script is registered.
	 */
	async addInitScript(source) {
		this.#assertOpen()
		if (typeof source !== 'string' || source.trim() === '') {
			throw new CdpError(CODES.INVALID_ARGUMENT, 'addInitScript(source) requires a non-empty source string')
		}
		await this.#send('Page.addScriptToEvaluateOnNewDocument', { source })
	}

	/**
	 * Poll an expression until it returns a truthy value.
	 *
	 * Transient evaluation errors (contexts destroyed during navigation) are
	 * treated as "not yet"; a disconnected page stops the wait immediately.
	 *
	 * @param {string|Function} expression - polled expression.
	 * @param {{ timeoutMs?: number, intervalMs?: number }} [options] - budget and interval.
	 * @returns {Promise<void>} resolves on the first truthy value.
	 * @throws {CdpError} `CDP_TIMEOUT` when the expression never became truthy.
	 */
	async waitFor(expression, options = {}) {
		this.#assertOpen()
		const source = toExpressionSource(expression)
		const timeoutMs = normalizeBudget(options.timeoutMs, DEFAULT_WAIT_FOR_TIMEOUT_MS)
		const intervalMs = normalizeBudget(options.intervalMs, DEFAULT_WAIT_FOR_INTERVAL_MS)
		let lastError
		const found = await pollUntil(
			async () => {
				this.#assertOpen()
				try {
					const value = await this.evaluate(source)
					lastError = undefined
					return Boolean(value)
				} catch (error) {
					if (error instanceof CdpError && error.code === CODES.DISCONNECTED) throw error
					lastError = error
					return false
				}
			},
			{ timeoutMs, intervalMs }
		)
		if (!found) {
			const suffix = lastError ? `; last error: ${lastError.message}` : ''
			throw new CdpError(CODES.TIMEOUT, `waitFor timed out after ${timeoutMs}ms: ${source}${suffix}`)
		}
	}

	/**
	 * Scroll down in `times` steps, pausing `delayMs` after each step so the
	 * feed/comment list can load. Returns how many scrolls were issued.
	 *
	 * @param {{ times?: number, distance?: number, delayMs?: number }} [options] - scroll plan.
	 * @returns {Promise<number>} number of scroll steps actually performed.
	 */
	async scrollToLoadMore(options = {}) {
		this.#assertOpen()
		const times = normalizeBudget(options.times, DEFAULT_SCROLL_TIMES)
		const distance = normalizeBudget(options.distance, DEFAULT_SCROLL_DISTANCE)
		const delayMs = normalizeBudget(options.delayMs, DEFAULT_SCROLL_DELAY_MS)
		let completed = 0
		for (let index = 0; index < times; index += 1) {
			this.#assertOpen()
			await this.evaluate(`window.scrollBy(0, ${distance})`)
			completed += 1
			if (delayMs > 0) await delay(delayMs)
		}
		return completed
	}

	/**
	 * Wait for `document.readyState === 'complete'`, then for a quiet window in
	 * which readyState/DOM size/scroll height stop changing.
	 *
	 * @param {{ quietMs?: number, timeoutMs?: number }} [options] - quiet window and overall budget.
	 * @returns {Promise<void>} resolves once the page stayed quiet for `quietMs`.
	 * @throws {CdpError} `CDP_TIMEOUT` when the page never settles in time.
	 */
	async waitForIdle(options = {}) {
		this.#assertOpen()
		const quietMs = normalizeBudget(options.quietMs, DEFAULT_IDLE_QUIET_MS)
		const timeoutMs = normalizeBudget(options.timeoutMs, DEFAULT_IDLE_TIMEOUT_MS)
		const deadline = Date.now() + timeoutMs
		const ready = await pollUntil(() => this.evaluate('document.readyState === "complete"'), {
			timeoutMs: Math.max(0, deadline - Date.now()),
			intervalMs: READY_STATE_POLL_INTERVAL_MS
		})
		if (!ready) {
			throw new CdpError(CODES.TIMEOUT, `waitForIdle: document did not reach readyState "complete" within ${timeoutMs}ms`)
		}
		let lastSignature
		let lastChangeAt = Date.now()
		for (;;) {
			const now = Date.now()
			if (now >= deadline) {
				throw new CdpError(CODES.TIMEOUT, `waitForIdle: page did not stay quiet for ${quietMs}ms within ${timeoutMs}ms`)
			}
			if (now - lastChangeAt >= quietMs) return
			const signature = await this.evaluate(IDLE_SIGNATURE_EXPRESSION)
			if (signature !== lastSignature) {
				lastSignature = signature
				lastChangeAt = Date.now()
			}
			const pause = Math.min(IDLE_POLL_INTERVAL_MS, Math.max(MIN_TIMER_MS, quietMs - (Date.now() - lastChangeAt)))
			await delay(pause)
		}
	}

	/**
	 * Read the browser cookies visible to this page (login detection uses this:
	 * Xiaohongshu stores the session in `web_session`).
	 *
	 * Enables the Network domain on first use.
	 *
	 * @param {string[]} [urls] - URL scope; omitted means every cookie of the browser.
	 * @returns {Promise<Array<{ name: string, value: string, domain: string, path: string, expires: number, httpOnly: boolean, secure: boolean }>>} cookies.
	 */
	async getCookies(urls) {
		this.#assertOpen()
		await this.#ensureNetwork()
		const params = Array.isArray(urls) && urls.length > 0 ? { urls } : {}
		const result = await this.#send('Network.getCookies', params)
		return Array.isArray(result?.cookies) ? result.cookies : []
	}

	/**
	 * Bring the page window to the foreground (QR-code login). Best effort: it
	 * never throws, so a background/headed race cannot break the login flow.
	 *
	 * @returns {Promise<void>} always resolves.
	 */
	async bringToFront() {
		if (this.#closed) return
		try {
			await this.#send('Page.bringToFront', {}, { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS })
		} catch {
			// Window focus is a nicety; a closed page or a rejected command is fine.
		}
	}

	/**
	 * Current `location.href`, convenience wrapper over `evaluate`.
	 *
	 * @returns {Promise<string>} the page URL (empty string when unknown).
	 */
	async getLocationHref() {
		const href = await this.evaluate('location.href')
		return typeof href === 'string' ? href : ''
	}

	/**
	 * Subscribe to a page event: `'load'`, `'domContentLoaded'`, `'dialog'` or `'close'`.
	 *
	 * The returned cleanup is synchronous (and also awaits safely), so callers
	 * can write both `const off = page.on(...)` and `const off = await page.on(...)`.
	 *
	 * @param {'load'|'domContentLoaded'|'dialog'|'close'} event - event name.
	 * @param {(payload: object) => void} listener - handler.
	 * @returns {() => void} unsubscribe function.
	 */
	on(event, listener) {
		if (typeof listener !== 'function') {
			throw new CdpError(CODES.INVALID_ARGUMENT, `listener for page event "${event}" must be a function`)
		}
		if (this.#closed) return NOOP
		let listeners = this.#listeners.get(event)
		if (!listeners) {
			listeners = new Set()
			this.#listeners.set(event, listeners)
		}
		listeners.add(listener)
		return () => {
			listeners.delete(listener)
		}
	}

	/**
	 * Close the page target. Idempotent: a second close (or a close after the
	 * browser already went away) resolves without doing anything.
	 *
	 * @returns {Promise<void>} resolves once the target was asked to close.
	 */
	async close() {
		if (this.#closed) return
		const targetId = this.targetId
		this.#markClosed('closed by caller')
		try {
			await this.#connection.send('Target.closeTarget', { targetId })
		} catch {
			// The target may already be gone, or the whole browser is closing.
		}
	}

	/**
	 * Enable the Network domain once per page session, so `Network.getCookies`
	 * can be called.
	 *
	 * @returns {Promise<void>} resolves once Network is enabled.
	 */
	async #ensureNetwork() {
		if (this.#networkEnabled) return
		await this.#send('Network.enable')
		this.#networkEnabled = true
	}

	/**
	 * Send one flat-session command.
	 *
	 * @param {string} method - CDP method.
	 * @param {object} [params] - parameters.
	 * @param {{ timeoutMs?: number }} [options] - timeout override.
	 * @returns {Promise<object>} command result.
	 */
	#send(method, params = {}, options = {}) {
		return this.#connection.send(method, params, { sessionId: this.sessionId, timeoutMs: options.timeoutMs })
	}

	/**
	 * Wait for one page event with a timeout.
	 *
	 * @param {string} event - page event name.
	 * @param {number} timeoutMs - budget; `0` means wait forever (unused by callers).
	 * @returns {{ promise: Promise<boolean>, cancel: () => void }} resolves true on the event, false on timeout/cancel.
	 */
	#waitForEvent(event, timeoutMs) {
		const state = { settled: false, timer: null, off: NOOP, finish: NOOP }
		const promise = new Promise((resolve) => {
			state.finish = (value) => {
				if (state.settled) return
				state.settled = true
				if (state.timer !== null) clearTimeout(state.timer)
				state.off()
				resolve(value === true)
			}
			if (timeoutMs > 0) state.timer = setTimeout(() => state.finish(false), timeoutMs)
			state.off = this.on(event, () => state.finish(true))
		})
		return { promise, cancel: () => state.finish(false) }
	}

	/**
	 * Poll `document.readyState` as the degraded load signal for `goto`.
	 *
	 * @param {number} timeoutMs - budget.
	 * @returns {Promise<boolean>} true once the document is complete.
	 */
	async #waitForReadyState(timeoutMs) {
		const deadline = Date.now() + Math.max(0, timeoutMs)
		for (;;) {
			try {
				const remaining = Math.max(MIN_TIMER_MS, deadline - Date.now())
				const state = await this.evaluate('document.readyState', { timeoutMs: remaining })
				if (state === 'complete') return true
			} catch (error) {
				if (error instanceof CdpError && error.code === CODES.DISCONNECTED) throw error
			}
			const now = Date.now()
			if (now >= deadline) return false
			await delay(Math.min(READY_STATE_POLL_INTERVAL_MS, Math.max(MIN_TIMER_MS, deadline - now)))
		}
	}

	/**
	 * Dispatch one event to page listeners; listener errors are isolated.
	 *
	 * @param {string} event - page event name.
	 * @param {object} payload - event payload.
	 */
	#emit(event, payload) {
		const listeners = this.#listeners.get(event)
		if (!listeners) return
		for (const listener of [...listeners]) {
			try {
				listener(payload)
			} catch {
				// A broken collector listener must not break CDP event dispatch.
			}
		}
	}

	/**
	 * Mark the page as closed exactly once, drop its subscriptions and emit `close`.
	 *
	 * @param {string} reason - why the page disappeared.
	 */
	#markClosed(reason) {
		if (this.#closed) return
		this.#closed = true
		this.#closedReason = reason ?? 'unknown reason'
		for (const unsubscribe of this.#unsubscribers) {
			try {
				unsubscribe()
			} catch {
				// Removing an already detached listener is harmless.
			}
		}
		this.#unsubscribers = []
		this.#emit('close', { reason: this.#closedReason })
		this.#listeners.clear()
	}

	/** @throws {CdpError} when the page or its connection is already closed. */
	#assertOpen() {
		if (this.#closed) {
			throw new CdpError(CODES.DISCONNECTED, `page ${this.targetId} is closed (${this.#closedReason})`)
		}
	}
}

/**
 * Enable Page and Runtime on a fresh flat session.
 *
 * @param {CdpConnection} connection - browser connection.
 * @param {string} sessionId - flat page session.
 * @returns {Promise<void>} resolves once both domains are enabled.
 */
async function enablePageDomains(connection, sessionId) {
	await connection.send('Page.enable', {}, { sessionId })
	await connection.send('Runtime.enable', {}, { sessionId })
}

/**
 * Poll `GET /json/version` once.
 *
 * @param {number} port - CDP port.
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options] - fetch implementation and probe budget.
 * @returns {Promise<object|undefined>} parsed version body, or undefined when not listening.
 */
async function probeChrome(port, options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch
	if (typeof fetchImpl !== 'function') return undefined
	const timeoutMs = normalizeBudget(options.timeoutMs, HTTP_PROBE_TIMEOUT_MS)
	let response
	try {
		response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: createTimeoutSignal(timeoutMs) })
	} catch {
		return undefined
	}
	if (!response || response.ok !== true) return undefined
	try {
		return await response.json()
	} catch {
		return undefined
	}
}

/**
 * Build the Chrome command line. Uses a dedicated profile and no automation flags.
 *
 * @param {{ port: number, userDataDir: string, headless: boolean, startUrl: string }} options - launch facts.
 * @returns {string[]} argv to pass to Chrome.
 */
function buildChromeArgs(options) {
	const args = [
		`--remote-debugging-port=${options.port}`,
		`--user-data-dir=${options.userDataDir}`,
		...CHROME_FLAGS
	]
	if (options.headless) args.push(CHROME_HEADLESS_FLAG)
	if (typeof options.startUrl === 'string' && options.startUrl !== '') args.push(options.startUrl)
	return args
}

/**
 * Watch a spawned Chrome for early `error`/`exit` while its endpoint comes up.
 *
 * @param {object} child - `child_process.spawn` result.
 * @returns {{ error: Error|undefined, exit: { code: number|null, signal: string|null }|undefined }} lifecycle state.
 */
function monitorChild(child) {
	const state = { error: undefined, exit: undefined }
	try {
		child.once?.('error', (error) => {
			state.error = error
		})
	} catch {
		// A fake child without listeners is fine.
	}
	try {
		child.once?.('exit', (code, signal) => {
			state.exit = { code, signal }
		})
	} catch {
		// A fake child without listeners is fine.
	}
	return state
}

/**
 * Stop a Chrome child: SIGTERM first, SIGKILL after the grace period.
 *
 * @param {object} child - spawned child process.
 * @param {number} [graceMs] - wait after SIGTERM.
 * @returns {Promise<void>} resolves once the child is gone or was killed.
 */
async function stopChildProcess(child, graceMs = CHILD_EXIT_GRACE_MS) {
	if (!child) return
	if (child.exitCode !== undefined && child.exitCode !== null) return
	let resolveExit = NOOP
	const exitPromise = new Promise((resolve) => {
		resolveExit = resolve
	})
	const unsubscribers = [
		subscribeChild(child, 'exit', () => resolveExit(true)),
		subscribeChild(child, 'close', () => resolveExit(true))
	]
	try {
		child.kill?.('SIGTERM')
	} catch {
		// The process may already be gone.
	}
	let timer = null
	const timeoutPromise = new Promise((resolve) => {
		timer = setTimeout(() => resolve(false), normalizeBudget(graceMs, CHILD_EXIT_GRACE_MS))
	})
	const graceful = await Promise.race([exitPromise, timeoutPromise])
	if (timer !== null) clearTimeout(timer)
	for (const unsubscribe of unsubscribers) unsubscribe()
	if (graceful || (child.exitCode !== undefined && child.exitCode !== null)) return
	try {
		child.kill?.('SIGKILL')
	} catch {
		// Nothing left to kill.
	}
}

/**
 * Register one child-process listener and return its remover.
 *
 * @param {object} child - spawned child process.
 * @param {string} event - event name.
 * @param {Function} listener - handler.
 * @returns {() => void} remover.
 */
function subscribeChild(child, event, listener) {
	if (typeof child.once !== 'function') return NOOP
	try {
		child.once(event, listener)
	} catch {
		return NOOP
	}
	return () => {
		try {
			child.removeListener?.(event, listener)
		} catch {
			// Nothing to remove.
		}
	}
}

/**
 * Wait for the browser WebSocket handshake.
 *
 * @param {WebSocket} socket - socket created by `new WebSocket(url)`.
 * @param {number} timeoutMs - budget.
 * @returns {Promise<void>} resolves on `open`.
 */
async function waitForSocketOpen(socket, timeoutMs) {
	if (socket?.readyState === SOCKET_OPEN) return
	await new Promise((resolve, reject) => {
		let settled = false
		let timer = null
		const unsubscribers = []
		const finish = (error) => {
			if (settled) return
			settled = true
			if (timer !== null) clearTimeout(timer)
			for (const unsubscribe of unsubscribers) {
				try {
					unsubscribe()
				} catch {
					// Best effort: the socket is going away anyway.
				}
			}
			if (error) reject(error)
			else resolve()
		}
		timer = setTimeout(
			() => finish(new CdpError(CODES.TIMEOUT, `WebSocket handshake timed out after ${timeoutMs}ms`)),
			timeoutMs
		)
		unsubscribers.push(addSocketListener(socket, 'open', () => finish()))
		unsubscribers.push(
			addSocketListener(socket, 'error', (event) => {
				finish(new CdpError(CODES.DISCONNECTED, `WebSocket failed to open: ${describeSocketError(event)}`))
			})
		)
		unsubscribers.push(
			addSocketListener(socket, 'close', (event) => {
				finish(new CdpError(CODES.DISCONNECTED, `WebSocket closed before opening (${describeCloseEvent(event)})`))
			})
		)
		if (socket?.readyState === SOCKET_OPEN) finish()
	})
}

/**
 * Attach one socket listener, supporting both `EventTarget` sockets (Node's
 * global WebSocket) and the legacy `onopen=`/`onmessage=` shape used by fakes.
 *
 * @param {object} socket - WebSocket-like object.
 * @param {'open'|'close'|'error'|'message'} type - event name.
 * @param {Function} handler - listener.
 * @returns {() => void} remover.
 */
function addSocketListener(socket, type, handler) {
	if (socket && typeof socket.addEventListener === 'function') {
		socket.addEventListener(type, handler)
		return () => {
			try {
				socket.removeEventListener?.(type, handler)
			} catch {
				// Already detached.
			}
		}
	}
	const key = `on${type}`
	const previous = socket?.[key]
	const wrapped = (event) => {
		if (typeof previous === 'function') previous.call(socket, event)
		handler(event)
	}
	if (socket) socket[key] = wrapped
	return () => {
		if (socket && socket[key] === wrapped) socket[key] = previous
	}
}

/**
 * Decode a binary WebSocket frame into CDP JSON text.
 *
 * @param {ArrayBuffer|ArrayBufferView|Blob|unknown} data - frame payload.
 * @returns {Promise<string|undefined>} decoded text, or undefined when unsupported.
 */
async function decodeFrame(data) {
	if (data instanceof ArrayBuffer) return TEXT_DECODER.decode(new Uint8Array(data))
	if (ArrayBuffer.isView(data)) return TEXT_DECODER.decode(data)
	if (data && typeof data === 'object' && typeof data.text === 'function') {
		try {
			return await data.text()
		} catch {
			return undefined
		}
	}
	return undefined
}

/**
 * `AbortSignal.timeout` when available, so a hung probe cannot leak.
 *
 * @param {number} timeoutMs - budget.
 * @returns {AbortSignal|undefined} signal for fetch.
 */
function createTimeoutSignal(timeoutMs) {
	if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined
	try {
		return AbortSignal.timeout(Math.max(MIN_TIMER_MS, timeoutMs))
	} catch {
		return undefined
	}
}

/**
 * Poll `check` until truthy or the budget is exhausted.
 *
 * @param {() => Promise<boolean>|boolean} check - one probe.
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options] - budget and interval.
 * @returns {Promise<boolean>} true when the probe returned truthy.
 */
async function pollUntil(check, options = {}) {
	const timeoutMs = normalizeBudget(options.timeoutMs, DEFAULT_WAIT_FOR_TIMEOUT_MS)
	const intervalMs = normalizeBudget(options.intervalMs, DEFAULT_WAIT_FOR_INTERVAL_MS)
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (await check()) return true
		const now = Date.now()
		if (now >= deadline) return false
		await delay(Math.min(intervalMs, Math.max(MIN_TIMER_MS, deadline - now)))
	}
}

/**
 * Turn a caller expression into CDP source.
 *
 * @param {string|Function} expression - expression or function.
 * @returns {string} source passed to `Runtime.evaluate`.
 */
function toExpressionSource(expression) {
	if (typeof expression === 'function') return `(${expression.toString()})()`
	if (typeof expression === 'string' && expression.trim() !== '') return expression
	throw new CdpError(CODES.INVALID_ARGUMENT, 'expression must be a non-empty string or a function')
}

/**
 * Summarise `Runtime.evaluate`'s `exceptionDetails` into one readable line.
 *
 * @param {object} details - CDP exception details.
 * @returns {string} page error text.
 */
function describeException(details) {
	const description = details?.exception?.description
	if (typeof description === 'string' && description.trim() !== '') return firstLine(description)
	const value = details?.exception?.value
	if (value !== undefined) return typeof value === 'string' ? value : safeStringify(value)
	const text = typeof details?.text === 'string' && details.text !== '' ? details.text : 'JavaScript evaluation failed'
	const line = details?.lineNumber
	return line === undefined ? text : `${text} (line ${line})`
}

/**
 * First line of a multi-line error description.
 *
 * @param {string} text - error description.
 * @returns {string} first line.
 */
function firstLine(text) {
	const index = text.indexOf('\n')
	return index === -1 ? text.trim() : text.slice(0, index).trim()
}

/**
 * JSON stringify that never throws.
 *
 * @param {unknown} value - any value.
 * @returns {string} JSON text or a fallback string.
 */
function safeStringify(value) {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

/**
 * Readable description of a socket close event.
 *
 * @param {{ code?: number, reason?: string }} [event] - close event.
 * @returns {string} e.g. `1006: network gone`.
 */
function describeCloseEvent(event) {
	const code = event?.code ?? 'unknown code'
	const reason = event?.reason
	return reason ? `${code}: ${reason}` : String(code)
}

/**
 * Readable description of a socket error event.
 *
 * @param {unknown} event - error event or Error.
 * @returns {string} message.
 */
function describeSocketError(event) {
	if (event instanceof Error) return event.message
	const message = event?.message ?? event?.error?.message
	return typeof message === 'string' && message !== '' ? message : 'unknown socket error'
}

/**
 * Describe a child that exited before its CDP endpoint came up.
 *
 * @param {{ code: number|null, signal: string|null }} exit - exit facts.
 * @returns {string} error message.
 */
function describeUnexpectedExit(exit) {
	const signal = exit.signal ? `, signal ${exit.signal}` : ''
	return `Chrome exited before CDP was ready (exit code ${exit.code ?? 'null'}${signal})`
}

/**
 * Validate and normalise a CDP port.
 *
 * @param {number|string|undefined} port - requested port.
 * @returns {number} integer port.
 */
function assertPort(port) {
	const value = port === undefined || port === null || port === '' ? DEFAULT_CHROME_PORT : Number(port)
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new CdpError(CODES.INVALID_ARGUMENT, `invalid CDP port: ${String(port)}`)
	}
	return value
}

/**
 * Normalise an optional budget/interval into a non-negative integer.
 *
 * @param {unknown} value - raw option.
 * @param {number} fallback - default when absent/invalid.
 * @returns {number} non-negative integer.
 */
function normalizeBudget(value, fallback) {
	if (value === undefined || value === null) return fallback
	const number = Number(value)
	if (!Number.isFinite(number)) return fallback
	return Math.max(0, Math.trunc(number))
}

/**
 * Sleep helper.
 *
 * @param {number} milliseconds - wait duration.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(milliseconds) {
	return new Promise((resolve) => {
		setTimeout(resolve, Math.max(0, milliseconds))
	})
}
