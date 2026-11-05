/**
 * Host half of dsh-xhs-check.
 *
 * The plugin lets a real, logged-in browser render Xiaohongshu, records the
 * site's own signed web API traffic from inside the page, and keeps structured
 * JSON on disk. Nothing here reverse-engineers `x-s`: the site signs its own
 * requests, we only record them.
 *
 * Two backends share one page API (see `lib/inner-driver.mjs`):
 * - `inner-chrome` (default): the DSH built-in browser in the right sidebar,
 *   driven through the `ctx.innerChrome` Host service exposed by
 *   `dsh-inner-chrome`. No extra Chrome process, and the browser partition the
 *   user already signed in to is reused.
 * - `cdp`: the legacy dedicated Chrome over CDP (`lib/cdp.mjs`), kept as a
 *   fallback for profiles without `dsh-inner-chrome`.
 *
 * Surfaces:
 * - Agent tools: `xhs_status`, `xhs_login`, `xhs_collect`, `xhs_library`,
 *   `xhs_probe`, `xhs_close`.
 * - Authenticated POST routes consumed by the settings panel:
 *   `/api/xhs.status`, `/api/xhs.login`, `/api/xhs.chrome`, `/api/xhs.library`,
 *   `/api/xhs.reveal`, `/api/xhs.jobs`.
 *
 * All state is process-local; collected data lives under the configured
 * `dataDir` (by default `<package>/data`).
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { isChromeListening, launchChrome } from './lib/cdp.mjs'
import { createInnerDriver } from './lib/inner-driver.mjs'
import { RECORDER_SOURCE, TAKE_EXPRESSION } from './lib/recorder.mjs'
import { Store } from './lib/store.mjs'
import {
	HOME_URL,
	collectChat,
	collectNote,
	collectNotifications,
	collectProfile,
	collectSearch,
	probePage,
	readStateUserId,
} from './lib/collect.mjs'

/** Package directory, used to resolve the default data directory. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** Read-only helpers shared by every route body parser. */
const MAX_BODY_BYTES = 64 * 1024

/** Default on-disk Chrome profile: private to this machine, not deliverable. */
const DEFAULT_PROFILE_DIR = join(homedir(), '.dsh', 'xhs-check', 'chrome-profile')

/** Default macOS Chrome binary. */
const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Default CDP port. */
const DEFAULT_CHROME_PORT = 9333

/** Default polite delay between page interactions. */
const DEFAULT_REQUEST_DELAY_MS = 1500

/** Default backend: the DSH built-in browser, no extra Chrome process. */
const DEFAULT_BACKEND = 'inner-chrome'

/** Supported backends. */
const BACKENDS = new Set(['inner-chrome', 'cdp'])

/** Default post-navigation settle window for the built-in browser (ms). */
const DEFAULT_INNER_SETTLE_MS = 400

/** Default page-script evaluation timeout for the built-in browser (ms). */
const DEFAULT_EVAL_TIMEOUT_MS = 20000

/** How long a cached login result stays authoritative. */
const LOGIN_TTL_MS = 30 * 60 * 1000

/** Jobs kept for the panel. */
const MAX_JOBS = 20

/** Operator-facing plugin name. */
export const name = 'xhs-check'

/** Services required before activation. */
export const inject = ['connection', 'tools']

/** Route table: path -> handler name, kept in one place for the panel contract. */
const ROUTES = {
	status: '/api/xhs.status',
	login: '/api/xhs.login',
	chrome: '/api/xhs.chrome',
	library: '/api/xhs.library',
	reveal: '/api/xhs.reveal',
	jobs: '/api/xhs.jobs',
}

/**
 * Probe login state from DOM classes. Xiaohongshu shows a login entry on the
 * home page when logged out, and an avatar when logged in.
 */
const LOGIN_DOM_EXPRESSION = `(() => {
  try {
    const loginEntry = document.querySelector('#login-btn, .login-btn, .login-container, [class*="login-modal"], [class*="login-btn"]');
    const avatar = document.querySelector('[class*="avatar"] img, .user .avatar img, .side-bar .user img');
    const nameNodes = Array.from(document.querySelectorAll('.user .name, [class*="user"] [class*="nickname"], [class*="user"] [class*="name"]'));
    const nickname = nameNodes.map((node) => (node.textContent || '').trim()).find((text) => text.length > 0 && text.length <= 30) || '';
    return { hasLoginEntry: loginEntry !== null, hasAvatar: avatar !== null, nickname };
  } catch (error) {
    return { hasLoginEntry: false, hasAvatar: false, nickname: '' };
  }
})()`

/** Short pause used to let the SPA hydrate after navigation. */
const HYDRATE_MS = 2500

/**
 * Resolve the plugin settings: built-in defaults, then `settings.json` next to
 * this package, then an environment override for the data directory.
 * @returns the merged, normalized settings.
 */
async function loadSettings() {
	const defaults = {
		backend: DEFAULT_BACKEND,
		dataDir: join(PACKAGE_DIR, 'data'),
		profileDir: DEFAULT_PROFILE_DIR,
		chromePath: DEFAULT_CHROME_PATH,
		chromePort: DEFAULT_CHROME_PORT,
		requestDelayMs: DEFAULT_REQUEST_DELAY_MS,
		innerSettleMs: DEFAULT_INNER_SETTLE_MS,
		evalTimeoutMs: DEFAULT_EVAL_TIMEOUT_MS,
		maxComments: 50,
		maxScrolls: 8,
	}
	let settings = defaults
	try {
		const raw = await readFile(join(PACKAGE_DIR, 'settings.json'), 'utf8')
		const parsed = JSON.parse(raw)
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			settings = { ...defaults, ...parsed }
		}
	} catch (error) {
		// A missing settings file is the normal case: defaults are the contract.
	}
	if (typeof process.env.XHS_CHECK_DATA_DIR === 'string' && process.env.XHS_CHECK_DATA_DIR !== '') {
		settings = { ...settings, dataDir: resolve(process.env.XHS_CHECK_DATA_DIR) }
	}
	if (typeof process.env.XHS_CHECK_CHROME_PATH === 'string' && process.env.XHS_CHECK_CHROME_PATH !== '') {
		settings = { ...settings, chromePath: process.env.XHS_CHECK_CHROME_PATH }
	}
	if (typeof process.env.XHS_CHECK_BACKEND === 'string' && process.env.XHS_CHECK_BACKEND !== '') {
		settings = { ...settings, backend: process.env.XHS_CHECK_BACKEND }
	}
	settings.backend = BACKENDS.has(settings.backend) ? settings.backend : DEFAULT_BACKEND
	settings.dataDir = resolve(settings.dataDir)
	settings.profileDir = resolve(settings.profileDir)
	settings.chromePort = Number(settings.chromePort) || DEFAULT_CHROME_PORT
	settings.requestDelayMs = Math.max(300, Number(settings.requestDelayMs) || DEFAULT_REQUEST_DELAY_MS)
	settings.innerSettleMs = Math.max(0, Number(settings.innerSettleMs) || 0)
	settings.evalTimeoutMs = Math.min(60000, Math.max(1000, Number(settings.evalTimeoutMs) || DEFAULT_EVAL_TIMEOUT_MS))
	settings.maxComments = Math.max(1, Number(settings.maxComments) || 50)
	settings.maxScrolls = Math.max(1, Number(settings.maxScrolls) || 8)
	return settings
}

