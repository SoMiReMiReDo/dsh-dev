/**
 * Browser half of dsh-side-chat v0.2.
 *
 * Registers the right-Sidebar tab type that shows an in-memory side
 * conversation, plus the conversation-header action that creates one. The body
 * uses a plugin-owned transcript and composer with a registry-scoped transport.
 * Ordinary Session history APIs reject the deliberately cwd-less child.
 *
 * Differences from v0.1.x:
 * - No inherited history: the child session starts empty, so the transcript
 *   only shows this side conversation's own turns. Main-conversation context is
 *   injected by the Host as hidden sourced context rows.
 * - Closing the tab ends the side conversation (the Host disposes its Agent).
 *   A page reload keeps it: the restored tab re-attaches while the Host lives.
 * - Restored tabs whose side conversation no longer exists close themselves.
 * - Live side conversations are hidden from the workspace session list.
 */

window.__ModuleLoader__.load({
	id: 'dsh-side-chat',
	factory(require) {
		const React = require('react')
		const h = React.createElement
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

		/** Locale namespace for this plugin's visible copy. */
		const NS = 'sidechat'

		/** Implementation identity of the tab type and its body. */
		const ID = 'dsh-side-chat'

		/** Resource protocol owned by this plugin. */
		const PROTOCOL = 'sidechat'

		/** Address prefix for one side conversation. */
		const ADDRESS_PREFIX = 'dsh-resource://sidechat/session/'

		/** Resource pattern matched by the tab type (kept broad for restored tabs). */
		const PROTOCOL_PATTERN = 'dsh-resource://sidechat/'

		/** Route that creates or reuses a side conversation on the Host. */
		const OPEN_ROUTE = '/api/sidechat.open'

		/** Route that disposes a side conversation on the Host. */
		const CLOSE_ROUTE = '/api/sidechat.close'

		/** Route that lists the side conversations alive right now. */
		const LIST_ROUTE = '/api/sidechat.list'

		/** Whether this document is being unloaded; survives as module state. */
		let unloading = false
		if (typeof window !== 'undefined') {
			window.addEventListener('pagehide', () => {
				unloading = true
			})
			window.addEventListener('pageshow', () => {
				unloading = false
			})
		}

		const zh = {
			'meta.title': '侧边聊天',
			'meta.description': '在主会话旁开一个只读的临时侧聊，上下文实时读取主会话，关闭即结束。',
			'button.label': '侧聊',
			'button.aria': '打开侧边聊天',
			'button.errorNoTurn': '主会话还没有激活，先在主会话里发一条消息',
			'button.error': '侧聊创建失败',
			'tab.title': '侧聊',
			'tab.titleOf': '侧聊 · {title}',
			'banner.label': '侧边对话 · 只读 · 实时读取主会话',
			'banner.hint': '关闭此标签页即结束侧聊',
			'banner.finish': '结束侧聊',
			'state.opening': '正在创建侧聊…',
			'state.missing': '侧聊会话不可用',
			'chat.you': '你',
			'chat.assistant': '侧聊',
			'chat.connecting': '正在连接侧聊…',
			'chat.context': '已连接主会话',
			'chat.contextDetails': '{count} 条上下文记录 · 提问时读取最新内容',
			'chat.empty': '可以直接询问主会话中的内容，不必等待主会话结束。',
			'chat.running': '正在回复…',
			'chat.placeholder': '询问主会话中的内容…',
			'chat.send': '发送',
			'chat.stop': '停止',
			'chat.readonly': '只读',
			'chat.copy': '复制',
			'chat.copied': '已复制',
			'chat.code': '代码',
			'chat.wrap': '自动换行',
			'chat.unwrap': '取消换行',
			'chat.footnotes': '脚注'
		}

		const en = {
			'meta.title': 'Side chat',
			'meta.description': 'Open a temporary read-only side conversation next to the main chat; context is read live and closing it ends it.',
			'button.label': 'Side chat',
			'button.aria': 'Open a side chat',
			'button.errorNoTurn': 'The main conversation is not active yet; send one message in it first',
			'button.error': 'Could not start the side chat',
			'tab.title': 'Side chat',
			'tab.titleOf': 'Side · {title}',
			'banner.label': 'Side conversation · read-only · live main context',
			'banner.hint': 'Closing this tab ends the side chat',
			'banner.finish': 'End side chat',
			'state.opening': 'Starting the side chat…',
			'state.missing': 'The side chat session is unavailable',
			'chat.you': 'You',
			'chat.assistant': 'Side chat',
			'chat.connecting': 'Connecting…',
			'chat.context': 'Main chat connected',
			'chat.contextDetails': '{count} context records · refreshed with each question',
			'chat.empty': 'Ask about the main conversation, even while it is running.',
			'chat.running': 'Replying…',
			'chat.placeholder': 'Ask about the main chat…',
			'chat.send': 'Send',
			'chat.stop': 'Stop',
			'chat.readonly': 'Read-only',
			'chat.copy': 'Copy',
			'chat.copied': 'Copied',
			'chat.code': 'Code',
			'chat.wrap': 'Wrap',
			'chat.unwrap': 'Unwrap',
			'chat.footnotes': 'Footnotes'
		}

		/**
		 * Production identity for the tab type and its body.
		 * @param childId - forked session id.
		 * @param parentId - session the side conversation belongs to.
		 * @returns the canonical resource address.
		 */
		function sideChatAddress(childId, parentId) {
			return `${ADDRESS_PREFIX}${encodeURIComponent(childId)}?parent=${encodeURIComponent(parentId)}`
		}

		/**
		 * Parse one canonical side-conversation address.
		 * @param value - possible resource address.
		 * @returns the child and parent ids, or undefined for another or malformed address.
		 */
		function parseSideChatAddress(value) {
			let url
			try {
				url = new URL(value)
			} catch {
				return undefined
			}
			if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== PROTOCOL) return undefined
			const parts = url.pathname.split('/').filter(Boolean)
			if (parts.length !== 2 || parts[0] !== 'session') return undefined
			const parentId = url.searchParams.get('parent')
			if (parentId === null || parentId === '') return undefined
			try {
				return { childId: decodeURIComponent(parts[1]), parentId }
			} catch {
				return undefined
			}
		}

		/**
		 * POST one JSON request to the Host plugin routes.
		 * @param path - route path.
		 * @param body - JSON-serializable body.
		 * @returns the parsed response payload.
		 */
		async function post(path, body, signal) {
			const response = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal
			})
			const payload = await response.json().catch(() => undefined)
			if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
			return payload
		}

		/**
		 * Process-local index of live side conversations. Feeds the header-action
		 * visibility, row hiding in the workspace session list, and restored-tab
		 * validation.
		 * @returns the index with its DOM row-hiding style element.
		 */
		function createSideChatIndex() {
			/** Live child session ids. */
			const ids = new Set()
			/** Subscribers for header-action re-renders. */
			const listeners = new Set()
			/** Injected stylesheet hiding live side-conversation rows. */
			const style = typeof document === 'undefined' ? undefined : document.createElement('style')
			if (style !== undefined) {
				style.setAttribute('data-dsh-side-chat', '')
				document.head.appendChild(style)
			}

			/** Re-render the row-hiding stylesheet and notify subscribers. */
			function publish() {
				if (style !== undefined) {
					style.textContent = [...ids]
						.map((id) => `[data-row-key="session:${id}"]{display:none !important}`)
						.join('\n')
				}
				for (const listener of listeners) listener()
			}

			return {
				has(id) {
					return ids.has(id)
				},
				list() {
					return [...ids]
				},
				subscribe(listener) {
					listeners.add(listener)
					return () => {
						listeners.delete(listener)
					}
				},
				replace(next) {
					ids.clear()
					for (const id of next) ids.add(id)
					publish()
				},
				add(id) {
					if (ids.has(id)) return
					ids.add(id)
					publish()
				},
				delete(id) {
					if (!ids.has(id)) return
					ids.delete(id)
					publish()
				},
				dispose() {
					ids.clear()
					listeners.clear()
					style?.remove()
				}
			}
		}

		/**
		 * Hold the side-chat resource for as long as a tab record exists.
		 *
		 * A tab whose side conversation is gone (Host restarted) resolves a stale
		 * value so the tab body can close itself. A tab that is removed while the
		 * document is not unloading disposes the Host Agent: closing the panel ends
		 * the side conversation.
		 *
		 * @param index - live side-conversation index.
		 * @param liveIds - reads the Host's current live ids.
		 * @param onClosed - idempotent Host close + session-list refresh for one child.
		 * @returns the resource provider to register.
		 */
		function sideChatResource(index, liveIds, onClosed) {
			return {
				protocol: PROTOCOL,
				async *open(resourceAddress, { signal }) {
					const parsed = parseSideChatAddress(resourceAddress)
					if (parsed === undefined) throw new Error(`side-chat: invalid resource address "${resourceAddress}"`)
					if (signal.aborted) return
					const live = await liveIds().catch((error) => {
						console.warn('side-chat: live list failed:', error)
						return undefined
					})
					if (signal.aborted) return
					// A failed probe is fail-open: keeping a reachable tab is better
					// than closing a live side conversation on a transient error.
					const known = live === undefined ? true : live.includes(parsed.childId)
					if (!known) {
						yield { ok: true, value: { ...parsed, stale: true } }
						await new Promise((resolve) => {
							if (signal.aborted) resolve()
							else signal.addEventListener('abort', () => resolve(), { once: true })
						})
						return
					}
					index.add(parsed.childId)
					try {
						yield { ok: true, value: { ...parsed, stale: false } }
						await new Promise((resolve) => {
							if (signal.aborted) resolve()
							else signal.addEventListener('abort', () => resolve(), { once: true })
						})
					} finally {
						if (!unloading) {
							// Closing the tab ends the side conversation. Keep the row hidden
							// until the refreshed session list no longer contains it.
							try {
								await onClosed(parsed.childId)
							} finally {
								index.delete(parsed.childId)
							}
						}
					}
				}
			}
		}

		/** Independent chat surface: ordinary Session APIs reject cwd-less agents. */
		function SideChatConversation({ sessionId, t }) {
			const [snapshot, setSnapshot] = React.useState(undefined)
			const [draft, setDraft] = React.useState('')
			const [sending, setSending] = React.useState(false)
			const [error, setError] = React.useState(undefined)
			const [copied, setCopied] = React.useState(undefined)
			const scroll = React.useRef(null)
			const editor = React.useRef(null)
			const sendingRef = React.useRef(false)
			const nearBottom = React.useRef(true)
			React.useEffect(() => {
				const controller = new AbortController()
				let timer
				async function poll() {
					let busy = false
					try {
						const value = await post('/api/sidechat.read', { sessionId }, controller.signal)
						if (controller.signal.aborted) return
						setSnapshot(value)
						setError(value.error)
						busy = value.running
					} catch (error) {
						if (!controller.signal.aborted) setError(error.message)
					} finally {
						if (!controller.signal.aborted) timer = setTimeout(poll, busy ? 350 : 1500)
					}
				}
				void poll()
				return () => { controller.abort(); clearTimeout(timer) }
			}, [sessionId])
			React.useEffect(() => {
				if (scroll.current && nearBottom.current) scroll.current.scrollTop = scroll.current.scrollHeight
			}, [snapshot])
			React.useEffect(() => {
				if (!editor.current) return
				editor.current.style.height = 'auto'
				editor.current.style.height = `${Math.min(336, editor.current.scrollHeight)}px`
			}, [draft])
			async function send() {
				if (sendingRef.current || snapshot?.running || !draft.trim() || snapshot === undefined) return
				sendingRef.current = true
				setSending(true)
				setError(undefined)
				try {
					await post('/api/sidechat.send', { sessionId, text: draft, requestId: crypto.randomUUID() })
					setDraft((current) => current === draft ? '' : current)
					nearBottom.current = true
					setSnapshot(await post('/api/sidechat.read', { sessionId }))
				} catch (error) { setError(error.message) }
				finally { sendingRef.current = false; setSending(false) }
			}
			const busy = sending || snapshot?.running === true
			const messages = snapshot?.messages ?? []
			const markdownLabels = {
				code: { copyLabel: t('chat.copy'), copiedLabel: t('chat.copied'), toolbarLabels: { codeLabel: t('chat.code'), wrapLabel: t('chat.wrap'), unwrapLabel: t('chat.unwrap') } },
				footnotes: t('chat.footnotes')
			}
			const bubble = (message, key, streaming = false) => h('article', {
				key,
				'data-side-chat-message': message.role,
				style: { display: 'flex', flexDirection: 'column', alignItems: message.role === 'user' ? 'flex-end' : 'stretch', margin: '16px 0 24px', minWidth: 0 }
			}, message.role === 'user'
				? h('div', { style: { maxWidth: '82%', boxSizing: 'border-box', padding: '10px 16px', borderRadius: 'var(--dsw-radius-xl, 16px)', background: 'var(--dsw-specific-bubble)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))' } }, message.text)
				: [
					primitives.MarkdownText
						? h(primitives.MarkdownText, { key: 'text', text: message.text, streaming, labels: markdownLabels })
						: h('div', { key: 'text', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65 } }, message.text),
					streaming ? null : h('button', {
						key: 'copy', type: 'button', 'aria-label': t(copied === key ? 'chat.copied' : 'chat.copy'), title: t(copied === key ? 'chat.copied' : 'chat.copy'),
						onClick: () => navigator.clipboard.writeText(message.text).then(() => setCopied(key), (error) => setError(error.message)),
						style: { display: 'flex', alignItems: 'center', alignSelf: 'flex-start', marginTop: 12, padding: 4, border: 0, borderRadius: 'var(--dsw-radius-sm)', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer' }
					}, copied === key ? t('chat.copied') : h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, 'aria-hidden': true }, [
						h('rect', { key: 'back', x: 2, y: 5, width: 9, height: 9, rx: 2 }),
						h('path', { key: 'front', d: 'M5 5V4a2 2 0 012-2h5a2 2 0 012 2v5a2 2 0 01-2 2h-1' })
					]))
				])
			const disabled = !busy && (snapshot === undefined || !draft.trim())
			return h('div', {
				'data-side-chat-conversation': '',
				style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', fontSize: 'var(--dsh-content-font-size, 14px)' }
			}, [
				h('div', { key: 'context', role: 'status', title: snapshot === undefined ? undefined : t('chat.contextDetails', { count: snapshot.contextMessages }), style: { padding: '12px 24px 4px', fontSize: 'var(--dsh-content-font-size-secondary, 12px)', color: 'var(--dsw-alias-label-tertiary)' } }, snapshot === undefined ? t('chat.connecting') : t('chat.context')),
				h('div', { key: 'messages', ref: scroll, 'aria-live': 'polite', style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 24px 12px' }, onScroll: () => {
					const el = scroll.current
					if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
				} }, [
					messages.length === 0 ? h('p', { key: 'empty', style: { margin: '24px 0', color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: 1.7 } }, t('chat.empty')) : null,
					...messages.map((message, index) => bubble(message, message.id ?? index)),
					snapshot?.stream?.text ? bubble({ role: 'assistant', text: snapshot.stream.text }, 'stream', true) : null,
					busy ? h('div', { key: 'busy', role: 'status', style: { padding: '8px 0', color: 'var(--dsw-alias-label-deep-diving)', fontSize: 'var(--dsh-content-font-size-secondary, 13px)' } }, t('chat.running')) : null
				]),
				error ? h('div', { key: 'error', role: 'alert', style: { padding: '8px 24px', color: 'var(--dsw-alias-state-danger-primary, #ef7777)', overflowWrap: 'anywhere' } }, error) : null,
				h('form', { key: 'composer', 'data-side-chat-composer': '', onSubmit: (event) => { event.preventDefault(); void send() }, style: { flex: 'none', margin: '8px 8px 12px', borderRadius: 'var(--dsw-radius-panel, 20px)', background: 'var(--dsw-specific-input-major)', boxShadow: 'var(--dsw-elevation-soft)', paddingTop: 8 } }, [
					h('textarea', { key: 'input', ref: editor, 'aria-label': t('chat.placeholder'), placeholder: t('chat.placeholder'), value: draft, maxLength: 16000, rows: 2,
						onChange: (event) => setDraft(event.target.value), onKeyDown: (event) => {
							if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() }
						}, style: { display: 'block', boxSizing: 'border-box', width: '100%', resize: 'none', minHeight: 52, maxHeight: 336, padding: '6px 14px', border: 0, outline: 'none', background: 'transparent', color: 'inherit', font: 'inherit', lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))' } }),
					h('div', { key: 'actions', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 8px 6px 14px' } }, [
						h('span', { key: 'mode', style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } }, t('chat.readonly')),
						h('button', {
							key: 'primary', type: busy ? 'button' : 'submit', 'aria-label': t(busy ? 'chat.stop' : 'chat.send'), title: t(busy ? 'chat.stop' : 'chat.send'), disabled,
							onClick: busy ? () => { post('/api/sidechat.cancel', { sessionId }).catch((error) => setError(error.message)) } : undefined,
							style: { width: 34, height: 34, flex: 'none', display: 'grid', placeItems: 'center', border: 0, borderRadius: 999, padding: 0, cursor: disabled ? 'default' : 'pointer', background: 'var(--dsw-alias-button-info-fill)', color: '#fff', opacity: disabled ? 0.4 : 1, transform: 'translateY(-2px)' }
						}, h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true }, busy
							? h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 3, fill: 'currentColor' })
							: h('path', { d: 'M8 2v12M3 7l5-5 5 5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' })))
					])
				])
			])
		}

		/** Slim strip above the embedded conversation: identity and end. */
		function SideChatBanner({ t, onFinish }) {
			const [finishing, setFinishing] = React.useState(false)
			return h('div', {
				'data-side-chat-banner': '',
				title: t('banner.hint'),
				style: {
					flex: 'none',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: 8,
					padding: '6px 8px',
					borderBottom: '1px solid var(--dsw-alias-border-l1)',
					background: 'var(--dsw-alias-bg-l1)'
				}
			}, [
				h('span', {
					key: 'label',
					style: {
						minWidth: 0,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
						fontSize: 12,
						lineHeight: '18px',
						color: 'var(--dsw-alias-label-tertiary)'
					}
				}, t('banner.label')),
				h('div', { key: 'actions', style: { display: 'flex', gap: 4, flex: 'none' } }, [
					h(primitives.Button, {
						key: 'finish',
						size: 'sm',
						variant: 'outline',
						disabled: finishing,
						onClick: () => {
							setFinishing(true)
							Promise.resolve(onFinish()).catch((error) => {
								console.warn('side-chat: finish failed:', error)
								setFinishing(false)
							})
						},
						children: t('banner.finish')
					})
				])
			])
		}

		/**
		 * Right-Sidebar tab body: bind the side conversation, then render banner + conversation.
		 * @param props - slot kit props plus the injected close and finish actions.
		 */
		function SideChatTab({ useResource, useTabInfo, t, closeTab, finish }) {
			const { tab } = useTabInfo()
			const resource = useResource(tab.contentId)
			const value = resource.value
			const stale = value?.stale === true
			React.useEffect(() => {
				if (!stale) return
				// The Host no longer knows this side conversation (process restart):
				// drop the restored tab instead of showing a dead session.
				closeTab(tab.id)
			}, [stale, tab.id, closeTab])
			return h('div', {
				'data-side-chat': '',
				style: { width: '100%', minWidth: 0, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }
			}, [
				h(SideChatBanner, {
					key: 'banner',
					t,
					onFinish: () => finish(tab.id, value === undefined ? undefined : value.childId)
				}),
				h('div', {
					key: 'body',
					style: { flex: 1, minHeight: 0, display: 'flex', minWidth: 0 }
				}, value === undefined
					? h('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, stale ? t('state.missing') : t('state.opening'))
					: stale
						? h('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('state.missing'))
						: h(SideChatConversation, { key: value.childId, sessionId: value.childId, t }))
			])
		}

		/**
		 * Conversation-header action that creates the side chat for the current session.
		 * Hidden while the current session is itself a side conversation.
		 * @param props - the bound session id, the translator, the open action, and the live index.
		 */
		function SideChatButton({ sessionId, t, open, index }) {
			const [phase, setPhase] = React.useState('idle')
			const [failure, setFailure] = React.useState(undefined)
			const [isSideChat, setSideChat] = React.useState(() => index.has(sessionId))
			React.useEffect(() => index.subscribe(() => setSideChat(index.has(sessionId))), [index, sessionId])
			if (isSideChat) return null
			const label = failure === undefined ? t('button.label') : `${t('button.error')}：${failure}`
			return h(primitives.Tooltip, {
				label,
				side: 'bottom',
				delayMs: 400,
				children: h(primitives.Button, {
					size: 'sm',
					'aria-label': t('button.aria'),
					'data-side-chat-open': '',
					disabled: phase === 'opening',
					onClick: () => {
						if (phase === 'opening') return
						setPhase('opening')
						setFailure(undefined)
						Promise.resolve(open(sessionId)).then(() => {
							setPhase('idle')
						}, (error) => {
							setPhase('idle')
							setFailure(error instanceof Error ? error.message : String(error))
							console.warn('side-chat: open failed:', error)
						})
					},
					children: h(primitives.IconBranchOutlineRegular, { style: { width: 16, height: 16 } })
				})
			})
		}

		/** Required Client services. */
		const inject = ['slots', 'locale', 'sessions', 'resources', 'sidebarRight', 'sidebarRightTabs']

		/**
		 * Client plugin body: register copy, the resource owner, the tab type and
		 * body, and the conversation-header action.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS)
			const sessions = ctx.sessions
			const index = createSideChatIndex()
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-chat: dictionaries')
			ctx.effect(() => () => index.dispose(), 'side-chat: live index')

			/**
			 * Read the side conversations alive on the Host.
			 * @returns their child session ids.
			 */
			async function liveIds() {
				const payload = await post(LIST_ROUTE, {})
				return (Array.isArray(payload?.items) ? payload.items : [])
					.map((item) => item?.sessionId)
					.filter((id) => typeof id === 'string')
			}

			/**
			 * Refresh the process-local live index from the Host.
			 */
			async function refreshLive() {
				try {
					const ids = await liveIds()
					index.replace(ids)
				} catch (error) {
					console.warn('side-chat: live list refresh failed:', error)
				}
			}

			/**
			 * Create or reuse the side conversation of the addressed session and show it.
			 * @param sessionId - the main conversation's session id.
			 */
			async function openSideChat(sessionId) {
				const payload = await post(OPEN_ROUTE, { sessionId })
				const childId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
				if (childId === undefined) throw new Error('the Host returned no side conversation id')
				const parentId = typeof payload?.parentSessionId === 'string' ? payload.parentSessionId : sessionId
				index.add(childId)
				// The Host created the child outside this Client's own create/fork path,
				// so pull the catalog row that gives the tab its title.
				Promise.resolve(ctx.sessions.refresh()).catch((error) => {
					console.warn('side-chat: session list refresh failed:', error)
				})
				ctx.sidebarRight.openResource(sideChatAddress(childId, parentId), { preferNewPane: true })
			}

			/**
			 * Dispose one side conversation on the Host and refresh the catalog so its
			 * live row disappears. Idempotent: unknown children are acknowledged.
			 * @param sessionId - side-conversation session id.
			 */
			async function closeOnHost(sessionId) {
				try {
					await post(CLOSE_ROUTE, { sessionId })
				} catch (error) {
					console.warn('side-chat: close failed:', error)
				}
				index.delete(sessionId)
				await Promise.resolve().then(() => sessions.refresh()).catch((error) => {
					console.warn('side-chat: session list refresh failed:', error)
				})
			}

			/**
			 * End one side conversation: dispose it on the Host, then drop its tab.
			 * @param tabId - Right-Sidebar tab occurrence to close.
			 * @param sessionId - side-conversation session id, when the body resolved it.
			 */
			async function finishSideChat(tabId, sessionId) {
				try {
					if (sessionId !== undefined) await closeOnHost(sessionId)
				} finally {
					ctx.sidebarRight.close(tabId)
				}
			}

			ctx.effect(() => ctx.resources.register(sideChatResource(index, liveIds, closeOnHost)), 'side-chat: resource owner')

			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: ID,
				kind: PROTOCOL,
				patterns: [`${PROTOCOL_PATTERN}**`],
				priority: 'extension',
				canOpen: (address) => parseSideChatAddress(address) !== undefined,
				title: (address) => {
					const parsed = parseSideChatAddress(address)
					if (parsed === undefined) return t('tab.title')
					const parent = ctx.sessions.list.getSnapshot().byId[parsed.parentId]
					const title = typeof parent?.title === 'string' ? parent.title.trim() : ''
					return title === '' ? t('tab.title') : t('tab.titleOf', { title })
				}
			}), 'side-chat: tab type')

			ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
				name: 'sidebar.right.pane.tab',
				key: ID,
				locale: NS,
				inject: () => ({ closeTab: (tabId) => ctx.sidebarRight.close(tabId), finish: finishSideChat })
			}, SideChatTab)), 'side-chat: tab body')

			ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
				name: 'conversation.session.header.actions',
				id: 'side-chat',
				order: 60,
				locale: NS,
				inject: () => ({ open: openSideChat, index })
			}, SideChatButton)), 'side-chat: header action')

			// Restored tabs need the current live set to validate themselves.
			void refreshLive()
		}

		return { inject, apply }
	}
})
