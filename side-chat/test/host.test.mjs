/**
 * Host-half tests for dsh-side-chat v0.2.
 *
 * The real DSH Host is not importable from this workspace (the app ships a
 * packaged asar), so these tests drive `index.js` through a fake Cordis ctx
 * that models the exact service surface the plugin consumes. They pin the
 * plugin's own contract: no fork seed, no header cwd, process-local lifecycle,
 * scoped boundary, read-only sandbox, tool denial, live-context injection.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../index.js'

const PARENT_ID = 'session-parent'

/**
 * Build one fake model-visible message.
 * @param role - message role.
 * @param text - message text.
 * @param extra - extra content blocks.
 * @returns the message object.
 */
function message(role, text, extra = []) {
	return { id: `msg-${role}-${Math.random().toString(36).slice(2)}`, role, content: [{ type: 'text', text }, ...extra], source: { kind: role === 'assistant' ? 'model' : 'user' } }
}

/**
 * Build the fake Host environment for one test.
 * @param options - parent messages, parent title, and projection facts.
 * @returns a harness exposing the ctx and helpers to call routes/listeners.
 */
function harness(options = {}) {
	const parentMessages = options.messages ?? [
		{ id: 'msg-system', role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }], source: { kind: 'system-prompt' } },
		{ id: 'msg-context', role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }], source: { kind: 'runtime-context' } },
		message('user', '帮我重构侧聊插件'),
		message('assistant', '好的，先看现有实现。')
	]
	const parent = {
		id: PARENT_ID,
		header: { version: 4, id: PARENT_ID, createdAt: 0, cwd: '/tmp/project', isSeeded: false },
		messages: parentMessages,
		surface: { contentGeneration: 1 },
		projections: {
			modelSelection: { lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }, pending: null },
			agentPreset: 'standard'
		},
		parentEvents: [
			{ type: 'approval/policy', data: { policy: 'ask' } },
			{ type: 'permission/preset', data: { preset: 'workspace-write' } }
		],
		deriveMessages() {
			return this.messages
		},
		snapshotEvents() {
			return this.parentEvents
		},
		requestHeader() {
			return undefined
		}
	}

	const state = {
		parent,
		agents: new Map([[PARENT_ID, { id: PARENT_ID, session: parent }]]),
		sessions: new Map([[PARENT_ID, parent]]),
		routes: new Map(),
		events: new Map(),
		disposers: [],
		created: undefined,
		childSessions: new Map(),
		disposed: [],
		sections: [],
		restrictions: [],
		preSteps: [],
		appended: new Map(),
		archived: [],
		legacyListed: options.legacyListed ?? [],
		legacyInspected: new Map(options.legacyInspected ?? [])
	}

	const services = {
		workspaceRegistry: {
			archivedSessionIds: [],
			async archiveSession(id) {
				state.archived.push(id)
			}
		},
		sessionController: {
			async rename() {
				return { title: '侧聊 · 主会话', seq: 1 }
			},
			async list() {
				return { items: state.legacyListed }
			},
			async inspect(id) {
				const found = state.legacyInspected.get(id)
				if (found === undefined) throw new Error(`unknown session ${id}`)
				return found
			}
		},
		sessionTitle: {
			get(session) {
				return { title: session.id === PARENT_ID ? (options.parentTitle ?? '主会话') : '' }
			}
		},
		workingDirectory: {
			get() {
				return '/tmp/project'
			}
		},
		agentDefaultModel: {
			currentSelection() {
				return { provider: 'deepseek-account', model: 'deepseek-flash' }
			}
		},
		agentPresets: {
			async resolve(id) {
				return { id }
			},
			async mount() {}
		}
	}

	const ctx = {
		effect(fn) {
			const disposer = fn()
			state.disposers.push(disposer)
			return disposer
		},
		on(event, callback) {
			state.events.set(event, callback)
			return () => state.events.delete(event)
		},
		inject(_names, callback) {
			callback(ctx)
		},
		get(service) {
			return services[service]
		},
		connection: {
			fetch: {
				register(spec) {
					state.routes.set(spec.path, spec.fetch)
					return () => state.routes.delete(spec.path)
				}
			}
		},
		agents: {
			get(id) {
				return state.agents.get(id)
			},
			async create(createOptions) {
				const child = {
					id: createOptions.sessionId,
					messages: [],
					deriveMessages() { return this.messages },
					header: { version: 4, id: createOptions.sessionId, createdAt: 0, isSeeded: false },
					events: [],
					append(type, data) {
						const list = state.appended.get(createOptions.sessionId) ?? []
						list.push({ type, data })
						state.appended.set(createOptions.sessionId, list)
						child.events.push({ type, data })
					},
					snapshotEvents() {
						return child.events
					}
				}
				let finishTurn
				const agent = {
					id: createOptions.sessionId, session: child, status: 'idle',
					followup(message) {
						child.messages.push(message)
						this.status = 'running'
					},
					whenIdle() { return new Promise((resolve) => { finishTurn = resolve }) },
					cancel() { this.status = 'idle'; finishTurn?.() }
				}
				const agentListeners = new Map()
				const agentCtx = {
					systemPrompt: {
						section(definition) {
							state.sections.push(definition)
							return () => {}
						}
					},
					tools: {
						schemas() {
							return [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'bash' }, { name: 'send_message' }, { name: 'glob' }]
						},
						restrict(filter) {
							state.restrictions.push(filter)
							return () => {}
						}
					},
					get(service) {
						return service === 'tools' ? this.tools : undefined
					},
					on(event, callback) {
						agentListeners.set(event, callback)
						return () => agentListeners.delete(event)
					}
				}
				state.childSessions.set(createOptions.sessionId, child)
				state.agents.set(createOptions.sessionId, agent)
				state.sessions.set(createOptions.sessionId, child)
				await createOptions.setup(agentCtx, agent)
				state.created = { options: createOptions, child, agent, agentListeners }
				return {
					agent,
					async dispose() {
						state.disposed.push(createOptions.sessionId)
						state.agents.delete(createOptions.sessionId)
						state.sessions.delete(createOptions.sessionId)
					}
				}
			}
		},
		sessions: {
			get(id) {
				return state.sessions.get(id)
			}
		},
		sessionProjections: {
			stateOf(session, key) {
				return session.projections?.[key]
			}
		}
	}

	/**
	 * Call one registered route with a JSON body.
	 * @param path - registered route path.
	 * @param body - JSON-serializable request body.
	 * @returns the parsed response and status.
	 */
	async function call(path, body) {
		const handler = state.routes.get(path)
		assert.ok(handler, `route ${path} is registered`)
		const response = await handler({
			async text() {
				return JSON.stringify(body)
			}
		})
		return { status: response.status, body: await response.json() }
	}

	apply(ctx)

	return { ctx, state, call, parent }
}

