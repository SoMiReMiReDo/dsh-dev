/**
 * Host-wiring tests for `index.js` with a fake plugin context.
 *
 * These tests pin the `inner-chrome` backend selection: the tools and the panel
 * routes must talk to the built-in browser through the `ctx.innerChrome` Host
 * service, and must fail with actionable messages when that service is absent.
 * No browser, no network, and no real `~/.dsh` state is touched: the data
 * directory is redirected to a temporary directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { HOME_URL } from '../lib/collect.mjs'

/** One fake `innerChrome` Host service with a recorded call log. */
function fakeInnerChrome() {
	const calls = []
	const tabs = new Map()
	let counter = 0
	return {
		calls,
		async status() {
			return {
				client: {
					connected: true,
					platform: 'desktop',
					capabilities: ['open', 'read', 'click', 'screenshot', 'tabs', 'navigate', 'eval', 'close', 'inject'],
				},
				version: '0.2.0',
				pendingCommands: 0,
			}
		},
		async tabs() {
			return { tabs: [...tabs.values()].map((tab) => ({ ...tab })) }
		},
		async open(url, options = {}) {
			calls.push({ kind: 'open', url, options })
			const tabId = options.tabId ?? `tab-${++counter}`
			tabs.set(tabId, { tabId, url, title: '小红书', active: true })
			return {
				tabId,
				sessionId: options.sessionId ?? '',
				url,
				title: '小红书',
				loading: false,
				injected: options.injectScript !== undefined,
			}
		},
		async evaluate(expression, options = {}) {
			calls.push({ kind: 'evaluate', expression, options })
			if (typeof expression === 'string' && expression.includes('__XHS_TAKE__')) return { value: '[]' }
			if (typeof expression === 'string' && expression.includes('hasLoginEntry')) {
				return { value: { hasLoginEntry: false, hasAvatar: true, nickname: '测试用户' } }
			}
			if (expression === 'location.href') return { value: HOME_URL }
			return { value: null }
		},
		async close(tabId) {
			calls.push({ kind: 'close', tabId })
			const existed = tabs.delete(tabId)
			return { tabId, closed: existed }
		},
	}
}

/**
 * Build one fake Host plugin context.
 * @param options - { innerChrome?: object }.
 * @returns the fake ctx plus captured registrations.
 */
function fakeCtx({ innerChrome } = {}) {
	const tools = new Map()
	const routes = new Map()
	const disposers = []
	const ctx = {
		effect(execute) {
			const value = execute()
			if (typeof value === 'function') disposers.push(value)
			return value
		},
		inject(names, callback) {
			assert.deepEqual(names, ['innerChrome'])
			if (innerChrome === undefined) return undefined
			const value = callback({ innerChrome })
			if (typeof value === 'function') disposers.push(value)
			return value
		},
		connection: {
			fetch: {
				register(definition) {
					routes.set(definition.path, definition)
					return () => { routes.delete(definition.path) }
				},
			},
		},
		tools: {
			register(definition) {
				tools.set(definition.name, definition)
				return () => { tools.delete(definition.name) }
			},
		},
	}
	return { ctx, tools, routes, dispose: () => { for (const dispose of disposers.splice(0)) dispose() } }
}

/** Build one fake tool execution context. */
function fakeExec() {
	return {
		agent: { session: { id: 'session-test' } },
		signal: new AbortController().signal,
	}
}

/** Create an isolated data directory for one test. */
async function tempDataDir(t) {
	const dir = await mkdtemp(join(tmpdir(), 'xhs-index-test-'))
	process.env.XHS_CHECK_DATA_DIR = dir
	process.env.XHS_CHECK_BACKEND = 'inner-chrome'
	t.after(async () => {
		delete process.env.XHS_CHECK_DATA_DIR
		delete process.env.XHS_CHECK_BACKEND
		await rm(dir, { recursive: true, force: true })
	})
	return dir
}

test('status reports the built-in browser backend', async (t) => {
	await tempDataDir(t)
	const innerChrome = fakeInnerChrome()
	const fake = fakeCtx({ innerChrome })
	apply(fake.ctx)
	const status = await fake.tools.get('xhs_status').execute({}, fakeExec())
	assert.equal(status.backend, 'inner-chrome')
	assert.equal(status.browser.available, true)
	assert.equal(status.browser.connected, true)
	assert.equal(status.browser.platform, 'desktop')
	assert.equal(status.settings.backend, 'inner-chrome')
	assert.match(fake.tools.get('xhs_status').description, /内置浏览器/)
	fake.dispose()
})

