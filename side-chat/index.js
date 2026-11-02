/**
 * Host half of dsh-side-chat.
 *
 * Owns the side-conversation lifecycle the browser half cannot own:
 *
 * - `POST /api/sidechat.open` forks the addressed session at its last completed
 *   turn (the same `sessionController.fork` the ordinary fork action uses),
 *   renames the child, and remembers that the child is a side conversation.
 * - `POST /api/sidechat.close` ends one: archiving stops its work and hides it
 *   from the workspace session list without deleting the log.
 * - A dynamic system-prompt section tells the side conversation what it is.
 *   The section resolves per assembly and renders to an empty string for every
 *   session that is not a side conversation, so ordinary sessions and the main
 *   chat see no change.
 *
 * The remembered set is process-local: it covers the fork-and-chat flow (and
 * every assembly in between), but a side conversation reopened after a Host
 * restart is an ordinary fork again. Persisting the marker is deliberately out
 * of scope for this version; the fork is still a normal, resumable session.
 */

/** Authenticated POST route that forks one side conversation. */
const OPEN_PATH = '/api/sidechat.open'

/** Authenticated POST route that ends one side conversation. */
const CLOSE_PATH = '/api/sidechat.close'

/** Durable title prefix that identifies a side conversation in the session list. */
const TITLE_PREFIX = '侧聊 · '

/** Locale-independent part of the title prefix, used as the durable marker. */
const TITLE_MARKER = '侧聊'

/**
 * Prompt section placement: after the deliverable file references, before
 * structured output. External contributions may use any finite order.
 */
const SECTION_ORDER = 9500

/** Max accepted request body; both routes carry one session id. */
const MAX_BODY_BYTES = 8 * 1024

/**
 * What the side conversation's model is told. Adapted from the Codex `/side`
 * design: the inherited fork history is reference material, not the current
 * task, and mutations require an explicit request inside the side conversation.
 */
const SIDE_CONVERSATION_INSTRUCTIONS = `Side conversation boundary.

This conversation is a side conversation forked from a main conversation at an earlier point. The conversation history you inherited before the user's first message in this side conversation is reference material only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, or edits that appear in the inherited history. Only messages the user sends in this side conversation are active instructions for it.

Answer the user's question and do lightweight, non-mutating exploration: reading or searching files, and running checks that do not change workspace state. Do not modify files, source, git state, permissions, configuration, or any other workspace state unless the user explicitly requests that mutation in this side conversation. Do not request escalated permissions or broader sandbox access unless the user explicitly requests a mutation that requires it. If the user does request a mutation, keep it minimal, local to that request, and avoid disrupting the main conversation.

Do not present yourself as continuing the main conversation's active task.`

/** A plugin row would need a config schema to accept fields; this version has none. */
export const name = 'side-chat'

/** Services this plugin needs before it activates. */
export const inject = ['connection', 'sessionController', 'systemPrompt', 'agents']

/**
 * Register the two routes and the dynamic prompt section.
 * @param ctx - Host plugin context (connection, sessionController, systemPrompt, agents).
 */
export function apply(ctx) {
	/** Side-conversation id -> parent session id. */
	const sideChats = new Map()

	/** Memoized title-marker verdicts, so the durable fallback folds a log once. */
	const titleVerdicts = new Map()

	ctx.systemPrompt.section({
		name: 'side-chat:bounds',
		order: SECTION_ORDER,
		interpolate: false,
		text: (context) => isSideConversation(ctx, sideChats, titleVerdicts, context?.agent?.session)
			? SIDE_CONVERSATION_INSTRUCTIONS
			: ''
	})

	ctx.effect(() => ctx.connection.fetch.register({
		path: OPEN_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: (request) => openSideChat(ctx, sideChats, request)
	}), 'side-chat: open route')

	ctx.effect(() => ctx.connection.fetch.register({
		path: CLOSE_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: (request) => closeSideChat(ctx, sideChats, titleVerdicts, request)
	}), 'side-chat: close route')
}

/**
 * Fork the addressed session into a side conversation and return the child id.
 *
 * The parent's live Agent may be mid-turn; `sessionController.fork` cuts at the
 * last completed turn, so opening a side conversation never waits for the main
 * task, and the in-flight turn is not inherited.
 *
 * @param ctx - Host plugin context.
 * @param sideChats - Registered side conversations.
 * @param request - The buffered POST request.
 * @returns one JSON response describing the child.
 */
async function openSideChat(ctx, sideChats, request) {
	const body = await readBody(request)
	const sessionId = sessionIdOf(body)
	if (sessionId === undefined) return failure(400, 'sidechat/bad-request', 'body must be a JSON object with a non-empty "sessionId"')

	// One live side conversation per parent: a second click focuses the first.
	// A remembered child whose Agent is gone (archived, interrupted, disposed)
	// is dropped so this click forks a fresh one.
	for (const [childId, parentId] of sideChats) {
		if (parentId !== sessionId) continue
		if (ctx.agents.get(childId) !== undefined) return Response.json({ sessionId: childId, parentSessionId: parentId, reused: true })
		sideChats.delete(childId)
	}

	let childId
	try {
		const forked = await ctx.sessionController.fork({ sessionId })
		childId = forked.sessionId
	} catch (error) {
		return failure(...forkFailure(error))
	}

	sideChats.set(childId, sessionId)

	const base = parentTitle(ctx, sessionId)
	const title = base === '' ? TITLE_PREFIX.trim() : `${TITLE_PREFIX}${base}`
	try {
		await ctx.sessionController.rename({ sessionId: childId, title })
	} catch (error) {
		// A missing title service must not fail the side conversation.
		console.warn(`side-chat: could not rename "${childId}": ${String(error)}`)
	}

	return Response.json({ sessionId: childId, parentSessionId: sessionId })
}

