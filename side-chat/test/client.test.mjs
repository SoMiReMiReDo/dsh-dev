/**
 * Browser-half smoke tests for dsh-side-chat v0.2.
 *
 * The Client module is a plain `window.__ModuleLoader__` bundle factory, so the
 * test installs minimal globals (window/document/React primitives), imports the
 * module for its registration side effect, and then drives `apply()` and the
 * registered resource with a fake Client ctx. This pins the plugin's own
 * contract without a browser: opening posts + focuses a tab, stale restored
 * tabs resolve as stale, closing a tab posts the Host close route.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Responses installed by each test, keyed by route. */
const responses = new Map()

/** Calls made through the global fetch stub. */
const calls = []

globalThis.fetch = async (path, options) => {
	calls.push({ path, body: options?.body === undefined ? undefined : JSON.parse(options.body) })
	const payload = responses.get(path)
	if (payload === undefined) throw new Error(`unexpected fetch ${path}`)
	return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** Minimal DOM used by the row-hiding stylesheet. */
const appendedStyles = []
globalThis.document = {
	createElement(tag) {
		return {
			tag,
			textContent: '',
			attributes: {},
			setAttribute(name, value) {
				this.attributes[name] = value
			},
			remove() {}
		}
	},
	head: {
		appendChild(element) {
			appendedStyles.push(element)
		}
	}
}

globalThis.window = {
	addEventListener() {}
}

/** Captured bundle module returned by the loader factory. */
let bundle

/** Fake React surface: apply() only registers components, it never renders them. */
const React = {
	createElement: (type, props, children) => ({ type, props, children }),
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useEffect: () => {},
	useCallback: (callback) => callback,
	Fragment: Symbol('Fragment')
}

const primitives = {
	Button: 'Button',
	Tooltip: 'Tooltip',
	IconBranchOutlineRegular: 'IconBranchOutlineRegular'
}

globalThis.window.__ModuleLoader__ = {
	load({ factory }) {
		bundle = factory((name) => {
			if (name === 'react') return React
			if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
			throw new Error(`unexpected require ${name}`)
		})
	}
}

await import('../client.js')

/**
 * Build one fake Client ctx with the exact registrations the plugin consumes.
 * @returns the ctx, registries, and helpers.
 */
function clientHarness() {
	const registry = {
		routes: [],
		tabs: [],
		slots: [],
		resources: [],
		effects: [],
		opened: [],
		closed: [],
		refreshed: 0,
		retained: []
	}
	const sessions = {
		list: { getSnapshot: () => ({ byId: { 'session-parent': { title: '主会话' } } }) },
		refresh: async () => {
			registry.refreshed += 1
		},
		retain(id, options) {
			registry.retained.push({ id, options })
			return { release() {} }
		}
	}
	const ctx = {
		locale: {
			register() {},
			bind: () => (key, values) => (values === undefined ? key : `${key}:${JSON.stringify(values)}`)
		},
		effect(fn) {
			const disposer = fn()
			registry.effects.push(disposer)
			return disposer
		},
		resources: {
			register(provider) {
				registry.resources.push(provider)
				return () => {}
			}
		},
		sidebarRightTabs: {
			register(definition) {
				registry.tabs.push(definition)
				return () => {}
			}
		},
		slots: {
			inject(name, factory) {
				const entry = { name }
				registry.slots.push(entry)
				registry.pendingSlot = entry
				factory()
				registry.pendingSlot = undefined
				return () => {}
			},
			register(definition, component) {
				registry.pendingSlot.definition = definition
				registry.pendingSlot.component = component
				return () => {}
			}
		},
		sidebarRight: {
			openResource(address, options) {
				registry.opened.push({ address, options })
			},
			close(tabId) {
				registry.closed.push(tabId)
			}
		},
		sessions
	}
	bundle.apply(ctx)
	return { ctx, registry }
}

/**
 * Read the next value from one resource generator.
 * @param generator - resource generator.
 * @returns the yielded value.
 */
async function firstValue(generator) {
	const { value, done } = await generator.next()
	assert.equal(done, false)
	return value
}

test('client bundle exposes the expected inject list', () => {
	assert.deepEqual(bundle.inject, ['slots', 'locale', 'sessions', 'resources', 'sidebarRight', 'sidebarRightTabs'])
})

test('apply registers the resource, tab type, tab body, and header action', () => {
	responses.set('/api/sidechat.list', { items: [] })
	const { registry } = clientHarness()
	assert.equal(registry.resources.length, 1)
	assert.equal(registry.resources[0].protocol, 'sidechat')
	assert.equal(registry.tabs.length, 1)
	assert.equal(registry.tabs[0].kind, 'sidechat')
	assert.equal(registry.tabs[0].id, 'dsh-side-chat')
	assert.deepEqual(registry.tabs[0].patterns, ['dsh-resource://sidechat/**'])
	assert.equal(registry.tabs[0].title('dsh-resource://sidechat/session/session-child?parent=session-parent'), 'tab.titleOf:{"title":"主会话"}')
	assert.deepEqual(registry.slots.map((slot) => slot.name), ['sidebar.right.pane.tab', 'sidebar.sidechat.conversation', 'conversation.session.header.actions'])
})

test('opening posts the open route, hides the row, refreshes the list, and focuses the tab', async () => {
	responses.set('/api/sidechat.list', { items: [] })
	responses.set('/api/sidechat.open', { sessionId: 'session-child', parentSessionId: 'session-parent' })
	const { registry } = clientHarness()
	await new Promise((resolve) => setImmediate(resolve))
	const header = registry.slots.find((slot) => slot.name === 'conversation.session.header.actions')
	const injected = header.definition.inject()
	await injected.open('session-parent')

	const openCall = calls.find((call) => call.path === '/api/sidechat.open')
	assert.deepEqual(openCall.body, { sessionId: 'session-parent' })
	assert.equal(registry.opened.length, 1)
	assert.equal(registry.opened[0].address, 'dsh-resource://sidechat/session/session-child?parent=session-parent')
	assert.equal(registry.refreshed, 1)
	await new Promise((resolve) => setImmediate(resolve))
	const style = appendedStyles.at(-1)
	assert.match(style.textContent, /session:session-child/)
})

test('the header action hides itself for a side-conversation session', async () => {
	responses.set('/api/sidechat.list', { items: [{ sessionId: 'session-child', parentSessionId: 'session-parent' }] })
	const { registry } = clientHarness()
	await new Promise((resolve) => setImmediate(resolve))
	const header = registry.slots.find((slot) => slot.name === 'conversation.session.header.actions')
	const injected = header.definition.inject()
	assert.equal(injected.index.has('session-child'), true)
})

test('a resource whose side conversation is gone resolves stale without retaining', async () => {
	responses.set('/api/sidechat.list', { items: [] })
	const { registry } = clientHarness()
	const provider = registry.resources[0]
	const controller = new AbortController()
	const generator = provider.open('dsh-resource://sidechat/session/session-dead?parent=session-parent', { signal: controller.signal })
	const value = await firstValue(generator)
	assert.equal(value.ok, true)
	assert.equal(value.value.stale, true)
	assert.equal(value.value.reference, undefined)
	assert.equal(registry.retained.length, 0)
	controller.abort()
	await generator.next()
})

test('a failed live-list probe is fail-open and retains the session', async () => {
	responses.delete('/api/sidechat.list')
	const { registry } = clientHarness()
	const provider = registry.resources[0]
	const controller = new AbortController()
	const generator = provider.open('dsh-resource://sidechat/session/session-child?parent=session-parent', { signal: controller.signal })
	const value = await firstValue(generator)
	assert.equal(value.value.stale, false)
	assert.equal(registry.retained.length, 1)
	controller.abort()
	await generator.next()
})

test('closing a tab retains the session, then posts the host close route', async () => {
	responses.set('/api/sidechat.list', { items: [{ sessionId: 'session-child', parentSessionId: 'session-parent' }] })
	responses.set('/api/sidechat.close', { ok: true, disposed: true })
	const { registry } = clientHarness()
	const provider = registry.resources[0]
	const controller = new AbortController()
	const generator = provider.open('dsh-resource://sidechat/session/session-child?parent=session-parent', { signal: controller.signal })
	const value = await firstValue(generator)
	assert.equal(value.value.stale, false)
	assert.equal(typeof value.value.reference.release, 'function')
	assert.equal(registry.retained.length, 1)
	assert.equal(registry.retained[0].id, 'session-child')

	calls.length = 0
	controller.abort()
	await generator.next()
	const closeCall = calls.find((call) => call.path === '/api/sidechat.close')
	assert.ok(closeCall, 'close route posted')
	assert.deepEqual(closeCall.body, { sessionId: 'session-child' })
})

test('the finish action posts the close route before closing the tab', async () => {
	responses.set('/api/sidechat.list', { items: [] })
	responses.set('/api/sidechat.close', { ok: true, disposed: true })
	const { registry } = clientHarness()
	const body = registry.slots.find((slot) => slot.name === 'sidebar.right.pane.tab')
	const injected = body.definition.inject()
	await injected.finish('tab-1', 'session-child')
	assert.deepEqual(calls.find((call) => call.path === '/api/sidechat.close').body, { sessionId: 'session-child' })
	assert.deepEqual(registry.closed, ['tab-1'])
})