test('plugin exposes the expected identity and services', () => {
	assert.equal(name, 'side-chat')
	assert.deepEqual(inject, ['connection', 'agents', 'sessions', 'sessionProjections'])
})

test('open creates a fresh child Agent with no fork seed and no header cwd', async () => {
	const h = harness()
	const { status, body } = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	assert.equal(status, 200)
	assert.equal(body.parentSessionId, PARENT_ID)
	assert.match(body.sessionId, /^session-/)

	const created = h.state.created
	assert.ok(created, 'agents.create was called')
	assert.equal(created.options.meta.parentSession, PARENT_ID)
	assert.equal(created.options.meta.isSeeded, false)
	assert.equal(created.options.meta.cwd, undefined)
	assert.equal(created.options.meta.agentPreset, 'standard')
	assert.equal(created.options.seed, undefined)
	assert.deepEqual(created.options.agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' })

	const appended = h.state.appended.get(body.sessionId) ?? []
	const byType = (type) => appended.filter((event) => event.type === type)
	assert.equal(byType('working-directory/change').length, 1)
	assert.deepEqual(byType('working-directory/change')[0].data, { cwd: '/tmp/project' })
	assert.equal(byType('sandbox/mode').length, 1)
	assert.deepEqual(byType('sandbox/mode')[0].data, { mode: 'read-only' })
	assert.equal(byType('approval/policy').length, 1)
	assert.equal(byType('permission/preset').length, 1)
	// No inherited conversation: the child log starts empty apart from policy facts.
	assert.ok(appended.every((event) => !['user/message', 'assistant/message', 'tool/result'].includes(event.type)))
})

test('open registers the boundary, tool restriction, and context injector', async () => {
	const h = harness()
	await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const section = h.state.sections.find((entry) => entry.name === 'side-chat:bounds')
	assert.ok(section, 'boundary section registered')
	assert.equal(section.order, 9500)
	assert.equal(section.interpolate, false)
	assert.match(section.text, /Side conversation boundary/)
	assert.doesNotMatch(section.text, /fork/)
	assert.equal(h.state.restrictions.length, 1)
	assert.deepEqual(h.state.restrictions[0].deny, ['write', 'edit', 'send_message'])
	const preStep = h.state.created.agentListeners.get('agent/pre-step')
	assert.equal(typeof preStep, 'function', 'live context injector registered')
})

test('second open reuses the live child', async () => {
	const h = harness()
	const first = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const second = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	assert.equal(second.status, 200)
	assert.equal(second.body.sessionId, first.body.sessionId)
	assert.equal(second.body.reused, true)
})

test('concurrent opens create exactly one child', async () => {
	const h = harness()
	const [a, b] = await Promise.all([
		h.call('/api/sidechat.open', { sessionId: PARENT_ID }),
		h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	])
	assert.equal(a.body.sessionId, b.body.sessionId)
	assert.ok(a.body.reused === true || b.body.reused === true, 'one response reports reuse')
})

test('open rejects an inactive parent, a missing body, and nesting', async () => {
	const h = harness()
	h.state.agents.delete(PARENT_ID)
	const inactive = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	assert.equal(inactive.status, 409)
	assert.equal(inactive.body.error.code, 'sidechat/parent-not-active')

	const bad = await h.call('/api/sidechat.open', {})
	assert.equal(bad.status, 400)
	assert.equal(bad.body.error.code, 'sidechat/bad-request')

	const active = harness()
	const child = await active.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const nested = await active.call('/api/sidechat.open', { sessionId: child.body.sessionId })
	assert.equal(nested.status, 400)
	assert.equal(nested.body.error.code, 'sidechat/nested')
})

test('list reports live children and close disposes exactly once', async () => {
	const h = harness()
	const opened = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const listed = await h.call('/api/sidechat.list', {})
	assert.deepEqual(listed.body.items, [{ sessionId: opened.body.sessionId, parentSessionId: PARENT_ID }])

	const closed = await h.call('/api/sidechat.close', { sessionId: opened.body.sessionId })
	assert.equal(closed.status, 200)
	assert.equal(closed.body.disposed, true)
	assert.deepEqual(h.state.disposed, [opened.body.sessionId])

	const listedAfter = await h.call('/api/sidechat.list', {})
	assert.deepEqual(listedAfter.body.items, [])

	const again = await h.call('/api/sidechat.close', { sessionId: opened.body.sessionId })
	assert.equal(again.body.disposed, false)
})

test('reopen after close creates a new child id', async () => {
	const h = harness()
	const first = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	await h.call('/api/sidechat.close', { sessionId: first.body.sessionId })
	const second = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	assert.notEqual(second.body.sessionId, first.body.sessionId)
	assert.equal(second.body.reused, undefined)
})

test('parent disposal disposes its side conversation', async () => {
	const h = harness()
	const opened = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const listener = h.state.events.get('agent/disposed')
	assert.equal(typeof listener, 'function')
	listener({ agent: { id: PARENT_ID } })
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(h.state.disposed, [opened.body.sessionId])
})

test('pre-step injects the main conversation snapshot once, then only deltas', async () => {
	const h = harness()
	await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const preStep = h.state.created.agentListeners.get('agent/pre-step')

	const userMessage = message('user', '侧聊，帮我解释一下现在的实现')
	const first = await preStep({ signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [userMessage] }))
	assert.equal(first.messages.length, 2)
	const injected = first.messages[0]
	assert.equal(injected.role, 'user')
	assert.equal(injected.source.kind, 'side-chat-context')
	assert.equal(injected.source.form, 'snapshot')
	const text = injected.content[0].text
	assert.match(text, /Live main-conversation snapshot/)
	assert.match(text, /帮我重构侧聊插件/)
	assert.match(text, /好的，先看现有实现/)
	assert.doesNotMatch(text, /You are an AI agent powered by DeepSeek Harness/)
	assert.doesNotMatch(text, /Current runtime context/)
	assert.equal(first.messages[1], userMessage)

	// No parent change: no second injection.
	const second = await preStep({ signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [message('user', '继续')] }))
	assert.equal(second.messages.length, 1)

	// One parent message appears: a delta-only injection (append changes no generation).
	h.parent.messages.push(message('assistant', '我改好了'))
	const third = await preStep({ signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [message('user', '现在呢')] }))
	assert.equal(third.messages.length, 2)
	const delta = third.messages[0].content[0].text
	assert.match(delta, /Live main-conversation update: 1 new message/)
	assert.match(delta, /我改好了/)
	assert.doesNotMatch(delta, /帮我重构侧聊插件/)
})

