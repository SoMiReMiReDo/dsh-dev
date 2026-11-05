/**
 * Contract tests for `lib/inner-driver.mjs`.
 *
 * The driver translates the page API used by `lib/collect.mjs` onto the
 * `ctx.innerChrome` Host service. A fake service records every call, so these
 * tests pin the command shape (tab routing, inject script, wait flags) without
 * a browser.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createInnerDriver } from '../lib/inner-driver.mjs'

/** Build one fake `innerChrome` Host service. */
function fakeService({ connected = true, failClose = false } = {}) {
	const calls = []
	let counter = 0
	const service = {
		calls,
		async status() {
			return {
				client: {
					connected,
					platform: 'desktop',
					capabilities: ['open', 'eval', 'close', 'inject'],
				},
				version: '0.2.0',
			}
		},
		async open(url, options = {}) {
			calls.push({ kind: 'open', url, options })
			counter += 1
			return {
				tabId: options.tabId ?? `tab-${counter}`,
				sessionId: options.sessionId ?? '',
				url,
				title: '标题',
				loading: false,
				injected: options.injectScript !== undefined,
			}
		},
		async evaluate(expression, options = {}) {
			calls.push({ kind: 'eval', expression, options })
			if (expression === 'location.href') return { value: 'https://www.xiaohongshu.com/explore' }
			if (expression.startsWith('window.scrollBy')) return { value: undefined }
			return { value: { echoed: expression } }
		},
		async close(tabId, options = {}) {
			calls.push({ kind: 'close', tabId, options })
			if (failClose) {
				const error = new Error('标签页不存在')
				error.code = 'NO_TAB'
				throw error
			}
			return { tabId, closed: true }
		},
	}
	return service
}

test('createInnerDriver rejects a missing service with NO_CLIENT', () => {
	assert.throws(() => createInnerDriver({}), (error) => {
		assert.equal(error.code, 'NO_CLIENT')
		return true
	})
})

test('first goto opens a new tab with the inject script; later gotos reuse the tab', async () => {
	const service = fakeService()
	const driver = createInnerDriver({ service, sessionId: 'session-1', settings: { innerSettleMs: 0 } })
	const page = await driver.newPage()
	page.addInitScript('window.__TEST__ = 1')
	await page.goto('https://www.xiaohongshu.com/explore')
	await page.goto('https://www.xiaohongshu.com/notification')

	const opens = service.calls.filter((call) => call.kind === 'open')
	assert.equal(opens.length, 2)
	assert.equal(opens[0].options.newTab, true)
	assert.equal(opens[0].options.sessionId, 'session-1')
	assert.equal(opens[0].options.injectScript, 'window.__TEST__ = 1')
	assert.equal(opens[0].options.waitForLoad, true)
	assert.equal(opens[1].options.tabId, 'tab-1')
	assert.equal(opens[1].options.newTab, undefined)
	assert.equal(driver.tabIds.has('tab-1'), true)
})

test('goto with waitUntil none does not wait for the load and skips the settle delay', async () => {
	const service = fakeService()
	const driver = createInnerDriver({ service, sessionId: 's', settings: { innerSettleMs: 0 } })
	const page = await driver.newPage()
	await page.goto('https://www.xiaohongshu.com/im', { waitUntil: 'none', timeoutMs: 8000 })
	const open = service.calls.find((call) => call.kind === 'open')
	assert.equal(open.options.waitForLoad, false)
	assert.equal(open.options.timeoutMs, 8000)
})

test('goto reopens a fresh tab when the current one disappeared', async () => {
	const service = fakeService()
	let opened = 0
	const originalOpen = service.open
	service.open = async (url, options = {}) => {
		if (options.tabId === 'tab-1') {
			const error = new Error('找不到标签页 tab-1')
			error.code = 'NO_TAB'
			throw error
		}
		opened += 1
		return await originalOpen(url, options)
	}
	const driver = createInnerDriver({ service, sessionId: 's', settings: { innerSettleMs: 0 } })
	const page = await driver.newPage()
	await page.goto('https://www.xiaohongshu.com/explore')
	await page.goto('https://www.xiaohongshu.com/notification')
	const opens = service.calls.filter((call) => call.kind === 'open')
	assert.equal(opened, 2)
	assert.equal(opens.at(-1).options.newTab, true)
})

