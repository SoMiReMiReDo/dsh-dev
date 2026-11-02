/**
 * Browser half of dsh-side-chat.
 *
 * Registers the right-Sidebar tab type that shows a side conversation, plus
 * the conversation header action that opens one. The conversation body itself
 * is the product's own `conversation.content` factory, so the side panel gets
 * the same transcript, composer, streaming, and queue behaviour as the main
 * chat; only the address and the parent binding differ.
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

		/** Session-scoped child slot the tab body binds before rendering the conversation. */
		const CONVERSATION_SLOT = 'sidebar.sidechat.conversation'

		/** Route that forks a side conversation on the Host. */
		const OPEN_ROUTE = '/api/sidechat.open'

		/** Route that archives a side conversation on the Host. */
		const CLOSE_ROUTE = '/api/sidechat.close'

		const zh = {
			'meta.title': '侧边聊天',
			'meta.description': '把当前会话 fork 到右侧栏里单独聊，不打断主对话。',
			'button.label': '侧聊',
			'button.aria': '打开侧边聊天',
			'button.errorNoTurn': '主对话还没有完整轮次，先发一条消息再开侧聊',
			'button.error': '侧聊创建失败',
			'tab.title': '侧聊',
			'tab.titleOf': '侧聊 · {title}',
			'banner.label': '侧边对话 · 独立于主对话',
			'banner.back': '收起',
			'banner.finish': '结束侧聊',
			'state.opening': '正在创建侧聊…',
			'state.missing': '侧聊会话不可用'
		}

		const en = {
			'meta.title': 'Side chat',
			'meta.description': 'Fork the current session into the right sidebar without interrupting the main chat.',
			'button.label': 'Side chat',
			'button.aria': 'Open a side chat',
			'button.errorNoTurn': 'The main conversation has no completed turn yet; send one message first',
			'button.error': 'Could not start the side chat',
			'tab.title': 'Side chat',
			'tab.titleOf': 'Side · {title}',
			'banner.label': 'Side conversation · independent of the main chat',
			'banner.back': 'Collapse',
			'banner.finish': 'End side chat',
			'state.opening': 'Starting the side chat…',
			'state.missing': 'The side chat session is unavailable'
		}

		/**
		 * Render one side conversation address.
		 * @param childId - Forked session id.
		 * @param parentId - Session the side conversation was forked from.
		 * @returns the canonical resource address.
		 */
		function sideChatAddress(childId, parentId) {
			return `${ADDRESS_PREFIX}${encodeURIComponent(childId)}?parent=${encodeURIComponent(parentId)}`
		}

		/**
		 * Parse one canonical side-conversation address.
		 * @param value - Possible resource address.
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
		 * Hold one side conversation's Session reference for as long as a tab shows it.
		 * @param sessions - Client Session service.
		 * @returns the resource provider to register.
		 */
		function sideChatResource(sessions) {
			return {
				protocol: PROTOCOL,
				async *open(resourceAddress, { signal }) {
					const parsed = parseSideChatAddress(resourceAddress)
					if (parsed === undefined) throw new Error(`side-chat: invalid resource address "${resourceAddress}"`)
					if (signal.aborted) return
					const reference = sessions.retain(parsed.childId, { source: 'sideChat', signal })
					try {
						yield { ok: true, value: { ...parsed, reference } }
						await new Promise((resolve) => {
							if (signal.aborted) resolve()
							else signal.addEventListener('abort', () => resolve(), { once: true })
						})
					} finally {
						reference.release()
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
		 * Mirrors the shipped subagent sidebar chat so phase selection stays consistent.
		 */
		function SideChatConversation({ sessionId, useSession, useSessions, useConversation, renderFactorySlot }) {
			const session = useSession((value) => value)
			const conversation = useConversation((value) => value)
			const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank)
			const shellPhase = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
				? 'active'
				: session.promptAttempted ? 'engaging' : 'blank'
			const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
			const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
			return renderFactorySlot('conversation.content', {
				variant: 'embedded',
				phase: settling ? 'settling' : hero ? 'hero' : 'active',
				hero
			}, { slots: { views: FixedChatView } })
		}

		/** Slim strip above the embedded conversation: identity, collapse, and end. */
		function SideChatBanner({ t, onBack, onFinish }) {
			const [finishing, setFinishing] = React.useState(false)
			return h('div', {
				'data-side-chat-banner': '',
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
						key: 'back',
						size: 'sm',
						variant: 'outline',
						onClick: onBack,
						children: t('banner.back')
					}),
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
			return h('div', {
				'data-side-chat': '',
				style: { width: '100%', minWidth: 0, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }
			}, [
				h(SideChatBanner, {
					key: 'banner',
					t,
					onBack: () => closeTab(tab.id),
					onFinish: () => finish(tab.id, value === undefined ? undefined : value.childId)
				}),
				h('div', {
					key: 'body',
					style: { flex: 1, minHeight: 0, display: 'flex', minWidth: 0 }
				}, value === undefined
					? h('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('state.opening'))
					: h(SessionProvider, {
						session: value.reference,
						children: renderSlot(CONVERSATION_SLOT, {})
					}))
			])
		}

		/**
		 * Conversation-header action that opens the side chat for the current session.
		 * @param props - the bound session id, the translator, and the open action.
		 */
		function SideChatButton({ sessionId, t, open }) {
			const [phase, setPhase] = React.useState('idle')
			const [failure, setFailure] = React.useState(undefined)
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
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-chat: dictionaries')

			/**
			 * Fork the addressed session on the Host and show the child in the panel.
			 * @param sessionId - The main conversation's session id.
			 */
			async function openSideChat(sessionId) {
				const response = await fetch(OPEN_ROUTE, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId })
				})
				const payload = await response.json().catch(() => undefined)
				if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
				const childId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
				if (childId === undefined) throw new Error('the Host returned no side conversation id')
				const parentId = typeof payload?.parentSessionId === 'string' ? payload.parentSessionId : sessionId
				// The Host created the child outside this Client's own create/fork path,
				// so pull the catalog row that gives the tab its title and session summary.
				Promise.resolve(ctx.sessions.refresh()).catch((error) => {
					console.warn('side-chat: session list refresh failed:', error)
				})
				ctx.sidebarRight.openResource(sideChatAddress(childId, parentId), { preferNewPane: true })
			}

			/**
			 * End one side conversation: archive it on the Host, then drop its tab.
			 * @param tabId - Right-Sidebar tab occurrence to close.
			 * @param sessionId - Side-conversation session id, when the body resolved it.
			 */
			async function finishSideChat(tabId, sessionId) {
				try {
					if (sessionId !== undefined) {
						await fetch(CLOSE_ROUTE, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ sessionId })
						})
					}
				} finally {
					ctx.sidebarRight.close(tabId)
					Promise.resolve(ctx.sessions.refresh()).catch((error) => {
						console.warn('side-chat: session list refresh failed:', error)
					})
				}
			}

			ctx.effect(() => ctx.resources.register(sideChatResource(ctx.sessions)), 'side-chat: resource owner')

			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: ID,
				kind: PROTOCOL,
				patterns: [`${ADDRESS_PREFIX}**`],
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
				inject: () => ({ open: openSideChat })
			}, SideChatButton)), 'side-chat: header action')
		}

		return { inject, apply }
	}
})