test('compaction/rewrite resyncs the live context instead of injecting a broken delta', async () => {
	const h = harness()
	await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const preStep = h.state.created.agentListeners.get('agent/pre-step')
	await preStep({ signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [message('user', '第一问')] }))

	h.parent.messages = [message('assistant', '压缩后的摘要')]
	h.parent.surface.contentGeneration += 1
	const resync = await preStep({ signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [message('user', '第二问')] }))
	assert.equal(resync.messages.length, 2)
	const text = resync.messages[0].content[0].text
	assert.match(text, /refreshed/)
	assert.match(text, /压缩后的摘要/)
	assert.doesNotMatch(text, /帮我重构侧聊插件/)
})

test('a rejected step is never injected into', async () => {
	const h = harness()
	await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const preStep = h.state.created.agentListeners.get('agent/pre-step')
	const decision = await preStep({ signal: { aborted: false } }, async () => ({ kind: 'reject' }))
	assert.deepEqual(decision, { kind: 'reject' })
})

test('disposing the plugin disposes every live child', async () => {
	const h = harness()
	const opened = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const cleanup = h.state.disposers.find((disposer) => typeof disposer === 'function' && disposer.length === 0 && disposer.toString().includes('Promise.allSettled'))
	if (cleanup === undefined) {
		// The cleanup effect is the first registered effect; invoke the whole disposer chain.
		for (const disposer of h.state.disposers) if (typeof disposer === 'function') await disposer()
	} else {
		await cleanup()
	}
	assert.deepEqual(h.state.disposed, [opened.body.sessionId])
})