test('evaluate forwards the tab id and the configured timeout', async () => {
	const service = fakeService()
	const driver = createInnerDriver({ service, sessionId: 's', settings: { evalTimeoutMs: 5000, innerSettleMs: 0 } })
	const page = await driver.newPage()
	await page.goto('https://www.xiaohongshu.com/explore')
	const value = await page.evaluate('document.title')
	assert.deepEqual(value, { echoed: 'document.title' })
	const evalCall = service.calls.find((call) => call.kind === 'eval')
	assert.equal(evalCall.options.tabId, 'tab-1')
	assert.equal(evalCall.options.sessionId, 's')
	assert.equal(evalCall.options.timeoutMs, 5000)
	assert.equal(await page.getLocationHref(), 'https://www.xiaohongshu.com/explore')
})

test('evaluate before the first goto fails clearly', async () => {
	const service = fakeService()
	const driver = createInnerDriver({ service, sessionId: 's' })
	const page = await driver.newPage()
	await assert.rejects(() => page.evaluate('1 + 1'), /页面尚未打开/)
})

test('scrollToLoadMore issues bounded scrollBy evaluations', async () => {
	const service = fakeService()
	const driver = createInnerDriver({ service, sessionId: 's', settings: { innerSettleMs: 0 } })
	const page = await driver.newPage()
	await page.goto('https://www.xiaohongshu.com/explore')
	const done = await page.scrollToLoadMore({ times: 3, distance: 900, delayMs: 0 })
	assert.equal(done, 3)
	const scrolls = service.calls.filter((call) => call.kind === 'eval' && call.expression.startsWith('window.scrollBy'))
	assert.equal(scrolls.length, 3)
	assert.equal(scrolls[0].expression, 'window.scrollBy(0, 900)')
})

test('close closes the tracked tab once and never throws', async () => {
	const service = fakeService({ failClose: true })
	const driver = createInnerDriver({ service, sessionId: 's', settings: { innerSettleMs: 0 } })
	const page = await driver.newPage()
	await page.goto('https://www.xiaohongshu.com/explore')
	await page.close()
	await page.close()
	assert.equal(service.calls.filter((call) => call.kind === 'close').length, 1)
	assert.equal(driver.tabIds.size, 0)
})

test('pages() reports the connection and the open tabs of this driver', async () => {
	const connected = createInnerDriver({ service: fakeService(), sessionId: 's' })
	assert.deepEqual(await connected.pages(), [])
	const disconnected = createInnerDriver({ service: fakeService({ connected: false }), sessionId: 's' })
	await assert.rejects(() => disconnected.pages(), (error) => {
		assert.equal(error.code, 'NO_CLIENT')
		return true
	})
})

test('status() describes the built-in browser', async () => {
	const driver = createInnerDriver({ service: fakeService(), sessionId: 's' })
	const status = await driver.status()
	assert.equal(status.backend, 'inner-chrome')
	assert.equal(status.connected, true)
	assert.equal(status.platform, 'desktop')
	assert.deepEqual(status.tabIds, [])
})

test('close() closes every tab the driver opened', async () => {
	const service = fakeService()
	const tracked = []
	const driver = createInnerDriver({
		service,
		sessionId: 's',
		settings: { innerSettleMs: 0 },
		onTrack: (tabId) => tracked.push(tabId),
	})
	const first = await driver.newPage()
	await first.goto('https://www.xiaohongshu.com/explore')
	assert.deepEqual(tracked, ['tab-1'])
	const closed = await driver.close()
	assert.equal(closed, 1)
	assert.equal(driver.tabIds.size, 0)
	assert.equal(service.calls.filter((call) => call.kind === 'close').length, 1)
})
