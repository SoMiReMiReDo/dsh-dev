/**
 * Protocol-layer tests for `lib/cdp.mjs`.
 *
 * No real Chrome and no network: a fake `WebSocket` class and a fake `fetch`
 * are injected into `connectChrome`/`launchChrome`, and the launch tests inject
 * a fake `child_process.spawn` result. The tests pin the contract from
 * CONTRACT.md §2: id-based response dispatch, command timeout, wholesale reject
 * on disconnect, Chrome launch argv, page helpers (scroll/evaluate/init
 * script/goto/cookies/bringToFront) and handle idempotency.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	CDP_ERROR_CODES,
	CdpError,
	connectChrome,
	isChromeListening,
	launchChrome
} from '../lib/cdp.mjs'

/** Port and endpoint the fake /json/version reports. */
const PORT = 9333
const WS_URL = `ws://127.0.0.1:${PORT}/devtools/browser/fake-browser`
const SESSION_ID = 'fake-session'
const TARGET_ID = 'fake-target'

/** Fake `/json/version` body for a listening Chrome. */
function versionResponse(wsUrl = WS_URL) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ Browser: 'Chrome/144.0.0.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: wsUrl })
	}
}

/** Fetch implementation that always reports a listening CDP endpoint. */
function listeningFetch(wsUrl = WS_URL) {
	return async () => versionResponse(wsUrl)
}

/** Fetch implementation that reports nothing listening (connection refused). */
function refusedFetch() {
	return async () => {
		throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:9333')
	}
}

/** Default CDP answers for the commands the client sends during setup. */
function defaultResult(message) {
	switch (message.method) {
		case 'Target.createTarget':
			return { targetId: TARGET_ID }
		case 'Target.attachToTarget':
			return { sessionId: SESSION_ID }
		case 'Target.getTargets':
			return {
				targetInfos: [
					{ targetId: TARGET_ID, type: 'page', url: 'https://www.xiaohongshu.com/explore', title: '小红书' },
					{ targetId: 'fake-worker', type: 'service_worker', url: 'https://www.xiaohongshu.com/sw.js', title: '' }
				]
			}
		case 'Page.navigate':
			return { frameId: 'fake-frame' }
		case 'Network.getCookies':
			return { cookies: [] }
		case 'Runtime.evaluate':
			return { result: { type: 'undefined' } }
		default:
			return {}
	}
}

/**
 * Build a responder: per-method overrides win, everything else uses defaults.
 * Returning `undefined` from an override holds the response (manual control),
 * returning an `Error` sends a JSON-RPC error frame.
 *
 * @param {Record<string, Function>} [overrides] - per-method handlers.
 * @returns {(message: object, socket: object) => object|Error|undefined} responder.
 */
function autoRespond(overrides = {}) {
	return (message, socket) => {
		const override = overrides[message.method]
		if (typeof override === 'function') return override(message, socket)
		return defaultResult(message)
	}
}

/**
 * Fake browser-level WebSocket. Opens on the next microtask and answers every
 * command through `respond`.
 *
 * @param {{ respond?: Function }} [options] - responder.
 * @returns {{ FakeWebSocket: Function, instances: object[] }} fake class plus its instances.
 */
function createFakeWebSocket(options = {}) {
	const respond = options.respond ?? autoRespond()
	const instances = []

	class FakeWebSocket {
		constructor(url) {
			this.url = url
			this.readyState = 0
			this.listeners = new Map()
			this.sent = []
			this.closed = false
			instances.push(this)
			queueMicrotask(() => this.#open())
		}

		#open() {
			if (this.readyState !== 0) return
			this.readyState = 1
			this.emit('open', { type: 'open' })
		}

		addEventListener(type, listener) {
			let listeners = this.listeners.get(type)
			if (!listeners) {
				listeners = new Set()
				this.listeners.set(type, listeners)
			}
			listeners.add(listener)
		}

		removeEventListener(type, listener) {
			this.listeners.get(type)?.delete(listener)
		}

		emit(type, event) {
			for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
		}

		send(raw) {
			const message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
			this.sent.push(message)
			const result = respond(message, this)
			if (result === undefined) return
			if (result instanceof Error) {
				queueMicrotask(() => {
					if (this.closed) return
					this.receive({ id: message.id, error: { code: -32000, message: result.message } })
				})
				return
			}
			queueMicrotask(() => {
				if (this.closed) return
				this.receive({ id: message.id, result })
			})
		}

		receive(message) {
			if (this.closed) return
			this.emit('message', { data: JSON.stringify(message) })
		}

		/** Simulated graceful socket close (client side). */
		close() {
			if (this.closed) return
			this.closed = true
			this.readyState = 3
			this.emit('close', { code: 1000, reason: 'client closed' })
		}

		/** Simulated network drop (Chrome died, cable pulled, ...). */
		drop() {
			if (this.closed) return
			this.closed = true
			this.readyState = 3
			this.emit('close', { code: 1006, reason: 'network gone' })
		}
	}

	return { FakeWebSocket, instances }
}

