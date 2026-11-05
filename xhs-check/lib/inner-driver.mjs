/**
 * Page driver backed by the DSH built-in browser (`dsh-inner-chrome`).
 *
 * `lib/collect.mjs` is written against a tiny page-object interface
 * (`goto` / `evaluate` / `scrollToLoadMore` / `getLocationHref` / `close` /
 * `addInitScript`). The legacy backend implements it over CDP against an
 * external Chrome; this module implements the same interface over the
 * `ctx.innerChrome` Host service, so the collectors run unchanged inside the
 * right-sidebar browser (where the user is already signed in).
 *
 * Mapping:
 *
 * | page method          | inner-chrome command                          |
 * |----------------------|-----------------------------------------------|
 * | `newPage()`          | first `open` uses `newTab: true`              |
 * | `goto(url)`          | `open { url, tabId?, injectScript? }`         |
 * | `evaluate(expr)`     | `eval { expression }`                         |
 * | `scrollToLoadMore()` | `eval` + `window.scrollBy`                    |
 * | `getLocationHref()`  | `eval` + `location.href`                      |
 * | `addInitScript()`    | passed as `injectScript` on the next `goto`   |
 * | `close()`            | `close { tabId }`                             |
 *
 * Tabs are session-scoped in the built-in browser (the sidebar isolates storage
 * per session), so every driver is bound to the Session id that issued the tool
 * call. Explicit `tabId` routing keeps commands on our own tab and never
 * hijacks a tab the user is browsing.
 */

import { TAKE_EXPRESSION } from './recorder.mjs'

/** Default timeout for one page-script evaluation. */
const DEFAULT_EVAL_TIMEOUT_MS = 20000

/** Upper bound accepted by the inner-chrome protocol. */
const MAX_EVAL_TIMEOUT_MS = 60000

/** Broker waits `eval timeout + 5s`, so give `open` more room than the default 25s. */
const OPEN_TIMEOUT_MS = 45000

/** Short settle window after a navigation so the SPA can hydrate before the first drain. */
const DEFAULT_SETTLE_MS = 400

/** Longest init-script bundle accepted by the inner-chrome protocol. */
const MAX_INJECT_CHARS = 262144

/** Bound on one `scrollToLoadMore` step. */
const MAX_SCROLL_TIMES = 80

/**
 * Sleep for a bounded time.
 * @param ms - milliseconds.
 * @returns a promise.
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Clamp an untrusted number into an inclusive integer range.
 * @param value - candidate.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - value used when the candidate is not finite.
 * @returns the clamped integer.
 */
