/**
 * Browser-half unit tests for dsh-inner-chrome.
 *
 * The Client module is a plain `window.__ModuleLoader__` bundle factory, so the
 * test installs a minimal `window`/`document`/React surface, imports the module
 * for its registration side effect, and then drives `apply()` with a fake
 * Client ctx. This pins the plugin's own contract without a browser: the tab
 * type takeover, the body/header Slot registrations, the `innerChrome` service,
 * the one-time chat preference migration, and the pure URL/command helpers.
 *
 * Zero dependencies: `node --test inner-chrome/test/client.test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Fetches made through the global stub. */
const fetchCalls = []

/** Commands the next poll returns; empty means "hang like a long poll". */
const pollCommands = []

/** Build one JSON Response. */
function jsonResponse(payload) {
	return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** Rejection used when a test disposes an in-flight long poll. */
function abortError() {
	const error = new Error('aborted')
	error.name = 'AbortError'
	return error
}

// The Host half long-polls: the stub hangs `poll` until the bridge (or the test
// teardown) aborts it, exactly like a real deployment with no pending command.
globalThis.fetch = (path, init) => {
	fetchCalls.push({ path, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
	if (path === '/api/inner-chrome.hello') return Promise.resolve(jsonResponse({ ok: true, protocol: 1, version: '0.2.0' }))
	if (path === '/api/inner-chrome.result') return Promise.resolve(jsonResponse({ ok: true }))
	if (path === '/api/inner-chrome.poll') {
		if (pollCommands.length > 0) return Promise.resolve(jsonResponse({ ok: true, command: pollCommands.shift(), serverTime: Date.now() }))
		return new Promise((resolve, reject) => {
			const signal = init?.signal
			if (signal === undefined) return
			if (signal.aborted) {
				reject(abortError())
				return
			}
			signal.addEventListener('abort', () => reject(abortError()), { once: true })
		})
	}
	return Promise.resolve(jsonResponse({ ok: true }))
}

/** Appended `<style>` elements. */
const appendedStyles = []

/**
 * Minimal fake DOM node: attributes/text plus the `<webview>` surface the
 * Desktop carrier consumes (event listeners, navigation, page scripts).
 * @param tag - element tag name.
 * @returns the fake node.
 */
function fakeNode(tag) {
	const listeners = new Map()
	const node = {
		tag,
		className: '',
		textContent: '',
		attributes: {},
		children: [],
		scripts: [],
		loadUrls: [],
		reloads: 0,
		currentUrl: '',
		pageTitle: '',
		loading: false,
		removed: false,
		scriptHandler: undefined,
		setAttribute(name, value) {
			node.attributes[name] = value
		},
		appendChild(child) {
			node.children.push(child)
			return child
		},
		remove() {
			node.removed = true
		},
		addEventListener(name, listener) {
			const list = listeners.get(name) ?? []
			list.push(listener)
			listeners.set(name, list)
		},
		emit(name, event) {
			for (const listener of [...(listeners.get(name) ?? [])]) listener(event ?? {})
		},
		loadURL(url) {
			node.loadUrls.push(url)
			node.currentUrl = url
			return Promise.resolve()
		},
		getURL() {
			return node.currentUrl
		},
		getTitle() {
			return node.pageTitle
		},
		isLoading() {
			return node.loading === true
		},
		canGoBack() {
			return false
		},
		canGoForward() {
			return false
		},
		goBack() {},
		goForward() {},
		reload() {
			node.reloads += 1
		},
		executeJavaScript(script, userGesture) {
			node.scripts.push({ script, userGesture })
			if (typeof node.scriptHandler !== 'function') return Promise.resolve(undefined)
			return node.scriptHandler(script, userGesture)
		}
	}
	return node
}

/** Minimal document: stylesheet injection plus fake carrier elements. */
globalThis.document = {
	querySelector: () => null,
	createElement: fakeNode,
	head: {
		appendChild(element) {
			appendedStyles.push(element)
		}
	}
}

/** Captured bundle module returned by the loader factory. */
let bundle

/** Fake React surface: apply() only registers components, it never renders them. */
const React = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useEffect: () => {},
	useRef: (initial) => ({ current: initial }),
	useMemo: (factory) => factory(),
	useCallback: (callback) => callback,
	Fragment: Symbol('Fragment')
}

globalThis.window = {
	__ModuleLoader__: {
		load({ factory }) {
			bundle = factory((name) => {
				if (name === 'react') return React
				if (name === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('primitives unavailable in the test realm')
				throw new Error(`unexpected require ${name}`)
			})
		}
	},
	location: { origin: 'http://127.0.0.1:63666' }
}

await import('../client.js')

/**
 * Build one fake Client ctx exposing exactly the registrations the plugin
 * consumes, run `apply`, and return the captured registries plus a teardown.
 * @param options - optional `configForms` service.
 * @returns the fake ctx, captured registrations, and the teardown.
 */
function clientHarness(options = {}) {
	const registrations = {
		tabs: [],
		slots: [],
		provides: [],
		effects: [],
		openTabs: [],
		closed: [],
		injected: [],
		dictionaries: undefined
	}
	const disposers = []
	const ctx = {
		locale: {
			register(namespace, dictionaries) {
				registrations.dictionaries = { namespace, dictionaries }
				return () => {}
			},
			bind: () => (key) => key
		},
		effect(fn, label) {
			registrations.effects.push(label)
			const disposer = fn()
			if (typeof disposer === 'function') disposers.push(disposer)
			return disposer
		},
		sidebarRightTabs: {
			register(definition) {
				registrations.tabs.push(definition)
				return () => {}
			}
		},
		sidebarRight: {
			openTab(kind, tabOptions) {
				registrations.openTabs.push({ kind, options: tabOptions })
			},
			close(tabId) {
				registrations.closed.push(tabId)
			},
			mounted: {
				getSnapshot: () => 'session-1',
				subscribe: () => () => {}
			},
			openTabs: {
				getSnapshot: () => []
			}
		},
		slots: {
			pending: undefined,
			inject(name, factory) {
				const entry = { name }
				registrations.slots.push(entry)
				ctx.slots.pending = entry
				factory()
				ctx.slots.pending = undefined
				return () => {}
			},
			register(definition, component) {
				ctx.slots.pending.definition = definition
				ctx.slots.pending.component = component
				return () => {}
			}
		},
		reflect: {
			provide(name, value) {
				registrations.provides.push({ name, value })
				return () => {}
			}
		},
		inject(names, callback) {
			registrations.injected.push(names.join(','))
			if (options.configForms !== undefined && names.includes('configForms')) callback({ configForms: options.configForms })
		}
	}
	bundle.apply(ctx)
	return {
		ctx,
		registrations,
		dispose() {
			for (const disposer of disposers.splice(0)) {
				try {
					disposer()
				} catch {
					// Teardown must never mask an assertion failure.
				}
			}
		}
	}
}

/**
 * Run one test body with a harness and always tear the plugin down.
 * @param options - harness options.
 * @param run - assertions receiving the harness.
 */
async function withHarness(options, run) {
	const harness = clientHarness(options)
	try {
		await run(harness)
	} finally {
		harness.dispose()
	}
}

/**
 * The hub injected into the pane-tab body Slot.
 * @param registrations - captured registrations.
 * @returns the hub.
 */
function bodyHub(registrations) {
	const body = registrations.slots.find((slot) => slot.name === 'sidebar.right.pane.tab')
	assert.ok(body !== undefined, 'body slot present')
	return body.definition.inject('session-1', {}).hub
}

/** Fake carrier viewport container. */
function fakeContainer() {
	return {
		children: [],
		appendChild(node) {
			this.children.push(node)
			return node
		}
	}
}

/**
 * Install a fake `dshDesktop` guest bridge for one test.
 * @returns the fake bridge.
 */
function installDesktopBridge() {
	const bridge = {
		acquired: [],
		released: [],
		onOpenRequested() {
			return () => {}
		},
		async acquire(workspaceKey) {
			bridge.acquired.push(workspaceKey)
			return { lease: 'lease-1', partition: 'persist:test' }
		},
		async release(lease) {
			bridge.released.push(lease)
		}
	}
	globalThis.dshDesktop = { protocolVersion: 1, browser: bridge }
	return bridge
}

/** Uninstall the fake Desktop bridge. */
function removeDesktopBridge() {
	delete globalThis.dshDesktop
}

/**
 * Wait for one predicate across timer turns (the command bridge polls and
 * carrier readiness checks run on intervals, not only microtasks).
 * @param predicate - condition to poll.
 * @param message - assertion message on timeout.
 */
async function eventually(predicate, message) {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	assert.fail(message ?? 'condition did not hold')
}

test('the bundle exposes the required Client services', () => {
	assert.deepEqual(bundle.inject, ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'])
	assert.equal(typeof bundle.apply, 'function')
})

test('apply registers the browser tab type as an extension takeover', async () => {
	await withHarness({}, ({ registrations }) => {
		assert.equal(registrations.tabs.length, 1)
		const definition = registrations.tabs[0]
		assert.equal(definition.id, 'dsh-inner-chrome')
		assert.equal(definition.kind, 'browser')
		assert.equal(definition.priority, 'extension')
		assert.equal(definition.multiple, true)
		assert.equal(definition.title(), 'type.label')
		assert.equal(definition.guide.length, 1)
		assert.equal(definition.guide[0].id, 'new')
		assert.equal(definition.guide[0].order, 30)
		assert.equal(typeof definition.guide[0].icon, 'function')
		assert.equal(typeof definition.guide[0].title, 'function')
		assert.equal(typeof definition.guide[0].description, 'function')
	})
})

test('the tab body is registered under the type id on the pane tab Slot', async () => {
	await withHarness({}, ({ registrations }) => {
		const body = registrations.slots.find((slot) => slot.name === 'sidebar.right.pane.tab')
		assert.ok(body !== undefined, 'body slot present')
		assert.equal(body.definition.name, 'sidebar.right.pane.tab')
		assert.equal(body.definition.key, 'dsh-inner-chrome')
		assert.equal(body.definition.locale, 'innerChrome')
		assert.equal(typeof body.component, 'function')
		const injected = body.definition.inject('session-1', {})
		assert.equal(injected.sessionId, 'session-1')
		assert.ok(injected.hub !== undefined)
		assert.equal(typeof injected.closeTab, 'function')
		injected.closeTab('tab-9')
		assert.deepEqual(registrations.closed, ['tab-9'])
	})
})

test('a conversation-header action opens a browser tab', async () => {
	await withHarness({}, ({ registrations }) => {
		const header = registrations.slots.find((slot) => slot.name === 'conversation.session.header.actions')
		assert.ok(header !== undefined, 'header slot present')
		assert.equal(header.definition.id, 'inner-chrome')
		assert.equal(typeof header.component, 'function')
		const injected = header.definition.inject('session-1', {})
		assert.equal(typeof injected.openBrowser, 'function')
		injected.openBrowser()
		const last = registrations.openTabs.at(-1)
		assert.equal(last.kind, 'browser')
		assert.deepEqual(last.options, { params: {} })
	})
})

test('innerChrome is provided and open() routes through sidebarRight.openTab', async () => {
	await withHarness({}, async ({ registrations }) => {
		const provided = registrations.provides.find((entry) => entry.name === 'innerChrome')
		assert.ok(provided !== undefined, 'innerChrome service provided')
		const api = provided.value
		assert.equal(api.isAvailable(), true)
		assert.equal(api.isDesktop(), false)
		assert.equal(api.current(), undefined)

		const result = await api.open('example.com')
		assert.deepEqual(result, { ok: true })
		const call = registrations.openTabs.at(-1)
		assert.equal(call.kind, 'browser')
		assert.deepEqual(call.options, { params: { url: 'https://example.com/' } })

		await assert.rejects(() => api.open('javascript:alert(1)'))
	})
})

test('the chat link preference is migrated to the sidebar once', async () => {
	const form = {
		value: { linkOpening: 'new-tab' },
		setCalls: [],
		getSnapshot() {
			return { value: this.value }
		},
		set(key, value) {
			this.setCalls.push([key, value])
			this.value = { ...this.value, [key]: value }
			return Promise.resolve()
		}
	}
	const storage = {
		store: new Map(),
		getItem(key) {
			return this.store.get(key) ?? null
		},
		setItem(key, value) {
			this.store.set(key, String(value))
		}
	}
	globalThis.localStorage = storage
	try {
		await withHarness({ configForms: { get: (namespace) => (namespace === 'ui-chat' ? form : undefined) } }, ({ registrations }) => {
			assert.ok(registrations.injected.includes('configForms'))
			assert.deepEqual(form.setCalls, [['linkOpening', 'sidebar']])
			assert.equal(storage.getItem('dsh-inner-chrome.link-opening-migrated'), '1')
		})

		form.value = { linkOpening: 'new-tab' }
		form.setCalls.length = 0
		await withHarness({ configForms: { get: () => form } }, () => {
			assert.deepEqual(form.setCalls, [], 'the marker suppresses a second migration')
		})
	} finally {
		delete globalThis.localStorage
	}
})

test('the migration waits for the shared settings snapshot to load', async () => {
	const listeners = new Set()
	const form = {
		snapshot: undefined,
		setCalls: [],
		getSnapshot() {
			return this.snapshot
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		set(key, value) {
			this.setCalls.push([key, value])
			return Promise.resolve()
		}
	}
	const storage = {
		store: new Map(),
		getItem(key) {
			return this.store.get(key) ?? null
		},
		setItem(key, value) {
			this.store.set(key, String(value))
		}
	}
	globalThis.localStorage = storage
	try {
		await withHarness({ configForms: { get: () => form } }, () => {
			assert.deepEqual(form.setCalls, [], 'no decision before the mirror loads')
			assert.equal(storage.getItem('dsh-inner-chrome.link-opening-migrated'), null)
			form.snapshot = { value: { linkOpening: 'new-tab' } }
			for (const listener of [...listeners]) listener()
			assert.deepEqual(form.setCalls, [['linkOpening', 'sidebar']])
			assert.equal(storage.getItem('dsh-inner-chrome.link-opening-migrated'), '1')
			assert.equal(listeners.size, 0, 'the watcher unsubscribes after deciding')
		})
	} finally {
		delete globalThis.localStorage
	}
})

test('the first on-screen Session opens one browser tab when none exists', async () => {
	await withHarness({}, ({ registrations }) => {
		const firstRun = registrations.openTabs.filter((call) => JSON.stringify(call.options) === JSON.stringify({ params: {} }))
		assert.equal(firstRun.length, 1)
		assert.equal(firstRun[0].kind, 'browser')
	})
})

test('polled commands execute and report a Result with the contract shape', async () => {
	pollCommands.push(
		{ id: 'cmd-tabs', kind: 'tabs', args: {}, createdAt: Date.now() },
		{ id: 'cmd-read', kind: 'read', args: {}, createdAt: Date.now() }
	)
	const before = fetchCalls.length
	await withHarness({}, async () => {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const results = fetchCalls.slice(before).filter((call) => call.path === '/api/inner-chrome.result')
			if (results.length >= 2) break
			await new Promise((resolve) => setImmediate(resolve))
		}
		const results = fetchCalls.slice(before).filter((call) => call.path === '/api/inner-chrome.result').map((call) => call.body)
		assert.equal(results.length, 2)

		const tabsResult = results.find((result) => result.id === 'cmd-tabs')
		assert.equal(tabsResult.ok, true)
		assert.deepEqual(tabsResult.value, { tabs: [] })
		assert.equal(typeof tabsResult.clientId, 'string')

		const readResult = results.find((result) => result.id === 'cmd-read')
		assert.equal(readResult.ok, false)
		assert.equal(readResult.error.code, 'NO_TAB')
		assert.equal(typeof readResult.error.message, 'string')
	})
})

test('the bridge starts with hello and long-polls the Host', async () => {
	const before = fetchCalls.length
	await withHarness({}, async () => {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (fetchCalls.slice(before).some((call) => call.path === '/api/inner-chrome.poll')) break
			await new Promise((resolve) => setImmediate(resolve))
		}
		const calls = fetchCalls.slice(before)
		const hello = calls.find((call) => call.path === '/api/inner-chrome.hello')
		assert.ok(hello !== undefined, 'hello was posted')
		assert.equal(hello.body.protocol, 1)
		assert.equal(hello.body.platform, 'web')
		assert.deepEqual(hello.body.capabilities, ['open', 'tabs', 'navigate', 'close'])
		assert.equal(typeof hello.body.clientId, 'string')
		const poll = calls.find((call) => call.path === '/api/inner-chrome.poll')
		assert.ok(poll !== undefined, 'poll was posted')
		assert.equal(poll.body.waitMs, 20000)
		assert.equal(poll.body.clientId, hello.body.clientId)
	})
})

test('URL normalization adds https to bare hosts and refuses unsafe schemes', () => {
	const { normalizeHttpUrl } = bundle.__test
	assert.deepEqual(normalizeHttpUrl('example.com'), { ok: true, url: 'https://example.com/' })
	assert.deepEqual(normalizeHttpUrl('  example.com/a?b=1  '), { ok: true, url: 'https://example.com/a?b=1' })
	assert.deepEqual(normalizeHttpUrl('localhost:3000'), { ok: true, url: 'https://localhost:3000/' })
	assert.deepEqual(normalizeHttpUrl('http://example.com'), { ok: true, url: 'http://example.com/' })
	assert.deepEqual(normalizeHttpUrl('https://example.com/x'), { ok: true, url: 'https://example.com/x' })

	assert.deepEqual(normalizeHttpUrl(''), { ok: false, reason: 'empty' })
	assert.deepEqual(normalizeHttpUrl('   '), { ok: false, reason: 'empty' })
	assert.deepEqual(normalizeHttpUrl('javascript:alert(1)'), { ok: false, reason: 'protocol' })
	assert.deepEqual(normalizeHttpUrl('file:///etc/passwd'), { ok: false, reason: 'protocol' })
	assert.deepEqual(normalizeHttpUrl('data:text/html,<h1>x</h1>'), { ok: false, reason: 'protocol' })
	assert.deepEqual(normalizeHttpUrl('ftp://example.com/x'), { ok: false, reason: 'protocol' })
	assert.deepEqual(normalizeHttpUrl('https://user:secret@example.com/'), { ok: false, reason: 'credentials' })
	assert.deepEqual(normalizeHttpUrl(42), { ok: false, reason: 'invalid' })
	assert.deepEqual(normalizeHttpUrl('https://'), { ok: false, reason: 'invalid' })
	assert.deepEqual(normalizeHttpUrl('http://127.0.0.1:63666/x', 'http://127.0.0.1:63666'), { ok: false, reason: 'application-origin' })
})

test('command routing prefers the named tab, then the session, then the active tab', () => {
	const { routeTabId } = bundle.__test
	const records = [
		{ tabId: 'tab-a', sessionId: 'session-1', lastActiveAt: 1 },
		{ tabId: 'tab-b', sessionId: 'session-1', lastActiveAt: 5 },
		{ tabId: 'tab-c', sessionId: 'session-2', lastActiveAt: 9 }
	]
	assert.equal(routeTabId(records, { tabId: 'tab-a', sessionId: 'session-1' }, 'tab-c'), 'tab-a')
	assert.equal(routeTabId(records, { sessionId: 'session-1' }, 'tab-c'), 'tab-b')
	assert.equal(routeTabId(records, {}, 'tab-c'), 'tab-c')
	assert.equal(routeTabId(records, { sessionId: 'missing' }, undefined), 'tab-c')
	assert.equal(routeTabId([], {}, undefined), undefined)
	assert.equal(routeTabId(records, { sessionId: 'missing' }, 'missing'), 'tab-c')
})

test('argument clamping stays inside the contract bounds', () => {
	const { clampInt } = bundle.__test
	assert.equal(clampInt(undefined, 20000, 1000, 100000), 20000)
	assert.equal(clampInt(5, 20000, 1000, 100000), 1000)
	assert.equal(clampInt(999999, 20000, 1000, 100000), 100000)
	assert.equal(clampInt('300', 20000, 1000, 100000), 20000)
})

test('the stylesheet is injected once with ic- prefixed classes', async () => {
	const before = appendedStyles.length
	await withHarness({}, () => {})
	await withHarness({}, () => {})
	const injected = appendedStyles.slice(before)
	assert.equal(injected.length, 2, 'each apply calls the idempotent injector')
	for (const style of injected) {
		assert.equal(style.attributes['data-dsh-inner-chrome'], '')
		assert.match(style.textContent, /\.ic-root\{/)
		assert.match(style.textContent, /--dsw-alias-bg-base/)
		assert.doesNotMatch(style.textContent, /#[0-9a-fA-F]{3,8}/, 'no hardcoded colors')
	}
})

test('hello advertises the v0.2 Desktop capabilities', async () => {
	installDesktopBridge()
	try {
		const before = fetchCalls.length
		await withHarness({}, async () => {
			await eventually(() => fetchCalls.slice(before).some((call) => call.path === '/api/inner-chrome.hello'), 'hello was posted')
			const hello = fetchCalls.slice(before).find((call) => call.path === '/api/inner-chrome.hello')
			assert.equal(hello.body.platform, 'desktop')
			assert.deepEqual(hello.body.capabilities, ['open', 'read', 'click', 'screenshot', 'tabs', 'navigate', 'eval', 'close', 'inject'])
		})
	} finally {
		removeDesktopBridge()
	}
})

test('the Desktop carrier injects the initial script once the target document is ready', async () => {
	installDesktopBridge()
	try {
		await withHarness({}, async ({ registrations }) => {
			const hub = bodyHub(registrations)
			const container = fakeContainer()
			const carrier = hub.createCarrier({
				sessionId: 'session-1',
				container,
				initialUrl: 'https://example.com/',
				initialScript: 'window.__T__ = 1',
				onChange() {},
				onFailure() {}
			})
			await carrier.start()
			const node = container.children[0]
			assert.equal(node.tag, 'webview')
			assert.match(node.attributes.src, /^about:blank#lease-1$/u)

			node.emit('dom-ready')
			assert.deepEqual(node.loadUrls, ['https://example.com/'])
			assert.equal(node.scripts.length, 0, 'the bootstrap document never runs the script')

			node.emit('dom-ready')
			await eventually(() => node.scripts.length === 1, 'the injected script ran')
			assert.equal(node.scripts[0].script, 'window.__T__ = 1')
			assert.equal(node.scripts[0].userGesture, true)
			assert.equal(await carrier.injection(), true)

			node.emit('dom-ready')
			await new Promise((resolve) => setImmediate(resolve))
			assert.equal(node.scripts.length, 1, 'the script runs once per navigation')
			await carrier.dispose()

			// Best-effort injection: a throwing script reports false but never fails the command.
			const failingContainer = fakeContainer()
			const failing = hub.createCarrier({
				sessionId: 'session-1',
				container: failingContainer,
				initialUrl: 'https://example.com/',
				initialScript: 'throw new Error("boom")',
				onChange() {},
				onFailure() {}
			})
			await failing.start()
			const failingNode = failingContainer.children[0]
			failingNode.scriptHandler = () => Promise.reject(new Error('page threw'))
			const warn = console.warn
			console.warn = () => {}
			try {
				failingNode.emit('dom-ready')
				failingNode.emit('dom-ready')
				await eventually(() => failingNode.scripts.length === 1, 'the failing script was attempted')
				assert.equal(await failing.injection(), false)
			} finally {
				console.warn = warn
			}
			await failing.dispose()
		})
	} finally {
		removeDesktopBridge()
	}
})

test('the Desktop carrier evaluates page expressions with timeout and failure codes', async () => {
	installDesktopBridge()
	try {
		await withHarness({}, async ({ registrations }) => {
			const hub = bodyHub(registrations)
			const container = fakeContainer()
			const carrier = hub.createCarrier({ sessionId: 'session-1', container, initialUrl: 'https://example.com/', onChange() {}, onFailure() {} })
			await carrier.start()
			const node = container.children[0]
			node.emit('dom-ready')
			node.pageTitle = 'Example'
			node.emit('dom-ready')

			node.scriptHandler = async (script) => {
				if (script === 'document.title') return 'Example'
				if (script === 'undefined()') return undefined
				throw new Error(`page exploded: ${script}`)
			}
			assert.equal(await carrier.eval('document.title', { timeoutMs: 5000 }), 'Example')
			assert.equal(node.scripts.at(-1).userGesture, true)
			assert.equal(await carrier.eval('undefined()'), undefined)

			await assert.rejects(() => carrier.eval('boom()', { timeoutMs: 5000 }), (error) => error.code === 'EVAL_FAILED' && /page exploded/u.test(error.message))

			node.scriptHandler = () => new Promise(() => {})
			const started = Date.now()
			await assert.rejects(() => carrier.eval('never()', { timeoutMs: 100 }), (error) => error.code === 'EVAL_TIMEOUT')
			assert.ok(Date.now() - started >= 80, 'the timeout is actually waited for')
			await carrier.dispose()
		})
	} finally {
		removeDesktopBridge()
	}
})

test('the eval command routes to the tab and returns the page value', async () => {
	installDesktopBridge()
	try {
		await withHarness({}, async ({ registrations }) => {
			const hub = bodyHub(registrations)
			const container = fakeContainer()
			const carrier = hub.createCarrier({ sessionId: 'session-1', container, initialUrl: 'https://example.com/', onChange() {}, onFailure() {} })
			await carrier.start()
			const node = container.children[0]
			node.emit('dom-ready')
			node.emit('dom-ready')
			node.scriptHandler = async (script) => {
				if (script === 'document.title') return 'Example'
				if (script === 'undefined()') return undefined
				throw new Error('page exploded')
			}
			await assert.rejects(() => hub.execute({ kind: 'eval', args: { expression: '1 + 1' } }), (error) => error.code === 'NO_TAB')

			const handle = hub.registerTab({
				tabId: 'tab-1',
				sessionId: 'session-1',
				initialUrl: 'https://example.com/',
				url: 'https://example.com/',
				title: 'Example',
				loading: false,
				navigate() {},
				getCarrier: () => carrier
			})

			const value = await hub.execute({ kind: 'eval', args: { expression: 'document.title', timeoutMs: 5000 }, tabId: 'tab-1' })
			assert.deepEqual(value, { tabId: 'tab-1', url: 'https://example.com/', title: 'Example', value: 'Example' })

			const nullValue = await hub.execute({ kind: 'eval', args: { expression: 'undefined()' }, tabId: 'tab-1' })
			assert.equal(nullValue.value, null)

			await assert.rejects(() => hub.execute({ kind: 'eval', args: { expression: 'boom()' }, tabId: 'tab-1' }), (error) => error.code === 'EVAL_FAILED')
			await assert.rejects(() => hub.execute({ kind: 'eval', args: {}, tabId: 'tab-1' }), (error) => error.code === 'BAD_ARGS')
			await assert.rejects(() => hub.execute({ kind: 'eval', args: { expression: 'x'.repeat(262145) }, tabId: 'tab-1' }), (error) => error.code === 'BAD_ARGS')

			handle.dispose()
			await carrier.dispose()
		})
	} finally {
		removeDesktopBridge()
	}
})

test('an eval timeout is reported to the Host as EVAL_TIMEOUT', async () => {
	installDesktopBridge()
	pollCommands.push({ id: 'cmd-eval-timeout', kind: 'eval', args: { expression: 'never()', timeoutMs: 100 }, tabId: 'tab-eval', sessionId: 'session-1', createdAt: Date.now() })
	const before = fetchCalls.length
	try {
		await withHarness({}, async ({ registrations }) => {
			const hub = bodyHub(registrations)
			const container = fakeContainer()
			const carrier = hub.createCarrier({ sessionId: 'session-1', container, initialUrl: 'https://example.com/', onChange() {}, onFailure() {} })
			const starting = carrier.start()
			// Register synchronously: the bridge may receive the queued command as
			// soon as the Hello round trip settles.
			hub.registerTab({
				tabId: 'tab-eval',
				sessionId: 'session-1',
				initialUrl: 'https://example.com/',
				url: 'https://example.com/',
				title: 'Example',
				loading: false,
				navigate() {},
				getCarrier: () => carrier
			})
			await starting
			const node = container.children[0]
			node.scriptHandler = () => new Promise(() => {})
			node.emit('dom-ready')
			node.emit('dom-ready')
			await eventually(() => fetchCalls.slice(before).some((call) => call.path === '/api/inner-chrome.result' && call.body.id === 'cmd-eval-timeout'), 'the eval result was reported')
			const result = fetchCalls.slice(before).find((call) => call.path === '/api/inner-chrome.result' && call.body.id === 'cmd-eval-timeout').body
			assert.equal(result.ok, false)
			assert.equal(result.error.code, 'EVAL_TIMEOUT')
			assert.equal(typeof result.error.message, 'string')
			await carrier.dispose()
		})
	} finally {
		removeDesktopBridge()
	}
})

test('a screenshot capture that never settles times out instead of wedging the bridge', async () => {
	installDesktopBridge()
	pollCommands.push({ id: 'cmd-shot-hang', kind: 'screenshot', args: { timeoutMs: 100 }, tabId: 'tab-shot', sessionId: 'session-1', createdAt: Date.now() })
	const before = fetchCalls.length
	try {
		await withHarness({}, async ({ registrations }) => {
			const hub = bodyHub(registrations)
			const container = fakeContainer()
			const carrier = hub.createCarrier({ sessionId: 'session-1', container, initialUrl: 'https://example.com/', onChange() {}, onFailure() {} })
			const starting = carrier.start()
			// Register synchronously: the bridge may receive the queued command as
			// soon as the Hello round trip settles.
			hub.registerTab({
				tabId: 'tab-shot',
				sessionId: 'session-1',
				initialUrl: 'https://example.com/',
				url: 'https://example.com/',
				title: 'Example',
				loading: false,
				navigate() {},
				getCarrier: () => carrier
			})
			await starting
			const node = container.children[0]
			// The guest capture never settles; only the client timeout can report it.
			node.capturePage = () => new Promise(() => {})
			node.emit('dom-ready')
			node.emit('dom-ready')
			await eventually(() => fetchCalls.slice(before).some((call) => call.path === '/api/inner-chrome.result' && call.body.id === 'cmd-shot-hang'), 'the screenshot timeout was reported')
			const result = fetchCalls.slice(before).find((call) => call.path === '/api/inner-chrome.result' && call.body.id === 'cmd-shot-hang').body
			assert.equal(result.ok, false)
			assert.equal(result.error.code, 'SCREENSHOT_FAILED')
			assert.match(result.error.message, /截图超时/)
			await carrier.dispose()
		})
	} finally {
		removeDesktopBridge()
	}
})

test('open passes injectScript to the new tab and runs it after dom-ready', async () => {
	installDesktopBridge()
	try {
		await withHarness({}, async ({ registrations }) => {
			const hub = bodyHub(registrations)
			const container = fakeContainer()
			const carrier = hub.createCarrier({ sessionId: 'session-1', container, initialUrl: 'https://example.com/', onChange() {}, onFailure() {} })
			await carrier.start()
			const node = container.children[0]
			node.emit('dom-ready')
			node.emit('dom-ready')
			const handle = hub.registerTab({
				tabId: 'tab-1',
				sessionId: 'session-1',
				initialUrl: 'https://example.com/',
				url: 'https://example.com/',
				title: 'Example',
				loading: false,
				navigate() {},
				getCarrier: () => carrier
			})

			const pending = hub.execute({ kind: 'open', args: { url: 'https://example.com/next', injectScript: 'window.__T__ = 1' }, tabId: 'tab-1' })
			await eventually(() => node.loadUrls.includes('https://example.com/next'), 'the navigation was handed to the guest')
			node.emit('dom-ready')
			const value = await pending
			assert.equal(value.injected, true)
			assert.deepEqual(node.scripts.map((entry) => entry.script), ['window.__T__ = 1'])
			assert.equal(node.scripts[0].userGesture, true)

			handle.dispose()
			await carrier.dispose()
		})
	} finally {
		removeDesktopBridge()
	}
})

test('open forwards injectScript through openTab params and waitForLoad:false skips settling', async () => {
	await withHarness({}, async ({ registrations }) => {
		const hub = bodyHub(registrations)
		const startedAt = Date.now()
		const pending = hub.execute({
			kind: 'open',
			args: { url: 'https://example.com/', injectScript: 'window.__T__ = 1', waitForLoad: false },
			sessionId: 'session-1'
		})
		await eventually(() => registrations.openTabs.length > 0, 'the Sidebar was asked for a tab')
		const call = registrations.openTabs.at(-1)
		assert.equal(call.kind, 'browser')
		assert.deepEqual(call.options.params, { url: 'https://example.com/', script: 'window.__T__ = 1' })

		// Simulate the tab body mounting while still loading: the command must not wait.
		const carrier = { isReady: () => true, load() { throw new Error('waitForLoad:false must not load') } }
		const handle = hub.registerTab({
			tabId: 'tab-new',
			sessionId: 'session-1',
			initialUrl: 'https://example.com/',
			url: 'https://example.com/',
			title: '',
			loading: true,
			navigate() {},
			getCarrier: () => carrier
		})
		const value = await pending
		assert.equal(value.tabId, 'tab-new')
		assert.equal(value.loading, true)
		assert.equal(value.injected, false)
		assert.ok(Date.now() - startedAt < 2000, 'the command returned before the load settled')

		handle.dispose()
	})
})

test('the close command closes the tab through the Sidebar and forgets it', async () => {
	await withHarness({}, async ({ registrations }) => {
		const hub = bodyHub(registrations)
		const first = hub.registerTab({
			tabId: 'tab-1',
			sessionId: 'session-1',
			initialUrl: 'https://example.com/',
			url: 'https://example.com/',
			title: 'Example',
			loading: false,
			navigate() {},
			getCarrier: () => undefined
		})
		const second = hub.registerTab({
			tabId: 'tab-2',
			sessionId: 'session-1',
			initialUrl: 'https://example.org/',
			url: 'https://example.org/',
			title: 'Other',
			loading: false,
			navigate() {},
			getCarrier: () => undefined
		})
		assert.equal((await hub.execute({ kind: 'tabs', args: {} })).tabs.length, 2)

		assert.deepEqual(await hub.execute({ kind: 'close', args: { tabId: 'tab-1' } }), { tabId: 'tab-1', closed: true })
		assert.deepEqual(registrations.closed, ['tab-1'])
		assert.deepEqual((await hub.execute({ kind: 'tabs', args: {} })).tabs.map((tab) => tab.tabId), ['tab-2'])

		// The Command-level tab id is the fallback when args omit it.
		assert.deepEqual(await hub.execute({ kind: 'close', args: {}, tabId: 'tab-2' }), { tabId: 'tab-2', closed: true })
		assert.deepEqual((await hub.execute({ kind: 'tabs', args: {} })).tabs, [])

		await assert.rejects(() => hub.execute({ kind: 'close', args: { tabId: 'tab-1' } }), (error) => error.code === 'NO_TAB')
		await assert.rejects(() => hub.execute({ kind: 'close', args: {} }), (error) => error.code === 'BAD_ARGS')

		first.dispose()
		second.dispose()
	})
})

test('the Web carrier refuses eval with READ_UNSUPPORTED', async () => {
	await withHarness({}, async ({ registrations }) => {
		const hub = bodyHub(registrations)
		const container = fakeContainer()
		const carrier = hub.createCarrier({ sessionId: 'session-1', container, initialUrl: 'https://example.com/', onChange() {}, onFailure() {} })
		carrier.start()
		assert.equal(carrier.canEval(), false)
		await assert.rejects(() => carrier.eval('1 + 1'), (error) => error.code === 'READ_UNSUPPORTED')

		const handle = hub.registerTab({
			tabId: 'tab-web',
			sessionId: 'session-1',
			initialUrl: 'https://example.com/',
			url: 'https://example.com/',
			title: 'Example',
			loading: false,
			navigate() {},
			getCarrier: () => carrier
		})
		await assert.rejects(() => hub.execute({ kind: 'eval', args: { expression: '1 + 1' }, tabId: 'tab-web' }), (error) => error.code === 'READ_UNSUPPORTED')

		handle.dispose()
		await carrier.dispose()
	})
})