/**
 * End the addressed side conversation: archive it (which stops its work) so the
 * workspace session list no longer shows it. The log stays readable through the
 * workspace archive controls.
 *
 * @param ctx - Host plugin context.
 * @param sideChats - Registered side conversations.
 * @param verdicts - Memoized title-marker verdicts.
 * @param request - The buffered POST request.
 * @returns one JSON acknowledgement.
 */
async function closeSideChat(ctx, sideChats, verdicts, request) {
	const body = await readBody(request)
	const sessionId = sessionIdOf(body)
	if (sessionId === undefined) return failure(400, 'sidechat/bad-request', 'body must be a JSON object with a non-empty "sessionId"')

	sideChats.delete(sessionId)
	verdicts.delete(sessionId)

	const workspaces = ctx.get('workspaces')
	if (workspaces === undefined) return Response.json({ ok: true, archived: false })

	try {
		await workspaces.archiveSession(sessionId, { stopActivity: true })
		return Response.json({ ok: true, archived: true })
	} catch (error) {
		console.warn(`side-chat: could not archive "${sessionId}": ${String(error)}`)
		return Response.json({ ok: true, archived: false })
	}
}

/**
 * Map a fork rejection onto an HTTP status and stable code.
 * @param error - Whatever the controller threw.
 * @returns the status, code, and message to answer with.
 */
function forkFailure(error) {
	const code = typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : undefined
	const message = error instanceof Error ? error.message : String(error)
	if (code === 'session/fork-unavailable') return [409, 'sidechat/no-completed-turn', 'the session has no completed turn to fork from yet; send one message in the main chat first']
	if (code === 'session/not-found') return [404, 'sidechat/session-not-found', message]
	if (code === 'session/migration-required') return [409, 'sidechat/migration-required', message]
	return [500, 'sidechat/fork-failed', message]
}

/**
 * Whether one session is a side conversation.
 *
 * The process-local registration answers while it exists; after a Host restart
 * the durable title marker answers instead, so a reopened side conversation
 * keeps its boundary instructions. Only seeded (forked) sessions are asked:
 * every side conversation is a fork, and ordinary sessions never pay for the
 * title fold. The verdict is memoized per session id.
 *
 * @param ctx - Host plugin context.
 * @param sideChats - Registered side conversations.
 * @param verdicts - Memoized title-marker verdicts.
 * @param session - The session whose prompt is being assembled, when known.
 * @returns whether the side-conversation section belongs in this assembly.
 */
function isSideConversation(ctx, sideChats, verdicts, session) {
	if (session === undefined) return false
	if (sideChats.has(session.id)) return true
	const known = verdicts.get(session.id)
	if (known !== undefined) return known
	let verdict = false
	if (session.header?.isSeeded === true) verdict = sessionTitle(ctx, session).startsWith(TITLE_MARKER)
	verdicts.set(session.id, verdict)
	return verdict
}

/**
 * Read the latest durable title of one live session.
 * @param ctx - Host plugin context.
 * @param session - The live session.
 * @returns its title text, or an empty string when unavailable.
 */
function sessionTitle(ctx, session) {
	const titles = ctx.get('sessionTitle')
	if (titles === undefined) return ''
	try {
		const snapshot = titles.get(session)
		if (typeof snapshot === 'string') return snapshot
		return typeof snapshot?.title === 'string' ? snapshot.title : ''
	} catch {
		return ''
	}
}

/**
 * Read the parent session's durable title for the fork's display name.
 * @param ctx - Host plugin context.
 * @param sessionId - The parent session.
 * @returns its title, or an empty string when the parent is not live.
 */
function parentTitle(ctx, sessionId) {
	const agent = ctx.agents.get(sessionId)
	return agent === undefined ? '' : sessionTitle(ctx, agent.session)
}

/**
 * Read a bounded JSON body.
 * @param request - The buffered POST request.
 * @returns the parsed value, or undefined for a missing, oversized, or malformed body.
 */
async function readBody(request) {
	const text = await request.text()
	if (text.length > MAX_BODY_BYTES) return undefined
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/**
 * Pick the session id out of a parsed body.
 * @param body - Parsed request body.
 * @returns the non-empty session id, or undefined.
 */
function sessionIdOf(body) {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
	const sessionId = body.sessionId
	return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId : undefined
}

/**
 * Build one failure response.
 * @param status - HTTP status code.
 * @param code - Stable machine-readable failure code.
 * @param message - Human-readable explanation.
 * @returns the response to answer with.
 */
function failure(status, code, message) {
	return Response.json({ error: { code, message } }, { status })
}