function clamp(value, min, max, fallback) {
	const number = Number(value)
	if (!Number.isFinite(number)) return fallback
	return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * Wrap a driver failure with the guidance a user needs for that protocol code.
 * @param error - error thrown by the `innerChrome` service.
 * @returns the error to surface (the original when no mapping applies).
 */
function decorateError(error) {
	const code = typeof error?.code === 'string' ? error.code : ''
	const message = error instanceof Error ? error.message : String(error)
	if (code === 'NO_CLIENT') {
		const wrapped = new Error(`内置浏览器没有连接：请确认 DSH Desktop 窗口开着，并在右侧栏打开「内置浏览器」标签页后重试（${message}）`)
		wrapped.code = code
		return wrapped
	}
	if (code === 'CLIENT_GONE') {
		const wrapped = new Error(`内置浏览器连接已断开：请刷新页面后在右侧栏重新打开「内置浏览器」再重试（${message}）`)
		wrapped.code = code
		return wrapped
	}
	if (code === 'NO_TAB') {
		const wrapped = new Error(`内置浏览器标签页不可用：${message}`)
		wrapped.code = code
		return wrapped
	}
	return error
}

/**
 * Create one page handle for a driver.
 *
 * @param driver - owning driver face (tab registry + service).
 * @returns the page face used by `lib/collect.mjs`.
 */
function createPage(driver) {
	let tabId
	let closed = false
	const initScripts = []

	/**
	 * Combine the registered init scripts into one injectable bundle.
	 * @returns the script text, or undefined when nothing was registered.
	 */
	function initBundle() {
		if (initScripts.length === 0) return undefined
		const text = initScripts.join('\n;\n')
		return text.length > MAX_INJECT_CHARS ? text.slice(0, MAX_INJECT_CHARS) : text
	}

	const page = {
		/** Tab id once the first navigation created it (diagnostics only). */
		get tabId() {
			return tabId
		},

		/**
		 * Register a script evaluated in the page after every navigation.
		 * @param source - script source (the network recorder, normally).
		 */
		addInitScript(source) {
			if (typeof source !== 'string' || source === '') return
			initScripts.push(source)
		},

		/**
		 * Open or navigate the tab and wait until the load settles.
		 * @param url - HTTP(S) address.
		 * @param options - { waitUntil?: 'none', timeoutMs?: number }.
		 * @returns the open command value.
		 */
		async goto(url, options = {}) {
			if (closed) throw new Error('页面已关闭')
			if (typeof url !== 'string' || url === '') throw new Error('goto 需要 url')
			const waitForLoad = options?.waitUntil !== 'none'
			const injectScript = initBundle()
			const timeoutMs = clamp(options?.timeoutMs, 5000, 120000, OPEN_TIMEOUT_MS)
			let value
			if (tabId === undefined) {
				value = await driver.service.open(url, {
					sessionId: driver.sessionId,
					newTab: true,
					injectScript,
					waitForLoad,
					timeoutMs,
				})
				tabId = value?.tabId
				driver.track(tabId)
			} else {
				try {
					value = await driver.service.open(url, {
						sessionId: driver.sessionId,
						tabId,
						injectScript,
						waitForLoad,
						timeoutMs,
					})
				} catch (error) {
					if (error?.code !== 'NO_TAB') throw decorateError(error)
					// The user closed our tab: forget it and open a fresh one.
					driver.forget(tabId)
					tabId = undefined
					return await page.goto(url, options)
				}
			}
			if (waitForLoad && driver.settleMs > 0) await sleep(driver.settleMs)
			return value
		},

		/**
		 * Evaluate one expression in the page's main world.
		 * @param expression - JavaScript expression source.
		 * @returns the JSON value produced by the page.
		 */
		async evaluate(expression) {
			if (closed) throw new Error('页面已关闭')
			if (tabId === undefined) throw new Error('页面尚未打开：请先 goto')
			const result = await driver.service.evaluate(String(expression), {
				sessionId: driver.sessionId,
				tabId,
				timeoutMs: driver.evalTimeoutMs,
			})
			return result?.value
		},

		/**
		 * Drain the recorder buffer, tolerating a page that is still loading.
		 * @returns captured entries.
		 */
		async drainCaptures() {
			const text = await page.evaluate(TAKE_EXPRESSION)
			if (typeof text !== 'string' || text === '') return []
			try {
				const parsed = JSON.parse(text)
				return Array.isArray(parsed) ? parsed : []
			} catch (error) {
				return []
			}
		},

		/**
		 * Scroll the page down a bounded number of times, pausing between steps.
		 * @param options - { times, distance, delayMs }.
		 * @returns number of completed scroll steps.
		 */
		async scrollToLoadMore(options = {}) {
			const times = clamp(options.times, 1, MAX_SCROLL_TIMES, 1)
			const distance = clamp(options.distance, 100, 20000, 1200)
			const delayMs = clamp(options.delayMs, 0, 30000, 1200)
			let completed = 0
			for (let index = 0; index < times; index += 1) {
				if (closed) break
				try {
					await page.evaluate(`window.scrollBy(0, ${distance})`)
				} catch (error) {
					break
				}
				completed += 1
				if (delayMs > 0) await sleep(delayMs)
			}
			return completed
		},

		/**
		 * Read the tab's committed URL.
		 * @returns the URL, or an empty string when it cannot be read.
		 */
		async getLocationHref() {
			try {
				const href = await page.evaluate('location.href')
				return typeof href === 'string' ? href : ''
			} catch (error) {
				return ''
			}
		},

		/** No-op: opening a tab already reveals it in the sidebar. */
		bringToFront() {},

		/**
		 * Close this page's tab. Safe to call twice; never throws.
		 * @returns nothing.
		 */
		async close() {
			if (closed) return
			closed = true
			const target = tabId
			tabId = undefined
			if (target === undefined) return
			driver.forget(target)
			try {
				await driver.service.close(target, { sessionId: driver.sessionId })
			} catch (error) {
				// A tab the user already closed is not an error for a collector.
			}
		},
	}

	return page
}

/**
 * Create the built-in-browser driver.
 *
 * @param options - { service, sessionId, settings?, onTrack? }.
 *   `service` is the Host `ctx.innerChrome` service provided by `dsh-inner-chrome`;
 *   `sessionId` is the Session that issued the tool call (tab ownership);
 *   `onTrack(tabId)` / `onUntrack(tabId)` let the plugin keep a cross-job tab registry.
 * @returns the driver face shared with the CDP backend.
 */
export function createInnerDriver({ service, sessionId, settings = {}, onTrack, onUntrack } = {}) {
	if (service === undefined || service === null) {
		const error = new Error('内置浏览器插件（dsh-inner-chrome）不可用：请在插件页确认它已启用后重试')
		error.code = 'NO_CLIENT'
		throw error
	}
	/** Tab ids this driver opened; used for health checks and teardown. */
	const tabs = new Set()
	const driver = {
		kind: 'inner-chrome',
		service,
		sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined,
		evalTimeoutMs: clamp(settings.evalTimeoutMs, 1000, MAX_EVAL_TIMEOUT_MS, DEFAULT_EVAL_TIMEOUT_MS),
		settleMs: clamp(settings.innerSettleMs, 0, 5000, DEFAULT_SETTLE_MS),
		tabIds: tabs,

		/**
		 * Remember a tab this driver owns.
		 * @param tabId - tab id from an `open` result.
		 */
		track(tabId) {
			if (typeof tabId !== 'string' || tabId === '') return
			tabs.add(tabId)
			try {
				onTrack?.(tabId)
			} catch (error) {
				// Bookkeeping hooks must never break a collection.
			}
		},

		/**
		 * Forget a tab (closed by us or by the user).
		 * @param tabId - tab id.
		 */
		forget(tabId) {
			if (typeof tabId !== 'string' || tabId === '') return
			tabs.delete(tabId)
			try {
				onUntrack?.(tabId)
			} catch (error) {
				// Bookkeeping hooks must never break a collection.
			}
		},

		/**
		 * Open one fresh tab.
		 * @returns the page face.
		 */
		async newPage() {
			return createPage(driver)
		},

		/**
		 * Health probe used by the Host half before every collection.
		 * @returns the open tabs of this driver.
		 */
		async pages() {
			const status = await driver.service.status()
			if (status?.client?.connected !== true) {
				const error = new Error('内置浏览器没有连接：请确认 DSH Desktop 窗口开着，并在右侧栏打开「内置浏览器」标签页后重试')
				error.code = 'NO_CLIENT'
				throw error
			}
			return [...tabs].map((tabId) => ({ tabId }))
		},

		/**
		 * Describe the driver for `xhs_status` and the settings panel.
		 * @returns the snapshot.
		 */
		async status() {
			const status = await driver.service.status()
			const client = status?.client ?? {}
			return {
				backend: 'inner-chrome',
				available: true,
				connected: client.connected === true,
				platform: typeof client.platform === 'string' ? client.platform : '',
				capabilities: Array.isArray(client.capabilities) ? client.capabilities : [],
				version: typeof status?.version === 'string' ? status.version : '',
				tabIds: [...tabs],
			}
		},

		/**
		 * Close every tab this driver opened (used by `xhs_close`).
		 * @returns number of tabs closed.
		 */
		async close() {
			let closed = 0
			for (const tabId of [...tabs]) {
				tabs.delete(tabId)
				try {
					await driver.service.close(tabId, { sessionId: driver.sessionId })
					closed += 1
				} catch (error) {
					// Already gone: nothing to do.
				}
				try {
					onUntrack?.(tabId)
				} catch (error) {
					// Ignore hook failures.
				}
			}
			return closed
		},
	}
	return driver
}