/**
 * Activate the Host plugin.
 * @param ctx - Host plugin context with `connection` and `tools`.
 */
export function apply(ctx) {
	/** Process-local runtime state. */
	const state = {
		/** Backend in effect for the last operation (`inner-chrome` or `cdp`). */
		backend: DEFAULT_BACKEND,
		/** Host service `ctx.innerChrome`, present once dsh-inner-chrome is loaded. */
		innerChrome: undefined,
		/** Tabs this plugin opened in the built-in browser (any session). */
		tabs: new Set(),
		/** Driver that owns the persistent login tab (built-in browser only). */
		loginDriver: undefined,
		/** Connected external Chrome handle (legacy `cdp` backend). */
		browser: undefined,
		/** In-flight launch, so concurrent tools share one Chrome. */
		launching: undefined,
		/** Whether this plugin started the Chrome process. */
		launched: false,
		/** Page kept open for QR-code login. */
		loginPage: undefined,
		/** Job records, newest first. */
		jobs: [],
		/** Serializes collection jobs. */
		chain: Promise.resolve(),
		/** Store instance and the directory it was built for. */
		store: undefined,
		storeDir: undefined,
		/** Last login probe. */
		login: undefined,
	}

	// Optional dependency: the built-in browser Host service provided by
	// dsh-inner-chrome. Absent until that plugin is loaded (or if it is disabled).
	ctx.inject(['innerChrome'], (scope) => {
		const service = scope.innerChrome
		state.innerChrome = service
		return () => {
			if (state.innerChrome === service) state.innerChrome = undefined
		}
	})

	let settingsPromise

	/**
	 * Read the settings once per process.
	 * @returns the settings promise.
	 */
	function settings() {
		if (settingsPromise === undefined) settingsPromise = loadSettings()
		return settingsPromise
	}

	/**
	 * Lazily open the JSON store for the configured directory.
	 * @param currentSettings - resolved settings.
	 * @returns the initialized store.
	 */
	async function storeFor(currentSettings) {
		if (state.store !== undefined && state.storeDir === currentSettings.dataDir) return state.store
		const store = new Store(currentSettings.dataDir)
		await store.init()
		state.store = store
		state.storeDir = currentSettings.dataDir
		return store
	}

	/**
	 * Read the built-in browser into a uniform descriptor.
	 * @param currentSettings - resolved settings.
	 * @returns the descriptor shared by `xhs_status` and the panel.
	 */
	async function builtInStatus(currentSettings) {
		const descriptor = {
			backend: 'inner-chrome',
			available: state.innerChrome !== undefined,
			connected: false,
			platform: '',
			capabilities: [],
			version: '',
			pendingCommands: 0,
			tabIds: [...state.tabs],
			tabId: '',
			url: '',
			title: '',
			hint: undefined,
		}
		if (state.innerChrome === undefined) {
			descriptor.hint = '内置浏览器插件 dsh-inner-chrome 未启用：请安装/启用它，或在 settings.json 里把 backend 设为 cdp'
			return descriptor
		}
		try {
			const status = await state.innerChrome.status()
			const client = status?.client ?? {}
			descriptor.connected = client.connected === true
			descriptor.platform = typeof client.platform === 'string' ? client.platform : ''
			descriptor.capabilities = Array.isArray(client.capabilities) ? client.capabilities : []
			descriptor.version = typeof status?.version === 'string' ? status.version : ''
			descriptor.pendingCommands = Number(status?.pendingCommands) || 0
		} catch (error) {
			descriptor.error = error instanceof Error ? error.message : String(error)
		}
		const loginTabId = typeof state.loginPage?.tabId === 'string' ? state.loginPage.tabId : ''
		descriptor.tabId = loginTabId !== '' ? loginTabId : descriptor.tabIds.at(-1) ?? ''
		if (descriptor.tabId !== '' && descriptor.connected === true) {
			try {
				const listed = await state.innerChrome.tabs()
				const tab = (listed?.tabs ?? []).find((item) => item?.tabId === descriptor.tabId)
				if (tab !== undefined) {
					descriptor.url = typeof tab.url === 'string' ? tab.url : ''
					descriptor.title = typeof tab.title === 'string' ? tab.title : ''
				}
			} catch (error) {
				// Tab listing is diagnostics only.
			}
		}
		return descriptor
	}

	/**
	 * Describe the legacy external Chrome backend.
	 * @param currentSettings - resolved settings.
	 * @returns the descriptor shared by `xhs_status` and the panel.
	 */
	async function chromeStatus(currentSettings) {
		if (state.browser !== undefined) {
			try {
				await state.browser.pages()
				return {
					backend: 'cdp',
					available: true,
					connected: true,
					running: true,
					launched: state.launched,
					port: currentSettings.chromePort,
					userDataDir: currentSettings.profileDir,
					pid: state.browser.pid,
				}
			} catch (error) {
				state.browser = undefined
				state.launched = false
			}
		}
		return {
			backend: 'cdp',
			available: true,
			connected: false,
			running: await isChromeListening(currentSettings.chromePort).catch(() => false),
			launched: state.launched,
			port: currentSettings.chromePort,
			userDataDir: currentSettings.profileDir,
			pid: undefined,
		}
	}

	/**
	 * Create the driver used by one operation.
	 *
	 * The built-in-browser driver is per operation (its tabs die with the
	 * collection); the legacy CDP browser is a process-wide singleton.
	 *
	 * @param currentSettings - resolved settings.
	 * @param sessionId - Session that issued the command (built-in browser tabs
	 *   are owned by a Session).
	 * @returns the driver/browser handle with `newPage()`/`pages()`/`close()`.
	 */
	async function ensureBrowser(currentSettings, sessionId) {
		state.backend = currentSettings.backend
		if (currentSettings.backend === 'cdp') return await ensureChromeBrowser(currentSettings)
		return createInnerDriver({
			service: state.innerChrome,
			sessionId,
			settings: currentSettings,
			onTrack: (tabId) => { state.tabs.add(tabId) },
			onUntrack: (tabId) => { state.tabs.delete(tabId) },
		})
	}

	/**
	 * Connect to Chrome, launching a dedicated profile when needed (legacy).
	 * @param currentSettings - resolved settings.
	 * @returns the Chrome browser handle.
	 */
	async function ensureChromeBrowser(currentSettings) {
		if (state.browser !== undefined) {
			try {
				await state.browser.pages()
				return state.browser
			} catch (error) {
				state.browser = undefined
				state.launched = false
			}
		}
		if (state.launching !== undefined) return state.launching
		state.launching = (async () => {
			await mkdir(currentSettings.profileDir, { recursive: true })
			const browser = await launchChrome({
				chromePath: currentSettings.chromePath,
				port: currentSettings.chromePort,
				userDataDir: currentSettings.profileDir,
			})
			state.browser = browser
			state.launched = browser.launched === true
			return browser
		})()
		try {
			return await state.launching
		} finally {
			state.launching = undefined
		}
	}

	/**
	 * Close whatever this plugin opened, per backend.
	 * @param currentSettings - resolved settings (optional on unload).
	 */
	async function closeBrowser(currentSettings) {
		const backend = currentSettings?.backend ?? state.backend
		state.loginPage = undefined
		state.loginDriver = undefined
		state.login = undefined
		if (backend === 'inner-chrome') {
			const service = state.innerChrome
			const tabs = [...state.tabs]
			state.tabs.clear()
			if (service === undefined) return 0
			let closed = 0
			for (const tabId of tabs) {
				try {
					await service.close(tabId)
					closed += 1
				} catch (error) {
					console.warn(`xhs-check: could not close built-in browser tab ${tabId}: ${String(error)}`)
				}
			}
			return closed
		}
		const browser = state.browser
		state.browser = undefined
		state.launched = false
		if (browser !== undefined) {
			try {
				await browser.close()
				return 1
			} catch (error) {
				console.warn(`xhs-check: could not close Chrome: ${String(error)}`)
			}
		}
		return 0
	}

	/**
	 * Ensure the persistent login tab exists in the built-in browser.
	 *
	 * The tab is kept open across calls so the user can scan the QR code once
	 * and so `xhs_status` can report what the browser is showing.
	 *
	 * @param currentSettings - resolved settings.
	 * @param sessionId - Session that owns the tab.
	 * @returns the login page handle.
	 */
	async function ensureLoginPage(currentSettings, sessionId) {
		if (state.loginPage !== undefined) return state.loginPage
		if (state.innerChrome === undefined) {
			const error = new Error('内置浏览器插件 dsh-inner-chrome 未启用：请在插件页启用它，或在 settings.json 里把 backend 设为 cdp')
			error.code = 'NO_CLIENT'
			throw error
		}
		const driver = state.loginDriver ?? createInnerDriver({
			service: state.innerChrome,
			sessionId,
			settings: currentSettings,
			onTrack: (tabId) => { state.tabs.add(tabId) },
			onUntrack: (tabId) => { state.tabs.delete(tabId) },
		})
		state.loginDriver = driver
		const page = await driver.newPage()
		try {
			// The built-in-browser driver records the script synchronously; the CDP
			// path returns a promise, whose failure only costs the capture evidence.
			const pending = page.addInitScript(RECORDER_SOURCE)
			if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') {
				pending.catch(() => {})
			}
		} catch (error) {
			// Without the recorder the DOM login heuristic still answers.
		}
		state.loginPage = page
		return page
	}

	/**
	 * Probe the login state of one page without navigating it.
	 *
	 * `web_session` is not proof: Xiaohongshu hands anonymous visitors a session
	 * cookie too. The authoritative signal is `/api/sns/web/v2/user/me`, whose
	 * `data.guest` flag is `true` for anonymous sessions. The recorder is
	 * installed on the page, so the page's own signed request is what we read;
	 * when the response is not captured (it may fire before `dom-ready`), the
	 * avatar/login-entry DOM heuristic answers instead.
	 *
	 * @param page - page handle (CDP or built-in browser).
	 * @returns the login snapshot.
	 */
	async function probeLogin(page) {
		const captures = await drainCaptures(page)
		const me = readUserMe(captures)
		let dom
		try {
			dom = await page.evaluate(LOGIN_DOM_EXPRESSION)
		} catch (error) {
			dom = undefined
		}
		let stateUserId = ''
		try {
			stateUserId = await readStateUserId(page)
		} catch (error) {
			stateUserId = ''
		}
		const meUserId = typeof me?.userId === 'string' ? me.userId : ''
		const domSaysOut = dom?.hasLoginEntry === true
		const loggedIn = me !== undefined
			? me.guest !== true && meUserId !== ''
			: domSaysOut !== true && (stateUserId !== '' || dom?.hasAvatar === true)
		const nickname = typeof dom?.nickname === 'string' && dom.nickname !== ''
			? dom.nickname
			: typeof me?.nickname === 'string' ? me.nickname : ''
		const snapshot = {
			loggedIn,
			userId: meUserId !== '' ? meUserId : stateUserId,
			nickname,
			evidence: me !== undefined ? `user/me guest=${me.guest === true}` : stateUserId !== '' ? 'state.user' : 'dom',
			checkedAt: new Date().toISOString(),
		}
		state.login = snapshot
		return snapshot
	}

	/**
	 * Probe the current login state.
	 *
	 * @param currentSettings - resolved settings.
	 * @param options - { keepPage?: boolean, sessionId?: string }.
	 * @returns the login snapshot.
	 */
	async function inspectLogin(currentSettings, { keepPage = false, sessionId } = {}) {
		if (currentSettings.backend === 'inner-chrome') {
			const page = await ensureLoginPage(currentSettings, sessionId)
			await page.goto(HOME_URL)
			await sleep(HYDRATE_MS)
			return await probeLogin(page)
		}
		const browser = await ensureChromeBrowser(currentSettings)
		let page = state.loginPage
		let owned = false
		if (page === undefined) {
			page = await browser.newPage()
			owned = true
			if (keepPage) state.loginPage = page
		}
		try {
			try {
				await page.addInitScript(RECORDER_SOURCE)
			} catch (error) {
				// Without the recorder the DOM fallback below still answers.
			}
			try {
				await page.bringToFront?.()
			} catch (error) {
				// Bringing the window forward is a convenience, never a requirement.
			}
			await page.goto(HOME_URL)
			await sleep(HYDRATE_MS)
			return await probeLogin(page)
		} finally {
			if (owned && !keepPage) {
				await page.close().catch(() => {})
			}
		}
	}

	/**
	 * Reuse a fresh login snapshot or probe again.
	 * @param currentSettings - resolved settings.
	 * @param sessionId - Session that issued the command.
	 * @returns the login snapshot.
	 */
	async function currentLogin(currentSettings, sessionId) {
		const cached = state.login
		if (cached !== undefined && cached.loggedIn === true && Date.now() - Date.parse(cached.checkedAt) < LOGIN_TTL_MS) return cached
		return await inspectLogin(currentSettings, { sessionId })
	}

	/**
	 * Build the status payload shared by the tool and the panel.
	 * @param options - { includeJobs?: boolean }.
	 * @returns the status snapshot.
	 */
	async function statusSnapshot({ includeJobs = true } = {}) {
		const currentSettings = await settings()
		state.backend = currentSettings.backend
		const store = await storeFor(currentSettings)
		let counts = {}
		try {
			counts = await store.counts()
		} catch (error) {
			counts = {}
		}
		const browser = currentSettings.backend === 'inner-chrome'
			? await builtInStatus(currentSettings)
			: await chromeStatus(currentSettings)
		const login = state.login === undefined
			? { loggedIn: undefined, checkedAt: undefined, nickname: '' }
			: state.login
		return {
			ok: true,
			backend: currentSettings.backend,
			dataDir: currentSettings.dataDir,
			profileDir: currentSettings.profileDir,
			browser,
			login,
			counts,
			jobs: includeJobs ? state.jobs : [],
			settings: {
				backend: currentSettings.backend,
				requestDelayMs: currentSettings.requestDelayMs,
				maxComments: currentSettings.maxComments,
				maxScrolls: currentSettings.maxScrolls,
				chromePort: currentSettings.chromePort,
				innerSettleMs: currentSettings.innerSettleMs,
				evalTimeoutMs: currentSettings.evalTimeoutMs,
			},
		}
	}

	/**
	 * Create a job record for the panel.
	 * @param mode - collection mode.
	 * @param target - human-readable target.
	 * @returns the record.
	 */
	function createJob(mode, target) {
		const record = {
			id: randomUUID().slice(0, 8),
			mode,
			target,
			phase: 'queued',
			startedAt: new Date().toISOString(),
			finishedAt: undefined,
			ok: undefined,
			error: undefined,
			progress: { done: 0, total: 0 },
		}
		state.jobs.unshift(record)
		if (state.jobs.length > MAX_JOBS) state.jobs.length = MAX_JOBS
		return record
	}

	/**
	 * Run one operation after every earlier one settled (single Chrome, single
	 * account: never two collections at once).
	 * @param operation - the operation.
	 * @returns its result.
	 */
	function enqueue(operation) {
		const next = state.chain.then(operation, operation)
		state.chain = next.then(() => undefined, () => undefined)
		return next
	}

	/**
	 * Create a job, run one collection, and keep the record current.
	 * @param mode - collection mode.
	 * @param target - human-readable target.
	 * @param operation - receives the job record.
	 * @returns the operation result.
	 */
	async function runJob(mode, target, operation) {
		const record = createJob(mode, target)
		return await enqueue(async () => {
			record.phase = 'running'
			record.startedAt = new Date().toISOString()
			try {
				const value = await operation(record)
				record.ok = value?.ok !== false
				record.phase = 'done'
				return value
			} catch (error) {
				record.ok = false
				record.phase = 'failed'
				record.error = error instanceof Error ? error.message : String(error)
				throw error
			} finally {
				record.finishedAt = new Date().toISOString()
			}
		})
	}

	/**
	 * Shared collection entry point: settings, browser, login gate, store.
	 * @param mode - collection mode.
	 * @param target - human-readable target.
	 * @param operation - receives the collection context.
	 * @param options - { signal?: AbortSignal, sessionId?: string }.
	 * @returns the operation result.
	 */
	async function runCollection(mode, target, operation, { signal, sessionId } = {}) {
		return await runJob(mode, target, async (record) => {
			const currentSettings = await settings()
			const browser = await ensureBrowser(currentSettings, sessionId)
			record.phase = 'checking-login'
			const login = await currentLogin(currentSettings, sessionId)
			if (login.loggedIn !== true) {
				record.phase = 'done'
				return {
					ok: false,
					mode,
					login,
					error: currentSettings.backend === 'inner-chrome'
						? '未登录小红书：请先调用 xhs_login，在右侧栏内置浏览器里扫码登录后重试'
						: '未登录小红书：请先调用 xhs_login，在弹出的 Chrome 窗口扫码登录后重试',
				}
			}
			const store = await storeFor(currentSettings)
			record.phase = 'collecting'
			const collectionContext = {
				browser,
				store,
				settings: currentSettings,
				signal,
				progress: ({ done, total, phase }) => {
					if (typeof done === 'number') record.progress.done = done
					if (typeof total === 'number') record.progress.total = total
					if (typeof phase === 'string') record.phase = phase
				},
			}
			return await operation(collectionContext)
		})
	}

	/** Register one authenticated POST route. */
	function registerRoute(path, handler) {
		ctx.effect(() => ctx.connection.fetch.register({
			path,
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: async (request) => {
				try {
					const body = await readBody(request)
					return Response.json(await handler(body))
				} catch (error) {
					return Response.json({
						error: {
							code: 'xhs-check/failed',
							message: error instanceof Error ? error.message : String(error),
						},
					}, { status: 500 })
				}
			},
		}), `xhs-check: route ${path}`)
	}

	/** Panel route: status snapshot. */
	registerRoute(ROUTES.status, async () => await statusSnapshot())
	/** Panel route: open the browser and report the login state. */
	registerRoute(ROUTES.login, async (body) => {
		const currentSettings = await settings()
		const wait = body?.wait !== false
		if (currentSettings.backend === 'inner-chrome') {
			const page = await ensureLoginPage(currentSettings)
			await page.goto(HOME_URL)
			await sleep(HYDRATE_MS)
			let snapshot = await probeLogin(page)
			if (wait) {
				const deadline = Date.now() + 180000
				while (snapshot.loggedIn !== true && Date.now() < deadline) {
					await sleep(2000)
					try {
						snapshot = await probeLogin(page)
					} catch (error) {
						break
					}
				}
			}
			return { ok: true, login: snapshot, browser: (await statusSnapshot({ includeJobs: false })).browser }
		}
		const login = await inspectLogin(currentSettings, { keepPage: wait })
		if (wait !== true) return { ok: true, login, browser: (await statusSnapshot({ includeJobs: false })).browser }
		const deadline = Date.now() + 180000
		let snapshot = login
		while (snapshot.loggedIn !== true && Date.now() < deadline) {
			await sleep(2000)
			try {
				snapshot = await inspectLogin(currentSettings, { keepPage: true })
			} catch (error) {
				break
			}
		}
		return { ok: true, login: snapshot, browser: (await statusSnapshot({ includeJobs: false })).browser }
	})
	/** Panel route: open/close/focus the collection browser. */
	registerRoute(ROUTES.chrome, async (body) => {
		const action = typeof body?.action === 'string' ? body.action : 'open'
		const currentSettings = await settings()
		if (action === 'close') {
			await closeBrowser(currentSettings)
			return await statusSnapshot()
		}
		if (currentSettings.backend === 'inner-chrome') {
			try {
				// The sidebar already reveals a newly opened tab; this just makes
				// sure a login tab exists for the user to scan.
				await ensureLoginPage(currentSettings)
			} catch (error) {
				// Opening failures surface through the status payload instead.
			}
			return await statusSnapshot()
		}
		const browser = await ensureChromeBrowser(currentSettings)
		try {
			if (action === 'focus') {
				const page = state.loginPage ?? await browser.newPage()
				try {
					await page.bringToFront?.()
				} catch (error) {
					// Focus is best-effort.
				}
			}
		} catch (error) {
			// Focus failures are not user-visible problems.
		}
		return await statusSnapshot()
	})
	/** Panel route: browse collected items from the index. */
	registerRoute(ROUTES.library, async (body) => {
		const currentSettings = await settings()
		const store = await storeFor(currentSettings)
		const listed = await store.list({
			type: typeof body?.type === 'string' && body.type !== '' ? body.type : undefined,
			query: typeof body?.query === 'string' && body.query !== '' ? body.query : undefined,
			limit: clampNumber(body?.limit, 1, 200, 20),
			offset: clampNumber(body?.offset, 0, 100000, 0),
		})
		return { ok: true, ...listed }
	})
	/** Panel route: open the data directory in the OS file manager. */
	registerRoute(ROUTES.reveal, async () => {
		const currentSettings = await settings()
		await mkdir(currentSettings.dataDir, { recursive: true })
		spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [currentSettings.dataDir], {
			detached: true,
			stdio: 'ignore',
		}).unref()
		return { ok: true, dataDir: currentSettings.dataDir }
	})
	/** Panel route: lightweight job polling. */
	registerRoute(ROUTES.jobs, async () => ({ ok: true, jobs: state.jobs }))

	// ---------------------------------------------------------------------
	// Agent tools
	// ---------------------------------------------------------------------

	ctx.effect(() => ctx.tools.register({
		name: 'xhs_status',
		description: '检查小红书采集插件的状态：采集浏览器（默认右侧栏内置浏览器）是否已连接、登录态、数据目录、各类型已采集数量与最近采集任务。开始任何采集前先看这里。',
		parameters: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render(_args, value) {
				return [{ type: 'text', text: renderStatus(value) }]
			},
		},
		async execute() {
			return jsonValue(await statusSnapshot())
		},
	}), 'xhs-check: tool xhs_status')

	ctx.effect(() => ctx.tools.register({
		name: 'xhs_login',
		description: '打开（或复用）小红书首页并等待用户扫码登录。默认在 DSH 内置浏览器（右侧栏标签页）里打开，不需要另外弹 Chrome 窗口；登录态保存在内置浏览器的持久分区里，之后无需重复登录。首次使用必须调用。',
		parameters: {
			type: 'object',
			properties: {
				waitSeconds: { type: 'integer', description: '等待扫码登录的秒数，默认 90，最大 300。' },
			},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render(_args, value) {
				if (value?.ok === false) return [{ type: 'text', text: `登录失败：${value.error ?? '未知原因'}` }]
				const login = value?.login ?? {}
				if (login.loggedIn === true) return [{ type: 'text', text: `已登录小红书${login.nickname ? `（${login.nickname}）` : ''}，可以开始采集。` }]
				return [{ type: 'text', text: '已在采集浏览器里打开小红书首页，但还没有检测到登录态。请在右侧栏页面扫码/登录后，再调用 xhs_status 或直接开始采集。' }]
			},
		},
		async execute(args, exec) {
			const currentSettings = await settings()
			const sessionId = exec?.agent?.session?.id
			const waitSeconds = clampNumber(args?.waitSeconds, 5, 300, 90)
			await runJob('login', 'xiaohongshu.com', async (record) => {
				if (currentSettings.backend === 'inner-chrome') {
					record.phase = 'opening-browser'
					let page
					try {
						page = await ensureLoginPage(currentSettings, sessionId)
						await page.goto(HOME_URL)
						await sleep(HYDRATE_MS)
					} catch (error) {
						return { ok: false, mode: 'login', error: error instanceof Error ? error.message : String(error) }
					}
					record.phase = 'waiting-for-scan'
					const deadline = Date.now() + waitSeconds * 1000
					let login = await probeLogin(page)
					while (login.loggedIn !== true && Date.now() < deadline) {
						await sleep(2000)
						try {
							login = await probeLogin(page)
						} catch (error) {
							break
						}
					}
					return { ok: true, mode: 'login', login }
				}
				record.phase = 'opening-chrome'
				let page
				try {
					const browser = await ensureChromeBrowser(currentSettings)
					page = state.loginPage ?? await browser.newPage()
					state.loginPage = page
					try {
						await page.bringToFront?.()
					} catch (error) {
						// Focus is a convenience only.
					}
					await page.goto(HOME_URL)
					await sleep(HYDRATE_MS)
				} catch (error) {
					return { ok: false, mode: 'login', error: error instanceof Error ? error.message : String(error) }
				}
				record.phase = 'waiting-for-scan'
				const deadline = Date.now() + waitSeconds * 1000
				let login = state.login
				while (Date.now() < deadline) {
					try {
						login = await inspectLogin(currentSettings, { keepPage: true })
					} catch (error) {
						break
					}
					if (login.loggedIn === true) break
					await sleep(2000)
				}
				return { ok: true, mode: 'login', login }
			})
			return jsonValue(await statusSnapshot())
		},
	}), 'xhs-check: tool xhs_login')

	ctx.effect(() => ctx.tools.register({
		name: 'xhs_collect',
		description: `驱动已登录的采集浏览器（默认 DSH 内置浏览器 / 右侧栏；可用 settings.json 的 backend 切回 CDP Chrome）采集小红书数据并落盘为结构化 JSON。mode：
- note：采集单篇笔记（正文/图片/标签/互动数/作者 + 一级与楼中楼评论），传 url 或 noteId；
- search：按关键词采集搜索结果列表，传 keyword，可传 sort=default|popular|latest；
- profile：采集用户主页笔记、收藏或赞过，传 userId（me 表示当前账号）与 tab=notes|fav|liked；
- chat：采集私信会话与消息（接口未公开，属探测式采集，失败时先用 xhs_probe）；
- notifications：采集通知列表。`,
		parameters: {
			type: 'object',
			properties: {
				mode: { type: 'string', enum: ['note', 'search', 'profile', 'chat', 'notifications'], description: '采集模式。' },
				url: { type: 'string', description: 'note 模式的笔记链接（最好带 xsec_token）。' },
				noteId: { type: 'string', description: 'note 模式的笔记 id，没有链接时使用。' },
				keyword: { type: 'string', description: 'search 模式的关键词。' },
				sort: { type: 'string', enum: ['default', 'popular', 'latest'], description: 'search 模式排序，默认 default。' },
				userId: { type: 'string', description: 'profile 模式的用户 id；me 表示当前登录账号。' },
				tab: { type: 'string', enum: ['notes', 'fav', 'liked'], description: 'profile 模式的标签页，默认 notes。' },
				limit: { type: 'integer', description: 'search/profile 最多保留条数，默认 40。' },
				maxComments: { type: 'integer', description: 'note 模式评论目标条数（软上限），默认 50。' },
				maxScrolls: { type: 'integer', description: '最大滚动次数，默认 8，用于控制请求节奏。' },
			},
			required: ['mode'],
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render(_args, value) {
				return [{ type: 'text', text: renderCollection(value) }]
			},
		},
		async execute(args, exec) {
			return jsonValue(await dispatchCollect(args, exec))
		},
	}), 'xhs-check: tool xhs_collect')

	/**
	 * Route one `xhs_collect` call to its collector.
	 * @param args - tool arguments.
	 * @param exec - tool run context.
	 * @returns the collector result.
	 */
	async function dispatchCollect(args, exec) {
			const mode = typeof args?.mode === 'string' ? args.mode : ''
			const signal = exec?.signal
			const sessionId = exec?.agent?.session?.id
			if (mode === 'note') {
				const noteId = typeof args.noteId === 'string' ? args.noteId.trim() : ''
				let url = typeof args.url === 'string' ? args.url.trim() : ''
				// A note collected from search already knows its token-bearing URL;
				// reuse it instead of asking the caller to copy a 140-char link.
				if (url === '' && noteId !== '') {
					try {
						const store = await storeFor(await settings())
						const existing = await store.get('note', noteId)
						if (typeof existing?.url === 'string' && existing.url !== '') url = existing.url
					} catch (error) {
						// No cached URL: fall through and let the collector report it.
					}
				}
				if (url === '' && noteId === '') {
					return { ok: false, mode, error: 'note 模式需要 url 或 noteId' }
				}
				const target = url !== '' ? url : `note:${noteId}`
				return await runCollection('note', target, async (collectionContext) => await collectNote(collectionContext, {
					url,
					noteId: noteId === '' ? undefined : noteId,
					maxComments: args.maxComments,
					maxScrolls: args.maxScrolls,
				}), { signal, sessionId })
			}
			if (mode === 'search') {
				if (typeof args.keyword !== 'string' || args.keyword.trim() === '') {
					return { ok: false, mode, error: 'search 模式需要 keyword' }
				}
				return await runCollection('search', args.keyword, async (collectionContext) => await collectSearch(collectionContext, {
					keyword: args.keyword,
					sort: args.sort,
					limit: args.limit,
					maxScrolls: args.maxScrolls,
				}), { signal, sessionId })
			}
			if (mode === 'profile') {
				const userId = typeof args.userId === 'string' && args.userId !== '' ? args.userId : 'me'
				return await runCollection('profile', `${userId}${args.tab ? `:${args.tab}` : ''}`, async (collectionContext) => await collectProfile(collectionContext, {
					userId,
					tab: args.tab,
					limit: args.limit,
					maxScrolls: args.maxScrolls,
				}), { signal, sessionId })
			}
			if (mode === 'chat') {
				return await runCollection('chat', 'private messages', async (collectionContext) => await collectChat(collectionContext, {
					limit: args.limit,
				}), { signal, sessionId })
			}
			if (mode === 'notifications') {
				return await runCollection('notifications', 'notifications', async (collectionContext) => await collectNotifications(collectionContext, {
					maxScrolls: args.maxScrolls,
				}), { signal, sessionId })
			}
			return { ok: false, mode, error: `未知 mode：${mode}` }
	}

	ctx.effect(() => ctx.tools.register({
		name: 'xhs_library',
		description: '浏览已采集到本地的小红书数据：按类型（note/comment/chat_conversation/chat_message/notification/search/profile）过滤、按关键词搜索标题与正文，返回精简列表与文件路径。不联网、不启动 Chrome。',
		parameters: {
			type: 'object',
			properties: {
				type: { type: 'string', description: '数据类型过滤，留空表示全部。' },
				query: { type: 'string', description: '关键词，匹配标题、正文或作者。' },
				limit: { type: 'integer', description: '返回条数，默认 20，最大 200。' },
				offset: { type: 'integer', description: '分页偏移，默认 0。' },
			},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render(_args, value) {
				return [{ type: 'text', text: renderLibrary(value) }]
			},
		},
		async execute(args) {
			const currentSettings = await settings()
			const store = await storeFor(currentSettings)
			return jsonValue(await store.list({
				type: typeof args?.type === 'string' && args.type !== '' ? args.type : undefined,
				query: typeof args?.query === 'string' && args.query !== '' ? args.query : undefined,
				limit: clampNumber(args?.limit, 1, 200, 20),
				offset: clampNumber(args?.offset, 0, 100000, 0),
			}))
		},
	}), 'xhs-check: tool xhs_library')

	ctx.effect(() => ctx.tools.register({
		name: 'xhs_probe',
		description: '打开一个小红书 URL，录制指定秒数窗口内页面发出的全部 /api/ 流量，落盘到 data/raw/，并返回接口清单（路径、方法、状态、次数）。用于适配未公开接口（尤其是私信 chat）或排查采集失败原因。',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: '要探测的 URL，默认小红书首页。' },
				seconds: { type: 'integer', description: '录制秒数，默认 12，最大 120。' },
				scroll: { type: 'boolean', description: '录制期间是否滚动页面以触发懒加载，默认 false。' },
			},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render(_args, value) {
				return [{ type: 'text', text: renderProbe(value) }]
			},
		},
		async execute(args, exec) {
			const currentSettings = await settings()
			const sessionId = exec?.agent?.session?.id
			const browser = await ensureBrowser(currentSettings, sessionId)
			const store = await storeFor(currentSettings)
			return await runJob('probe', typeof args?.url === 'string' ? args.url : HOME_URL, async (record) => {
				record.phase = 'recording'
				return jsonValue(await probePage({ browser, store, settings: currentSettings, signal: exec?.signal }, {
					url: args?.url,
					seconds: args?.seconds,
					scroll: args?.scroll === true,
				}))
			})
		},
	}), 'xhs-check: tool xhs_probe')

	ctx.effect(() => ctx.tools.register({
		name: 'xhs_close',
		description: '关闭本插件打开的采集浏览器页面：默认关闭右侧栏内置浏览器里由小红书采集打开的标签页（登录态保留在内置浏览器的持久分区里，下次打开仍在）；cdp 后端则关闭插件启动的 Chrome。',
		parameters: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render(_args, value) {
				if (value?.backend === 'inner-chrome') {
					return [{ type: 'text', text: `已关闭内置浏览器里的小红书采集标签页（${value?.closed ?? 0} 个）。登录态仍保留在内置浏览器中。` }]
				}
				return [{ type: 'text', text: `Chrome 已关闭。登录态保留在：${value?.profileDir ?? ''}` }]
			},
		},
		async execute() {
			const currentSettings = await settings()
			const closed = await closeBrowser(currentSettings)
			return jsonValue({ ok: true, backend: currentSettings.backend, closed: closed ?? 0, profileDir: currentSettings.profileDir })
		},
	}), 'xhs-check: tool xhs_close')

	// The browser is an owned resource: never leave tabs/windows behind on unload.
	ctx.effect(() => () => {
		void closeBrowser()
	}, 'xhs-check: close browser on dispose')
}