/**
 * Connect a fake browser and open one fake page.
 *
 * @param {{ respond?: Function }} [options] - fake socket responder.
 * @returns {Promise<{ browser: object, page: object, socket: object, FakeWebSocket: Function, instances: object[] }>} fakes plus handles.
 */
async function openFakePage(options = {}) {
	const fake = createFakeWebSocket(options)
	const browser = await connectChrome(PORT, { fetchImpl: listeningFetch(), WebSocketImpl: fake.FakeWebSocket })
	const page = await browser.newPage()
	return { browser, page, socket: fake.instances[0], FakeWebSocket: fake.FakeWebSocket, instances: fake.instances }
}

/**
 * Fake `child_process.spawn` result that exits when killed.
 *
 * @param {{ pid?: number }} [options] - pid to report.
 * @returns {object} child-like object.
 */
function createFakeChild(options = {}) {
	const listeners = new Map()
	const child = {
		pid: options.pid ?? 4242,
		exitCode: null,
		signals: [],
		kill(signal = 'SIGTERM') {
			child.signals.push(signal)
			if (child.exitCode !== null) return true
			child.exitCode = 0
			setTimeout(() => emit('exit', 0, signal), 0)
			return true
		},
		once(type, listener) {
			if (!listeners.has(type)) listeners.set(type, new Set())
			listeners.get(type).add(listener)
		},
		removeListener(type, listener) {
			listeners.get(type)?.delete(listener)
		}
	}
	/** Finish the child without going through kill (simulates Chrome crashing). */
	child.exitNow = (code = 1, signal = null) => {
		child.exitCode = code
		emit('exit', code, signal)
	}

	function emit(type, ...args) {
		for (const listener of [...(listeners.get(type) ?? [])]) listener(...args)
	}
	return child
}

/**
 * Temporarily create an isolated profile directory that launchChrome will pass
 * to Chrome; cleaned up by the caller.
 *
 * @returns {Promise<string>} absolute directory path.
 */
async function makeProfileDir() {
	return mkdtemp(join(tmpdir(), 'xhs-check-cdp-test-'))
}

test('responses are dispatched by message id, not by arrival order', async (t) => {
	const pending = []
	const { FakeWebSocket, instances } = createFakeWebSocket({
		respond: autoRespond({
			// Hold Runtime.evaluate so the test can answer in reverse order.
			'Runtime.evaluate': (message) => {
				pending.push(message)
				return undefined
			}
		})
	})
	const browser = await connectChrome(PORT, { fetchImpl: listeningFetch(), WebSocketImpl: FakeWebSocket })
	t.after(() => browser.close())
	const page = await browser.newPage()

	const first = page.evaluate('slow()')
	const second = page.evaluate('fast()')
	assert.equal(pending.length, 2)

	const socket = instances[0]
	socket.receive({ id: pending[1].id, result: { result: { type: 'string', value: 'fast-value' } } })
	socket.receive({ id: pending[0].id, result: { result: { type: 'string', value: 'slow-value' } } })

	assert.equal(await second, 'fast-value')
	assert.equal(await first, 'slow-value')
})

test('a command that never gets an answer rejects with CDP_TIMEOUT', async (t) => {
	const { browser, page } = await openFakePage({
		respond: autoRespond({ 'Runtime.evaluate': () => undefined })
	})
	t.after(() => browser.close())

	await assert.rejects(page.evaluate('1 + 1', { timeoutMs: 40 }), (error) => {
		assert.ok(error instanceof CdpError)
		assert.equal(error.code, CDP_ERROR_CODES.TIMEOUT)
		assert.match(error.message, /Runtime\.evaluate/)
		return true
	})
})