test('legacy cleanup archives only seeded side-marked forks', async () => {
	const legacyFork = 'session-legacy-fork'
	const userFork = 'session-user-fork'
	const h = harness({
		legacyListed: [
			{ sessionId: legacyFork, parentSessionId: PARENT_ID },
			{ sessionId: userFork, parentSessionId: PARENT_ID }
		],
		legacyInspected: new Map([
			[legacyFork, { meta: { id: legacyFork, isSeeded: true }, inheritedEventCount: 5, events: [{ type: 'session/title', data: { title: '侧聊 · 旧侧聊' } }] }],
			[userFork, { meta: { id: userFork, isSeeded: true }, inheritedEventCount: 5, events: [{ type: 'session/title', data: { title: '主会话 (fork)' } }] }]
		])
	})
	await new Promise((resolve) => setImmediate(resolve))
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(h.state.archived, [legacyFork])
})

test('chat transport only accepts registered live children and hides injected context', async () => {
	const h = harness()
	assert.equal((await h.call('/api/sidechat.read', { sessionId: PARENT_ID })).status, 404)
	const { body: opened } = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const sessionId = opened.sessionId
	const child = h.state.created.child
	child.messages.push(message('user', 'my question'), message('assistant', 'my answer'), {
		...message('user', 'hidden main transcript'), source: { kind: 'side-chat-context' }
	}, { ...message('system', 'hidden system') })
	const read = await h.call('/api/sidechat.read', { sessionId })
	assert.deepEqual(read.body.messages.map((m) => m.text), ['my question', 'my answer'])
	assert.equal(read.body.contextMessages, 2)
	await h.call('/api/sidechat.close', { sessionId })
	for (const method of ['read', 'send', 'cancel']) assert.equal((await h.call(`/api/sidechat.${method}`, { sessionId })).status, 404)
})

test('send deduplicates requests, rejects concurrent turns, and cancel releases the turn', async () => {
	const h = harness()
	const { body: { sessionId } } = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	assert.equal((await h.call('/api/sidechat.send', { sessionId, text: ' ', requestId: 'a' })).status, 400)
	assert.equal((await h.call('/api/sidechat.send', { sessionId, text: 'question', requestId: 'a' })).status, 200)
	assert.equal((await h.call('/api/sidechat.send', { sessionId, text: 'question', requestId: 'a' })).body.reused, true)
	assert.equal((await h.call('/api/sidechat.send', { sessionId, text: 'question', requestId: 'b' })).status, 409)
	assert.equal(h.state.created.child.messages.length, 1)
	assert.equal((await h.call('/api/sidechat.read', { sessionId })).body.running, true)
	await h.call('/api/sidechat.cancel', { sessionId })
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal((await h.call('/api/sidechat.read', { sessionId })).body.running, false)
})

test('stream snapshots include visible text only and surface model errors', async () => {
	const h = harness()
	const { body: { sessionId } } = await h.call('/api/sidechat.open', { sessionId: PARENT_ID })
	const agent = h.state.created.agent
	const emit = (frame) => h.state.events.get('agent/assistant-stream')({ agent, frame })
	emit({ type: 'start', attemptId: 'attempt-1' })
	emit({ type: 'chunk', attemptId: 'attempt-1', chunk: { type: 'reasoning-delta', index: 0, text: 'private reasoning' } })
	emit({ type: 'chunk', attemptId: 'attempt-1', chunk: { type: 'text-delta', index: 1, text: 'hello' } })
	emit({ type: 'chunk', attemptId: 'attempt-1', chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'hello world' } } })
	assert.equal((await h.call('/api/sidechat.read', { sessionId })).body.stream.text, 'hello world')
	emit({ type: 'end', attemptId: 'attempt-1' })
	assert.equal((await h.call('/api/sidechat.read', { sessionId })).body.stream, undefined)
	h.state.events.get('agent/error')({ agent, error: new Error('provider unavailable') })
	assert.equal((await h.call('/api/sidechat.read', { sessionId })).body.error, 'provider unavailable')
})
