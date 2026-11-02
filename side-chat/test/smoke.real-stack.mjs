/**
 * Real-stack smoke test for dsh-side-chat (manual, not part of `node --test`).
 *
 * Runs inside the installed DeepSeek Harness runtime (Electron-as-Node) so the
 * packaged `@deepseek-ai/*` packages can be imported from `app.asar`. It
 * composes only the services the plugin touches, stubs the LLM transport, and
 * verifies against the real Host stack:
 *
 *   agents.create(meta.parentSession, isSeeded:false, no cwd)
 *   -> pre-step live-context injection into a real turn
 *   -> scoped boundary section assembly
 *   -> close/dispose
 *   -> persisted cold child header stays cwd-less (invisible to session list)
 *
 * Usage (macOS app install):
 *
 *   ELECTRON_RUN_AS_NODE=1 \
 *     "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --expose-internals side-chat/test/smoke.real-stack.mjs
 *
 * Override the app bundle with DSH_APP="/path/to/DeepSeek Harness.app".
 */

import { pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app'
const ASAR = `${APP}/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai`
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', 'index.js')
const ROOT = join(process.env.TMPDIR ?? '/tmp', 'dsh-side-chat-smoke')

const load = (name) => import(pathToFileURL(`${ASAR}/${name}/lib/index.js`).href)
const log = (...args) => console.log('[side-chat smoke]', ...args)

/**
 * Abort the smoke run with a non-zero exit code.
 * @param message - failure description.
 */
function fail(message) {
	console.error('[side-chat smoke] FAIL:', message)
	process.exit(1)
}

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'sessions'), { recursive: true })
mkdirSync(join(ROOT, 'workspace'), { recursive: true })

const { Context } = await load('cordis')
const SessionPack = await load('dsh-session')
const ProjectionPack = await load('dsh-session-projection')
const PersistencePack = await load('dsh-session-persistence-jsonl')
const AgentPack = await load('dsh-agent')
const LoopPack = await load('dsh-agent-loop')
const SystemPromptPack = await load('dsh-system-prompt')
const ToolsPack = await load('dsh-tools')

const root = new Context()
const routes = new Map()

// Stubbed model transport: creation and the side turn must not need a provider.
root.provide('llm', {
	async prepareCall(config) {
		return {
			config,
			async *stream() {
				yield { type: 'text-delta', index: 0, text: 'test assistant reply' }
			}
		}
	}
})
// Stubbed authenticated fetch channel: the plugin's routes register into it.
root.provide('connection', {
	fetch: {
		register(spec) {
			routes.set(spec.path, spec.fetch)
			return () => routes.delete(spec.path)
		}
	}
})

const pluginOf = (pack) => (typeof pack.default === 'function' ? pack.default : pack)
for (const [label, pack, config] of [
	['system-prompt', SystemPromptPack, {}],
	['tools', ToolsPack, {}],
	['session-projection', ProjectionPack, {}],
	['session', SessionPack, {}],
	['session-persistence-jsonl', PersistencePack, { root: join(ROOT, 'sessions') }],
	['agent', AgentPack, {}],
	['agent-loop', LoopPack, {}]
]) {
	try {
		await root.plugin(pluginOf(pack), config)
	} catch (error) {
		fail(`loading ${label}: ${error?.stack ?? error}`)
	}
}

const sideChat = await import(pathToFileURL(PLUGIN).href)
try {
	await root.plugin({ ...sideChat }, {})
} catch (error) {
	fail(`loading side-chat plugin: ${error?.stack ?? error}`)
}
for (const path of ['/api/sidechat.open', '/api/sidechat.close', '/api/sidechat.list']) {
	if (!routes.has(path)) fail(`route ${path} was not registered`)
}

// One ordinary live parent session with a real cwd and one completed turn.
const parent = await root.agents.create({
	sessionId: 'session-parent',
	meta: { cwd: join(ROOT, 'workspace') },
	agentOptions: { provider: 'test-provider', model: 'test-model' },
	setup: async () => {}
})
parent.agent.followup({
	id: crypto.randomUUID(),
	role: 'user',
	content: [{ type: 'text', text: 'main conversation question' }],
	source: { kind: 'user' }
})
await parent.agent.whenIdle()