test('a dropped socket rejects every pending command with CDP_DISCONNECTED', async (t) => {
	const { browser, page, socket } = await openFakePage({
		respond: autoRespond({ 'Runtime.evaluate': () => undefined })
	})
	t.after(() => browser.close())

	const settled = Promise.allSettled([page.evaluate('one()'), page.evaluate('two()')])
	socket.drop()
	const results = await settled
	for (const result of results) {
		assert.equal(result.status, 'rejected')
		assert.ok(result.reason instanceof CdpError)
		assert.equal(result.reason.code, CDP_ERROR_CODES.DISCONNECTED)
	}
	await assert.rejects(page.evaluate('three()'), (error) => {
		assert.equal(error.code, CDP_ERROR_CODES.DISCONNECTED)
		return true
	})
})

test('launchChrome reuses a Chrome that already listens on the port', async (t) => {
	let spawnCalls = 0
	const spawnImpl = () => {
		spawnCalls += 1
		throw new Error('spawn must not be called when the port is already open')
	}
	const { FakeWebSocket, instances } = createFakeWebSocket()
	const browser = await launchChrome({
		port: PORT,
		userDataDir: join(tmpdir(), 'xhs-check-should-not-be-used'),
		fetchImpl: listeningFetch(),
		spawnImpl,
		WebSocketImpl: FakeWebSocket
	})
	t.after(() => browser.close())

	assert.equal(spawnCalls, 0)
	assert.equal(browser.launched, false)
	assert.equal(browser.pid, undefined)
	assert.equal(browser.port, PORT)
	assert.equal(browser.wsUrl, WS_URL)
	assert.equal(instances.length, 1)
	assert.equal(instances[0].url, WS_URL)
})