/**
 * Drain the recorder buffer of one page.
 * @param page - CDP page handle.
 * @returns recorded captures.
 */
async function drainCaptures(page) {
	try {
		const text = await page.evaluate(TAKE_EXPRESSION)
		if (typeof text !== 'string' || text === '') return []
		const parsed = JSON.parse(text)
		return Array.isArray(parsed) ? parsed : []
	} catch (error) {
		return []
	}
}

/**
 * Read the last `/user/me` answer out of captured traffic.
 * @param captures - recorded captures.
 * @returns { guest, userId, nickname }, or undefined when the call is absent.
 */
function readUserMe(captures) {
	let found
	for (const capture of captures) {
		if (typeof capture?.url !== 'string' || capture.url.indexOf('/v2/user/me') === -1) continue
		const data = capture.body?.data
		if (typeof data !== 'object' || data === null) continue
		found = {
			guest: data.guest === true,
			userId: typeof data.user_id === 'string' ? data.user_id : '',
			nickname: typeof data.user?.nickname === 'string' ? data.user.nickname : '',
		}
	}
	return found
}

/**
 * Project one tool result onto lossless JSON.
 *
 * DSH rejects tool values that do not survive a JSON round-trip, and optional
 * fields are naturally `undefined` here (unknown pid, unchecked login, absent
 * author). Dropping those keys keeps the returned object exactly equal to its
 * JSON form, so the tool pipeline accepts it.
 *
 * @param value - arbitrary tool return value.
 * @returns the same data with `undefined` keys dropped and non-finite numbers nulled.
 */