test('login opens the page in the built-in browser and detects the signed-in account', async (t) => {
	await tempDataDir(t)
	const innerChrome = fakeInnerChrome()
	const fake = fakeCtx({ innerChrome })
	apply(fake.ctx)

	const result = await fake.tools.get('xhs_login').execute({ waitSeconds: 5 }, fakeExec())
	assert.equal(result.backend, 'inner-chrome')
	assert.equal(result.login.loggedIn, true)
	assert.equal(result.login.nickname, '测试用户')
	assert.equal(result.browser.connected, true)
	assert.ok(result.browser.tabIds.length > 0, 'the login tab must be tracked')

	const opened = innerChrome.calls.filter((call) => call.kind === 'open')
	assert.equal(opened.length, 1)
	assert.equal(opened[0].url, HOME_URL)
	assert.equal(opened[0].options.newTab, true)
	assert.equal(opened[0].options.sessionId, 'session-test')
	// The recorder must be injected on the navigation that produced the page.
	assert.match(opened[0].options.injectScript ?? '', /__XHS_NET__/)
	fake.dispose()
})

test('close closes the tabs this plugin opened', async (t) => {
	await tempDataDir(t)
	const innerChrome = fakeInnerChrome()
	const fake = fakeCtx({ innerChrome })
	apply(fake.ctx)
	await fake.tools.get('xhs_login').execute({ waitSeconds: 5 }, fakeExec())

	const closed = await fake.tools.get('xhs_close').execute({}, fakeExec())
	assert.equal(closed.backend, 'inner-chrome')
	assert.ok(closed.closed >= 1)
	assert.equal(innerChrome.calls.filter((call) => call.kind === 'close').length, closed.closed)
	const status = await fake.tools.get('xhs_status').execute({}, fakeExec())
	assert.deepEqual(status.browser.tabIds, [])
	fake.dispose()
})

test('collection fails with guidance when dsh-inner-chrome is not loaded', async (t) => {
	await tempDataDir(t)
	const fake = fakeCtx({})
	apply(fake.ctx)
	await assert.rejects(
		() => fake.tools.get('xhs_collect').execute({ mode: 'search', keyword: '咖啡' }, fakeExec()),
		(error) => {
			assert.match(error.message, /内置浏览器插件（dsh-inner-chrome）不可用/)
			assert.equal(error.code, 'NO_CLIENT')
			return true
		},
	)
	fake.dispose()
})

test('probe drives the built-in browser end to end and writes the raw capture', async (t) => {
	await tempDataDir(t)
	const innerChrome = fakeInnerChrome()
	const fake = fakeCtx({ innerChrome })
	apply(fake.ctx)
	const result = await fake.tools.get('xhs_probe').execute({ url: HOME_URL, seconds: 2 }, fakeExec())
	assert.equal(result.mode, 'probe')
	assert.equal(result.captures, 0)
	assert.ok(typeof result.rawPath === 'string' && result.rawPath !== '')
	const opened = innerChrome.calls.filter((call) => call.kind === 'open')
	assert.equal(opened.length, 1)
	assert.equal(opened[0].options.newTab, true)
	assert.equal(innerChrome.calls.filter((call) => call.kind === 'close').length, 1)
	fake.dispose()
})

test('the panel status route returns the same snapshot shape as the tool', async (t) => {
	await tempDataDir(t)
	const innerChrome = fakeInnerChrome()
	const fake = fakeCtx({ innerChrome })
	apply(fake.ctx)
	const route = fake.routes.get('/api/xhs.status')
	assert.ok(route !== undefined, 'the status route must be registered')
	const response = await route.fetch(new Request('http://localhost/api/xhs.status', { method: 'POST', body: '{}' }))
	const payload = await response.json()
	assert.equal(payload.ok, true)
	assert.equal(payload.backend, 'inner-chrome')
	assert.equal(payload.browser.connected, true)
	fake.dispose()
})