test('launchChrome spawns Chrome with isolated-profile flags and no automation flags', async (t) => {
	const profileDir = await makeProfileDir()
	t.after(() => rm(profileDir, { recursive: true, force: true }))

	const child = createFakeChild()
	const spawnCalls = []
	const spawnImpl = (command, args, spawnOptions) => {
		spawnCalls.push({ command, args, spawnOptions })
		return child
	}
	let probeCount = 0
	const fetchImpl = async () => {
		probeCount += 1
		if (probeCount === 1) throw new Error('fetch failed: ECONNREFUSED')
		return versionResponse()
	}
	const { FakeWebSocket } = createFakeWebSocket()
	const browser = await launchChrome({
		port: PORT,
		userDataDir: profileDir,
		fetchImpl,
		spawnImpl,
		WebSocketImpl: FakeWebSocket,
		launchTimeoutMs: 2_000,
		pollIntervalMs: 5
	})
	t.after(() => browser.close())

	assert.equal(spawnCalls.length, 1)
	const [{ command, args, spawnOptions }] = spawnCalls
	assert.equal(command, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
	assert.ok(args.includes(`--remote-debugging-port=${PORT}`))
	assert.ok(args.includes(`--user-data-dir=${profileDir}`))
	assert.ok(args.includes('--no-first-run'))
	assert.ok(args.includes('--no-default-browser-check'))
	assert.ok(args.includes('--window-size=1440,900'))
	assert.ok(args.includes('--disable-background-timer-throttling'))
	assert.equal(args.some((arg) => arg.includes('enable-automation')), false)
	assert.equal(args.some((arg) => arg.startsWith('--headless')), false)
	assert.deepEqual(spawnOptions, { detached: false, stdio: 'ignore' })

	assert.equal(browser.launched, true)
	assert.equal(browser.pid, child.pid)
	const profile = await stat(profileDir)
	assert.equal(profile.isDirectory(), true)

	await browser.close()
	assert.deepEqual(child.signals, ['SIGTERM'])
})

test('launchChrome adds --headless only when explicitly requested', async (t) => {
	const profileDir = await makeProfileDir()
	t.after(() => rm(profileDir, { recursive: true, force: true }))

	const child = createFakeChild({ pid: 5151 })
	let capturedArgs = []
	let probeCount = 0
	const fetchImpl = async () => {
		probeCount += 1
		if (probeCount === 1) throw new Error('fetch failed: ECONNREFUSED')
		return versionResponse()
	}
	const { FakeWebSocket } = createFakeWebSocket()
	const browser = await launchChrome({
		port: PORT,
		userDataDir: profileDir,
		headless: true,
		fetchImpl,
		spawnImpl: (chromePath, args) => {
			capturedArgs = args
			return child
		},
		WebSocketImpl: FakeWebSocket,
		launchTimeoutMs: 2_000,
		pollIntervalMs: 5
	})
	t.after(() => browser.close())

	assert.ok(capturedArgs.includes('--headless=new'))
	assert.equal(browser.launched, true)
})

test('launchChrome fails with CDP_LAUNCH_FAILED when Chrome exits before CDP is up', async (t) => {
	const profileDir = await makeProfileDir()
	t.after(() => rm(profileDir, { recursive: true, force: true }))

	const child = createFakeChild()
	const exitTimer = setTimeout(() => child.exitNow(1, null), 10)
	t.after(() => clearTimeout(exitTimer))

	const { FakeWebSocket } = createFakeWebSocket()
	await assert.rejects(
		launchChrome({
			port: PORT,
			userDataDir: profileDir,
			fetchImpl: refusedFetch(),
			spawnImpl: () => child,
			WebSocketImpl: FakeWebSocket,
			launchTimeoutMs: 2_000,
			pollIntervalMs: 5
		}),
		(error) => {
			assert.ok(error instanceof CdpError)
			assert.equal(error.code, CDP_ERROR_CODES.LAUNCH_FAILED)
			return true
		}
	)
})

test('scrollToLoadMore runs exactly the requested number of scroll steps', async (t) => {
	const expressions = []
	const { browser, page } = await openFakePage({
		respond: autoRespond({
			'Runtime.evaluate': (message) => {
				expressions.push(message.params.expression)
				return { result: { type: 'undefined' } }
			}
		})
	})
	t.after(() => browser.close())

	const count = await page.scrollToLoadMore({ times: 3, distance: 500, delayMs: 1 })
	assert.equal(count, 3)
	assert.equal(expressions.length, 3)
	for (const expression of expressions) {
		assert.match(expression, /window\.scrollBy\(0, 500\)/)
	}

	const none = await page.scrollToLoadMore({ times: 0, distance: 500, delayMs: 1 })
	assert.equal(none, 0)
	assert.equal(expressions.length, 3)
})

test('evaluate surfaces exceptionDetails as CDP_EVALUATION_ERROR', async (t) => {
	const { browser, page } = await openFakePage({
		respond: autoRespond({
			'Runtime.evaluate': () => ({
				result: { type: 'object', subtype: 'error' },
				exceptionDetails: {
					text: 'Uncaught',
					lineNumber: 0,
					columnNumber: 6,
					exception: {
						type: 'object',
						subtype: 'error',
						description: 'Error: boom from page\n    at <anonymous>:1:7'
					}
				}
			})
		})
	})
	t.after(() => browser.close())

	await assert.rejects(page.evaluate('throw new Error("boom from page")'), (error) => {
		assert.ok(error instanceof CdpError)
		assert.equal(error.code, CDP_ERROR_CODES.EVALUATION_ERROR)
		assert.match(error.message, /boom from page/)
		assert.ok(error.details.exceptionDetails ?? error.details.exception)
		return true
	})
})

test('evaluate forwards awaitPromise/returnByValue and returns the raw result when asked', async (t) => {
	const sentParams = []
	const { browser, page } = await openFakePage({
		respond: autoRespond({
			'Runtime.evaluate': (message) => {
				sentParams.push(message.params)
				return message.params.returnByValue
					? { result: { type: 'number', value: 2 } }
					: { result: { type: 'object', className: 'Promise', description: 'Promise' } }
			}
		})
	})
	t.after(() => browser.close())

	assert.equal(await page.evaluate('1 + 1'), 2)
	assert.deepEqual(sentParams[0], { expression: '1 + 1', awaitPromise: true, returnByValue: true })

	const raw = await page.evaluate('Promise.resolve(2)', { awaitPromise: false, returnByValue: false })
	assert.deepEqual(raw, { type: 'object', className: 'Promise', description: 'Promise' })
	assert.equal(sentParams[1].awaitPromise, false)
	assert.equal(sentParams[1].returnByValue, false)
})

test('addInitScript registers the source on new documents', async (t) => {
	const { browser, page, socket } = await openFakePage()
	t.after(() => browser.close())

	await page.addInitScript('window.__XHS_NET__ = []')
	const message = socket.sent.find((entry) => entry.method === 'Page.addScriptToEvaluateOnNewDocument')
	assert.ok(message)
	assert.equal(message.params.source, 'window.__XHS_NET__ = []')
	assert.equal(message.sessionId, SESSION_ID)

	await assert.rejects(page.addInitScript(''), (error) => {
		assert.equal(error.code, CDP_ERROR_CODES.INVALID_ARGUMENT)
		return true
	})
})

test('goto resolves on Page.loadEventFired and sends the URL', async (t) => {
	let navigateParams
	const { browser, page, socket } = await openFakePage({
		respond: autoRespond({
			'Page.navigate': (message) => {
				navigateParams = message.params
				setImmediate(() => {
					socket.receive({ method: 'Page.loadEventFired', sessionId: SESSION_ID, params: { timestamp: 1 } })
				})
				return { frameId: 'fake-frame' }
			}
		})
	})
	t.after(() => browser.close())

	await page.goto('https://www.xiaohongshu.com/explore', { timeoutMs: 1_000 })
	assert.deepEqual(navigateParams, { url: 'https://www.xiaohongshu.com/explore' })
	const navigateMessage = socket.sent.find((entry) => entry.method === 'Page.navigate')
	assert.equal(navigateMessage.sessionId, SESSION_ID)
})

test('goto falls back to polling document.readyState when the load event is missed', async (t) => {
	const { browser, page } = await openFakePage({
		respond: autoRespond({
			// No Page.loadEventFired is ever emitted: goto must poll readyState.
			'Page.navigate': () => ({ frameId: 'fake-frame' }),
			'Runtime.evaluate': (message) => ({
				result: {
					type: 'string',
					value: message.params.expression === 'document.readyState' ? 'complete' : ''
				}
			})
		})
	})
	t.after(() => browser.close())

	await page.goto('https://www.xiaohongshu.com/explore', { timeoutMs: 60 })
})

test('getCookies enables Network once and returns the cookie array', async (t) => {
	const cookies = [
		{
			name: 'web_session',
			value: 'fake-session-value',
			domain: '.xiaohongshu.com',
			path: '/',
			expires: 1_800_000_000,
			httpOnly: true,
			secure: true
		},
		{ name: 'a1', value: 'fake-a1', domain: '.xiaohongshu.com', path: '/', expires: 1_800_000_000, httpOnly: false, secure: true }
	]
	const { browser, page, socket } = await openFakePage({
		respond: autoRespond({
			'Network.enable': () => ({}),
			'Network.getCookies': () => ({ cookies })
		})
	})
	t.after(() => browser.close())

	const first = await page.getCookies(['https://www.xiaohongshu.com/'])
	assert.deepEqual(first, cookies)

	const enableCalls = socket.sent.filter((entry) => entry.method === 'Network.enable')
	assert.equal(enableCalls.length, 1)
	assert.equal(enableCalls[0].sessionId, SESSION_ID)
	const getCookieCalls = socket.sent.filter((entry) => entry.method === 'Network.getCookies')
	assert.deepEqual(getCookieCalls[0].params, { urls: ['https://www.xiaohongshu.com/'] })
	assert.equal(getCookieCalls[0].sessionId, SESSION_ID)

	const second = await page.getCookies()
	assert.deepEqual(second, cookies)
	assert.equal(socket.sent.filter((entry) => entry.method === 'Network.enable').length, 1)
	assert.deepEqual(
		socket.sent.filter((entry) => entry.method === 'Network.getCookies')[1].params,
		{}
	)
})

test('bringToFront never throws, even when the command fails', async (t) => {
	const { browser, page, socket } = await openFakePage({
		respond: autoRespond({
			'Page.bringToFront': () => new Error('Browser window is not active')
		})
	})
	t.after(() => browser.close())

	await page.bringToFront()
	const message = socket.sent.find((entry) => entry.method === 'Page.bringToFront')
	assert.ok(message)
	assert.deepEqual(message.params, {})
	assert.equal(message.sessionId, SESSION_ID)
})

test('getLocationHref wraps evaluate(location.href)', async (t) => {
	const { browser, page } = await openFakePage({
		respond: autoRespond({
			'Runtime.evaluate': () => ({
				result: { type: 'string', value: 'https://www.xiaohongshu.com/explore?channel_id=homefeed' }
			})
		})
	})
	t.after(() => browser.close())

	assert.equal(await page.getLocationHref(), 'https://www.xiaohongshu.com/explore?channel_id=homefeed')
})

test('waitFor polls until the expression is truthy', async (t) => {
	let polls = 0
	const { browser, page } = await openFakePage({
		respond: autoRespond({
			'Runtime.evaluate': (message) => {
				polls += 1
				const value = polls >= 3
				return { result: { type: 'boolean', value } }
			}
		})
	})
	t.after(() => browser.close())

	await page.waitFor('window.__ready === true', { timeoutMs: 500, intervalMs: 1 })
	assert.ok(polls >= 3)
})

test('waitFor rejects with CDP_TIMEOUT when the expression never turns truthy', async (t) => {
	const { browser, page } = await openFakePage({
		respond: autoRespond({
			'Runtime.evaluate': () => ({ result: { type: 'boolean', value: false } })
		})
	})
	t.after(() => browser.close())

	await assert.rejects(page.waitFor('window.__never === true', { timeoutMs: 50, intervalMs: 5 }), (error) => {
		assert.equal(error.code, CDP_ERROR_CODES.TIMEOUT)
		return true
	})
})

test('waitForIdle waits for readyState and then a quiet window', async (t) => {
	let signatureSamples = 0
	const { browser, page } = await openFakePage({
		respond: autoRespond({
			'Runtime.evaluate': (message) => {
				const expression = message.params.expression
				if (expression === 'document.readyState === "complete"') {
					return { result: { type: 'boolean', value: true } }
				}
				if (expression.startsWith('JSON.stringify(')) {
					signatureSamples += 1
					return { result: { type: 'string', value: JSON.stringify(['complete', 100, 2000]) } }
				}
				return { result: { type: 'undefined' } }
			}
		})
	})
	t.after(() => browser.close())

	const startedAt = Date.now()
	await page.waitForIdle({ quietMs: 20, timeoutMs: 1_000 })
	assert.ok(Date.now() - startedAt >= 15)
	assert.ok(signatureSamples >= 1)
})

test('waitForIdle rejects with CDP_TIMEOUT when the quiet window cannot fit', async (t) => {
	const { browser, page } = await openFakePage({
		respond: autoRespond({
			'Runtime.evaluate': () => ({ result: { type: 'boolean', value: true } })
		})
	})
	t.after(() => browser.close())

	await assert.rejects(page.waitForIdle({ quietMs: 50, timeoutMs: 20 }), (error) => {
		assert.equal(error.code, CDP_ERROR_CODES.TIMEOUT)
		return true
	})
})

test('pages() lists only page targets', async (t) => {
	const { browser } = await openFakePage()
	t.after(() => browser.close())

	const pages = await browser.pages()
	assert.deepEqual(pages, [
		{ targetId: TARGET_ID, url: 'https://www.xiaohongshu.com/explore', title: '小红书' }
	])
})

test('browser and page handles are idempotent after close', async (t) => {
	const { browser, page } = await openFakePage()
	t.after(() => browser.close())

	await page.close()
	await page.close()
	await browser.close()
	await browser.close()
	await assert.rejects(browser.newPage(), (error) => {
		assert.equal(error.code, CDP_ERROR_CODES.DISCONNECTED)
		return true
	})
})

test('page events fan out to on() listeners, filter by session and detach via cleanup', async (t) => {
	const { browser, page, socket } = await openFakePage()
	t.after(() => browser.close())

	const loads = []
	const off = page.on('load', (params) => loads.push(params))
	assert.equal(typeof off, 'function')
	socket.receive({ method: 'Page.loadEventFired', sessionId: SESSION_ID, params: { timestamp: 7 } })
	socket.receive({ method: 'Page.loadEventFired', sessionId: 'another-session', params: { timestamp: 8 } })
	assert.deepEqual(loads, [{ timestamp: 7 }])
	off()
	socket.receive({ method: 'Page.loadEventFired', sessionId: SESSION_ID, params: { timestamp: 9 } })
	assert.equal(loads.length, 1)

	const closes = []
	page.on('close', (payload) => closes.push(payload.reason))
	await browser.close()
	assert.deepEqual(closes, ['client closed the connection'])
})

test('isChromeListening reports endpoint availability without throwing', async () => {
	assert.equal(await isChromeListening(PORT, { fetchImpl: listeningFetch() }), true)
	assert.equal(await isChromeListening(PORT, { fetchImpl: refusedFetch() }), false)
	assert.equal(
		await isChromeListening(PORT, {
			fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) })
		}),
		false
	)
})
