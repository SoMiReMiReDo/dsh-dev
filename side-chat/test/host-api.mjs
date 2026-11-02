/**
 * Manual host-API probe for dsh-side-chat (development aid, not a unit test).
 *
 * Discovers the desktop app's current GUI port cookie from the Electron cookie
 * store, then drives the real Host routes end to end:
 *
 *   POST /api/sidechat.list   -> expected empty or existing rows
 *   POST /api/sidechat.open   -> creates a child (or reuses one)
 *   POST /api/sidechat.open   -> second call must report reused:true
 *   POST /api/sidechat.list   -> child present
 *   POST /api/sidechat.close  -> disposed:true
 *   POST /api/sidechat.list   -> child gone
 *
 * Usage (parentSessionId must be a LIVE main conversation):
 *
 *   node side-chat/test/host-api.mjs <gui-port> <parentSessionId>
 *
 * The GUI port is printed in the DSH runtime context ("http://127.0.0.1:<port>").
 * The cookie rotates on every app restart; this script re-discovers it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const port = process.argv[2]
const parentSessionId = process.argv[3]
if (port === undefined || parentSessionId === undefined) {
	console.error('usage: node side-chat/test/host-api.mjs <gui-port> <live-parent-session-id>')
	process.exit(2)
}

const COOKIE_DB = join(homedir(), 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop', 'Cookies')
if (!existsSync(COOKIE_DB)) {
	console.error(`cookie store not found at ${COOKIE_DB} (is this the macOS desktop app build?)`)
	process.exit(2)
}

/**
 * Find the dsh-auth cookie whose signed payload names this GUI authority.
 * @returns the `name=value` cookie pair.
 */
function findCookie() {
	const rows = execFileSync('sqlite3', ['-separator', '\t', COOKIE_DB, "select name, value from cookies where host_key='127.0.0.1'"], { encoding: 'utf8' })
	for (const row of rows.split('\n')) {
		const [name, value] = row.split('\t')
		if (name === undefined || value === undefined || !name.startsWith('dsh-auth-')) continue
		const payload = value.split('.')[1]
		if (payload === undefined) continue
		try {
			const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
			if (decoded.authority === `127.0.0.1:${port}`) return `${name}=${value}`
		} catch {
			// Not a signed token row; keep looking.
		}
	}
	throw new Error(`no dsh-auth cookie for 127.0.0.1:${port}; reopen the GUI URL printed by the Host`)
}

const cookie = findCookie()
const base = `http://127.0.0.1:${port}`

/**
 * POST one JSON body to a Host route.
 * @param path - route path.
 * @param body - JSON body.
 * @returns the parsed JSON payload.
 */
async function post(path, body) {
	const response = await fetch(`${base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify(body)
	})
	const payload = await response.json().catch(() => undefined)
	if (!response.ok) throw new Error(`${path} -> HTTP ${response.status} ${JSON.stringify(payload)}`)
	return payload
}

/** Run one async step with a labelled log line. */
async function step(label, operation) {
	const value = await operation()
	console.log(`${label}: ${JSON.stringify(value)}`)
	return value
}

const before = await step('list before', () => post('/api/sidechat.list', {}))
const opened = await step('open #1', () => post('/api/sidechat.open', { sessionId: parentSessionId }))
const reused = await step('open #2 (expect reused:true)', () => post('/api/sidechat.open', { sessionId: parentSessionId }))
const during = await step('list during', () => post('/api/sidechat.list', {}))
const closed = await step('close', () => post('/api/sidechat.close', { sessionId: opened.sessionId }))
const after = await step('list after', () => post('/api/sidechat.list', {}))

const ok = opened.sessionId !== undefined
	&& reused.reused === true
	&& reused.sessionId === opened.sessionId
	&& during.items.some((item) => item.sessionId === opened.sessionId)
	&& closed.disposed === true
	&& after.items.every((item) => item.sessionId !== opened.sessionId)
console.log(ok ? 'HOST API OK' : 'HOST API FAILED')
process.exit(ok ? 0 : 1)