const opened = await routes.get('/api/sidechat.open')({
	async text() {
		return JSON.stringify({ sessionId: 'session-parent' })
	}
})
const openBody = await opened.json()
if (opened.status !== 200) fail(`open failed: HTTP ${opened.status} ${JSON.stringify(openBody)}`)
const childId = openBody.sessionId
const child = root.agents.get(childId)
if (child === undefined) fail('child agent is not live')

const header = child.session.header
log('child header:', JSON.stringify({ cwd: header.cwd ?? null, parentSession: header.parentSession, isSeeded: header.isSeeded }))
if (header.cwd !== undefined) fail('child header must not carry a cwd')
if (header.isSeeded !== false) fail('child must not be seeded')
if (header.parentSession !== 'session-parent') fail('child must name its parent session')
if (child.session.deriveMessages().length !== 0) fail('fresh child must start with zero model-visible messages')

async function chatRoute(operation, body) {
	const response = await routes.get(`/api/sidechat.${operation}`)({ async text() { return JSON.stringify(body) } })
	const result = await response.json()
	if (response.status !== 200) fail(`${operation} failed: ${JSON.stringify(result)}`)
	return result
}
const initial = await chatRoute('read', { sessionId: childId })
if (initial.messages.length !== 0 || initial.contextMessages < 1) fail('opening must read parent context and expose an empty side transcript')
await chatRoute('send', { sessionId: childId, text: 'side question', requestId: crypto.randomUUID() })
await child.whenIdle()

const visible = await chatRoute('read', { sessionId: childId })
if (!visible.messages.some((message) => message.role === 'user' && message.text === 'side question')) fail('side prompt did not reach the real Agent')
if (!visible.messages.some((message) => message.role === 'assistant' && message.text === 'test assistant reply')) fail('side reply is not visible through the plugin transport')
if (visible.messages.some((message) => message.text.includes('Live main-conversation'))) fail('hidden context leaked into the panel')
log('plugin chat transport: prompt, reply, parent-context status OK')

const events = child.session.snapshotEvents()
const injections = events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'side-chat-context')
log('live-context injections:', injections.length)
if (injections.length !== 1) fail(`expected exactly one live-context injection, got ${injections.length}`)
const injected = injections[0].data.content[0].text
if (!injected.includes('Live main-conversation snapshot')) fail('injection lacks the snapshot heading')
if (!injected.includes('main conversation question')) fail('injection is missing the main conversation content')

const childSystem = events
	.filter((event) => event.type === 'system/message')
	.map((event) => event.data.message.content[0]?.text ?? '')
if (!childSystem.some((text) => text.includes('Side conversation boundary.'))) fail('boundary section was not assembled for the child')
const parentSystem = parent.agent.session
	.snapshotEvents()
	.filter((event) => event.type === 'system/message')
	.map((event) => event.data.message.content[0]?.text ?? '')
if (parentSystem.some((text) => text.includes('Side conversation boundary.'))) fail('boundary leaked into the main conversation')

parent.agent.followup({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: 'new parent detail after side chat opened' }], source: { kind: 'user' } })
await parent.agent.whenIdle()
await chatRoute('send', { sessionId: childId, text: 'what changed?', requestId: crypto.randomUUID() })
await child.whenIdle()
const updatedInjections = child.session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'side-chat-context')
if (updatedInjections.length !== 2 || !updatedInjections.at(-1).data.content[0].text.includes('new parent detail after side chat opened')) fail('a later side prompt did not receive the updated parent log')
log('second prompt: latest parent log injected OK')

const closed = await routes.get('/api/sidechat.close')({
	async text() {
		return JSON.stringify({ sessionId: childId })
	}
})
const closeBody = await closed.json()
if (closed.status !== 200 || closeBody.disposed !== true) fail(`close failed: ${JSON.stringify(closeBody)}`)
if (root.agents.get(childId) !== undefined) fail('child agent is still live after close')

const stored = await root.sessionPersistence.list()
const record = stored.find((snapshot) => snapshot.header.id === childId)
if (record === undefined) fail('closed child has no persisted record')
log('stored child header:', JSON.stringify({ cwd: record.header.cwd ?? null, parentSession: record.header.parentSession }))
if (record.header.cwd !== undefined) fail('stored child must not carry a cwd (would reappear in session list)')

log('ALL CHECKS PASSED')
process.exit(0)
