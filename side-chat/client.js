/**
 * Browser half of dsh-side-chat v0.2.
 *
 * Registers the right-Sidebar tab type that shows an in-memory side
 * conversation, plus the conversation-header action that creates one. The body
 * is the product's own `conversation.content` factory, so the panel keeps the
 * native transcript, composer, streaming, and queue behaviour.
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

const PAGE_UNLOAD = Symbol('side-chat: page unload')

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

		/** Session-scoped child slot the tab body binds before rendering the conversation. */
		const CONVERSATION_SLOT = 'sidebar.sidechat.conversation'

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
			'state.missing': '侧聊会话不可用'
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
			'state.missing': 'The side chat session is unavailable'
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
		async function post(path, body) {
			const response = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
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
		 * Hold one side conversation's Session reference for as long as a tab shows it.
		 *
		 * A tab whose side conversation is gone (Host restarted) resolves a stale
		 * value so the tab body can close itself. A tab that is removed while the
		 * document is not unloading disposes the Host Agent: closing the panel ends
		 * the side conversation.
		 *
		 * @param sessions - Client Session service.
		 * @param index - live side-conversation index.
		 * @param liveIds - reads the Host's current live ids.
		 * @param onClosed - idempotent Host close + session-list refresh for one child.
		 * @returns the resource provider to register.
		 */
		function sideChatResource(sessions, index, liveIds, onClosed) {
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
					const reference = sessions.retain(parsed.childId, { source: 'sideChat', signal })
					try {
						yield { ok: true, value: { ...parsed, reference, stale: false } }
						await new Promise((resolve) => {
							if (signal.aborted) resolve()
							else signal.addEventListener('abort', () => resolve(), { once: true })
						})
					} finally {
						reference.release()
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

		/** The embedded conversation's fixed View: Chat, without the main header. */
		function FixedChatView(props) {
			return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
		}

		/**
		 * Render the shared Conversation for the side conversation bound by SessionProvider.
		 *
		 * The side conversation starts blank, so it skips the hero screen: the
		 * banner explains what the panel is and the composer is immediately usable.
		 */
		function SideChatConversation({ sessionId, useSession, useConversation, renderFactorySlot }) {
			const session = useSession((value) => value)
			const conversation = useConversation((value) => value)
			const shellPhase = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
				? 'active'
				: session.promptAttempted ? 'engaging' : 'blank'
			return renderFactorySlot('conversation.content', {
				variant: 'embedded',
				phase: shellPhase === 'blank' && session.openState !== 'open' ? 'settling' : 'active',
				hero: false
			}, { slots: { views: FixedChatView } })
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
		function SideChatTab({ useResource, useTabInfo, SessionProvider, renderSlot, t, closeTab, finish }) {
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
						: h(SessionProvider, {
							session: value.reference,
							children: renderSlot(CONVERSATION_SLOT, {})
						}))
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
				await Promise.resolve(ctx.sessions.refresh()).catch((error) => {
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

			ctx.effect(() => ctx.resources.register(sideChatResource(ctx.sessions, index, liveIds, closeOnHost)), 'side-chat: resource owner')

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
				children: { [CONVERSATION_SLOT]: { kind: 'single', scope: 'session' } },
				inject: () => ({ closeTab: (tabId) => ctx.sidebarRight.close(tabId), finish: finishSideChat })
			}, SideChatTab)), 'side-chat: tab body')

			ctx.effect(() => ctx.slots.inject(CONVERSATION_SLOT, () => ctx.slots.register({
				name: CONVERSATION_SLOT
			}, SideChatConversation)), 'side-chat: conversation body')

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