function jsonValue(value) {
	if (value === undefined) return null
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number') return Number.isFinite(value) ? value : null
	if (Array.isArray(value)) return value.map((item) => jsonValue(item))
	if (typeof value === 'object') {
		const out = {}
		for (const key of Object.keys(value)) {
			const item = value[key]
			if (item === undefined) continue
			out[key] = jsonValue(item)
		}
		return out
	}
	return String(value)
}

/**
 * Read a bounded JSON body.
 * @param request - buffered request.
 * @returns the parsed object (empty object for an empty body).
 */
async function readBody(request) {
	const text = await request.text()
	if (text.length > MAX_BODY_BYTES) throw new Error('request body too large')
	if (text.trim() === '') return {}
	try {
		const parsed = JSON.parse(text)
		return typeof parsed === 'object' && parsed !== null ? parsed : {}
	} catch (error) {
		throw new Error('request body must be JSON')
	}
}

/**
 * Clamp an untrusted number into an inclusive integer range.
 * @param value - candidate.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - value used when the input is not a finite number.
 * @returns the clamped integer.
 */
function clampNumber(value, min, max, fallback) {
	const number = Number(value)
	if (!Number.isFinite(number)) return fallback
	return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * Sleep helper for the login wait loop.
 * @param ms - milliseconds.
 * @returns a promise.
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Render the status snapshot for the model.
 * @param value - `xhs_status` result.
 * @returns compact text.
 */
function renderStatus(value) {
	if (value === undefined || value === null) return '没有拿到状态。'
	const browser = value.browser ?? {}
	const login = value.login ?? {}
	const counts = value.counts ?? {}
	const inner = value.backend === 'inner-chrome'
	let browserText
	if (inner) {
		if (browser.available !== true) browserText = `内置浏览器：不可用（${browser.hint ?? 'dsh-inner-chrome 未启用'}）`
		else if (browser.connected !== true) browserText = '内置浏览器：未连接（打开右侧栏「内置浏览器」标签页后重试）'
		else if (browser.tabId) browserText = `内置浏览器：已连接${browser.platform === 'desktop' ? '' : `（${browser.platform}）`} · 当前页 ${browser.title || browser.url || browser.tabId}`
		else browserText = '内置浏览器：已连接 · 还没有打开页面'
	} else {
		const chrome = browser
		browserText = `Chrome（CDP 后端）：${chrome.connected === true ? `已连接（端口 ${chrome.port}）` : chrome.running === true ? `端口 ${chrome.port} 有实例，未连接` : '未启动'}`
	}
	const lines = [
		browserText,
		`登录：${login.loggedIn === true ? `已登录${login.nickname ? `（${login.nickname}）` : ''}` : login.loggedIn === false ? '未登录（调用 xhs_login 扫码后重试）' : '未知（调用 xhs_login 打开登录页）'}`,
		`数据目录：${value.dataDir ?? ''}`,
		`已采集：${formatCounts(counts)}`,
	]
	const jobs = Array.isArray(value.jobs) ? value.jobs.slice(0, 5) : []
	if (jobs.length > 0) {
		lines.push('最近任务：')
		for (const job of jobs) {
			lines.push(`  - ${job.mode} ${job.target ?? ''} · ${job.phase}${job.error ? ` · ${job.error}` : ''}`)
		}
	}
	return lines.join('\n')
}

/**
 * Render one collection result for the model.
 * @param value - `xhs_collect` result.
 * @returns compact text.
 */
function renderCollection(value) {
	if (value === undefined || value === null) return '没有拿到采集结果。'
	if (value.ok === false) {
		const lines = [`采集失败（${value.mode ?? '?'}）：${value.error ?? '未知原因'}`]
		for (const warning of value.warnings ?? []) lines.push(`- ${warning}`)
		return lines.join('\n')
	}
	const lines = []
	if (value.mode === 'note') {
		const note = value.note ?? {}
		lines.push(`笔记：${note.title || note.id || '(无标题)'}`)
		if (note.author) lines.push(`作者：${note.author}`)
		lines.push(`互动：赞 ${note.liked ?? '?'} · 评论 ${note.comments ?? '?'} · 图片 ${note.images ?? 0} 张`)
		const comments = value.comments ?? {}
		lines.push(`评论：一级 ${comments.top ?? 0} 条，楼中楼 ${comments.sub ?? 0} 条`)
		lines.push(`落盘：${value.paths?.note || '(未写入)'}`)
		if (value.paths?.comments) lines.push(`评论文件：${value.paths.comments}`)
	} else if (value.mode === 'search') {
		lines.push(`搜索「${value.query}」：${value.total ?? 0} 条笔记`)
		for (const note of value.notes ?? []) lines.push(`  - ${note.title || note.id}${note.author ? ` · ${note.author}` : ''}${note.liked ? ` · 赞 ${note.liked}` : ''}`)
		lines.push(`落盘：${value.path ?? ''}`)
	} else if (value.mode === 'profile') {
		lines.push(`主页 ${value.userId}（${value.tab ?? 'notes'}）：${value.total ?? 0} 条笔记`)
		for (const note of value.notes ?? []) lines.push(`  - ${note.title || note.id}`)
		lines.push(`落盘：${value.path ?? ''}`)
	} else if (value.mode === 'chat') {
		lines.push(`私信：会话 ${value.conversations ?? 0} 个，采到 ${value.collected?.length ?? 0} 个会话 / ${value.totalMessages ?? 0} 条消息`)
		for (const item of value.collected ?? []) lines.push(`  - ${item.conversationId}：${item.messages} 条`)
	} else if (value.mode === 'notifications') {
		lines.push(`通知：${value.total ?? 0} 条`)
		lines.push(`落盘：${value.path ?? ''}`)
	} else {
		lines.push(JSON.stringify(value, null, 2).slice(0, 4000))
	}
	for (const warning of value.warnings ?? []) lines.push(`⚠ ${warning}`)
	const endpoints = Array.isArray(value.endpoints) ? value.endpoints.slice(0, 8) : []
	if (endpoints.length > 0) lines.push(`接口：${endpoints.map((entry) => entry.path).join('、')}`)
	return lines.join('\n')
}

/**
 * Render a library listing for the model.
 * @param value - `xhs_library` result.
 * @returns compact text.
 */
function renderLibrary(value) {
	const items = Array.isArray(value?.items) ? value.items : []
	if (items.length === 0) return '本地还没有采集数据（或过滤条件没有命中）。'
	const lines = [`共 ${value.total ?? items.length} 条，显示 ${items.length} 条：`]
	for (const item of items) {
		lines.push(`- [${item.type}] ${item.title || item.id} · ${item.count ?? 0} 条 · ${item.collectedAt ?? ''} · ${item.path ?? ''}`)
	}
	return lines.join('\n')
}

/**
 * Render a probe inventory for the model.
 * @param value - `xhs_probe` result.
 * @returns compact text.
 */
function renderProbe(value) {
	if (value === undefined || value === null) return '没有拿到探测结果。'
	const lines = [`探测 ${value.url}：共 ${value.captures ?? 0} 条捕获，原始数据 ${value.rawPath ?? ''}`]
	for (const endpoint of value.inventory ?? []) lines.push(`- ${endpoint.path} × ${endpoint.count}`)
	if (value.hint) lines.push(value.hint)
	return lines.join('\n')
}

/**
 * Format a counts object as one line.
 * @param counts - type -> count.
 * @returns compact text.
 */
function formatCounts(counts) {
	const entries = Object.entries(counts ?? {}).filter(([, count]) => Number(count) > 0)
	if (entries.length === 0) return '暂无'
	return entries.map(([type, count]) => `${type} ${count}`).join(' · ')
}
