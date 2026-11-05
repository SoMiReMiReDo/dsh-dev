/**
 * Browser half of dsh-xhs-check.
 *
 * Registers one Settings section ("小红书采集" / "Xiaohongshu collector") that
 * shows the collector's runtime state: whether the dedicated Chrome is running
 * and signed in, the data directory, per-type collection counts, the active and
 * recent jobs, and the most recently collected library entries.
 *
 * The panel owns no data of its own: every value comes from the Host plugin's
 * POST routes (`/api/xhs.status`, `/api/xhs.library`, `/api/xhs.login`,
 * `/api/xhs.chrome`, `/api/xhs.reveal`). Polling is a self-rescheduling
 * `setTimeout` chain driven by one `AbortController` per mounted panel, fast
 * while a job runs and slow while idle, and torn down when the panel unmounts
 * (the Settings dialog owns the mount lifetime).
 *
 * Styling uses only host theme tokens (`var(--dsw-*)`) so the section follows
 * the light and dark themes; no DOM is written outside the component tree.
 */

window.__ModuleLoader__.load({
	id: 'dsh-xhs-check',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Locale namespace for this plugin's visible copy. */
		const NS = 'xhscheck'

		/** Settings-section identity; shipped sections already own their ids. */
		const SECTION_ID = 'xhs-check'

		/** Host routes consumed by this panel (all POST + JSON). */
		const ROUTES = {
			status: '/api/xhs.status',
			login: '/api/xhs.login',
			chrome: '/api/xhs.chrome',
			library: '/api/xhs.library',
			reveal: '/api/xhs.reveal'
		}

		/** Poll cadence while a job is running. */
		const POLL_BUSY_MS = 1500

		/** Poll cadence while no job is running. */
		const POLL_IDLE_MS = 5000

		/** How many recent library rows the panel asks for. */
		const LIBRARY_LIMIT = 20

		/** Count chips, in display order (first five are the required types). */
		const COUNT_TYPES = ['note', 'comment', 'chat_conversation', 'chat_message', 'notification', 'search', 'profile']

		/** Record types the library badge translates; anything else renders raw. */
		const TYPE_VALUES = new Set(['note', 'comment', 'chat', 'chat_conversation', 'chat_message', 'notification', 'search', 'profile'])

		/** Collection modes the job row translates; the Host may add more later. */
		const MODE_VALUES = new Set(['note', 'comment', 'comments', 'search', 'profile', 'chat', 'notification', 'notifications', 'probe', 'login'])

		/** Job phases the job row translates; an unknown phase renders raw. */
		const PHASE_VALUES = new Set(['queued', 'running', 'checking-login', 'opening-browser', 'opening-chrome', 'waiting-for-scan', 'recording', 'note', 'comments', 'starting', 'launching', 'navigating', 'scrolling', 'collecting', 'parsing', 'saving', 'done', 'failed', 'cancelled', 'idle'])

		const zh = {
			'panel.title': '小红书采集',
			'panel.subtitle': '在 DSH 内置浏览器（右侧栏）里采集笔记、评论、搜索、主页与私信，结果保存到数据目录；可在 settings.json 用 backend 切回 CDP Chrome。',
			'value.unknown': '未知',
			'value.none': '—',
			'state.loading': '正在读取状态…',
			'state.errorTitle': '无法读取插件状态',
			'state.errorHint': '确认 xhs-check 插件已启用，然后重试。',
			'state.retry': '重试',
			'state.stale': '状态刷新失败，下面是上次的结果。',
			'status.title': '运行状态',
			'chrome.label': '浏览器',
			'browser.connected': '内置浏览器 · 已连接',
			'browser.disconnected': '内置浏览器 · 未连接',
			'browser.unavailable': '内置浏览器不可用（未启用 dsh-inner-chrome）',
			'browser.web': 'Web 端降级（不能读取页面）',
			'chrome.runningConnected': '运行中 · 已连接',
			'chrome.runningDisconnected': '运行中 · 未连接',
			'chrome.stopped': '未运行',
			'chrome.port': '端口 {port}',
			'login.label': '登录',
			'login.loggedOut': '未登录',
			'login.unknown': '尚未检查',
			'login.loggedInNoName': '已登录',
			'login.hint': '尚未登录小红书：点「打开浏览器并登录」，在右侧栏内置浏览器里扫码登录后再刷新。',
			'login.hintNoChrome': '采集浏览器未连接。点「打开浏览器并登录」会在右侧栏打开小红书首页（若用 cdp 后端则启动独立 Chrome 窗口）。',
			'login.hintUnknown': '登录态尚未检测：点「打开浏览器并登录」会打开小红书首页并检查登录状态。',
			'dataDir.label': '数据目录',
			'dataDir.copy': '点击复制路径',
			'dataDir.copied': '已复制',
			'dataDir.copyFailed': '复制失败，请手动选择文本',
			'counts.label': '已采集',
			'type.note': '笔记',
			'type.comment': '评论',
			'type.chat': '私信',
			'type.chat_conversation': '会话',
			'type.chat_message': '消息',
			'type.notification': '通知',
			'type.search': '搜索',
			'type.profile': '主页',
			'action.login': '打开浏览器并登录',
			'action.loginBusy': '等待登录…',
			'action.refresh': '刷新',
			'action.closeChrome': '关闭采集页面',
			'action.closeChromeBusy': '正在关闭…',
			'action.reveal': '打开数据目录',
			'action.revealBusy': '正在打开…',
			'action.failed': '操作失败',
			'jobs.title': '任务',
			'jobs.empty': '还没有任务记录。',
			'jobs.running': '进行中',
			'jobs.done': '已完成',
			'jobs.failed': '失败',
			'jobs.started': '开始于 {time}',
			'jobs.finished': '结束于 {time}',
			'jobs.progressOf': '已处理 {done} / {total}',
			'jobs.progressDone': '已处理 {done}',
			'mode.note': '笔记',
			'mode.comment': '评论',
			'mode.comments': '评论',
			'mode.search': '搜索',
			'mode.profile': '主页',
			'mode.chat': '私信',
			'mode.notification': '通知',
			'mode.notifications': '通知',
			'mode.probe': '探测',
			'mode.login': '登录',
			'phase.queued': '排队中',
			'phase.running': '进行中',
			'phase.checking-login': '检查登录',
			'phase.opening-chrome': '启动 Chrome',
			'phase.opening-browser': '打开内置浏览器',
			'phase.waiting-for-scan': '等待扫码',
			'phase.recording': '录制中',
			'phase.note': '笔记',
			'phase.comments': '评论',
			'phase.starting': '启动中',
			'phase.launching': '启动 Chrome',
			'phase.navigating': '打开页面',
			'phase.scrolling': '滚动加载',
			'phase.collecting': '采集中',
			'phase.parsing': '解析中',
			'phase.saving': '保存中',
			'phase.done': '完成',
			'phase.failed': '失败',
			'phase.cancelled': '已取消',
			'phase.idle': '空闲',
			'library.title': '最近采集',
			'library.loading': '正在读取采集记录…',
			'library.error': '无法读取采集记录',
			'library.empty': '还没有采集记录。登录后让模型执行采集任务，结果会出现在这里。',
			'library.total': '共 {total} 项',
			'library.itemCount': '{count} 条',
			'library.copyPath': '点击复制路径',
			'library.copied': '已复制'
		}

		const en = {
			'panel.title': 'Xiaohongshu collector',
			'panel.subtitle': 'Collects notes, comments, searches, profiles and private messages inside the DSH built-in browser (right sidebar) and stores them in the data directory; set backend to cdp in settings.json to use Chrome over CDP.',
			'value.unknown': 'Unknown',
			'value.none': '—',
			'state.loading': 'Reading status…',
			'state.errorTitle': 'Could not read the plugin status',
			'state.errorHint': 'Make sure the xhs-check plugin is enabled, then retry.',
			'state.retry': 'Retry',
			'state.stale': 'Status refresh failed; showing the previous result.',
			'status.title': 'Runtime status',
			'chrome.label': 'Browser',
			'browser.connected': 'Built-in browser · connected',
			'browser.disconnected': 'Built-in browser · disconnected',
			'browser.unavailable': 'Built-in browser unavailable (dsh-inner-chrome not enabled)',
			'browser.web': 'Web fallback (cannot read pages)',
			'chrome.runningConnected': 'Running · connected',
			'chrome.runningDisconnected': 'Running · disconnected',
			'chrome.stopped': 'Not running',
			'chrome.port': 'Port {port}',
			'login.label': 'Sign-in',
			'login.loggedOut': 'Not signed in',
			'login.unknown': 'Not checked yet',
			'login.loggedInNoName': 'Signed in',
			'login.hint': 'Not signed in to Xiaohongshu yet: choose “Open browser and sign in”, scan the QR code in the right-sidebar browser, then refresh.',
			'login.hintNoChrome': 'The collection browser is not connected. “Open browser and sign in” opens Xiaohongshu in the right sidebar (or starts a separate Chrome window when backend is cdp).',
			'login.hintUnknown': 'Sign-in has not been checked yet: “Open browser and sign in” opens Xiaohongshu and checks the session.',
			'dataDir.label': 'Data directory',
			'dataDir.copy': 'Click to copy the path',
			'dataDir.copied': 'Copied',
			'dataDir.copyFailed': 'Copy failed; select the text manually',
			'counts.label': 'Collected',
			'type.note': 'Notes',
			'type.comment': 'Comments',
			'type.chat': 'Direct messages',
			'type.chat_conversation': 'Chats',
			'type.chat_message': 'Messages',
			'type.notification': 'Notifications',
			'type.search': 'Searches',
			'type.profile': 'Profiles',
			'action.login': 'Open browser and sign in',
			'action.loginBusy': 'Waiting for sign-in…',
			'action.refresh': 'Refresh',
			'action.closeChrome': 'Close collection pages',
			'action.closeChromeBusy': 'Closing…',
			'action.reveal': 'Open data folder',
			'action.revealBusy': 'Opening…',
			'action.failed': 'Action failed',
			'jobs.title': 'Jobs',
			'jobs.empty': 'No jobs recorded yet.',
			'jobs.running': 'Running',
			'jobs.done': 'Done',
			'jobs.failed': 'Failed',
			'jobs.started': 'Started {time}',
			'jobs.finished': 'Finished {time}',
			'jobs.progressOf': 'Processed {done} / {total}',
			'jobs.progressDone': 'Processed {done}',
			'mode.note': 'Note',
			'mode.comment': 'Comment',
			'mode.comments': 'Comments',
			'mode.search': 'Search',
			'mode.profile': 'Profile',
			'mode.chat': 'Direct messages',
			'mode.notification': 'Notifications',
			'mode.notifications': 'Notifications',
			'mode.probe': 'Probe',
			'mode.login': 'Sign-in',
			'phase.queued': 'Queued',
			'phase.running': 'Running',
			'phase.checking-login': 'Checking sign-in',
			'phase.opening-chrome': 'Launching Chrome',
			'phase.opening-browser': 'Opening built-in browser',
			'phase.waiting-for-scan': 'Waiting for sign-in',
			'phase.recording': 'Recording',
			'phase.note': 'Note',
			'phase.comments': 'Comments',
			'phase.starting': 'Starting',
			'phase.launching': 'Launching Chrome',
			'phase.navigating': 'Opening page',
			'phase.scrolling': 'Scrolling',
			'phase.collecting': 'Collecting',
			'phase.parsing': 'Parsing',
			'phase.saving': 'Saving',
			'phase.done': 'Done',
			'phase.failed': 'Failed',
			'phase.cancelled': 'Cancelled',
			'phase.idle': 'Idle',
			'library.title': 'Recently collected',
			'library.loading': 'Reading collected items…',
			'library.error': 'Could not read collected items',
			'library.empty': 'Nothing collected yet. After signing in, ask the model to run a collection job; results appear here.',
			'library.total': '{total} items',
			'library.itemCount': '{count} items',
			'library.copyPath': 'Click to copy the path',
			'library.copied': 'Copied'
		}

		/**
		 * POST one JSON request to the Host plugin routes.
		 * @param path - route path.
		 * @param body - JSON-serializable body.
		 * @param signal - aborts the request when the panel unmounts.
		 * @returns the parsed response payload.
		 */
		async function post(path, body, signal) {
			const response = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body ?? {}),
				signal
			})
			const payload = await response.json().catch(() => undefined)
			if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
			return payload
		}

		/**
		 * Whether the status payload still contains a job without an end time.
		 * @param jobs - the Host's job list, possibly absent.
		 * @returns true when at least one job is still running.
		 */
		function hasRunningJob(jobs) {
			return Array.isArray(jobs) && jobs.some((job) => job !== null && typeof job === 'object' && job.finishedAt == null)
		}

		/**
		 * Translate one Host enum value, falling back to the raw value when it is
		 * outside the known set (the Host may add modes or phases later). Only keys
		 * that exist in the dictionary are ever passed to `t`.
		 * @param t - namespace-bound translator.
		 * @param group - dictionary prefix, e.g. `mode` or `phase`.
		 * @param value - raw Host value.
		 * @param known - values this panel ships copy for.
		 * @returns the localized label, or the raw value when unknown.
		 */
		function enumLabel(t, group, value, known) {
			if (typeof value !== 'string' || value === '') return t('value.unknown')
			return known.has(value) ? t(`${group}.${value}`) : value
		}

		/**
		 * Format one ISO timestamp for the compact list rows.
		 * @param value - ISO timestamp from the Host.
		 * @returns the localized short date-time, or undefined when unparsable.
		 */
		function formatTime(value) {
			if (typeof value !== 'string' && typeof value !== 'number') return undefined
			const date = new Date(value)
			if (Number.isNaN(date.getTime())) return undefined
			try {
				return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
			} catch {
				return date.toISOString()
			}
		}

		/**
		 * Read a finite count out of a Host counts map.
		 * @param counts - per-type counts, possibly absent.
		 * @param type - record type key.
		 * @returns the count, or 0 when absent or not a number.
		 */
		function countOf(counts, type) {
			const value = counts?.[type]
			return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
		}

		/**
		 * Read one job's progress into plain numbers.
		 * @param job - one Host job row.
		 * @returns `{ done, total?, percent? }`, or undefined when the Host sent no progress.
		 */
		function jobProgress(job) {
			const progress = job?.progress
			const done = typeof progress?.done === 'number' && Number.isFinite(progress.done) ? progress.done : undefined
			if (done === undefined) return undefined
			const total = typeof progress?.total === 'number' && Number.isFinite(progress.total) && progress.total > 0 ? progress.total : undefined
			if (total === undefined) return { done, total: undefined, percent: undefined }
			return { done, total, percent: Math.min(100, Math.max(0, (done / total) * 100)) }
		}

		/** Shared inline styles; every color/radius comes from a host theme token. */
		const styles = {
			root: {
				display: 'flex',
				flexDirection: 'column',
				gap: 16,
				width: '100%',
				maxWidth: 860,
				minWidth: 0,
				boxSizing: 'border-box',
				color: 'var(--dsw-alias-label-primary)',
				fontSize: 14,
				lineHeight: '22px'
			},
			heading: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px' },
			subtitle: { margin: '4px 0 0', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
			card: {
				display: 'flex',
				flexDirection: 'column',
				gap: 12,
				minWidth: 0,
				boxSizing: 'border-box',
				padding: 16,
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: 'var(--dsw-radius-lg)',
				background: 'var(--dsw-alias-bg-layer-1)'
			},
			cardHead: {
				display: 'flex',
				flexWrap: 'wrap',
				alignItems: 'baseline',
				justifyContent: 'space-between',
				gap: '4px 12px',
				minWidth: 0
			},
			cardTitle: { margin: 0, fontSize: 14, fontWeight: 500, lineHeight: '22px' },
			cardNote: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
			fields: { display: 'flex', flexWrap: 'wrap', gap: '12px 28px', minWidth: 0 },
			field: { display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 190px', minWidth: 0 },
			fieldLabel: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
			fieldValue: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 13, lineHeight: '20px', overflowWrap: 'anywhere' },
			dot: { width: 8, height: 8, borderRadius: 999, display: 'inline-block', flex: 'none' },
			dataDirButton: {
				maxWidth: '100%',
				minWidth: 0,
				margin: 0,
				padding: '2px 6px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: 'var(--dsw-radius-xs)',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary)',
				fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
				fontSize: 11,
				lineHeight: '16px',
				textAlign: 'left',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
				cursor: 'pointer'
			},
			hint: { margin: 0, fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
			divider: { height: 1, margin: 0, border: 0, background: 'var(--dsw-alias-border-l1)' },
			counts: { display: 'flex', flexWrap: 'wrap', gap: 8, margin: 0, padding: 0, listStyle: 'none', minWidth: 0 },
			chip: {
				display: 'flex',
				flexDirection: 'column',
				gap: 2,
				flex: '1 0 72px',
				minWidth: 72,
				maxWidth: 132,
				boxSizing: 'border-box',
				padding: '7px 10px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: 'var(--dsw-radius-md)'
			},
			chipValue: { fontSize: 16, fontWeight: 500, lineHeight: '20px' },
			chipLabel: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
			actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 },
			list: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none', minWidth: 0 },
			row: {
				display: 'flex',
				flexWrap: 'wrap',
				alignItems: 'center',
				gap: '4px 10px',
				minWidth: 0,
				boxSizing: 'border-box',
				padding: '9px 11px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: 'var(--dsw-radius-md)'
			},
			badge: {
				flex: 'none',
				padding: '0 6px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: 'var(--dsw-radius-xs)',
				color: 'var(--dsw-alias-label-secondary)',
				fontSize: 11,
				lineHeight: '18px',
				whiteSpace: 'nowrap'
			},
			rowMain: {
				flex: '1 1 140px',
				minWidth: 0,
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
				fontSize: 13,
				lineHeight: '20px'
			},
			rowMeta: { flex: 'none', fontSize: 11, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
			metaLine: { flex: '1 1 100%', minWidth: 0, fontSize: 11, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
			jobHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', flex: '1 1 100%', minWidth: 0 },
			jobTarget: {
				flex: '1 1 120px',
				minWidth: 0,
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
				fontSize: 12,
				lineHeight: '18px',
				color: 'var(--dsw-alias-label-secondary)',
				fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
			},
			jobState: { flex: 'none', marginLeft: 'auto', fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap' },
			progressTrack: {
				flex: '1 1 100%',
				height: 4,
				borderRadius: 999,
				background: 'var(--dsw-alias-border-l1)',
				overflow: 'hidden'
			},
			progressFill: { height: '100%', borderRadius: 999, background: 'var(--dsw-alias-label-tertiary)' },
			muted: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
			errorBox: {
				display: 'flex',
				flexDirection: 'column',
				gap: 6,
				minWidth: 0,
				boxSizing: 'border-box',
				padding: '10px 12px',
				border: '1px solid var(--dsw-alias-state-error-secondary)',
				borderRadius: 'var(--dsw-radius-md)',
				color: 'var(--dsw-alias-state-error-primary)',
				fontSize: 13,
				lineHeight: '20px',
				overflowWrap: 'anywhere'
			},
			errorText: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
			errorDoc: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
		}

		/**
		 * Host-styled push button. Uses the same primary/outline token pairing as
		 * the shipped Settings controls and adds hover feedback locally.
		 * @param props.variant - `primary` or `outline`.
		 * @param props.disabled - blocks the click and dims the label.
		 * @param props.onClick - click handler.
		 * @param props.children - button label.
		 * @returns the button element.
		 */
		function PanelButton({ variant, disabled, onClick, children }) {
			const [hover, setHover] = React.useState(false)
			const primary = variant === 'primary'
			const active = hover && !disabled
			const style = primary
				? {
					height: 32,
					padding: '0 14px',
					border: '1px solid transparent',
					borderRadius: 'var(--dsw-radius-sm)',
					background: active ? 'var(--dsw-alias-button-primary-hover)' : 'var(--dsw-alias-button-primary-fill)',
					color: 'var(--dsw-alias-label-primary-inverted)'
				}
				: {
					height: 32,
					padding: '0 12px',
					border: '1px solid var(--dsw-alias-border-l3)',
					borderRadius: 'var(--dsw-radius-sm)',
					background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
					color: 'var(--dsw-alias-label-primary)'
				}
			return h('button', {
				type: 'button',
				disabled,
				onClick,
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				style: {
					...style,
					display: 'inline-flex',
					alignItems: 'center',
					justifyContent: 'center',
					gap: 6,
					flex: 'none',
					margin: 0,
					fontFamily: 'inherit',
					fontSize: 13,
					lineHeight: '20px',
					whiteSpace: 'nowrap',
					cursor: disabled ? 'default' : 'pointer',
					opacity: disabled ? 0.55 : 1
				}
			}, children)
		}

		/**
		 * One recent library entry: type badge, title or id, item count, time and
		 * its path. Hovering reveals the full path through the native tooltip;
		 * clicking copies it.
		 * @param props.item - one `{ type, id, title, count, collectedAt, path }` row.
		 * @param props.t - namespace-bound translator.
		 * @returns the list row.
		 */
		function LibraryRow({ item, t }) {
			const [feedback, setFeedback] = React.useState(undefined)
			const timer = React.useRef(undefined)
			React.useEffect(() => () => {
				clearTimeout(timer.current)
			}, [])
			const path = typeof item?.path === 'string' && item.path !== '' ? item.path : undefined
			const title = typeof item?.title === 'string' && item.title.trim() !== '' ? item.title.trim() : undefined
			const id = item?.id === undefined || item?.id === null || item?.id === '' ? undefined : String(item.id)
			const count = typeof item?.count === 'number' && Number.isFinite(item.count) ? item.count : undefined
			const time = formatTime(item?.collectedAt)
			const copy = () => {
				if (path === undefined) return
				Promise.resolve(navigator.clipboard?.writeText(path)).then(() => {
					setFeedback('copied')
				}, () => {
					setFeedback('failed')
				}).finally(() => {
					clearTimeout(timer.current)
					timer.current = setTimeout(() => setFeedback(undefined), 1800)
				})
			}
			const tooltip = path === undefined
				? undefined
				: feedback === 'copied' ? t('library.copied') : feedback === 'failed' ? t('dataDir.copyFailed') : path
			return h('li', {
				title: tooltip,
				'data-xhs-library-row': item?.type ?? '',
				onClick: copy,
				style: {
					...styles.row,
					cursor: path === undefined ? 'default' : 'pointer'
				}
			}, [
				h('span', { key: 'type', style: styles.badge }, enumLabel(t, 'type', item?.type, TYPE_VALUES)),
				h('span', { key: 'main', style: styles.rowMain }, title ?? id ?? t('value.unknown')),
				count === undefined ? null : h('span', { key: 'count', style: styles.rowMeta }, t('library.itemCount', { count })),
				h('span', { key: 'time', style: styles.rowMeta }, time ?? t('value.none')),
				path === undefined ? null : h('span', { key: 'path', style: { ...styles.rowMeta, flex: '1 1 100%', overflow: 'hidden', textOverflow: 'ellipsis' } }, path)
			])
		}

		/**
		 * One job row: mode/target, phase, progress and error.
		 * @param props.job - one Host job row.
		 * @param props.t - namespace-bound translator.
		 * @returns the list row.
		 */
		function JobRow({ job, t }) {
			const running = job?.finishedAt == null
			const failed = job?.ok === false || (typeof job?.error === 'string' && job.error !== '')
			const tone = failed ? 'var(--dsw-alias-state-error-primary)' : running ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)'
			const stateText = failed ? t('jobs.failed') : running ? t('jobs.running') : t('jobs.done')
			const progress = jobProgress(job)
			const meta = []
			if (typeof job?.phase === 'string' && job.phase !== '') meta.push(enumLabel(t, 'phase', job.phase, PHASE_VALUES))
			const started = formatTime(job?.startedAt)
			if (started !== undefined) meta.push(t('jobs.started', { time: started }))
			const finished = formatTime(job?.finishedAt)
			if (finished !== undefined) meta.push(t('jobs.finished', { time: finished }))
			const target = job?.target === undefined || job?.target === null || job?.target === '' ? undefined : String(job.target)
			return h('li', {
				'data-xhs-job': job?.id ?? '',
				style: styles.row
			}, [
				h('div', { key: 'head', style: styles.jobHead }, [
					h('span', { key: 'mode', style: styles.badge }, enumLabel(t, 'mode', job?.mode, MODE_VALUES)),
					target === undefined ? null : h('span', { key: 'target', style: styles.jobTarget, title: target }, target),
					h('span', { key: 'state', style: { ...styles.jobState, color: tone } }, stateText)
				]),
				meta.length === 0 ? null : h('div', { key: 'meta', style: styles.metaLine }, meta.join(' · ')),
				progress === undefined ? null : h('div', { key: 'progress', style: styles.metaLine, role: 'status' },
					progress.total === undefined
						? t('jobs.progressDone', { done: progress.done })
						: t('jobs.progressOf', { done: progress.done, total: progress.total })),
				progress === undefined || progress.percent === undefined ? null : h('div', { key: 'track', style: styles.progressTrack }, h('div', {
					style: { ...styles.progressFill, width: `${progress.percent}%`, background: failed ? 'var(--dsw-alias-state-error-primary)' : running ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)' }
				})),
				failed ? h('p', { key: 'error', style: styles.errorText }, String(job?.error ?? t('jobs.failed'))) : null
			])
		}

		/**
		 * The Settings section: status card, action row, job list and recent
		 * collections. Every fetch carries an abort signal; every effect and timer
		 * is torn down when the section unmounts.
		 * @param props.t - translator bound to this section's locale namespace.
		 * @param props.close - the shell's Settings close action (unused: the panel
		 *   stays readable while operations run, and the shell owns dismissal).
		 * @returns the section element tree.
		 */
		function XhsCheckSection({ t }) {
			const [status, setStatus] = React.useState(undefined)
			const [statusError, setStatusError] = React.useState(undefined)
			const [library, setLibrary] = React.useState(undefined)
			const [libraryError, setLibraryError] = React.useState(undefined)
			const [actionError, setActionError] = React.useState(undefined)
			const [busy, setBusy] = React.useState(undefined)
			const [reloadTick, setReloadTick] = React.useState(0)
			const [copied, setCopied] = React.useState(undefined)
			const actionControllers = React.useRef(new Set())
			const copyTimer = React.useRef(undefined)

			// A finished job can add a library row: refetch when that set changes.
			const finishedSignature = (Array.isArray(status?.jobs) ? status.jobs : [])
				.filter((job) => job !== null && typeof job === 'object' && job.finishedAt != null)
				.map((job) => `${job.id ?? ''}:${job.finishedAt}`)
				.join('|')

			// Status: one self-rescheduling chain, fast while a job runs.
			React.useEffect(() => {
				const controller = new AbortController()
				let timer
				async function poll() {
					let delay = POLL_IDLE_MS
					try {
						const payload = await post(ROUTES.status, {}, controller.signal)
						if (controller.signal.aborted) return
						setStatus(payload)
						setStatusError(undefined)
						delay = hasRunningJob(payload?.jobs) ? POLL_BUSY_MS : POLL_IDLE_MS
					} catch (error) {
						if (controller.signal.aborted) return
						setStatusError(error instanceof Error ? error.message : String(error))
					} finally {
						if (!controller.signal.aborted) timer = setTimeout(poll, delay)
					}
				}
				void poll()
				return () => {
					controller.abort()
					clearTimeout(timer)
				}
			}, [reloadTick])

			// Recent library rows: on mount, on manual refresh, and when a job ends.
			React.useEffect(() => {
				const controller = new AbortController()
				async function load() {
					try {
						const payload = await post(ROUTES.library, { limit: LIBRARY_LIMIT }, controller.signal)
						if (controller.signal.aborted) return
						setLibrary(payload)
						setLibraryError(undefined)
					} catch (error) {
						if (controller.signal.aborted) return
						setLibraryError(error instanceof Error ? error.message : String(error))
					}
				}
				void load()
				return () => controller.abort()
			}, [reloadTick, finishedSignature])

			// Unmount: abort any action request still in flight.
			React.useEffect(() => () => {
				for (const controller of actionControllers.current) controller.abort()
				actionControllers.current.clear()
				clearTimeout(copyTimer.current)
			}, [])

			const browser = status?.browser ?? {}
			const backend = status?.backend === 'inner-chrome' ? 'inner-chrome' : 'cdp'
			const login = status?.login ?? {}
			const counts = status?.counts ?? {}
			const jobs = Array.isArray(status?.jobs) ? status.jobs : []
			const running = backend === 'inner-chrome' ? browser.available === true : browser.running === true
			const connected = browser.connected === true
			const loginState = login.loggedIn === true ? 'in' : login.loggedIn === false ? 'out' : 'unknown'
			const nickname = typeof login.nickname === 'string' && login.nickname.trim() !== '' ? login.nickname.trim() : undefined
			const dataDir = typeof status?.dataDir === 'string' && status.dataDir !== '' ? status.dataDir : undefined
			const libraryItems = Array.isArray(library?.items) ? library.items : []
			const libraryTotal = typeof library?.total === 'number' && Number.isFinite(library.total) ? library.total : libraryItems.length

			/**
			 * Run one Host action, then restart the status poll immediately.
			 * @param name - action id owning the busy state.
			 * @param send - performs the POST and resolves its payload.
			 */
			async function runAction(name, send) {
				if (busy !== undefined) return
				const controller = new AbortController()
				actionControllers.current.add(controller)
				setBusy(name)
				setActionError(undefined)
				try {
					const payload = await send(controller.signal)
					if (controller.signal.aborted) return
					if (payload?.browser !== undefined || payload?.login !== undefined) {
						setStatus((current) => current === undefined ? current : {
							...current,
							browser: payload.browser ?? current.browser,
							login: payload.login ?? current.login
						})
					}
					setReloadTick((value) => value + 1)
				} catch (error) {
					if (!controller.signal.aborted) setActionError(error instanceof Error ? error.message : String(error))
				} finally {
					actionControllers.current.delete(controller)
					if (!controller.signal.aborted) setBusy(undefined)
				}
			}

			/**
			 * Restart both polls now: the status effect aborts its pending timer and
			 * fetches again, and the library effect refetches alongside it.
			 */
			function refreshNow() {
				setActionError(undefined)
				setReloadTick((value) => value + 1)
			}

			/**
			 * Copy the data directory path; failures stay inside the panel.
			 */
			async function copyDataDir() {
				if (dataDir === undefined) return
				try {
					await navigator.clipboard.writeText(dataDir)
					setCopied('copied')
				} catch {
					setCopied('failed')
				}
				clearTimeout(copyTimer.current)
				copyTimer.current = setTimeout(() => setCopied(undefined), 2000)
			}

			const chromeTone = running && connected
				? 'var(--dsw-alias-state-success-primary)'
				: running ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-idle-primary)'
			const chromeText = backend === 'inner-chrome'
				? browser.available !== true
					? t('browser.unavailable')
					: connected
						? browser.platform === 'web' ? t('browser.web') : t('browser.connected')
						: t('browser.disconnected')
				: running
					? connected ? t('chrome.runningConnected') : t('chrome.runningDisconnected')
					: t('chrome.stopped')
			const chromeMeta = backend === 'inner-chrome'
				? (typeof browser.title === 'string' && browser.title !== '' ? browser.title : (typeof browser.url === 'string' && browser.url !== '' ? browser.url : undefined))
				: running && typeof browser.port === 'number' ? t('chrome.port', { port: browser.port }) : undefined
			const dataDirLabel = copied === 'copied' ? t('dataDir.copied') : copied === 'failed' ? t('dataDir.copyFailed') : t('dataDir.copy')

			return h('article', {
				'data-xhs-check': '',
				style: styles.root
			}, [
				h('header', { key: 'header', style: { display: 'flex', flexDirection: 'column', minWidth: 0 } }, [
					h('h2', { key: 'title', style: styles.heading }, t('panel.title')),
					h('p', { key: 'subtitle', style: styles.subtitle }, t('panel.subtitle'))
				]),

				h('section', { key: 'status', 'aria-label': t('status.title'), style: styles.card }, [
					h('div', { key: 'head', style: styles.cardHead }, [
						h('h3', { key: 'title', style: styles.cardTitle }, t('status.title')),
						statusError === undefined ? null : h('span', { key: 'stale', role: 'status', style: styles.cardNote }, statusError)
					]),

					status === undefined && statusError === undefined
						? h('p', { key: 'loading', role: 'status', style: styles.muted }, t('state.loading'))
						: null,

					status === undefined && statusError !== undefined
						? h('div', { key: 'error', role: 'alert', style: styles.errorBox }, [
							h('p', { key: 'title', style: styles.errorText }, t('state.errorTitle')),
							h('p', { key: 'doc', style: styles.errorDoc }, statusError),
							h('p', { key: 'hint', style: styles.errorDoc }, t('state.errorHint')),
							h('div', { key: 'retry', style: { display: 'flex', gap: 8 } }, h(PanelButton, {
								variant: 'outline',
								onClick: refreshNow,
								children: t('state.retry')
							}))
						])
						: null,

					status === undefined ? null : h('div', { key: 'fields', style: styles.fields }, [
						h('div', { key: 'chrome', style: styles.field }, [
							h('span', { key: 'label', style: styles.fieldLabel }, t('chrome.label')),
							h('div', { key: 'value', style: styles.fieldValue }, [
								h('span', { key: 'dot', 'aria-hidden': 'true', style: { ...styles.dot, background: chromeTone } }),
								h('span', { key: 'text' }, chromeText),
								chromeMeta === undefined ? null : h('span', { key: 'meta', style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } }, chromeMeta)
							])
						]),
						h('div', { key: 'login', style: styles.field }, [
							h('span', { key: 'label', style: styles.fieldLabel }, t('login.label')),
							h('div', { key: 'value', style: styles.fieldValue },
								loginState === 'in'
									? h('span', { style: { fontWeight: 500 } }, nickname ?? t('login.loggedInNoName'))
									: h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, loginState === 'out' ? t('login.loggedOut') : t('login.unknown')))
						]),
						h('div', { key: 'dataDir', style: styles.field }, [
							h('span', { key: 'label', style: styles.fieldLabel }, t('dataDir.label')),
							h('div', { key: 'value', style: styles.fieldValue },
								dataDir === undefined
									? h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } }, t('value.unknown'))
									: h('button', {
										type: 'button',
										title: dataDirLabel,
										'aria-label': t('dataDir.copy'),
										onClick: () => { void copyDataDir() },
										style: styles.dataDirButton
									}, dataDir))
						])
					]),

					status !== undefined && loginState === 'out'
						? h('p', { key: 'loginHint', style: styles.hint }, running ? t('login.hint') : t('login.hintNoChrome'))
						: null,
					status !== undefined && loginState === 'unknown'
						? h('p', { key: 'loginHintUnknown', style: styles.hint }, t('login.hintUnknown'))
						: null,

					status === undefined ? null : h('hr', { key: 'divider', style: styles.divider }),

					status === undefined ? null : h('ul', { key: 'counts', 'aria-label': t('counts.label'), style: styles.counts },
						COUNT_TYPES.map((type) => h('li', { key: type, style: styles.chip }, [
							h('span', { key: 'value', style: styles.chipValue }, String(countOf(counts, type))),
							h('span', { key: 'label', style: styles.chipLabel }, t(`type.${type}`))
						])))
				]),

				h('div', { key: 'actions', style: styles.actions }, [
					h(PanelButton, {
						key: 'login',
						variant: 'primary',
						disabled: busy !== undefined,
						onClick: () => { void runAction('login', (signal) => post(ROUTES.login, { wait: true }, signal)) },
						children: busy === 'login' ? t('action.loginBusy') : t('action.login')
					}),
					h(PanelButton, {
						key: 'refresh',
						disabled: busy !== undefined,
						onClick: refreshNow,
						children: t('action.refresh')
					}),
					h(PanelButton, {
						key: 'closeChrome',
						disabled: busy !== undefined || (status !== undefined && !running),
						onClick: () => { void runAction('chrome-close', (signal) => post(ROUTES.chrome, { action: 'close' }, signal)) },
						children: busy === 'chrome-close' ? t('action.closeChromeBusy') : t('action.closeChrome')
					}),
					h(PanelButton, {
						key: 'reveal',
						disabled: busy === 'reveal',
						onClick: () => { void runAction('reveal', (signal) => post(ROUTES.reveal, {}, signal)) },
						children: busy === 'reveal' ? t('action.revealBusy') : t('action.reveal')
					})
				]),

				actionError === undefined ? null : h('div', { key: 'actionError', role: 'alert', style: styles.errorBox }, [
					h('p', { key: 'title', style: styles.errorText }, t('action.failed')),
					h('p', { key: 'doc', style: styles.errorDoc }, actionError)
				]),

				h('section', { key: 'jobs', 'aria-label': t('jobs.title'), style: styles.card }, [
					h('div', { key: 'head', style: styles.cardHead }, [
						h('h3', { key: 'title', style: styles.cardTitle }, t('jobs.title')),
						jobs.length === 0 ? null : h('span', { key: 'count', style: styles.cardNote }, String(jobs.length))
					]),
					jobs.length === 0
						? h('p', { key: 'empty', style: styles.muted }, t('jobs.empty'))
						: h('ul', { key: 'list', 'aria-live': 'polite', style: styles.list },
							jobs.map((job, index) => h(JobRow, { key: job?.id ?? index, job, t })))
				]),

				h('section', { key: 'library', 'aria-label': t('library.title'), style: styles.card }, [
					h('div', { key: 'head', style: styles.cardHead }, [
						h('h3', { key: 'title', style: styles.cardTitle }, t('library.title')),
						library === undefined ? null : h('span', { key: 'total', style: styles.cardNote }, t('library.total', { total: libraryTotal }))
					]),
					libraryError !== undefined
						? h('div', { key: 'error', role: 'alert', style: styles.errorBox }, [
							h('p', { key: 'title', style: styles.errorText }, t('library.error')),
							h('p', { key: 'doc', style: styles.errorDoc }, libraryError)
						])
						: null,
					library === undefined && libraryError === undefined
						? h('p', { key: 'loading', role: 'status', style: styles.muted }, t('library.loading'))
						: null,
					library !== undefined && libraryItems.length === 0
						? h('p', { key: 'empty', style: styles.muted }, t('library.empty'))
						: null,
					libraryItems.length === 0
						? null
						: h('ul', { key: 'list', style: styles.list },
							libraryItems.map((item, index) => h(LibraryRow, { key: `${item?.type ?? 'item'}:${item?.id ?? index}`, item, t })))
				])
			])
		}

		/** Required Client services: slot registration and translated copy. */
		const inject = ['slots', 'locale']

		/**
		 * Client plugin body: register copy, then the Settings section.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS)
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xhs-check: dictionaries')
			ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: SECTION_ID,
				order: 23,
				locale: NS,
				label: () => t('panel.title')
			}, XhsCheckSection)), 'xhs-check: settings section')
		}

		return { inject, apply }
	}
})
