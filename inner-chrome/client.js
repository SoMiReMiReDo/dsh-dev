/**
 * Browser half of dsh-inner-chrome.
 *
 * Registers the right-Sidebar tab type that owns the `browser` kind (an
 * `extension` registration that takes the page over from the shipped
 * implementation), renders a real Electron `<webview>` (or a degraded
 * sandboxed `<iframe>` on the Web), and serves the Agent's browser commands
 * through the Host's long-poll bridge:
 *
 *   POST /api/inner-chrome.hello   -> register this tab as the live client
 *   POST /api/inner-chrome.poll    -> long-poll for one Command
 *   POST /api/inner-chrome.result  -> report the Command's Result
 *
 * Everything is a single module because the client module loader evaluates
 * this file as one bundle (relative ESM imports are not resolvable). Render
 * failures are contained by an error boundary that shows a retryable failure
 * state; the carrier always releases its Electron guest lease on unmount.
 *
 * Only host theme tokens are used for styling; the stylesheet is injected once.
 */

window.__ModuleLoader__.load({
	id: 'dsh-inner-chrome',
	factory(require) {
		const React = require('react')
		const h = React.createElement
		let primitives
		try {
			primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		} catch {
			// The primitives bundle is optional for this plugin: every glyph below
			// is an inline SVG, so a resolution failure must not break the plugin.
			primitives = undefined
		}
		void primitives

		/** Locale namespace for this plugin's visible copy. */
		const NS = 'innerChrome'

		/** Implementation identity of the tab type and its body Slot key. */
		const ID = 'dsh-inner-chrome'

		/** Tab kind taken over from the shipped browser implementation. */
		const KIND = 'browser'

		/** Bridge protocol revision shared with the Host half. */
		const PROTOCOL = 1

		/** Host routes this client is allowed to call (contract §3.2). */
		const ROUTES = {
			hello: '/api/inner-chrome.hello',
			poll: '/api/inner-chrome.poll',
			result: '/api/inner-chrome.result'
		}

		/** Version reported to the Host in `hello`. */
		const VERSION = '0.2.0'

		/** Long-poll wait requested from the Host. */
		const POLL_WAIT_MS = 20000

		/** Client-side ceiling for one poll round trip. */
		const POLL_TIMEOUT_MS = 35000

		/** Delay between returning polls that carried no command. */
		const POLL_IDLE_MS = 250

		/** Reconnect backoff after a failed request. */
		const BACKOFF_MS = [1000, 2000, 5000, 10000]

		/** How long an `open` command waits for the new tab body to register. */
		const TAB_REGISTER_TIMEOUT_MS = 5000

		/** How long a page command waits for the Electron guest to become ready. */
		const TERMINAL_CARRIER_TIMEOUT_MS = 8000

		/** How long a page command waits for an in-flight load to settle. */
		const PAGE_SETTLE_TIMEOUT_MS = 10000

		/** `read` text bounds, per contract §4.4. */
		const READ_DEFAULT_MAX = 20000
		const READ_MIN = 1000
		const READ_MAX = 100000

		/** Screenshot width bounds. */
		const SHOT_DEFAULT_WIDTH = 1600
		const SHOT_MIN_WIDTH = 100
		const SHOT_MAX_WIDTH = 4096

		/** Screenshot capture ceiling: a stalled `capturePage()` must not wedge the bridge. */
		const SHOT_DEFAULT_TIMEOUT_MS = 8000
		const SHOT_MIN_TIMEOUT_MS = 100
		const SHOT_MAX_TIMEOUT_MS = 30000

		/** `eval` bounds, per contract §8.1. */
		const EVAL_DEFAULT_TIMEOUT_MS = 15000
		const EVAL_MIN_TIMEOUT_MS = 100
		const EVAL_MAX_TIMEOUT_MS = 60000
		const EVAL_MAX_EXPRESSION = 262144

		/** Client error codes this half is allowed to report (contract §3.3, §8.1). */
		const CLIENT_ERROR_CODES = new Set([
			'NO_TAB',
			'NO_WEBVIEW',
			'READ_UNSUPPORTED',
			'SCREENSHOT_FAILED',
			'NAV_FAILED',
			'CLICK_NOT_FOUND',
			'UNSUPPORTED_URL',
			'BAD_ARGS',
			'EVAL_FAILED',
			'EVAL_TIMEOUT'
		])

		/** Desktop capabilities; the Web carrier cannot read, click, screenshot, or eval. */
		const DESKTOP_CAPABILITIES = ['open', 'read', 'click', 'screenshot', 'tabs', 'navigate', 'eval', 'close', 'inject']
		const WEB_CAPABILITIES = ['open', 'tabs', 'navigate', 'close']

		/** Inline script returning the current document's title, URL, and text. */
		const READ_JS = `(() => {
	const body = document.body;
	return {
		title: document.title || '',
		url: location.href,
		text: body === null ? '' : String(body.innerText || '')
	};
})()`

		/** Simplified Chinese copy. */
		const zh = {
			'type.label': '内置浏览器',
			'guide.title': '内置浏览器',
			'guide.description': '浏览网页；Agent 可读取正文、点击、截图',
			'header.label': '内置浏览器',
			'header.aria': '在内置浏览器中打开',
			'back': '后退',
			'forward': '前进',
			'reload': '刷新',
			'go': '前往',
			'external': '在系统浏览器中打开',
			'close': '关闭标签页',
			'address.placeholder': '输入网址，回车打开',
			'start.title': '输入网址开始浏览',
			'start.hint': '或让 Agent 调用 inner_chrome_open',
			'start.web': 'Web 端可以浏览页面；读取正文、点击与截图需要 DSH Desktop 的内置浏览器。',
			'loading': '正在打开…',
			'load.failed': '页面加载失败',
			'load.failed.hint': '可以重试，或在系统浏览器中打开。',
			'retry': '重试',
			'error.empty': '请输入网址。',
			'error.invalid': '这个网址无效或过长。',
			'error.protocol': '只支持 HTTP 和 HTTPS 网址。',
			'error.credentials': '网址不能包含用户名或密码。',
			'error.application-origin': '不能在嵌入式浏览器中打开 DSH 应用自身。',
			'error.unsupported': '这个网址不能在内置浏览器中打开。'
		}

		/** English copy with the same key set. */
		const en = {
			'type.label': 'Inner Chrome',
			'guide.title': 'Inner Chrome',
			'guide.description': 'Browse web pages; the Agent can read, click, and screenshot',
			'header.label': 'Inner Chrome',
			'header.aria': 'Open in Inner Chrome',
			back: 'Back',
			forward: 'Forward',
			reload: 'Reload',
			go: 'Go',
			external: 'Open in system browser',
			close: 'Close tab',
			'address.placeholder': 'Enter a URL and press Enter',
			'start.title': 'Enter a URL to start browsing',
			'start.hint': 'Or let the Agent call inner_chrome_open',
			'start.web': 'Pages open on the Web, but reading, clicking, and screenshots require the DSH Desktop build-in browser.',
			loading: 'Opening…',
			'load.failed': 'The page could not load',
			'load.failed.hint': 'Retry, or open it in the system browser.',
			retry: 'Retry',
			'error.empty': 'Enter a URL.',
			'error.invalid': 'That URL is invalid or too long.',
			'error.protocol': 'Only HTTP and HTTPS URLs are supported.',
			'error.credentials': 'URLs cannot contain a username or password.',
			'error.application-origin': 'The embedded browser cannot open the DSH application itself.',
			'error.unsupported': 'That URL cannot be opened in the built-in browser.'
		}

		/** Map a normalization refusal onto its copy key. */
		const URL_REASON_KEYS = {
			empty: 'error.empty',
			invalid: 'error.invalid',
			protocol: 'error.protocol',
			credentials: 'error.credentials',
			'application-origin': 'error.application-origin'
		}

		/** Stylesheet, injected once per document. */
		const CSS = `
.ic-root{height:100%;min-height:0;display:flex;flex:auto;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.ic-toolbar{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:4px;height:38px;padding:5px 6px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.ic-tool{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ic-tool:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ic-tool:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}
.ic-address-box{position:relative;flex:auto;min-width:0}
.ic-address{box-sizing:border-box;width:100%;height:28px;padding:0 34px 0 9px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);outline:none}
.ic-address:focus{border-color:var(--dsw-alias-border-l3)}
.ic-address-go{position:absolute;top:0;right:0;visibility:hidden;opacity:0}
.ic-address-box:focus-within .ic-address-go{visibility:visible;opacity:1}
.ic-content{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.ic-viewport{position:relative;flex:1;min-height:0;display:flex}
.ic-webview{flex:1;width:100%;height:100%;border:0;background:transparent;display:flex}
.ic-frame{flex:1;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base)}
.ic-overlay{position:absolute;inset:0;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-base)}
.ic-start{display:flex;flex-direction:column;align-items:center;gap:6px;max-width:420px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.7}
.ic-start-title{color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size,14px)}
.ic-start-glyph{color:var(--dsw-alias-label-quaternary);margin-bottom:4px}
.ic-failure{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:440px;text-align:center}
.ic-failure-glyph{color:var(--dsw-alias-state-error-primary)}
.ic-failure-title{color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px)}
.ic-failure-detail{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,12px);overflow-wrap:anywhere}
.ic-button{height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.ic-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ic-loading{position:absolute;top:8px;left:50%;transform:translateX(-50%);padding:2px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;pointer-events:none;white-space:nowrap}
.ic-header-button{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ic-header-button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
`

		/**
		 * Inject the plugin stylesheet once.
		 * @returns nothing; a document-less test realm is left alone.
		 */
		function installStyles() {
			try {
				if (typeof document === 'undefined' || typeof document.createElement !== 'function') return
				const existing = typeof document.querySelector === 'function' ? document.querySelector('style[data-dsh-inner-chrome]') : null
				if (existing !== null && existing !== undefined) return
				const tag = document.createElement('style')
				tag.setAttribute('data-dsh-inner-chrome', '')
				tag.textContent = CSS
				document.head.appendChild(tag)
			} catch (error) {
				console.warn('inner-chrome: stylesheet injection failed:', error)
			}
		}

		/**
		 * Current DSH document origin, which the embedded browser refuses to open.
		 * @returns the origin, or undefined when unavailable.
		 */
		function applicationOrigin() {
			try {
				if (typeof window === 'undefined' || window.location === undefined || window.location === null) return undefined
				return typeof window.location.origin === 'string' ? window.location.origin : undefined
			} catch {
				return undefined
			}
		}

		/**
		 * Detect the Electron guest bridge exposed by the Desktop preload.
		 * @returns `dshDesktop.browser`, or undefined on the Web build.
		 */
		function detectDesktop() {
			try {
				const carrier = globalThis.dshDesktop
				if (carrier === undefined || carrier === null || carrier.protocolVersion !== PROTOCOL) return undefined
				const bridge = carrier.browser
				if (bridge === undefined || bridge === null) return undefined
				if (typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function') return undefined
				return bridge
			} catch {
				return undefined
			}
		}

		/**
		 * Random UUID with a getRandomValues fallback.
		 * @returns a v4 UUID string.
		 */
		function randomUuid() {
			const cryptoApi = globalThis.crypto
			if (cryptoApi !== undefined && cryptoApi !== null && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
			const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
			bytes[6] = (bytes[6] & 0x0f) | 0x40
			bytes[8] = (bytes[8] & 0x3f) | 0x80
			const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
		}

		/**
		 * Create a coded plugin error.
		 * @param code - one of the client error codes.
		 * @param message - human-readable message.
		 * @returns the error to throw.
		 */
		function clientError(code, message) {
			const error = new Error(message)
			error.code = code
			return error
		}

		/**
		 * Read one error's message.
		 * @param error - anything thrown.
		 * @returns its message text.
		 */
		function errorText(error) {
			if (typeof error === 'string') return error
			if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
			return String(error)
		}

		/**
		 * Capture and JPEG-encode one live guest's viewport.
		 *
		 * The caller bounds the wait: Electron's `webview.capturePage()` can stay
		 * pending while the guest is not visible, so this promise may never settle
		 * and must be raced rather than awaited directly.
		 *
		 * @param guest - the live `<webview>` element.
		 * @param maxWidthValue - requested image width bound.
		 * @returns the encoded image payload.
		 */
		async function captureScreenshot(guest, maxWidthValue) {
			let image
			try {
				image = await guest.capturePage()
			} catch (error) {
				throw clientError('SCREENSHOT_FAILED', `截图失败：${errorText(error)}`)
			}
			if (image === undefined || image === null || typeof image.toDataURL !== 'function') throw clientError('SCREENSHOT_FAILED', '截图失败：页面没有返回图像')
			try {
				const maxWidth = clampInt(maxWidthValue, SHOT_DEFAULT_WIDTH, SHOT_MIN_WIDTH, SHOT_MAX_WIDTH)
				// The renderer has no Node Buffer, so NativeImage.toJPEG() cannot run
				// here. Encode through a canvas instead: it also performs the resize
				// and yields the JPEG the Host persists.
				const dataUrl = image.toDataURL()
				if (typeof dataUrl !== 'string' || dataUrl.startsWith('data:') !== true) throw new Error('页面没有返回图像数据')
				const blob = await (await fetch(dataUrl)).blob()
				const bitmap = await createImageBitmap(blob)
				const scale = bitmap.width > maxWidth ? maxWidth / bitmap.width : 1
				const width = Math.max(1, Math.round(bitmap.width * scale))
				const height = Math.max(1, Math.round(bitmap.height * scale))
				const canvas = document.createElement('canvas')
				canvas.width = width
				canvas.height = height
				const context = canvas.getContext('2d')
				if (context === null) throw new Error('无法创建截图画布')
				context.drawImage(bitmap, 0, 0, width, height)
				if (typeof bitmap.close === 'function') bitmap.close()
				const jpeg = canvas.toDataURL('image/jpeg', 0.82)
				const base64 = jpeg.slice(jpeg.indexOf(',') + 1)
				return { base64, mime: 'image/jpeg', width, height }
			} catch (error) {
				throw clientError('SCREENSHOT_FAILED', `截图失败：${errorText(error)}`)
			}
		}

		/**
		 * Map a thrown value onto the contract's Result error shape.
		 * @param error - anything thrown by a command.
		 * @returns `{ code, message }` with a known code or `INTERNAL`.
		 */
		function resultError(error) {
			const code = error !== null && typeof error === 'object' && typeof error.code === 'string' && CLIENT_ERROR_CODES.has(error.code) ? error.code : 'INTERNAL'
			return { code, message: errorText(error) }
		}

		/**
		 * Normalize one user/Agent supplied address into the HTTP(S) allowlist.
		 * Bare hosts gain `https://`; credentials, non-HTTP protocols, and the DSH
		 * application origin are refused.
		 * @param input - address-bar or command input.
		 * @param origin - current application origin to refuse, when known.
		 * @returns `{ ok: true, url }` or `{ ok: false, reason }`.
		 */
		function normalizeHttpUrl(input, origin) {
			if (typeof input !== 'string') return { ok: false, reason: 'invalid' }
			const trimmed = input.trim()
			if (trimmed === '') return { ok: false, reason: 'empty' }
			if (trimmed.length > 16384) return { ok: false, reason: 'invalid' }
			const candidate = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(trimmed) ? trimmed : `https://${trimmed}`
			let url
			try {
				url = new URL(candidate)
			} catch {
				return { ok: false, reason: 'invalid' }
			}
			if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
			if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'protocol' }
			if (origin !== undefined && origin !== null && origin !== '' && origin !== 'null') {
				try {
					if (url.origin === new URL(origin).origin) return { ok: false, reason: 'application-origin' }
				} catch {
					// An unparsable application origin cannot be compared; allow the page.
				}
			}
			return { ok: true, url: url.href }
		}

		/**
		 * Translate a normalization refusal.
		 * @param t - namespace-bound translate.
		 * @param reason - the refusal reason.
		 * @returns readable copy.
		 */
		function urlProblemText(t, reason) {
			const key = URL_REASON_KEYS[reason] ?? 'error.unsupported'
			try {
				return t(key)
			} catch {
				return key
			}
		}

		/**
		 * Clamp an optional integer argument.
		 * @param value - the supplied value.
		 * @param fallback - default when absent.
		 * @param min - lower bound.
		 * @param max - upper bound.
		 * @returns the bounded integer.
		 */
		function clampInt(value, fallback, min, max) {
			const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
			return Math.min(max, Math.max(min, number))
		}

		/** localStorage key prefix remembering each tab's last committed URL. */
		const URL_STORE_PREFIX = 'dsh-inner-chrome.url.'

		/**
		 * Read one tab's remembered address.
		 * @param tabId - Right-Sidebar tab id.
		 * @returns the stored URL, or undefined.
		 */
		function readStoredUrl(tabId) {
			if (typeof tabId !== 'string' || tabId === '') return undefined
			try {
				const value = localStorage.getItem(URL_STORE_PREFIX + tabId)
				return typeof value === 'string' && value !== '' ? value : undefined
			} catch {
				return undefined
			}
		}

		/**
		 * Remember one tab's committed address so a page reload restores it.
		 * @param tabId - Right-Sidebar tab id.
		 * @param url - committed address.
		 */
		function storeUrl(tabId, url) {
			if (typeof tabId !== 'string' || tabId === '' || typeof url !== 'string' || url === '') return
			try {
				localStorage.setItem(URL_STORE_PREFIX + tabId, url)
			} catch {
				// A full or disabled storage must not break browsing.
			}
		}

		/**
		 * Forget one tab's remembered address.
		 * @param tabId - Right-Sidebar tab id.
		 */
		function clearStoredUrl(tabId) {
			if (typeof tabId !== 'string' || tabId === '') return
			try {
				localStorage.removeItem(URL_STORE_PREFIX + tabId)
			} catch {
				// Ignore storage failures.
			}
		}

		/**
		 * Pick the tab an incoming command addresses.
		 *
		 * Order: the explicitly named tab, then the most recently active tab of the
		 * command's session, then the globally active tab, then the most recent tab.
		 *
		 * @param records - tab records, array or Map.
		 * @param command - the incoming Command (may be undefined).
		 * @param activeTabId - the currently active tab id.
		 * @returns the chosen tab id, or undefined when no tab exists.
		 */
		function routeTabId(records, command, activeTabId) {
			const list = Array.isArray(records) ? records : [...records.values()]
			if (list.length === 0) return undefined
			if (command !== undefined && command !== null && typeof command.tabId === 'string' && command.tabId !== '') {
				const exact = list.find((record) => record.tabId === command.tabId)
				if (exact !== undefined) return exact.tabId
			}
			if (command !== undefined && command !== null && typeof command.sessionId === 'string' && command.sessionId !== '') {
				let best
				for (const record of list) {
					if (record.sessionId !== command.sessionId) continue
					if (best === undefined || (record.lastActiveAt ?? 0) > (best.lastActiveAt ?? 0)) best = record
				}
				if (best !== undefined) return best.tabId
			}
			if (activeTabId !== undefined && list.some((record) => record.tabId === activeTabId)) return activeTabId
			let recent
			for (const record of list) {
				if (recent === undefined || (record.lastActiveAt ?? 0) > (recent.lastActiveAt ?? 0)) recent = record
			}
			return recent?.tabId
		}

		/**
		 * POST one JSON body to a Host route.
		 * @param path - route path.
		 * @param body - JSON-serializable body.
		 * @param signal - optional abort signal.
		 * @returns the parsed payload.
		 */
		async function postJson(path, body, signal) {
			const response = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal
			})
			const payload = await response.json().catch(() => undefined)
			if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
			if (payload !== undefined && payload !== null && payload.ok === false) {
				throw clientError(payload?.error?.code ?? 'INTERNAL', payload?.error?.message ?? 'Host request failed')
			}
			return payload
		}

		/**
		 * Convert NativeImage bytes into base64 in renderer and Node realms.
		 * @param bytes - Buffer, Uint8Array, or array-like.
		 * @returns the base64 payload.
		 */
		function toBase64(bytes) {
			if (bytes !== null && bytes !== undefined && typeof bytes.toString === 'function' && bytes.constructor !== undefined && bytes.constructor.name === 'Buffer') return bytes.toString('base64')
			let array
			if (bytes instanceof Uint8Array) array = bytes
			else if (bytes !== null && bytes !== undefined && bytes.buffer instanceof ArrayBuffer) array = new Uint8Array(bytes.buffer, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)
			else array = Uint8Array.from(bytes ?? [])
			if (typeof btoa === 'function') {
				let binary = ''
				const chunk = 0x8000
				for (let index = 0; index < array.length; index += chunk) binary += String.fromCharCode.apply(null, array.subarray(index, index + chunk))
				return btoa(binary)
			}
			return Buffer.from(array).toString('base64')
		}

		/**
		 * Build the click probe/executor script for one selector or exact label.
		 * @param selector - CSS selector, or undefined.
		 * @param text - exact visible label, or undefined.
		 * @returns an inline script evaluating to `{ found, tag?, text?, clicked? }`.
		 */
		function clickScript(selector, text) {
			return `(() => {
	const selector = ${JSON.stringify(selector ?? null)};
	const wanted = ${JSON.stringify(text ?? null)};
	const describe = (element) => {
		if (typeof element.innerText === 'string' && element.innerText.trim() !== '') return element.innerText.trim();
		return element.getAttribute('aria-label') || element.getAttribute('title') || element.value || '';
	};
	let list;
	if (selector !== null) {
		const element = document.querySelector(selector);
		list = element === null ? [] : [element];
	} else {
		list = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]'));
		if (wanted !== null) list = list.filter((element) => describe(element) === wanted);
	}
	const element = list[0];
	if (element === undefined) return { found: false };
	const label = describe(element);
	const tag = String(element.tagName || '').toLowerCase();
	try {
		if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center', inline: 'center' });
		element.click();
	} catch (error) {
		return { found: true, tag, text: label, clicked: false, error: String(error) };
	}
	return { found: true, tag, text: label, clicked: true };
})()`
		}

		/**
		 * View-side error description.
		 * @param t - namespace-bound translate.
		 * @param error - anything thrown.
		 * @returns `{ code?, message }` for the failure overlay.
		 */
		function viewError(t, error) {
			const message = errorText(error)
			return {
				code: error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined,
				message: message === '' ? t('load.failed') : message
			}
		}

		/** Inline SVG helper: one 16x16 stroke glyph. */
		function strokeSvg(children, size = 16) {
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 16 16',
				fill: 'none',
				'aria-hidden': true,
				focusable: 'false'
			}, children)
		}

		/** Back chevron. */
		function BackGlyph() {
			return strokeSvg(h('path', { d: 'M9.8 3.4 5.2 8l4.6 4.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
		}

		/** Forward chevron. */
		function ForwardGlyph() {
			return strokeSvg(h('path', { d: 'M6.2 3.4 10.8 8l-4.6 4.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
		}

		/** Reload arrow. */
		function ReloadGlyph() {
			return strokeSvg([
				h('path', { key: 'arc', d: 'M12.6 6.2A5 5 0 1 0 13 9.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
				h('path', { key: 'head', d: 'M12.9 3.1v3.4H9.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' })
			])
		}

		/** Submit arrow. */
		function GoGlyph() {
			return strokeSvg([
				h('path', { key: 'shaft', d: 'M3 8h10', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
				h('path', { key: 'head', d: 'M9.4 4.6 12.8 8l-3.4 3.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' })
			])
		}

		/** External-open arrow. */
		function ExternalGlyph() {
			return strokeSvg([
				h('path', { key: 'shaft', d: 'M6.4 3.2H3.2v9.6h9.6V9.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
				h('path', { key: 'head', d: 'M9.2 3.2h3.6v3.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
				h('path', { key: 'diag', d: 'M12.6 3.4 7.6 8.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' })
			])
		}

		/** Close cross. */
		function CloseGlyph() {
			return strokeSvg(h('path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
		}

		/** Globe glyph used by the header button and the guide card. */
		function GlobeGlyph({ size = 16, className }) {
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 24 24',
				fill: 'none',
				className,
				'aria-hidden': true,
				focusable: 'false'
			}, [
				h('circle', { key: 'rim', cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 1.5 }),
				h('ellipse', { key: 'meridian', cx: 12, cy: 12, rx: 4.2, ry: 9, stroke: 'currentColor', strokeWidth: 1.25 }),
				h('path', { key: 'equator', d: 'M3.4 12h17.2', stroke: 'currentColor', strokeWidth: 1.25 })
			])
		}

		/** Guide card artwork. */
		function InnerChromeGuideIcon({ size = 22, className }) {
			return h(GlobeGlyph, { size, className })
		}

		/** Warning glyph for the failure overlay. */
		function WarningGlyph({ size = 28 }) {
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 24 24',
				fill: 'none',
				'aria-hidden': true,
				focusable: 'false'
			}, [
				h('path', { key: 'triangle', d: 'M12 4 21 19H3L12 4Z', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
				h('path', { key: 'bar', d: 'M12 10v4.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
				h('circle', { key: 'dot', cx: 12, cy: 17.2, r: 0.9, fill: 'currentColor' })
			])
		}

		/**
		 * Release one guest lease without letting a rejection escape.
		 * @param bridge - the Desktop browser bridge.
		 * @param lease - reservation lease.
		 * @returns nothing.
		 */
		function releaseLease(bridge, lease) {
			if (lease === undefined) return Promise.resolve()
			return Promise.resolve()
				.then(() => bridge.release(lease))
				.catch((error) => console.warn('inner-chrome: guest lease release failed:', error))
		}

		/**
		 * Desktop carrier: one Electron `<webview>` behind a main-process lease.
		 *
		 * The guest is created only after `acquire` approves the partition; every
		 * failure ends in the failure overlay and in `release(lease)`.
		 *
		 * @param options - container, session, initial address, and state callbacks.
		 * @returns the carrier face used by the toolbar, commands, and teardown.
		 */
		function createDesktopCarrier(options) {
			const { bridge, container, sessionId, onChange, onFailure, onRequestedOpen } = options
			const workspaceKey = `session:${sessionId ?? 'unknown'}`
			const lifetime = new AbortController()
			let element
			let lease
			let unsubscribeOpen
			let ready = false
			let disposed = false
			let pendingUrl = options.initialUrl
			/** Inline script waiting for the next real target document's `dom-ready`. */
			let pendingScript
			/** Latest injection waiter: resolves to whether its script actually ran. */
			let injection = { promise: Promise.resolve(false), resolve: undefined }

			/**
			 * Track one script whose injection the current navigation must report.
			 * Any earlier waiter is superseded and resolves `false`.
			 * @param script - inline script, or undefined when the navigation has none.
			 * @returns the injection outcome promise.
			 */
			function beginInjection(script) {
				settleInjection(false)
				pendingScript = script
				let resolve
				const promise = new Promise((resolvePromise) => {
					resolve = resolvePromise
				})
				injection = { promise, resolve }
				return promise
			}

			/**
			 * Resolve the current injection waiter exactly once.
			 * @param injected - whether its script ran successfully.
			 */
			function settleInjection(injected) {
				const current = injection
				injection = { promise: Promise.resolve(injected), resolve: undefined }
				if (typeof current.resolve === 'function') current.resolve(injected)
			}

			// The body may hand the first navigation an inline script; track it from
			// the start so `injection()` is awaitable before the guest is ready.
			if (typeof options.initialUrl === 'string' && options.initialUrl !== '' && typeof options.initialScript === 'string' && options.initialScript !== '') {
				beginInjection(options.initialScript)
			}

			/**
			 * Publish an observed navigation state.
			 * @param extra - patches to apply on top of the element's own state.
			 */
			function observe(extra) {
				if (disposed || element === undefined) return
				const patch = { ...extra }
				try {
					const current = typeof element.getURL === 'function' ? element.getURL() : ''
					const parsed = current === '' ? undefined : normalizeHttpUrl(current)
					if (parsed !== undefined && parsed.ok) patch.url = parsed.url
					const title = typeof element.getTitle === 'function' ? element.getTitle() : ''
					if (typeof title === 'string' && title !== '') patch.title = title
					patch.loading = typeof element.isLoading === 'function' ? Boolean(element.isLoading()) : false
					patch.canGoBack = typeof element.canGoBack === 'function' ? Boolean(element.canGoBack()) : false
					patch.canGoForward = typeof element.canGoForward === 'function' ? Boolean(element.canGoForward()) : false
				} catch (error) {
					console.warn('inner-chrome: reading guest navigation state failed:', error)
				}
				onChange(patch)
			}

			/** Report one failed operation into the failure overlay. */
			function failed(code, error) {
				if (disposed) return
				onFailure && onFailure({ code, message: errorText(error) })
			}

			return {
				kind: 'webview',
				isReady() {
					return ready === true
				},
				canRead() {
					return true
				},
				canScreenshot() {
					return true
				},
				canEval() {
					return true
				},
				/** Whether the script of the latest navigation was injected (contract §8.1). */
				injection() {
					return injection.promise
				},
				async start() {
					let reservation
					try {
						reservation = await bridge.acquire(workspaceKey)
					} catch (error) {
						failed('NO_WEBVIEW', error)
						throw clientError('NO_WEBVIEW', `无法创建内置浏览器页面：${errorText(error)}`)
					}
					if (disposed || lifetime.signal.aborted) {
						await releaseLease(bridge, reservation?.lease)
						return
					}
					lease = reservation.lease
					const signal = lifetime.signal
					const node = document.createElement('webview')
					node.className = 'ic-webview'
					node.setAttribute('name', reservation.lease)
					node.setAttribute('partition', reservation.partition)
					node.setAttribute('allowpopups', '')
					node.setAttribute('src', `about:blank#${reservation.lease}`)
					node.setAttribute('data-inner-chrome-frame', 'webview')
					element = node
					node.addEventListener('dom-ready', () => {
						if (disposed) return
						ready = true
						onChange({ loading: pendingUrl !== undefined })
						if (pendingUrl !== undefined) {
							const target = pendingUrl
							pendingUrl = undefined
							loadUrl(target).catch((error) => failed('NAV_FAILED', error))
							return
						}
						// The first `dom-ready` is the `about:blank#<lease>` bootstrap
						// document, never a script target. Only a document loaded after
						// a real pending address consumes the pending inline script.
						// Injection is best-effort: command success does not depend on it.
						if (pendingScript === undefined) return
						const script = pendingScript
						pendingScript = undefined
						Promise.resolve()
							.then(() => element.executeJavaScript(script, true))
							.then(() => settleInjection(true), (error) => {
								console.warn('inner-chrome: page script injection failed:', error)
								settleInjection(false)
							})
					}, { signal })
					node.addEventListener('did-navigate', () => observe({}), { signal })
					node.addEventListener('did-navigate-in-page', (event) => {
						if (event?.isMainFrame === false) return
						observe({})
					}, { signal })
					node.addEventListener('did-start-loading', () => {
						if (!disposed) onChange({ loading: true, error: undefined })
					}, { signal })
					node.addEventListener('did-stop-loading', () => observe({}), { signal })
					node.addEventListener('page-title-updated', () => observe({}), { signal })
					node.addEventListener('did-fail-load', (event) => {
						if (event?.isMainFrame === false) return
						if (event?.errorCode === -3) return
						// A failed main-frame load never reaches the target document, so a
						// pending inline script cannot be injected for it.
						pendingScript = undefined
						settleInjection(false)
						const description = event?.errorDescription ?? 'load failed'
						failed('NAV_FAILED', `页面加载失败（${event?.errorCode ?? '?'}）：${description}`)
					}, { signal })
					for (const name of ['destroyed', 'render-process-gone']) {
						node.addEventListener(name, () => {
							if (disposed) return
							const released = lease
							lease = undefined
							ready = false
							pendingUrl = undefined
							pendingScript = undefined
							settleInjection(false)
							safeRemove(node)
							void releaseLease(bridge, released)
							failed('NO_WEBVIEW', '内置浏览器的页面进程已退出，请重试。')
						}, { signal })
					}
					if (typeof bridge.onOpenRequested === 'function') {
						try {
							unsubscribeOpen = bridge.onOpenRequested(reservation.lease, (url) => {
								if (disposed || element !== node) return
								if (typeof url === 'string' && url !== '') onRequestedOpen && onRequestedOpen(url)
							})
						} catch (error) {
							console.warn('inner-chrome: popup subscription failed:', error)
						}
					}
					container.appendChild(node)
				},
				load(url, loadOptions) {
					if (disposed) throw clientError('NO_WEBVIEW', '内置浏览器页面已关闭')
					const script = typeof loadOptions?.script === 'string' && loadOptions.script !== '' ? loadOptions.script : undefined
					if (script !== undefined) beginInjection(script)
					else {
						pendingScript = undefined
						settleInjection(false)
					}
					if (!ready || element === undefined) {
						pendingUrl = url
						onChange({ url, loading: true, error: undefined })
						return Promise.resolve()
					}
					return loadUrl(url)
				},
				goBack() {
					if (disposed || !ready || element === undefined) return
					try {
						if (typeof element.canGoBack === 'function' && element.canGoBack()) element.goBack()
					} catch (error) {
						failed('NAV_FAILED', error)
					}
				},
				goForward() {
					if (disposed || !ready || element === undefined) return
					try {
						if (typeof element.canGoForward === 'function' && element.canGoForward()) element.goForward()
					} catch (error) {
						failed('NAV_FAILED', error)
					}
				},
				reload() {
					if (disposed) return undefined
					if (!ready || element === undefined) {
						onChange({ loading: pendingUrl !== undefined })
						return undefined
					}
					try {
						element.reload()
					} catch (error) {
						failed('NAV_FAILED', error)
					}
					return undefined
				},
				async read() {
					requireGuest()
					const value = await element.executeJavaScript(READ_JS, true)
					return {
						title: typeof value?.title === 'string' ? value.title : '',
						url: typeof value?.url === 'string' ? value.url : '',
						text: typeof value?.text === 'string' ? value.text : String(value?.text ?? '')
					}
				},
				async click(args) {
					requireGuest()
					const value = await element.executeJavaScript(clickScript(args?.selector, args?.text), true)
					return {
						found: value?.found === true,
						tag: typeof value?.tag === 'string' ? value.tag : undefined,
						text: typeof value?.text === 'string' ? value.text : undefined
					}
				},
				/**
				 * Execute one expression in the page's main world (contract §8.1).
				 * @param expression - inline JavaScript, already length-checked by the hub.
				 * @param evalOptions - optional `timeoutMs`.
				 * @returns the page value, structurally clonable.
				 */
				async eval(expression, evalOptions) {
					requireGuest()
					const guest = element
					const timeoutMs = clampInt(evalOptions?.timeoutMs, EVAL_DEFAULT_TIMEOUT_MS, EVAL_MIN_TIMEOUT_MS, EVAL_MAX_TIMEOUT_MS)
					let timer
					const timeout = new Promise((resolve, reject) => {
						timer = setTimeout(() => reject(clientError('EVAL_TIMEOUT', `页面脚本执行超时（${timeoutMs} 毫秒）`)), timeoutMs)
						timer.unref?.()
					})
					const pending = Promise.resolve().then(() => guest.executeJavaScript(expression, true))
					// A rejection after the timeout already won must not surface as unhandled.
					pending.catch(() => {})
					try {
						return await Promise.race([pending, timeout])
					} catch (error) {
						if (error !== null && typeof error === 'object' && error.code === 'EVAL_TIMEOUT') throw error
						throw clientError('EVAL_FAILED', `页面脚本执行失败：${errorText(error)}`)
					} finally {
						clearTimeout(timer)
					}
				},
				async screenshot(args) {
					requireGuest()
					const guest = element
					const timeoutMs = clampInt(args?.timeoutMs, SHOT_DEFAULT_TIMEOUT_MS, SHOT_MIN_TIMEOUT_MS, SHOT_MAX_TIMEOUT_MS)
					let timer
					const timeout = new Promise((resolve, reject) => {
						timer = setTimeout(() => reject(clientError('SCREENSHOT_FAILED', `截图失败：页面截图超时（${timeoutMs} 毫秒），请稍后重试`)), timeoutMs)
						timer.unref?.()
					})
					// A stalled guest capture must never wedge the command bridge: the
					// timeout wins and a late settle stays swallowed here.
					const capture = Promise.resolve().then(() => captureScreenshot(guest, args?.maxWidth))
					capture.catch(() => {})
					try {
						return await Promise.race([capture, timeout])
					} catch (error) {
						if (error !== null && typeof error === 'object' && error.code === 'SCREENSHOT_FAILED') throw error
						throw clientError('SCREENSHOT_FAILED', `截图失败：${errorText(error)}`)
					} finally {
						clearTimeout(timer)
					}
				},
				async dispose() {
					if (disposed) return
					disposed = true
					lifetime.abort()
					try {
						if (typeof unsubscribeOpen === 'function') unsubscribeOpen()
					} catch (error) {
						console.warn('inner-chrome: popup unsubscribe failed:', error)
					}
					unsubscribeOpen = undefined
					const node = element
					element = undefined
					ready = false
					pendingUrl = undefined
					pendingScript = undefined
					settleInjection(false)
					safeRemove(node)
					const released = lease
					lease = undefined
					await releaseLease(bridge, released)
				}
			}

			/** Throw when no live guest can execute page scripts. */
			function requireGuest() {
				if (disposed) throw clientError('NO_WEBVIEW', '内置浏览器页面已关闭')
				if (!ready || element === undefined) throw clientError('NO_WEBVIEW', '内置浏览器页面尚未就绪')
			}

			/**
			 * Navigate the live guest, surfacing rejected loads as NAV_FAILED.
			 * @param url - normalized HTTP(S) address.
			 * @returns when the load has been handed to Chromium.
			 */
			function loadUrl(url) {
				if (disposed || element === undefined) throw clientError('NO_WEBVIEW', '内置浏览器页面已关闭')
				onChange({ url, loading: true, error: undefined })
				return element.loadURL(url).catch((error) => {
					if (disposed) return
					// ERR_ABORTED (-3) means another navigation (a new address, a
					// link click, a user gesture) took over: that is not a failure.
					if (error !== null && typeof error === 'object' && error.code === 'ERR_ABORTED') return
					if (/\(-3\)|ERR_ABORTED/u.test(errorText(error))) return
					const failure = { code: 'NAV_FAILED', message: `页面加载失败：${errorText(error)}` }
					onFailure && onFailure(failure)
					throw clientError('NAV_FAILED', failure.message)
				})
			}
		}

		/**
		 * Detach one DOM node defensively.
		 * @param node - element to remove.
		 */
		function safeRemove(node) {
			try {
				node?.remove()
			} catch (error) {
				console.warn('inner-chrome: element removal failed:', error)
			}
		}

		/**
		 * Web carrier: a sandboxed iframe with application-owned history.
		 *
		 * Cross-origin page content is unreadable, so `read`, `click`, and
		 * `screenshot` refuse with `READ_UNSUPPORTED` per contract §4.3.
		 *
		 * @param options - container, initial address, and state callbacks.
		 * @returns the carrier face used by the toolbar and commands.
		 */
		function createWebCarrier(options) {
			const { container, onChange, onFailure } = options
			const history = []
			let index = -1
			let element
			let disposed = false

			/** Publish the selected application-known history entry. */
			function applyHistory() {
				if (disposed) return
				const url = history[index]
				if (url === undefined) return
				onChange({ url, loading: true, error: undefined, canGoBack: index > 0, canGoForward: index < history.length - 1 })
				if (element !== undefined) element.src = url
			}

			return {
				kind: 'iframe',
				isReady() {
					return element !== undefined
				},
				canRead() {
					return false
				},
				canScreenshot() {
					return false
				},
				canEval() {
					return false
				},
				start() {
					const node = document.createElement('iframe')
					node.className = 'ic-frame'
					node.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox')
					node.setAttribute('referrerpolicy', 'no-referrer')
					node.setAttribute('data-inner-chrome-frame', 'iframe')
					node.addEventListener('load', () => {
						if (!disposed) onChange({ loading: false, canGoBack: index > 0, canGoForward: index < history.length - 1 })
					})
					node.addEventListener('error', () => {
						if (disposed) return
						const failure = { code: 'NAV_FAILED', message: '页面加载失败' }
						onFailure && onFailure(failure)
					})
					element = node
					container.appendChild(node)
					if (typeof options.initialUrl === 'string' && options.initialUrl !== '') {
						history.push(options.initialUrl)
						index = 0
						applyHistory()
					}
				},
				load(url) {
					if (disposed) throw clientError('NO_WEBVIEW', '内置浏览器页面已关闭')
					// The Web carrier cannot run page scripts, so a requested
					// `injectScript` is ignored here (the result reports injected:false).
					if (history[index] === url) {
						applyHistory()
						return
					}
					history.splice(index + 1)
					history.push(url)
					if (history.length > 100) history.splice(0, history.length - 100)
					index = history.length - 1
					applyHistory()
				},
				goBack() {
					if (disposed || index <= 0) return
					index -= 1
					applyHistory()
				},
				goForward() {
					if (disposed || index >= history.length - 1) return
					index += 1
					applyHistory()
				},
				reload() {
					if (disposed) return
					applyHistory()
				},
				async read() {
					throw clientError('READ_UNSUPPORTED', 'Web 端无法读取跨域页面，请使用 DSH Desktop 的内置浏览器。')
				},
				async click() {
					throw clientError('READ_UNSUPPORTED', 'Web 端无法读取跨域页面，请使用 DSH Desktop 的内置浏览器。')
				},
				async screenshot() {
					throw clientError('READ_UNSUPPORTED', 'Web 端无法读取跨域页面，请使用 DSH Desktop 的内置浏览器。')
				},
				async eval() {
					throw clientError('READ_UNSUPPORTED', 'Web 端无法执行页面脚本，请使用 DSH Desktop 的内置浏览器。')
				},
				async dispose() {
					disposed = true
					const node = element
					element = undefined
					safeRemove(node)
				}
			}
		}

		/**
		 * Create the browser application state shared by the tab bodies, the
		 * command bridge, and the `innerChrome` service.
		 *
		 * @param ctx - Client root context.
		 * @param t - namespace-bound translate used by commands.
		 * @returns the hub face.
		 */
		function createHub(ctx, t) {
			const desktop = detectDesktop()
			/** Live tab bodies, keyed by Right-Sidebar tab id. */
			const tabs = new Map()
			/** `open` commands waiting for their tab body to mount. */
			const pendingOpens = new Set()
			/** Last active tab id. */
			let activeTabId
			/** Monotonic activity stamp. */
			let stamp = 0

			/**
			 * Mark a tab active and return its activity stamp.
			 * @param record - tab record.
			 * @returns the stamp.
			 */
			function touch(record) {
				stamp += 1
				record.lastActiveAt = stamp
				activeTabId = record.tabId
				return stamp
			}

			/**
			 * Resolve pending `open` commands whose tab has just mounted.
			 * @param record - the freshly registered tab record.
			 */
			function settlePending(record) {
				for (const entry of [...pendingOpens]) {
					if (entry.url === undefined) continue
					const parsed = normalizeHttpUrl(record.initialUrl ?? record.url, applicationOrigin())
					if (!parsed.ok || parsed.url !== entry.url) continue
					clearTimeout(entry.timer)
					pendingOpens.delete(entry)
					entry.resolve(record)
				}
			}

			/**
			 * Poll a predicate until it holds or the timeout expires. Never rejects:
			 * callers decide whether a timeout is an error.
			 * @param predicate - condition read on each tick.
			 * @param timeoutMs - how long to wait.
			 * @param intervalMs - poll spacing.
			 * @returns whether the predicate held before the timeout.
			 */
			function waitUntil(predicate, timeoutMs, intervalMs = 100) {
				return new Promise((resolve) => {
					let settled = false
					const finish = (value) => {
						if (settled) return
						settled = true
						resolve(value)
					}
					try {
						if (predicate() === true) return finish(true)
					} catch {
						// Treat a throwing predicate as "not yet true".
					}
					const started = Date.now()
					const timer = setInterval(() => {
						let held = false
						try {
							held = predicate() === true
						} catch {
							held = false
						}
						if (held) {
							clearInterval(timer)
							finish(true)
							return
						}
						if (Date.now() - started >= timeoutMs) {
							clearInterval(timer)
							finish(false)
						}
					}, intervalMs)
					timer.unref?.()
				})
			}

			/**
			 * Find the browser tab body for a sidebar tab id.
			 * @param tabId - Right-Sidebar tab id.
			 * @returns the record, or undefined.
			 */
			function recordOf(tabId) {
				return tabId === undefined ? undefined : tabs.get(tabId)
			}

			/**
			 * Forget one tab record once the Sidebar has closed it.
			 * @param record - the tab record.
			 */
			function forgetTab(record) {
				if (tabs.get(record.tabId) !== record) return
				tabs.delete(record.tabId)
				if (activeTabId === record.tabId) {
					activeTabId = [...tabs.values()].reduce((best, candidate) => best === undefined || (candidate.lastActiveAt ?? 0) > (best.lastActiveAt ?? 0) ? candidate : best, undefined)?.tabId
				}
			}

			/**
			 * Await the best-effort script injection of one navigation (contract §8.1).
			 * @param carrier - carrier that ran the navigation.
			 * @param script - the requested inline script, when any.
			 * @returns whether the script actually ran before the page settled.
			 */
			async function injectedOf(carrier, script) {
				if (script === undefined || carrier === undefined || carrier === null || typeof carrier.injection !== 'function') return false
				let timer
				const timeout = new Promise((resolve) => {
					timer = setTimeout(() => resolve(false), PAGE_SETTLE_TIMEOUT_MS)
					timer.unref?.()
				})
				try {
					const injected = await Promise.race([
						Promise.resolve().then(() => carrier.injection()).then((value) => value === true, () => false),
						timeout
					])
					return injected === true
				} finally {
					clearTimeout(timer)
				}
			}

			/**
			 * Await a live, ready carrier for one tab record.
			 * @param record - mounted tab body record.
			 * @returns the carrier face.
			 */
			async function carrierOf(record) {
				if ((record.getCarrier?.() ?? undefined) === undefined && (typeof record.url !== 'string' || record.url === '')) {
					throw clientError('NO_WEBVIEW', '内置浏览器还没有打开网页，请先用 inner_chrome_open 打开一个网址')
				}
				const ready = await waitUntil(() => {
					const current = record.getCarrier?.()
					if (current === undefined || current === null) return false
					return typeof current.isReady !== 'function' || current.isReady() === true
				}, TERMINAL_CARRIER_TIMEOUT_MS)
				const carrier = record.getCarrier?.()
				if (ready !== true || carrier === undefined || carrier === null) {
					throw clientError('NO_WEBVIEW', '内置浏览器页面尚未就绪')
				}
				return carrier
			}

			/**
			 * The most recently active tab of one session.
			 * @param sessionId - owning Session id.
			 * @returns the record, or undefined.
			 */
			function sessionRecord(sessionId) {
				if (typeof sessionId !== 'string' || sessionId === '') return undefined
				let best
				for (const record of tabs.values()) {
					if (record.sessionId !== sessionId) continue
					if (best === undefined || (record.lastActiveAt ?? 0) > (best.lastActiveAt ?? 0)) best = record
				}
				return best
			}

			/**
			 * Route one command to a tab record.
			 * @param command - incoming Command.
			 * @returns the record, or undefined.
			 */
			function recordForCommand(command) {
				const tabId = routeTabId(tabs, command, activeTabId)
				return recordOf(tabId)
			}

			/**
			 * Wait for a tab body to register after `openTab`.
			 * @param url - normalized address whose tab we await.
			 * @param timeoutMs - how long to wait.
			 * @returns the awaited promise plus an idempotent cancellation.
			 */
			function waitForTab(url, timeoutMs) {
				const waiter = { promise: undefined, cancel: undefined }
				waiter.promise = new Promise((resolve, reject) => {
					const entry = { url, resolve, timer: undefined }
					entry.timer = setTimeout(() => {
						pendingOpens.delete(entry)
						reject(clientError('NO_TAB', '内置浏览器标签页没有出现（5 秒超时）'))
					}, timeoutMs)
					entry.timer.unref?.()
					pendingOpens.add(entry)
					waiter.cancel = () => {
						if (!pendingOpens.delete(entry)) return
						clearTimeout(entry.timer)
						resolve(undefined)
					}
				})
				return waiter
			}

			/**
			 * Open one browser tab through the Sidebar service and wait for its body.
			 * @param url - normalized address.
			 * @param sessionId - Session the command came from, when known.
			 * @param openOptions - optional `script` and `waitForLoad` (contract §8.1).
			 * @returns the Result value for `open`.
			 */
			async function openTab(url, sessionId, openOptions = {}) {
				const script = openOptions.script
				const waitForLoad = openOptions.waitForLoad !== false
				const sidebarRight = ctx.sidebarRight
				if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.openTab !== 'function') throw clientError('NO_TAB', '右侧栏不可用，无法打开内置浏览器')
				const params = { url }
				if (script !== undefined) params.script = script
				const waiter = waitForTab(url, TAB_REGISTER_TIMEOUT_MS)
				try {
					sidebarRight.openTab(KIND, { params })
				} catch (error) {
					waiter.cancel?.()
					throw clientError('NO_TAB', `无法打开内置浏览器标签页：${errorText(error)}`)
				}
				const record = await waiter.promise
				if (record === undefined) throw clientError('NO_TAB', '内置浏览器标签页没有出现')
				await waitUntil(() => {
					const carrier = record.getCarrier?.()
					return carrier !== undefined && carrier !== null
				}, TAB_REGISTER_TIMEOUT_MS)
				if (waitForLoad !== true) {
					return {
						tabId: record.tabId,
						sessionId: record.sessionId ?? sessionId ?? '',
						url: record.url !== '' ? record.url : url,
						title: record.title ?? '',
						loading: true,
						injected: false
					}
				}
				await waitUntil(() => record.loading !== true, PAGE_SETTLE_TIMEOUT_MS)
				const injected = await injectedOf(record.getCarrier?.(), script)
				return {
					tabId: record.tabId,
					sessionId: record.sessionId ?? sessionId ?? '',
					url: record.url !== '' ? record.url : url,
					title: record.title ?? '',
					loading: record.loading !== false,
					injected
				}
			}

			/**
			 * Load one address into an existing tab record, starting an idle tab's
			 * carrier first so an auto-opened blank page becomes usable.
			 * @param record - target tab.
			 * @param url - normalized address.
			 * @param openOptions - optional `script` and `waitForLoad` (contract §8.1).
			 * @returns the Result value for `open`.
			 */
			async function loadInto(record, url, openOptions = {}) {
				const script = openOptions.script
				const waitForLoad = openOptions.waitForLoad !== false
				let carrier = record.getCarrier?.()
				if (carrier === undefined || carrier === null) {
					if (typeof record.navigate !== 'function') throw clientError('NO_WEBVIEW', '内置浏览器页面尚未就绪')
					record.navigate(url)
					const ready = await waitUntil(() => {
						const next = record.getCarrier?.()
						return next !== undefined && next !== null
					}, TAB_REGISTER_TIMEOUT_MS)
					carrier = record.getCarrier?.()
					if (ready !== true || carrier === undefined || carrier === null) {
						throw clientError('NO_WEBVIEW', '内置浏览器页面尚未就绪')
					}
				}
				await carrier.load(url, script === undefined ? undefined : { script })
				if (waitForLoad !== true) {
					return {
						tabId: record.tabId,
						sessionId: record.sessionId ?? '',
						url: record.url !== '' ? record.url : url,
						title: record.title ?? '',
						loading: true,
						injected: false
					}
				}
				await waitUntil(() => record.loading !== true, PAGE_SETTLE_TIMEOUT_MS)
				const injected = await injectedOf(carrier, script)
				return {
					tabId: record.tabId,
					sessionId: record.sessionId ?? '',
					url: record.url !== '' ? record.url : url,
					title: record.title ?? '',
					loading: record.loading !== false,
					injected
				}
			}

			/** Result value for `tabs`. */
			function listTabs() {
				return [...tabs.values()].map((record) => ({
					tabId: record.tabId,
					sessionId: record.sessionId ?? '',
					url: record.url ?? '',
					// The bootstrap document title of the guest is `about:blank#<lease>`;
					// reporting it would only leak an internal id to the model.
					title: /^about:blank/iu.test(record.title ?? '') ? '' : (record.title ?? ''),
					active: record.tabId === activeTabId
				}))
			}

			/**
			 * Execute one Host Command.
			 * @param command - Command from the poll response.
			 * @returns the Result value.
			 */
			async function execute(command) {
				if (command === null || typeof command !== 'object') throw clientError('BAD_ARGS', '命令格式无效')
				const kind = command.kind
				const args = command.args !== null && typeof command.args === 'object' ? command.args : {}
				if (kind === 'tabs') return { tabs: listTabs() }
				if (kind === 'open') {
					const parsed = normalizeHttpUrl(args.url, applicationOrigin())
					if (!parsed.ok) throw clientError('UNSUPPORTED_URL', `${urlProblemText(t, parsed.reason)}（${String(args.url ?? '')}）`)
					const sessionId = typeof command.sessionId === 'string' ? command.sessionId : undefined
					const script = typeof args.injectScript === 'string' && args.injectScript !== '' ? args.injectScript : undefined
					const openOptions = { script, waitForLoad: args.waitForLoad !== false }
					if (typeof command.tabId === 'string' && command.tabId !== '') {
						const named = recordOf(command.tabId)
						if (named === undefined) throw clientError('NO_TAB', `找不到标签页 ${command.tabId}`)
						if (args.newTab === true) return await openTab(parsed.url, sessionId, openOptions)
						return await loadInto(named, parsed.url, openOptions)
					}
					const existing = args.newTab === true ? undefined : sessionRecord(sessionId)
					if (existing !== undefined) return await loadInto(existing, parsed.url, openOptions)
					return await openTab(parsed.url, sessionId, openOptions)
				}
				if (kind === 'read') {
					const record = recordForCommand(command)
					if (record === undefined) throw clientError('NO_TAB', '没有打开的内置浏览器标签页')
					const carrier = await carrierOf(record)
					if (typeof carrier.canRead === 'function' && carrier.canRead() === false) throw clientError('READ_UNSUPPORTED', 'Web 端无法读取跨域页面，请使用 DSH Desktop 的内置浏览器。')
					let value
					try {
						value = await carrier.read()
					} catch (error) {
						throw error !== null && typeof error === 'object' && typeof error.code === 'string' ? error : clientError('READ_UNSUPPORTED', `读取页面失败：${errorText(error)}`)
					}
					const text = typeof value?.text === 'string' ? value.text : String(value?.text ?? '')
					const maxChars = clampInt(args.maxChars, READ_DEFAULT_MAX, READ_MIN, READ_MAX)
					const truncated = text.length > maxChars
					return {
						tabId: record.tabId,
						url: typeof value?.url === 'string' && value.url !== '' ? value.url : record.url ?? '',
						title: typeof value?.title === 'string' && value.title !== '' ? value.title : record.title ?? '',
						text: truncated ? text.slice(0, maxChars) : text,
						chars: truncated ? maxChars : text.length,
						truncated
					}
				}
				if (kind === 'click') {
					const record = recordForCommand(command)
					if (record === undefined) throw clientError('NO_TAB', '没有打开的内置浏览器标签页')
					const carrier = await carrierOf(record)
					if (typeof carrier.canRead === 'function' && carrier.canRead() === false) throw clientError('READ_UNSUPPORTED', 'Web 端无法读取跨域页面，请使用 DSH Desktop 的内置浏览器。')
					const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? args.selector.trim() : undefined
					const text = typeof args.text === 'string' && args.text.trim() !== '' ? args.text.trim() : undefined
					if (selector === undefined && text === undefined) throw clientError('BAD_ARGS', 'click 需要 selector 或 text')
					let value
					try {
						value = await carrier.click({ selector, text })
					} catch (error) {
						throw error !== null && typeof error === 'object' && typeof error.code === 'string' ? error : clientError('CLICK_NOT_FOUND', `点击失败：${errorText(error)}`)
					}
					if (value?.found !== true) throw clientError('CLICK_NOT_FOUND', `没有找到可点击的元素（${selector ?? text}）`)
					return {
						tabId: record.tabId,
						url: record.url ?? '',
						title: record.title ?? '',
						found: true,
						tag: typeof value?.tag === 'string' ? value.tag : undefined
					}
				}
				if (kind === 'screenshot') {
					const record = recordForCommand(command)
					if (record === undefined) throw clientError('NO_TAB', '没有打开的内置浏览器标签页')
					const carrier = await carrierOf(record)
					if (typeof carrier.canScreenshot === 'function' && carrier.canScreenshot() === false) throw clientError('READ_UNSUPPORTED', 'Web 端无法截图页面，请使用 DSH Desktop 的内置浏览器。')
					let shot
					try {
						shot = await carrier.screenshot({ maxWidth: args.maxWidth, timeoutMs: args.timeoutMs })
					} catch (error) {
						throw error !== null && typeof error === 'object' && typeof error.code === 'string' ? error : clientError('SCREENSHOT_FAILED', `截图失败：${errorText(error)}`)
					}
					return {
						tabId: record.tabId,
						url: record.url ?? '',
						title: record.title ?? '',
						mime: 'image/jpeg',
						base64: shot?.base64 ?? '',
						width: shot?.width ?? 0,
						height: shot?.height ?? 0
					}
				}
				if (kind === 'navigate') {
					const action = args.action
					if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'goto') throw clientError('BAD_ARGS', 'navigate.action 必须是 back/forward/reload/goto')
					const record = recordForCommand(command)
					if (record === undefined) throw clientError('NO_TAB', '没有打开的内置浏览器标签页')
					const carrier = await carrierOf(record)
					try {
						if (action === 'back') carrier.goBack()
						else if (action === 'forward') carrier.goForward()
						else if (action === 'reload') carrier.reload()
						else {
							const parsed = normalizeHttpUrl(args.url, applicationOrigin())
							if (!parsed.ok) throw clientError('UNSUPPORTED_URL', urlProblemText(t, parsed.reason))
							await carrier.load(parsed.url)
						}
					} catch (error) {
						throw error !== null && typeof error === 'object' && typeof error.code === 'string' ? error : clientError('NAV_FAILED', `导航失败：${errorText(error)}`)
					}
					return { tabId: record.tabId, url: record.url ?? '', title: record.title ?? '' }
				}
				if (kind === 'eval') {
					const expression = typeof args.expression === 'string' ? args.expression : undefined
					if (expression === undefined || expression === '' || expression.length > EVAL_MAX_EXPRESSION) throw clientError('BAD_ARGS', `eval.expression 必须是 1..${EVAL_MAX_EXPRESSION} 字符的字符串`)
					const record = recordForCommand(command)
					if (record === undefined) throw clientError('NO_TAB', '没有打开的内置浏览器标签页')
					const carrier = await carrierOf(record)
					if (typeof carrier.canEval === 'function' && carrier.canEval() === false) throw clientError('READ_UNSUPPORTED', 'Web 端无法执行页面脚本，请使用 DSH Desktop 的内置浏览器。')
					let value
					try {
						value = await carrier.eval(expression, { timeoutMs: args.timeoutMs })
					} catch (error) {
						throw error !== null && typeof error === 'object' && typeof error.code === 'string' ? error : clientError('EVAL_FAILED', `页面脚本执行失败：${errorText(error)}`)
					}
					return {
						tabId: record.tabId,
						url: record.url ?? '',
						title: record.title ?? '',
						value: value ?? null
					}
				}
				if (kind === 'close') {
					const tabId = typeof args.tabId === 'string' && args.tabId !== '' ? args.tabId : (typeof command.tabId === 'string' && command.tabId !== '' ? command.tabId : undefined)
					if (tabId === undefined) throw clientError('BAD_ARGS', 'close 需要 tabId')
					const record = recordOf(tabId)
					if (record === undefined) throw clientError('NO_TAB', `找不到标签页 ${tabId}`)
					const sidebarRight = ctx.sidebarRight
					if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.close !== 'function') throw clientError('NO_TAB', '右侧栏不可用，无法关闭内置浏览器标签页')
					try {
						clearStoredUrl(record.tabId)
						const closing = sidebarRight.close(record.tabId)
						if (closing !== null && typeof closing === 'object' && typeof closing.then === 'function') await closing
					} catch (error) {
						throw clientError('INTERNAL', `关闭内置浏览器标签页失败：${errorText(error)}`)
					}
					forgetTab(record)
					return { tabId: record.tabId, closed: true }
				}
				throw clientError('INTERNAL', `未知命令：${String(kind)}`)
			}

			/** The `innerChrome` Client service (contract §4.5). */
			const service = {
				isAvailable() {
					return true
				},
				isDesktop() {
					return desktop !== undefined
				},
				async open(url, options) {
					const parsed = normalizeHttpUrl(url, applicationOrigin())
					if (!parsed.ok) throw new Error(urlProblemText(t, parsed.reason))
					const sidebarRight = ctx.sidebarRight
					if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.openTab !== 'function') throw new Error('右侧栏不可用，无法打开内置浏览器')
					sidebarRight.openTab(KIND, { params: { url: parsed.url } })
					return { ok: true }
				},
				current() {
					let record = recordOf(activeTabId)
					if (record === undefined) {
						for (const candidate of tabs.values()) if (record === undefined || (candidate.lastActiveAt ?? 0) > (record.lastActiveAt ?? 0)) record = candidate
					}
					if (record === undefined) return undefined
					return { tabId: record.tabId, url: record.url ?? '', title: record.title ?? '' }
				}
			}

			return {
				desktop,
				createCarrier(options) {
					if (desktop !== undefined) return createDesktopCarrier({ ...options, bridge: desktop })
					return createWebCarrier(options)
				},
				/**
				 * Register one mounted tab body.
				 * @param input - identity, initial address, and carrier reader.
				 * @returns the update/dispose handle held by the body.
				 */
				registerTab(input) {
					const record = {
						tabId: input.tabId,
						sessionId: input.sessionId,
						initialUrl: input.initialUrl,
						url: input.url ?? '',
						title: input.title ?? '',
						loading: input.loading !== false,
						active: false,
						lastActiveAt: 0,
						navigate: input.navigate,
						getCarrier: input.getCarrier
					}
					tabs.set(record.tabId, record)
					touch(record)
					settlePending(record)
					return {
						update(patch) {
							if (tabs.get(record.tabId) !== record) return
							let changed = false
							for (const key of ['url', 'title', 'loading']) {
								if (patch[key] !== undefined && patch[key] !== record[key]) {
									record[key] = patch[key]
									changed = true
								}
							}
							if (patch.active === true) {
								record.active = true
								touch(record)
							}
							if (changed && patch.url !== undefined) {
								stamp += 1
								record.lastActiveAt = stamp
							}
						},
						dispose() {
							forgetTab(record)
						}
					}
				},
				execute,
				service,
				openTab(url) {
					const sidebarRight = ctx.sidebarRight
					if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.openTab !== 'function') return
					try {
						sidebarRight.openTab(KIND, { params: { url } })
					} catch (error) {
						console.warn('inner-chrome: openTab failed:', error)
					}
				}
			}
		}

		/**
		 * Failure card shown for load, carrier, and render errors.
		 * @param props - translator, error, and retry action.
		 */
		function FailureView({ t, error, onRetry }) {
			const message = typeof error?.message === 'string' && error.message !== '' ? error.message : t('load.failed')
			return h('div', { className: 'ic-overlay', 'data-inner-chrome-failure': '' }, [
				h('div', { key: 'card', className: 'ic-failure', role: 'alert' }, [
					h('span', { key: 'glyph', className: 'ic-failure-glyph' }, h(WarningGlyph, {})),
					h('span', { key: 'title', className: 'ic-failure-title' }, t('load.failed')),
					h('span', { key: 'detail', className: 'ic-failure-detail' }, message),
					h('span', { key: 'hint', className: 'ic-failure-detail' }, t('load.failed.hint')),
					h('button', { key: 'retry', type: 'button', className: 'ic-button', onClick: onRetry }, t('retry'))
				])
			])
		}

		/**
		 * Start page shown before the first address is requested.
		 * @param props - translator and whether the Web carrier is in use.
		 */
		function StartView({ t, web }) {
			return h('div', { className: 'ic-overlay', 'data-inner-chrome-start': '' }, [
				h('div', { key: 'card', className: 'ic-start' }, [
					h('span', { key: 'glyph', className: 'ic-start-glyph' }, h(GlobeGlyph, { size: 40 })),
					h('span', { key: 'title', className: 'ic-start-title' }, t('start.title')),
					h('span', { key: 'hint' }, t('start.hint')),
					web ? h('span', { key: 'web' }, t('start.web')) : null
				])
			])
		}

		/**
		 * Right-Sidebar tab body: toolbar over the carrier viewport.
		 *
		 * @param props - Slot kit props plus the injected session, hub, and close action.
		 */
		function BrowserTabBody(props) {
			const t = typeof props.t === 'function' ? props.t : fallbackT
			const hub = props.hub
			const useTabInfo = props.useTabInfo
			const { tab } = useTabInfo()
			const navigation = tab?.navigation ?? {}
			const parameterUrl = typeof navigation.params?.url === 'string' && navigation.params.url !== '' ? navigation.params.url : undefined
			// `open` commands may carry an inline script for this first navigation
			// (contract §8.1); the carrier injects it once the target document is ready.
			const parameterScript = typeof navigation.params?.script === 'string' && navigation.params.script !== '' ? navigation.params.script : undefined
			const initialUrl = parameterUrl ?? readStoredUrl(tab?.id)
			const initialParsed = initialUrl === undefined ? undefined : normalizeHttpUrl(initialUrl, applicationOrigin())
			const initialTarget = initialParsed !== undefined && initialParsed.ok ? initialParsed.url : undefined
			const initialFailure = initialUrl !== undefined && initialParsed !== undefined && !initialParsed.ok ? { code: 'UNSUPPORTED_URL', message: urlProblemText(t, initialParsed.reason) } : undefined

			const containerRef = React.useRef(null)
			const carrierRef = React.useRef(undefined)
			const handleRef = React.useRef(undefined)
			const targetRef = React.useRef(initialTarget)
			const [draft, setDraft] = React.useState(initialTarget ?? initialUrl ?? '')
			const [started, setStarted] = React.useState(initialTarget !== undefined)
			const [epoch, setEpoch] = React.useState(0)
			const [view, setView] = React.useState(() => ({
				url: initialTarget ?? '',
				title: '',
				loading: initialTarget !== undefined,
				canGoBack: false,
				canGoForward: false,
				error: initialFailure
			}))

			/**
			 * Merge a patch into the rendered carrier state.
			 * @param patch - partial state.
			 */
			function updateView(patch) {
				setView((current) => ({ ...current, ...patch }))
			}

			// Follow observed navigations in the address bar unless the user is typing.
			React.useEffect(() => {
				setDraft(view.url)
			}, [view.url])

			// Remember the committed address so a page reload restores this tab.
			React.useEffect(() => {
				if (typeof tab?.id === 'string') storeUrl(tab.id, view.url)
			}, [tab?.id, view.url])

			// Register this body as the command bridge's tab occurrence.
			React.useEffect(() => {
				if (hub === undefined || tab === undefined) return undefined
				const handle = hub.registerTab({
					tabId: tab.id,
					sessionId: props.sessionId,
					initialUrl,
					url: initialTarget ?? '',
					title: tab.title ?? '',
					loading: targetRef.current !== undefined,
					navigate: (url) => { navigateTo(url) },
					getCarrier: () => carrierRef.current
				})
				handleRef.current = handle
				return () => {
					handleRef.current = undefined
					handle.dispose()
				}
			}, [hub, tab?.id, props.sessionId, initialTarget, initialUrl])

			// Publish carrier state to the bridge.
			React.useEffect(() => {
				handleRef.current?.update({
					url: view.url,
					title: view.title !== '' ? view.title : tab?.title ?? '',
					loading: view.loading,
					active: tab?.visible === true
				})
			}, [view.url, view.title, view.loading, tab?.title, tab?.visible])

			// Create exactly one carrier per (tab, epoch) once navigation has started.
			React.useEffect(() => {
				if (!started || hub === undefined) return undefined
				const container = containerRef.current
				if (container === null || container === undefined) return undefined
				let cancelled = false
				const carrier = hub.createCarrier({
					sessionId: props.sessionId,
					container,
					initialUrl: targetRef.current,
					initialScript: parameterScript,
					onChange(patch) {
						if (!cancelled) updateView(patch)
					},
					onFailure(error) {
						if (!cancelled) updateView({ loading: false, error })
					},
					onRequestedOpen(url) {
						if (cancelled) return
						const parsed = normalizeHttpUrl(url, applicationOrigin())
						if (!parsed.ok) return
						const actions = tab?.actions
						if (actions !== undefined && typeof actions.openTab === 'function') actions.openTab(KIND, { params: { url: parsed.url }, revealIfOpened: false })
						else hub.openTab(parsed.url)
					}
				})
				carrierRef.current = carrier
				updateView({ loading: true, error: undefined })
				Promise.resolve()
					.then(() => carrier.start())
					.catch((error) => {
						if (!cancelled) updateView({ loading: false, error: viewError(t, error) })
					})
				return () => {
					cancelled = true
					if (carrierRef.current === carrier) carrierRef.current = undefined
					Promise.resolve(carrier.dispose()).catch((error) => console.warn('inner-chrome: carrier dispose failed:', error))
				}
			}, [hub, tab?.id, started, epoch])

			/**
			 * Navigate to one already-normalized address.
			 * @param url - normalized HTTP(S) address.
			 */
			function navigateTo(url) {
				targetRef.current = url
				updateView({ url, loading: true, error: undefined })
				const carrier = carrierRef.current
				if (carrier === undefined) {
					setStarted(true)
					setEpoch((value) => value + 1)
					return
				}
				Promise.resolve()
					.then(() => carrier.load(url))
					.catch((error) => updateView({ loading: false, error: viewError(t, error) }))
			}

			/**
			 * Validate the draft address and navigate.
			 * @param event - form submit event, when any.
			 */
			function submitAddress(event) {
				if (event !== undefined && event !== null && typeof event.preventDefault === 'function') event.preventDefault()
				const parsed = normalizeHttpUrl(draft, applicationOrigin())
				if (!parsed.ok) {
					updateView({ error: { code: 'UNSUPPORTED_URL', message: urlProblemText(t, parsed.reason) } })
					return
				}
				navigateTo(parsed.url)
			}

			/** Retry the failed address, or re-create the carrier. */
			function retry() {
				const candidate = view.url !== '' ? view.url : draft
				const parsed = normalizeHttpUrl(candidate, applicationOrigin())
				if (!parsed.ok) {
					updateView({ error: { code: 'UNSUPPORTED_URL', message: urlProblemText(t, parsed.reason) } })
					return
				}
				targetRef.current = parsed.url
				updateView({ url: parsed.url, loading: true, error: undefined })
				setStarted(true)
				setEpoch((value) => value + 1)
			}

			const url = view.url
			const hasAddress = url !== ''
			const toolbar = h('form', { className: 'ic-toolbar', onSubmit: submitAddress }, [
				h('button', {
					key: 'back',
					type: 'button',
					className: 'ic-tool',
					'aria-label': t('back'),
					title: t('back'),
					disabled: !view.canGoBack,
					onClick: () => carrierRef.current?.goBack()
				}, h(BackGlyph, {})),
				h('button', {
					key: 'forward',
					type: 'button',
					className: 'ic-tool',
					'aria-label': t('forward'),
					title: t('forward'),
					disabled: !view.canGoForward,
					onClick: () => carrierRef.current?.goForward()
				}, h(ForwardGlyph, {})),
				h('button', {
					key: 'reload',
					type: 'button',
					className: 'ic-tool',
					'aria-label': t('reload'),
					title: t('reload'),
					disabled: !hasAddress,
					onClick: () => carrierRef.current?.reload()
				}, h(ReloadGlyph, {})),
				h('div', { key: 'address', className: 'ic-address-box' }, [
					h('input', {
						key: 'input',
						className: 'ic-address',
						value: draft,
						'aria-label': t('address.placeholder'),
						placeholder: t('address.placeholder'),
						spellCheck: false,
						autoComplete: 'off',
						autoCapitalize: 'off',
						autoCorrect: 'off',
						onChange: (event) => setDraft(event.currentTarget?.value ?? '')
					}),
					h('button', {
						key: 'go',
						type: 'submit',
						className: 'ic-tool ic-address-go',
						'aria-label': t('go'),
						title: t('go')
					}, h(GoGlyph, {}))
				]),
				h('button', {
					key: 'external',
					type: 'button',
					className: 'ic-tool',
					'aria-label': t('external'),
					title: t('external'),
					disabled: !hasAddress,
					onClick: () => {
						if (!hasAddress) return
						try {
							window.open(url, '_blank', 'noopener,noreferrer')
						} catch (error) {
							console.warn('inner-chrome: external open failed:', error)
						}
					}
				}, h(ExternalGlyph, {})),
				h('button', {
					key: 'close',
					type: 'button',
					className: 'ic-tool',
					'aria-label': t('close'),
					title: t('close'),
					onClick: () => {
						try {
							clearStoredUrl(tab?.id)
							props.closeTab?.(tab.id)
						} catch (error) {
							console.warn('inner-chrome: close failed:', error)
						}
					}
				}, h(CloseGlyph, {}))
			])

			const content = h('div', { className: 'ic-content' }, [
				h('div', { key: 'viewport', className: 'ic-viewport', ref: containerRef }),
				view.error !== undefined
					? h(FailureView, { key: 'failure', t, error: view.error, onRetry: retry })
					: !started
						? h(StartView, { key: 'start', t, web: hub?.desktop === undefined })
						: view.loading
							? h('div', { key: 'loading', className: 'ic-loading', role: 'status' }, t('loading'))
							: null
			])

			return h('div', { className: 'ic-root', 'data-inner-chrome': '' }, [toolbar, content])
		}

		/**
		 * Error boundary class: a crashed body renders the retryable failure card
		 * instead of taking the Sidebar down with it. Defined once so re-renders do
		 * not remount the carrier subtree.
		 */
		const InnerChromeBoundary = typeof React.Component === 'function'
			? class InnerChromeBoundary extends React.Component {
				constructor(props) {
					super(props)
					this.state = { error: undefined }
				}

				static getDerivedStateFromError(error) {
					return { error }
				}

				componentDidCatch(error) {
					console.warn('inner-chrome: browser tab body crashed:', error)
				}

				render() {
					if (this.state.error !== undefined) {
						const t = typeof this.props.t === 'function' ? this.props.t : fallbackT
						return h(FailureView, { t, error: { code: 'INTERNAL', message: errorText(this.state.error) }, onRetry: () => this.setState({ error: undefined }) })
					}
					return this.props.children
				}
			}
			: undefined

		/**
		 * Error boundary wrapper for the tab body.
		 * @param props - translator plus the real body's props.
		 */
		function BrowserBodyBoundary(props) {
			if (InnerChromeBoundary === undefined) return h(BrowserTabBody, props)
			return h(InnerChromeBoundary, { t: props.t }, h(BrowserTabBody, props))
		}

		/**
		 * Conversation-header action: open the built-in browser tab.
		 * @param props - translator and the open action injected by the Slot.
		 */
		function InnerChromeHeaderButton(props) {
			const t = typeof props.t === 'function' ? props.t : fallbackT
			return h('button', {
				type: 'button',
				className: 'ic-header-button',
				'aria-label': t('header.aria'),
				title: t('header.aria'),
				'data-inner-chrome-header': '',
				onClick: () => {
					try {
						props.openBrowser?.()
					} catch (error) {
						console.warn('inner-chrome: header open failed:', error)
					}
				}
			}, h(GlobeGlyph, { size: 16 }))
		}

		/** Fallback translator used before the locale dictionary is bound. */
		function fallbackT(key) {
			return key
		}

		/**
		 * Start the Host long-poll bridge.
		 * @param ctx - Client root context.
		 * @param hub - browser hub whose `execute` runs commands.
		 * @returns cleanup that stops the loop and aborts the in-flight request.
		 */
		function startBridge(ctx, hub) {
			const clientId = randomUuid()
			const platform = hub.desktop !== undefined ? 'desktop' : 'web'
			const capabilities = platform === 'desktop' ? DESKTOP_CAPABILITIES : WEB_CAPABILITIES
			let stopped = false
			let sleepTimer
			let activeAbort

			/**
			 * Stop-aware sleep.
			 * @param ms - delay in milliseconds.
			 * @returns a promise resolved after the delay or on stop.
			 */
			function sleep(ms) {
				return new Promise((resolve) => {
					if (stopped) return resolve()
					sleepTimer = setTimeout(() => {
						sleepTimer = undefined
						resolve()
					}, ms)
					sleepTimer.unref?.()
				})
			}

			/** Backoff delay for one failed attempt. */
			function backoff(attempt) {
				return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
			}

			function stop() {
				stopped = true
				if (sleepTimer !== undefined) clearTimeout(sleepTimer)
				sleepTimer = undefined
				try {
					activeAbort?.abort()
				} catch (error) {
					console.warn('inner-chrome: poll abort failed:', error)
				}
				activeAbort = undefined
			}

			void (async () => {
				let attempt = 0
				while (!stopped) {
					try {
						await postJson(ROUTES.hello, { clientId, protocol: PROTOCOL, platform, capabilities, version: VERSION })
						break
					} catch (error) {
						if (stopped) return
						console.warn('inner-chrome: hello failed, retrying:', errorText(error))
						await sleep(backoff(attempt))
						attempt += 1
					}
				}
				if (stopped) return
				attempt = 0
				while (!stopped) {
					let payload
					try {
						const abort = new AbortController()
						activeAbort = abort
						const timer = setTimeout(() => abort.abort(), POLL_TIMEOUT_MS)
						timer.unref?.()
						try {
							payload = await postJson(ROUTES.poll, { clientId, waitMs: POLL_WAIT_MS }, abort.signal)
						} finally {
							clearTimeout(timer)
							if (activeAbort === abort) activeAbort = undefined
						}
					} catch (error) {
						if (stopped) return
						console.warn('inner-chrome: poll failed, retrying:', errorText(error))
						await sleep(backoff(attempt))
						attempt += 1
						continue
					}
					attempt = 0
					const command = payload?.command
					if (command === null || command === undefined) {
						await sleep(POLL_IDLE_MS)
						continue
					}
					let result
					try {
						const value = await hub.execute(command)
						result = { clientId, id: command.id, ok: true, value }
					} catch (error) {
						result = { clientId, id: command.id, ok: false, error: resultError(error) }
					}
					try {
						await postJson(ROUTES.result, result)
					} catch (error) {
						if (!stopped) console.warn('inner-chrome: result report failed:', errorText(error))
					}
				}
			})()

			return stop
		}

		/** Required Client services. */
		const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

		/**
		 * Client plugin body: register copy, the `browser` tab type and body, the
		 * header action, the `innerChrome` service, the one-time chat preference
		 * migration, the first-run tab, and the Host command bridge.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS)
			const hub = createHub(ctx, t)
			installStyles()

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'inner-chrome: dictionaries')

			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: ID,
				kind: KIND,
				multiple: true,
				priority: 'extension',
				keepMounted: hub.desktop !== undefined,
				title: () => t('type.label'),
				guide: [{
					id: 'new',
					order: 30,
					title: () => t('guide.title'),
					description: () => t('guide.description'),
					icon: InnerChromeGuideIcon
				}]
			}), 'inner-chrome: tab type')

			ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
				name: 'sidebar.right.pane.tab',
				key: ID,
				locale: NS,
				inject: (sessionId) => ({
					sessionId,
					hub,
					closeTab: (tabId) => {
						try {
							ctx.sidebarRight.close(tabId)
						} catch (error) {
							console.warn('inner-chrome: close tab failed:', error)
						}
					}
				})
			}, BrowserBodyBoundary)), 'inner-chrome: tab body')

			ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
				name: 'conversation.session.header.actions',
				id: 'inner-chrome',
				order: 61,
				locale: NS,
				inject: () => ({
					openBrowser: () => {
						try {
							ctx.sidebarRight.openTab(KIND, { params: {} })
						} catch (error) {
							console.warn('inner-chrome: header open failed:', error)
						}
					}
				})
			}, InnerChromeHeaderButton)), 'inner-chrome: header action')

			ctx.effect(() => ctx.reflect.provide('innerChrome', hub.service), 'inner-chrome: service')

			// One-time migration of the chat link preference to the Sidebar browser.
			// The shared form snapshot is populated asynchronously from the Host, so
			// wait for its first value instead of deciding on an empty mirror.
			try {
				const injectService = typeof ctx.inject === 'function' ? ctx.inject.bind(ctx) : undefined
				if (injectService !== undefined) {
					injectService(['configForms'], (scope) => {
						try {
							const mark = 'dsh-inner-chrome.link-opening-migrated'
							const storage = typeof localStorage === 'undefined' ? undefined : localStorage
							if (storage !== undefined && storage.getItem(mark) === '1') return
							const form = scope?.configForms?.get?.('ui-chat')
							if (form === undefined || form === null || typeof form.getSnapshot !== 'function') return
							let done = false
							let unsubscribe
							const finish = () => {
								done = true
								if (typeof unsubscribe === 'function') {
									try {
										unsubscribe()
									} catch (error) {
										console.warn('inner-chrome: link preference unsubscribe failed:', error)
									}
								}
								unsubscribe = undefined
							}
							const attempt = () => {
								if (done) return
								let value
								try {
									value = form.getSnapshot()?.value
								} catch (error) {
									console.warn('inner-chrome: link preference read failed:', error)
									return
								}
								if (value === undefined || value === null || typeof value !== 'object') return
								finish()
								if (value.linkOpening === 'new-tab') {
									Promise.resolve(form.set('linkOpening', 'sidebar')).catch((error) => {
										console.warn('inner-chrome: link preference migration failed:', error)
									})
								}
								storage?.setItem(mark, '1')
							}
							if (typeof form.subscribe === 'function') unsubscribe = form.subscribe(attempt)
							attempt()
							if (done) finish()
							if (typeof scope?.effect === 'function') scope.effect(() => () => finish())
						} catch (error) {
							console.warn('inner-chrome: link preference migration skipped:', error)
						}
					})
				}
			} catch (error) {
				console.warn('inner-chrome: configForms injection failed:', error)
			}

			// Show the built-in browser once per process when the Sidebar first names
			// an on-screen Session and that Session has no browser tab yet.
			ctx.effect(() => {
				const mounted = ctx.sidebarRight?.mounted
				if (mounted === undefined || mounted === null || typeof mounted.subscribe !== 'function') return undefined
				let opened = false
				const attempt = () => {
					if (opened) return
					let sessionId
					try {
						sessionId = mounted.getSnapshot()
					} catch (error) {
						console.warn('inner-chrome: mounted snapshot failed:', error)
						return
					}
					if (typeof sessionId !== 'string' || sessionId === '') return
					opened = true
					try {
						const openTabs = ctx.sidebarRight?.openTabs
						const tabs = typeof openTabs?.getSnapshot === 'function' ? openTabs.getSnapshot() : []
						const hasBrowser = Array.isArray(tabs) && tabs.some((tab) => tab?.sessionId === sessionId && tab?.kind === KIND)
						if (hasBrowser) return
						ctx.sidebarRight.openTab(KIND, { params: {} })
					} catch (error) {
						console.warn('inner-chrome: first-run browser tab failed:', error)
					}
				}
				const unsubscribe = mounted.subscribe(attempt)
				attempt()
				return () => {
					try {
						unsubscribe?.()
					} catch (error) {
						console.warn('inner-chrome: mounted unsubscribe failed:', error)
					}
				}
			}, 'inner-chrome: first-run browser tab')

			ctx.effect(() => startBridge(ctx, hub), 'inner-chrome: command bridge')
		}

		return {
			inject,
			apply,
			/** Pure helpers exposed for the zero-dependency unit tests. */
			__test: { normalizeHttpUrl, routeTabId, clampInt, toBase64 }
		}
	}
})
