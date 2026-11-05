/**
 * Collection orchestration for dsh-xhs-check.
 *
 * The Xiaohongshu web API is signed by the page itself, so instead of
 * reverse-engineering `x-s` we drive a real, logged-in Chrome over CDP, inject
 * the network recorder, and let the site issue its own requests while we
 * navigate, scroll and click. Every `/api/` response is captured, normalized
 * into structured records, and persisted by the store.
 *
 * One page (tab) per collection, closed in `finally`. All waiting is bounded
 * and abortable so a tool call can never hang forever.
 */

import { RECORDER_SOURCE, TAKE_EXPRESSION } from './recorder.mjs'
import { classify, commentsFromPage, mergeRecord, normalizeCapture, noteFromCard } from './normalize.mjs'

/** Site origin. */
export const ORIGIN = 'https://www.xiaohongshu.com'

/** Landing page used for login checks and DM discovery. */
export const HOME_URL = `${ORIGIN}/explore`

/** Default bounded waits. */
const DEFAULT_NOTE_TIMEOUT_MS = 25000

/** Short settle window after a scroll or reply expansion; never the whole budget. */
const DEFAULT_SETTLE_MS = 1500

/** Poll cadence while draining the recorder. */
const POLL_MS = 500

/** Candidate private-message URLs; the first one that renders a conversation list wins. */
const DM_CANDIDATES = [`${ORIGIN}/messages`, `${ORIGIN}/im`, `${ORIGIN}/chat`, `${ORIGIN}/message`]

/** DOM texts that open a conversation tab. */
const DM_NAV_TEXTS = ['私信', '消息', '聊天']

/** Profile tab labels by logical tab name. */
const PROFILE_TAB_TEXTS = {
	notes: ['笔记'],
	fav: ['收藏'],
	liked: ['赞过', '赞']
}

/** Bound on probe snapshots kept per capture when persisting raw traffic. */
const RAW_BODY_PREVIEW = 200000

/**
 * Synthetic API URLs used to route an SSR state slice through the normalizer.
 * The built-in browser may miss the very first response of a page (its recorder
 * starts at `dom-ready`), so the page's own `window.__INITIAL_STATE__` is the
 * fallback source for the first render.
 */
const STATE_CAPTURE_URLS = {
	trending: `${ORIGIN}/api/sns/web/v1/search/notes`,
	notification: `${ORIGIN}/api/sns/web/v1/you/mentions`,
	chat: `${ORIGIN}/api/im/web/v3/chats`
}

/** SSR slices worth reading per collection mode. */
const STATE_SLICE_KEYS = {
	search: ['search', 'feed'],
	notifications: ['notification'],
	chat: ['chatData', 'conversation', 'messageData', 'lastConversation'],
	profile: ['user']
}

/**
 * Wrap one SSR state slice as a synthetic capture so `normalizeCapture` can
 * route it through the same parsers as a real response.
 * @param kind - key of `STATE_CAPTURE_URLS`.
 * @param body - page state slice.
 * @returns capture-shaped object.
 */
function stateCapture(kind, body) {
	return {
		url: STATE_CAPTURE_URLS[kind] ?? ORIGIN,
		method: 'GET',
		status: 200,
		capturedAt: new Date().toISOString(),
		body
	}
}

/**
 * Reject the collection as soon as the caller aborted.
 * @param signal - optional AbortSignal.
 */
function throwIfAborted(signal) {
	if (signal?.aborted) throw new Error('collection aborted')
}

/**
 * Sleep that resolves early on abort.
 * @param ms - milliseconds.
 * @param signal - optional AbortSignal.
 * @returns a promise that settles after the delay or the abort.
 */
function sleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve()
		const timer = setTimeout(() => {
			signal?.removeEventListener?.('abort', onAbort)
			resolve()
		}, ms)
		function onAbort() {
			clearTimeout(timer)
			resolve()
		}
		signal?.addEventListener?.('abort', onAbort, { once: true })
	})
}

/**
 * Convert a JS function source plus one argument into an evaluable expression.
 * @param source - function body source text, e.g. `((texts) => ...)`.
 * @param arg - JSON-serializable argument.
 * @returns the expression string.
 */
function callExpression(source, arg) {
	return `(${source})(${JSON.stringify(arg === undefined ? null : arg)})`
}

/**
 * Class-name selector list shared by DOM heuristics.
 * @param selector - CSS selector.
 * @returns visible elements matching it.
 */
const VISIBLE_QUERY = `((selector) => {
  try {
    return Array.from(document.querySelectorAll(selector)).filter((node) => node.offsetParent !== null);
  } catch (error) { return []; }
})`

/**
 * Open a fresh tab with the recorder installed before the first document.
 * @param browser - CDP browser handle.
 * @param url - optional first URL.
 * @returns the page handle.
 */
async function openPage(browser, url) {
	const page = await browser.newPage()
	try {
		await page.addInitScript(RECORDER_SOURCE)
	} catch (error) {
		// Older Chrome builds may reject the init script; the recorder would then
		// only start after a reload. Surface it to the caller as a warning.
		console.warn(`xhs-check: could not install recorder: ${String(error)}`)
	}
	if (typeof url === 'string' && url !== '') await page.goto(url)
	return page
}

/**
 * Drain the page's recorder buffer.
 * @param page - CDP page handle.
 * @returns captured entries (empty when the recorder is absent).
 */
async function takeCaptures(page) {
	try {
		const text = await page.evaluate(TAKE_EXPRESSION)
		if (typeof text !== 'string' || text === '') return []
		const parsed = JSON.parse(text)
		return Array.isArray(parsed) ? parsed : []
	} catch (error) {
		return []
	}
}

/** Accumulating capture bag with kind-aware queries. */
class CaptureBag {
	/** All captures, in arrival order. */
	entries = []

	/**
	 * Append drained captures.
	 * @param entries - recorded entries.
	 * @returns the number appended.
	 */
	push(entries) {
		for (const entry of entries) {
			if (entry === undefined || entry === null) continue
			if (typeof entry !== 'object') continue
			if (typeof entry.url !== 'string') continue
			this.entries.push(entry)
		}
		return entries.length
	}

	/**
	 * Captures whose URL classifies as one kind.
	 * @param kind - capture kind.
	 * @returns matching entries.
	 */
	ofKind(kind) {
		return this.entries.filter((entry) => classify(entry.url) === kind)
	}

	/**
	 * Normalized records for one kind.
	 * @param kind - capture kind.
	 * @returns flattened records.
	 */
	records(kind) {
		const out = []
		for (const entry of this.ofKind(kind)) {
			try {
				const normalized = normalizeCapture(entry)
				for (const record of normalized.records) out.push(record)
			} catch (error) {
				// Normalization is best-effort per capture.
			}
		}
		return out
	}

	/**
	 * Normalize every capture of any kind and keep the records that match a type.
	 * @param type - record type, e.g. 'note'.
	 * @returns matching records.
	 */
	recordsOfType(type) {
		const out = []
		for (const entry of this.entries) {
			try {
				const normalized = normalizeCapture(entry)
				for (const record of normalized.records) {
					if (record?.type === type) out.push(record)
				}
			} catch (error) {
				// Ignore one malformed capture.
			}
		}
		return out
	}

	/** Distinct `/api/` paths observed, for diagnostics. */
	endpoints() {
		const seen = new Map()
		for (const entry of this.entries) {
			let path = entry.url
			try {
				const url = new URL(entry.url, ORIGIN)
				path = `${url.pathname}${url.search === '' ? '' : '?…'}`
			} catch (error) {
				// Keep the raw URL when it cannot be parsed.
			}
			seen.set(path, (seen.get(path) ?? 0) + 1)
		}
		return [...seen.entries()].map(([path, count]) => ({ path, count }))
	}
}

/**
 * Drain once, wait, and report.
 * @param page - CDP page handle.
 * @param bag - accumulating bag.
 * @param options - { timeoutMs, until, signal, onTick }.
 * @returns whether `until` became true before the timeout.
 */
async function pump(page, bag, { timeoutMs = 5000, until, signal, onTick } = {}) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		throwIfAborted(signal)
		bag.push(await takeCaptures(page))
		onTick?.()
		if (until !== undefined && until(bag)) return true
		await sleep(POLL_MS, signal)
	}
	return until === undefined ? false : until(bag)
}

/**
 * Wait until either a matching feed/search capture arrives or the page's SSR
 * state carries the note detail (Xiaohongshu renders note detail from
 * `window.__INITIAL_STATE__`, without a feed request).
 *
 * @param page - CDP page handle.
 * @param bag - accumulating bag.
 * @param expectedId - requested note id, or ''.
 * @param options - { timeoutMs, signal }.
 * @returns { source: 'capture'|'ssr'|'', ssr? }.
 */
async function waitForNoteSource(page, bag, expectedId, { timeoutMs = DEFAULT_NOTE_TIMEOUT_MS, signal } = {}) {
	const deadline = Date.now() + timeoutMs
	let ssr
	while (Date.now() < deadline) {
		throwIfAborted(signal)
		bag.push(await takeCaptures(page))
		if (bag.recordsOfType('note').some((record) => expectedId === '' || record.id === expectedId)) {
			return { source: 'capture', ssr }
		}
		ssr = await readNotePayload(page, expectedId)
		if (ssr !== undefined && ssr.card !== undefined && (expectedId === '' || ssr.id === expectedId)) return { source: 'ssr', ssr }
		await sleep(POLL_MS, signal)
	}
	ssr = ssr ?? await readNotePayload(page, expectedId)
	return { source: '', ssr }
}

/**
 * Progressive scroll while draining captures.
 * @param page - CDP page handle.
 * @param bag - accumulating bag.
 * @param options - { times, delayMs, distance, until, signal, progress }.
 * @returns number of scroll steps performed.
 */
async function scrollAndDrain(page, bag, { times = 6, delayMs = 1200, distance = 1200, until, signal, progress } = {}) {
	let performed = 0
	for (let index = 0; index < times; index += 1) {
		throwIfAborted(signal)
		if (until !== undefined && until(bag)) break
		try {
			await page.scrollToLoadMore({ times: 1, distance, delayMs })
		} catch (error) {
			break
		}
		performed += 1
		progress?.({ done: performed, total: times })
		await pump(page, bag, { timeoutMs: Math.max(delayMs, 600), signal })
	}
	return performed
}

/**
 * Click the first visible element whose normalized text matches one label.
 * @param page - CDP page handle.
 * @param labels - accepted labels, longest first.
 * @returns the clicked label, or an empty string.
 */
async function clickByText(page, labels) {
	const source = `((labels) => {
    const wanted = labels.map((label) => label.replace(/\\s+/g, ''));
    const nodes = Array.from(document.querySelectorAll('button, a, span, div[role="button"], li'));
    for (const node of nodes) {
      if (node.offsetParent === null) continue;
      const text = (node.textContent || '').replace(/\\s+/g, '').trim();
      if (text === '' || text.length > 24) continue;
      if (wanted.some((label) => text === label || text.startsWith(label))) {
        node.click();
        return text;
      }
    }
    return '';
  })`
	try {
		const clicked = await page.evaluate(callExpression(source, labels))
		return typeof clicked === 'string' ? clicked : ''
	} catch (error) {
		return ''
	}
}

/**
 * Recursively harvest note cards out of any response body. Xiaohongshu reuses
 * the same `note_card` shape across feed, search and profile responses, and
 * some endpoints wrap it differently, so a structural walk is more durable
 * than a per-endpoint parser.
 * @param value - any JSON value.
 * @param out - accumulator of note records.
 * @param limit - max records to collect.
 */
function harvestNoteCards(value, out, limit = 200) {
	if (out.length >= limit) return
	if (Array.isArray(value)) {
		for (const item of value) {
			harvestNoteCards(item, out, limit)
			if (out.length >= limit) return
		}
		return
	}
	if (typeof value !== 'object' || value === null) return
	if ((typeof value.note_card === 'object' && value.note_card !== null) || (typeof value.noteCard === 'object' && value.noteCard !== null)) {
		// Pass the wrapper: it carries the real note id and the xsec_token.
		const record = noteFromCard(value, {})
		if (record !== undefined) out.push(record)
		else harvestNoteCards(value.note_card ?? value.noteCard, out, limit)
		return
	}
	if (typeof value.note_id === 'string' && (typeof value.display_title === 'string' || typeof value.desc === 'string')) {
		const record = noteFromCard(value, {})
		if (record !== undefined) out.push(record)
		return
	}
	for (const key of Object.keys(value)) {
		const child = value[key]
		if (typeof child === 'object' && child !== null) harvestNoteCards(child, out, limit)
		if (out.length >= limit) return
	}
}

/**
 * Collect note ids seen anywhere in the accumulated captures (diagnostics).
 * @param bag - accumulating bag.
 * @returns note ids.
 */
function harvestNoteIds(bag) {
	const ids = []
	for (const entry of bag.entries) {
		const harvested = []
		harvestNoteCards(entry.body, harvested, 40)
		for (const record of harvested) {
			if (typeof record.id === 'string') ids.push(record.id)
		}
	}
	return ids
}

/**
 * Harvest any conversation-like objects from an unknown DM payload.
 * @param value - any JSON value.
 * @param out - accumulator.
 * @param limit - max records.
 */
function harvestConversations(value, out, limit = 100) {
	if (out.length >= limit) return
	if (Array.isArray(value)) {
		for (const item of value) {
			harvestConversations(item, out, limit)
			if (out.length >= limit) return
		}
		return
	}
	if (typeof value !== 'object' || value === null) return
	const peer = value.peer_user ?? value.user_info ?? value.target_user ?? value.user
	const last = value.last_message ?? value.latest_message ?? value.last_msg
	if (peer !== undefined && peer !== null && typeof peer === 'object' && last !== undefined) {
		out.push({ type: 'chat_conversation', raw: value, conversationId: value.conversation_id ?? value.session_id ?? value.chat_id })
		return
	}
	for (const key of Object.keys(value)) {
		const child = value[key]
		if (typeof child === 'object' && child !== null) harvestConversations(child, out, limit)
		if (out.length >= limit) return
	}
}

/**
 * Merge records by id keeping the more complete copy.
 * @param records - possibly duplicated records.
 * @returns unique records.
 */
function dedupe(records) {
	const byId = new Map()
	for (const record of records) {
		if (record === undefined || record === null) continue
		const id = typeof record.id === 'string' && record.id !== '' ? `${record.type}:${record.id}` : undefined
		if (id === undefined) continue
		const existing = byId.get(id)
		byId.set(id, existing === undefined ? record : mergeRecord(existing, record))
	}
	return [...byId.values()]
}

/**
 * Merge sub-comments into their parent comments.
 * @param comments - flattened comment records (parents and replies).
 * @returns parent comments with `subComments` arrays.
 */
function assembleComments(comments) {
	const parents = new Map()
	const replies = []
	for (const comment of comments) {
		if (comment === undefined || comment === null) continue
		if (typeof comment.parentId === 'string' && comment.parentId !== '') {
			replies.push(comment)
			continue
		}
		const existing = parents.get(comment.id)
		parents.set(comment.id, existing === undefined ? comment : mergeRecord(existing, comment))
	}
	for (const reply of replies) {
		const parent = parents.get(reply.parentId)
		if (parent === undefined) continue
		const list = Array.isArray(parent.subComments) ? parent.subComments : []
		const seen = new Set(list.map((item) => item.id))
		if (!seen.has(reply.id)) list.push(reply)
		parent.subComments = list
	}
	return [...parents.values()]
}

/**
 * Flatten assembled comments back into one list with reply nesting preserved.
 * @param parents - parents carrying subComments.
 * @returns { top, sub, all }.
 */
function countComments(parents) {
	let sub = 0
	for (const parent of parents) sub += Array.isArray(parent.subComments) ? parent.subComments.length : 0
	return { top: parents.length, sub, all: parents.length + sub }
}

/**
 * Last-resort search for the built-in browser.
 *
 * The inner-chrome recorder is installed at `dom-ready`, so the response of the
 * very first search request can predate it. Reload the shell (the recorder then
 * installs before the SPA mounts), route to the search URL from inside the SPA
 * (no document reload, so the recorder survives), and let the site issue its
 * own signed request.
 *
 * @param page - page handle.
 * @param bag - accumulating bag.
 * @param url - absolute search URL.
 * @param options - { keyword, signal }.
 * @returns whether search traffic was captured.
 */
async function searchViaSpa(page, bag, url, { keyword = '', signal } = {}) {
	let route = ''
	try {
		const parsed = new URL(url)
		route = `${parsed.pathname}${parsed.search}`
	} catch (error) {
		return false
	}
	const routeSource = `((href) => {
    try {
      history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      return location.pathname + location.search;
    } catch (error) { return ''; }
  })`
	const submitSource = `((keyword) => {
    const input = document.querySelector('#search-input, input[type="search"], input[placeholder*="搜索"]');
    if (input === null) return '';
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (descriptor !== undefined && typeof descriptor.set === 'function') descriptor.set.call(input, keyword);
    else input.value = keyword;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return keyword;
  })`
	try {
		await page.goto(HOME_URL)
	} catch (error) {
		return false
	}
	const captured = () => bag.ofKind('search').length > 0 || bag.ofKind('note').length > 0
	try {
		await page.evaluate(callExpression(routeSource, route))
		await pump(page, bag, { timeoutMs: 12000, until: captured, signal })
		if (captured()) return true
		if (keyword === '') return false
		await page.evaluate(callExpression(submitSource, keyword))
		await pump(page, bag, { timeoutMs: 10000, until: captured, signal })
		return captured()
	} catch (error) {
		return false
	}
}

/**
 * Click one same-page navigation entry by its visible text.
 *
 * Used after reloading the shell (recorder installed) so the target route's own
 * data request is issued while the recorder is listening.
 *
 * @param page - page handle.
 * @param labels - accepted visible labels, e.g. ['我'] or ['消息', '私信'].
 * @returns `{ text, href }` of the clicked entry, or undefined.
 */
async function clickNavByText(page, labels) {
	const source = `((labels) => {
    const norm = (value) => String(value === undefined || value === null ? '' : value).replace(/\\s+/g, '');
    const wanted = labels.map(norm);
    // Only real clickable nodes: a container <li> would swallow a synthetic click
    // without triggering the router.
    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    for (const node of nodes) {
      if (node.offsetParent === null) continue;
      const text = norm(node.textContent);
      if (text === '' || text.length > 12) continue;
      if (!wanted.includes(text)) continue;
      node.click();
      return { text, href: String(node.getAttribute('href') || '') };
    }
    return null;
  })`
	try {
		const clicked = await page.evaluate(callExpression(source, labels))
		return typeof clicked === 'object' && clicked !== null ? clicked : undefined
	} catch (error) {
		return undefined
	}
}

/**
 * Route the running SPA to one in-site path without reloading the document, so
 * the recorder installed on the current document keeps listening.
 * @param page - page handle.
 * @param route - e.g. `/user/profile/<id>`.
 * @returns whether the router was asked to navigate.
 */
async function routeWithinSpa(page, route) {
	if (typeof route !== 'string' || route === '') return false
	const source = `((href) => {
    try {
      history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      return location.pathname + location.search;
    } catch (error) { return ''; }
  })`
	try {
		const value = await page.evaluate(callExpression(source, route))
		return typeof value === 'string' && value !== ''
	} catch (error) {
		return false
	}
}

/**
 * Click "load more comments" style controls a bounded number of times.
 * @param page - CDP page handle.
 * @param bag - accumulating bag.
 * @param options - { rounds, delayMs, signal }.
 * @returns number of controls clicked.
 */
async function expandMoreComments(page, bag, { rounds = 5, delayMs = 1200, signal } = {}) {
	const source = `((maxRounds) => {
    const pattern = /^(加载更多|展开更多评论|查看全部评论|查看更多评论)$/;
    const nodes = Array.from(document.querySelectorAll('button, span, div[role="button"], a'));
    let clicked = 0;
    for (const node of nodes) {
      if (clicked >= maxRounds) break;
      if (node.offsetParent === null) continue;
      const text = (node.textContent || '').trim();
      if (!pattern.test(text)) continue;
      node.click();
      clicked += 1;
    }
    return clicked;
  })`
	let total = 0
	for (let round = 0; round < rounds; round += 1) {
		throwIfAborted(signal)
		let clicked = 0
		try {
			const result = await page.evaluate(callExpression(source, 1))
			clicked = typeof result === 'number' ? result : 0
		} catch (error) {
			break
		}
		if (clicked === 0) break
		total += clicked
		await pump(page, bag, { timeoutMs: delayMs, signal })
	}
	return total
}

/**
 * Best-effort expansion of "展开 N 条回复" controls inside the comment list.
 * @param page - CDP page handle.
 * @param bag - accumulating bag.
 * @param options - { maxExpands, delayMs, signal }.
 * @returns number of controls clicked.
 */
async function expandSubReplies(page, bag, { maxExpands = 10, delayMs = 900, signal } = {}) {
	const source = `((maxExpands) => {
    const pattern = /展开\\s*\\d*\\s*条?回复/;
    const nodes = Array.from(document.querySelectorAll('span, button, div[role="button"], a'));
    let clicked = 0;
    for (const node of nodes) {
      if (clicked >= maxExpands) break;
      if (node.offsetParent === null) continue;
      const text = (node.textContent || '').trim();
      if (text.length > 16) continue;
      if (!pattern.test(text)) continue;
      node.click();
      clicked += 1;
    }
    return clicked;
  })`
	let clicked = 0
	try {
		const result = await page.evaluate(callExpression(source, maxExpands))
		clicked = typeof result === 'number' ? result : 0
	} catch (error) {
		return 0
	}
	if (clicked > 0) await pump(page, bag, { timeoutMs: Math.max(delayMs * clicked, 1500), signal })
	return clicked
}

/**
 * Open the profile's notes route from inside the SPA and record `user_posted`.
 * @param page - page handle.
 * @param bag - accumulating bag.
 * @param options - { userId, self, signal, delayMs }.
 * @returns whether the profile notes response arrived.
 */
async function openProfileNotesViaSpa(page, bag, { userId, self = false, signal, delayMs = 1500 } = {}) {
	try {
		await page.goto(HOME_URL)
	} catch (error) {
		return false
	}
	await pump(page, bag, { timeoutMs: 4000, signal })
	let navigated = false
	if (self) {
		const clicked = await clickNavByText(page, ['我'])
		navigated = clicked !== undefined
	}
	if (!navigated) navigated = await routeWithinSpa(page, `/user/profile/${encodeURIComponent(userId)}`)
	if (!navigated) return false
	const hit = await pump(page, bag, {
		timeoutMs: 12000,
		until: (current) => current.ofKind('user_notes').length > 0,
		signal
	})
	if (hit) return true
	for (let index = 0; index < 3; index += 1) {
		await scrollAndDrain(page, bag, { times: 1, distance: 1000, delayMs, signal })
		if (bag.ofKind('user_notes').length > 0) return true
	}
	return bag.ofKind('user_notes').length > 0
}

/**
 * Open the DM pane from inside the SPA and harvest the conversation list.
 * @param page - page handle.
 * @param bag - accumulating bag.
 * @param options - { signal, delayMs }.
 * @returns conversation records (empty when the pane never rendered data).
 */
async function openChatViaSpa(page, bag, { signal, delayMs = 1500 } = {}) {
	try {
		await page.goto(HOME_URL)
	} catch (error) {
		return []
	}
	await pump(page, bag, { timeoutMs: 4000, signal })
	let navigated = false
	const clicked = await clickNavByText(page, ['消息', '私信'])
	navigated = clicked !== undefined
	if (!navigated) navigated = await routeWithinSpa(page, '/messages')
	if (!navigated) return []
	await pump(page, bag, {
		timeoutMs: 15000,
		until: (current) => current.ofKind('chat_conversations').length > 0,
		signal
	})
	let conversations = harvestConversationsFromBag(bag)
	if (conversations.length === 0) {
		for (let index = 0; index < 3; index += 1) {
			await scrollAndDrain(page, bag, { times: 1, distance: 900, delayMs, signal })
			conversations = harvestConversationsFromBag(bag)
			if (conversations.length > 0) break
		}
	}
	return conversations
}

/**
 * Collect one note with its comments.
 * @param ctx - { browser, store, settings, log, signal }.
 * @param options - { url?, noteId?, maxComments?, maxScrolls?, expandReplies? }.
 * @returns compact summary of what was saved.
 */
export async function collectNote(ctx, options = {}) {
	const { browser, store, settings, signal } = ctx
	const url = typeof options.url === 'string' && options.url !== ''
		? options.url
		: `${ORIGIN}/explore/${options.noteId ?? ''}`
	const maxScrolls = clamp(options.maxScrolls ?? settings.maxScrolls ?? 8, 1, 40)
	const expectedId = typeof options.noteId === 'string' && options.noteId !== ''
		? options.noteId
		: noteIdFromUrl(url)
	const page = await openPage(browser, undefined)
	const bag = new CaptureBag()
	const warnings = []
	try {
		ctx.progress?.({ phase: 'note' })
		await page.goto(url)
		// Note detail comes from SSR state; recommendation feeds may arrive as
		// `/v1/feed` too, so only the requested id counts as a hit.
		const found = await waitForNoteSource(page, bag, expectedId, { timeoutMs: DEFAULT_NOTE_TIMEOUT_MS, signal })
		const ssr = found.ssr
		if (bag.ofKind('note').length === 0 && bag.recordsOfType('note').length === 0 && ssr === undefined) {
			let href = ''
			try {
				href = await page.getLocationHref()
			} catch (error) {
				href = ''
			}
			const downgraded = typeof href === 'string' && href.indexOf('/h5/') !== -1
			warnings.push(downgraded
				? '链接缺少 xsec_token，小红书把页面降级到了 H5 版，拿不到笔记详情；请改用搜索/信息流结果里的带 token 链接'
				: '未捕获到笔记接口响应：可能是页面被风控或未登录')
		}
		const capturedNotes = bag.recordsOfType('note')
		let note = expectedId === ''
			? capturedNotes[0]
			: capturedNotes.find((record) => record.id === expectedId)
		if (note === undefined) {
			const harvested = []
			for (const entry of bag.entries) harvestNoteCards(entry.body, harvested, 20)
			if (expectedId === '') {
				note = harvested[0]
			} else {
				note = harvested.find((record) => record.id === expectedId)
			}
		}
		// Never persist a different note under the requested target: a stale
		// token or a mismatched xsec_source serves the home feed instead, and
		// silently saving that would poison the library.
		let ssrComments = []
		if (note === undefined && ssr !== undefined && ssr.card !== undefined) {
			note = noteFromCard(ssr.card, { kind: 'note', url, collectedAt: new Date().toISOString() })
			ssrComments = commentsFromPage({ data: { comments: ssr.comments?.list ?? [] } }, expectedId)
		}
		if (note !== undefined && expectedId !== '' && note.id !== expectedId) note = undefined
		if (note === undefined && expectedId !== '') {
			warnings.push(`未捕获到目标笔记 ${expectedId} 的详情：订阅 token 可能已失效，或 xsec_source 不匹配；页面里出现的是其它笔记，未落盘`)
		}
		let pageUrl = ''
		try {
			pageUrl = await page.getLocationHref()
		} catch (error) {
			pageUrl = ''
		}
		const seenNoteIds = [...new Set([...capturedNotes.map((record) => record.id), ...harvestNoteIds(bag)])].slice(0, 12)
		ctx.progress?.({ phase: 'comments' })
		await scrollAndDrain(page, bag, {
			times: maxScrolls,
			distance: 900,
			delayMs: settings.requestDelayMs ?? 1500,
			signal,
			until: (current) => current.records('comments').length >= (options.maxComments ?? 50)
		})
		await expandMoreComments(page, bag, { rounds: 5, delayMs: settings.requestDelayMs ?? 1200, signal })
		if (options.expandReplies !== false) await expandSubReplies(page, bag, { maxExpands: 10, signal })
		// One short settle pass: replies opened above may still be loading.
		await pump(page, bag, { timeoutMs: DEFAULT_SETTLE_MS, signal })

		const allComments = dedupe([...ssrComments, ...bag.records('comments'), ...bag.records('subcomments')])
		const scopedComments = expectedId === ''
			? allComments
			: allComments.filter((comment) => typeof comment.noteId !== 'string' || comment.noteId === expectedId)
		const parents = assembleComments(scopedComments.length > 0 ? scopedComments : allComments)
		const commentCounts = countComments(parents)
		let notePath = ''
		let commentsPath = ''
		if (note !== undefined) {
			note.sourceUrl = url
			if (note.stats !== undefined) {
				if (note.stats.comments === undefined) note.stats.comments = commentCounts.all
			}
			notePath = await store.save(note)
			commentsPath = (await store.saveComments(note.id, parents)).path
		}
		return {
			mode: 'note',
			ok: note !== undefined,
			note: note === undefined ? undefined : {
				id: note.id,
				title: note.title,
				author: note.author?.nickname,
				liked: note.stats?.liked,
				comments: note.stats?.comments,
				images: Array.isArray(note.images) ? note.images.length : 0,
				publishedAt: note.publishedAt
			},
			comments: commentCounts,
			paths: { note: notePath, comments: commentsPath },
			pageUrl,
			expectedNoteId: expectedId,
			seenNoteIds,
			endpoints: bag.endpoints(),
			warnings
		}
	} finally {
		await page.close().catch(() => {})
	}
}

/**
 * Search notes by keyword and persist the result set.
 * @param ctx - { browser, store, settings, log, signal }.
 * @param options - { keyword, sort?, limit?, maxScrolls? }.
 * @returns compact summary.
 */
export async function collectSearch(ctx, options = {}) {
	const { browser, store, settings, signal } = ctx
	const keyword = String(options.keyword ?? '').trim()
	if (keyword === '') throw new Error('keyword is required')
	const limit = clamp(options.limit ?? 40, 1, 200)
	const maxScrolls = clamp(options.maxScrolls ?? settings.maxScrolls ?? 10, 1, 40)
	const sortParams = options.sort === 'popular' ? '&sort=popularity_descending' : options.sort === 'latest' ? '&sort=time_descending' : ''
	const url = `${ORIGIN}/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes${sortParams}`
	const page = await openPage(browser, undefined)
	const bag = new CaptureBag()
	const warnings = []
	try {
		await page.goto(url)
		await pump(page, bag, {
			timeoutMs: 20000,
			until: (current) => current.ofKind('search').length > 0 || current.ofKind('note').length > 0,
			signal
		})
		let stall = 0
		let previous = 0
		for (let index = 0; index < maxScrolls; index += 1) {
			const notes = collectSearchNotes(bag)
			if (notes.length >= limit) break
			if (notes.length === previous) stall += 1
			else stall = 0
			previous = notes.length
			if (stall >= 2) break
			await scrollAndDrain(page, bag, { times: 1, distance: 1200, delayMs: settings.requestDelayMs ?? 1500, signal })
		}
		let notes = dedupe(collectSearchNotes(bag)).slice(0, limit)
		if (notes.length === 0) {
			// The built-in browser's recorder starts at dom-ready: the first search
			// response may predate it, but the page still rendered from SSR state.
			const slices = await readInitialStateSlices(page, STATE_SLICE_KEYS.search)
			const harvested = []
			for (const value of Object.values(slices ?? {})) harvestNoteCards(value, harvested, 200)
			let fromState = dedupe(harvested).slice(0, limit)
			if (fromState.length === 0 && settings.backend === 'inner-chrome') {
				// Second resort: reload the shell with the recorder installed, then
				// navigate to the search route from inside the SPA.
				const retried = await searchViaSpa(page, bag, url, { keyword, signal })
				if (retried) fromState = dedupe(collectSearchNotes(bag)).slice(0, limit)
			}
			if (fromState.length > 0) {
				notes = fromState
				warnings.push(bag.ofKind('search').length > 0 || bag.ofKind('note').length > 0
					? '搜索结果来自站内 SPA 二次请求（直接加载时首屏接口早于 recorder）'
					: '搜索结果来自页面 SSR 数据（未捕获到搜索接口响应）：含标题/作者/封面/互动数，不含正文')
			}
		}
		if (notes.length === 0) warnings.push('搜索结果为空：可能触发风控、需要登录，或页面结构已变化')
		const path = await store.saveSearch(keyword, notes, { url, sort: options.sort ?? 'default' })
		return {
			mode: 'search',
			ok: notes.length > 0,
			query: keyword,
			total: notes.length,
			notes: notes.slice(0, 20).map((note) => ({ id: note.id, title: note.title, author: note.author?.nickname, liked: note.stats?.liked })),
			path,
			endpoints: bag.endpoints(),
			warnings
		}
	} finally {
		await page.close().catch(() => {})
	}
}

/**
 * Extract note records from search/feed captures, falling back to a
 * structural harvest when the endpoint payload differs.
 * @param bag - accumulating bag.
 * @returns note records.
 */
function collectSearchNotes(bag) {
	const direct = [...bag.records('search'), ...bag.records('note'), ...bag.records('user_notes')]
	if (direct.length > 0) return direct
	const harvested = []
	for (const entry of bag.entries) harvestNoteCards(entry.body, harvested, 200)
	return harvested
}

/**
 * Collect a profile's note list, favorites or likes.
 * @param ctx - { browser, store, settings, log, signal }.
 * @param options - { userId?, tab?: 'notes'|'fav'|'liked', limit?, maxScrolls? }.
 * @returns compact summary.
 */
export async function collectProfile(ctx, options = {}) {
	const { browser, store, settings, signal } = ctx
	const tab = PROFILE_TAB_TEXTS[options.tab] === undefined ? 'notes' : options.tab
	const limit = clamp(options.limit ?? 40, 1, 200)
	const maxScrolls = clamp(options.maxScrolls ?? settings.maxScrolls ?? 8, 1, 40)
	const page = await openPage(browser, undefined)
	const bag = new CaptureBag()
	const warnings = []
	let userId = typeof options.userId === 'string' ? options.userId.trim() : ''
	let ownUserId = ''
	try {
		await page.goto(HOME_URL)
		await pump(page, bag, { timeoutMs: 8000, signal })
		if (userId === '' || userId === 'me') {
			userId = await resolveOwnUserId(page, bag)
			ownUserId = userId
		}
		if (userId === '') {
			warnings.push('无法确定当前登录用户 id，请直接传 userId 或先确认已登录')
			return { mode: 'profile', ok: false, tab, warnings, endpoints: bag.endpoints() }
		}
		const url = `${ORIGIN}/user/profile/${encodeURIComponent(userId)}`
		await page.goto(url)
		await pump(page, bag, { timeoutMs: 12000, until: (current) => current.ofKind('user_notes').length > 0, signal })
		if (tab !== 'notes') {
			const clicked = await clickByText(page, PROFILE_TAB_TEXTS[tab])
			if (clicked === '') warnings.push(`未找到「${PROFILE_TAB_TEXTS[tab][0]}」标签页入口`)
			await pump(page, bag, { timeoutMs: 6000, signal })
		}
		let previous = 0
		for (let index = 0; index < maxScrolls; index += 1) {
			const notes = dedupe(collectSearchNotes(bag))
			if (notes.length >= limit) break
			await scrollAndDrain(page, bag, { times: 1, distance: 1000, delayMs: settings.requestDelayMs ?? 1500, signal })
			const current = dedupe(collectSearchNotes(bag)).length
			if (current <= previous) break
			previous = current
		}
		let notes = dedupe(collectSearchNotes(bag)).slice(0, limit)
		if (notes.length === 0 && tab === 'notes') {
			// The notes tab is rendered from SSR state, not from an API response.
			const ssr = await readProfileNotes(page, userId)
			if (ssr !== undefined) {
				const cards = []
				for (const card of ssr.notes ?? []) {
					const record = noteFromCard(card, { kind: 'user_notes', url })
					if (record !== undefined) cards.push(record)
				}
				notes = dedupe(cards).slice(0, limit)
				if (notes.length > 0) warnings.push('主页笔记来自页面 SSR 数据：含标题/作者/封面/互动数，不含正文与完整图片列表')
			}
		}
		if (notes.length === 0 && tab === 'notes') {
			// Generic structural sweep of the SSR user store: the concrete
			// `state.user.notes` layout changes between releases, note cards do not.
			const slices = await readInitialStateSlices(page, STATE_SLICE_KEYS.profile)
			const harvested = []
			for (const value of Object.values(slices ?? {})) harvestNoteCards(value, harvested, 80)
			const fromState = dedupe(harvested).slice(0, limit)
			if (fromState.length > 0) {
				notes = fromState
				warnings.push('主页笔记来自页面 SSR 状态（通用扫描）：含标题/作者/封面/互动数，不含正文')
			}
		}
		if (notes.length === 0 && tab === 'notes' && settings.backend === 'inner-chrome') {
			// Last resort: reload the shell (the recorder installs at dom-ready),
			// then open the profile from inside the SPA so `user_posted` is
			// recorded while the recorder is listening.
			const opened = await openProfileNotesViaSpa(page, bag, {
				userId,
				self: userId === ownUserId,
				signal,
				delayMs: settings.requestDelayMs ?? 1500
			})
			if (opened) {
				notes = dedupe(collectSearchNotes(bag)).slice(0, limit)
				if (notes.length > 0) warnings.push('主页笔记来自站内 SPA 二次请求（直接加载时首屏接口早于 recorder）')
			}
		}
		if (notes.length === 0) warnings.push('主页未捕获到笔记列表：可能未登录、用户不存在或页面结构变化')
		const path = await store.saveProfile(userId, tab, notes, { url })
		return {
			mode: 'profile',
			ok: notes.length > 0,
			userId,
			tab,
			total: notes.length,
			notes: notes.slice(0, 20).map((note) => ({ id: note.id, title: note.title, liked: note.stats?.liked })),
			path,
			endpoints: bag.endpoints(),
			warnings
		}
	} finally {
		await page.close().catch(() => {})
	}
}

/**
 * Read the profile note grid out of the page's SSR state.
 *
 * The profile's notes tab is server-rendered from Vue refs; unwrap them in-page
 * and project the fields the normalizer knows.
 *
 * @param page - CDP page handle.
 * @param userId - profile user id.
 * @returns `{ userId, tab, notes }` or undefined.
 */
async function readProfileNotes(page, userId) {
	const expression = `((userId) => {
    const unwrap = (value) => {
      let out = value;
      let guard = 0;
      while (out !== null && typeof out === 'object' && out.__v_isRef === true && guard < 5) { out = out.value; guard += 1 }
      return out;
    };
    const state = window.__INITIAL_STATE__ ?? null;
    const tree = state === null ? null : state.user;
    if (tree === null || typeof tree !== 'object') return '';
    const raw = unwrap(tree.notes);
    if (!Array.isArray(raw)) return '';
    const cards = [];
    for (const chunk of raw) {
      const list = unwrap(chunk);
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (cards.length >= 80) break;
        const item = unwrap(entry);
        if (item === null || typeof item !== 'object') continue;
        const card = unwrap(item.noteCard) ?? unwrap(item.note_card) ?? item;
        if (card === null || typeof card !== 'object') continue;
        const cover = unwrap(card.cover) ?? null;
        const coverUrl = cover === null ? '' : (unwrap(cover.urlDefault) ?? unwrap(cover.url) ?? unwrap(cover.url_default) ?? '');
        cards.push({
          note_id: unwrap(card.noteId) ?? unwrap(card.note_id) ?? unwrap(item.id) ?? '',
          display_title: unwrap(card.displayTitle) ?? unwrap(card.display_title) ?? unwrap(card.title) ?? '',
          desc: unwrap(card.desc) ?? '',
          type: unwrap(card.type) ?? 'normal',
          time: unwrap(card.time) ?? undefined,
          user: unwrap(card.user) ?? undefined,
          interact_info: unwrap(card.interactInfo) ?? unwrap(card.interact_info) ?? undefined,
          image_list: coverUrl ? [{ url_default: coverUrl }] : [],
          xsec_token: unwrap(item.xsecToken) ?? unwrap(item.xsec_token) ?? ''
        });
      }
    }
    const safe = (value) => {
      try { return JSON.stringify(value) } catch (error) {
        const seen = new WeakSet();
        try { return JSON.stringify(value, (key, item) => { if (item !== null && typeof item === 'object') { if (seen.has(item)) return undefined; seen.add(item) } return item }) } catch (error2) { return '' }
      }
    };
    return safe({ userId, tab: unwrap(tree.activeTab) ?? 'notes', notes: cards });
  })(${JSON.stringify(userId)})`
	try {
		const text = await page.evaluate(expression)
		if (typeof text !== 'string' || text === '') return undefined
		const parsed = JSON.parse(text)
		return typeof parsed === 'object' && parsed !== null ? parsed : undefined
	} catch (error) {
		return undefined
	}
}

/**
 * Resolve the logged-in user id from captured payloads or the page itself.
 * @param page - CDP page handle.
 * @param bag - accumulating bag with traffic from the home page.
 * @returns the user id, or an empty string.
 */
async function resolveOwnUserId(page, bag) {
	for (const entry of bag.entries) {
		try {
			const normalized = normalizeCapture(entry)
			for (const record of normalized.records) {
				if (record?.type === 'user' && typeof record.id === 'string') return record.id
			}
		} catch (error) {
			// Ignore one malformed capture.
		}
	}
	const stateId = await readStateUserId(page)
	if (stateId !== '') return stateId
	const source = `(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/user/profile/"]'));
    for (const link of links) {
      const match = String(link.getAttribute('href') || '').match(/\\/user\\/profile\\/([0-9a-zA-Z]+)/);
      if (match) return match[1];
    }
    return '';
  })`
	try {
		const found = await page.evaluate(`(${source})()`)
		return typeof found === 'string' ? found : ''
	} catch (error) {
		return ''
	}
}

/**
 * Collect the notification feed.
 * @param ctx - { browser, store, settings, log, signal }.
 * @param options - { maxScrolls? }.
 * @returns compact summary.
 */
export async function collectNotifications(ctx, options = {}) {
	const { browser, store, settings, signal } = ctx
	const maxScrolls = clamp(options.maxScrolls ?? settings.maxScrolls ?? 6, 1, 30)
	const page = await openPage(browser, undefined)
	const bag = new CaptureBag()
	const warnings = []
	try {
		await page.goto(`${ORIGIN}/notification`)
		await pump(page, bag, { timeoutMs: 12000, signal })
		// Only the first tab is fetched on load; the others need a click.
		for (const label of ['赞和收藏', '新增关注', '评论和@']) {
			if (await clickByText(page, [label]) === '') continue
			await pump(page, bag, { timeoutMs: 4000, signal })
		}
		await scrollAndDrain(page, bag, { times: maxScrolls, distance: 1000, delayMs: settings.requestDelayMs ?? 1500, signal })
		let records = bag.recordsOfType('notification')
		if (records.length === 0) {
			const slices = await readInitialStateSlices(page, STATE_SLICE_KEYS.notifications)
			if (slices?.notification !== undefined) {
				try {
					records = normalizeCapture(stateCapture('notification', slices.notification)).records
				} catch (error) {
					records = []
				}
				if (records.length > 0) warnings.push('通知来自页面 SSR 数据（未捕获到通知接口响应）')
			}
		}
		if (records.length === 0) warnings.push('未捕获到通知接口响应：可能需要登录或页面结构变化')
		const path = await store.saveNotifications(records, { url: `${ORIGIN}/notification` })
		return {
			mode: 'notifications',
			ok: records.length > 0,
			total: records.length,
			items: records.slice(0, 20).map((record) => ({ id: record.id, category: record.category, title: record.title })),
			path,
			endpoints: bag.endpoints(),
			warnings
		}
	} finally {
		await page.close().catch(() => {})
	}
}

/**
 * Collect private-message conversations, and their messages when the DM pane
 * exposes a clickable conversation list.
 *
 * Xiaohongshu's web DM API is undocumented and the DM pane is heavy (it can
 * block the load event for a long time), so this collector combines three
 * sources: the conversation list the explore shell prefetches, a best-effort
 * visit to the DM routes, and structural harvesting of whatever `/api/im/`
 * traffic appears. Conversations are always persisted; messages only when the
 * payloads actually arrive, and the returned endpoint inventory is what
 * `xhs_probe` follow-up adapts.
 *
 * @param ctx - { browser, store, settings, log, signal }.
 * @param options - { limit? }.
 * @returns compact summary with diagnostics.
 */
export async function collectChat(ctx, options = {}) {
	const { browser, store, settings, signal } = ctx
	const limit = clamp(options.limit ?? 10, 1, 50)
	const page = await openPage(browser, undefined)
	const bag = new CaptureBag()
	const warnings = []
	let dmUrl = ''
	try {
		await page.goto(HOME_URL)
		await pump(page, bag, { timeoutMs: 8000, signal })
		// The explore shell already prefetched the conversation list.
		let conversations = harvestConversationsFromBag(bag)
		// Message bodies only come from the DM pane, which is one route that may be
		// unavailable (HTTP 504) or block its load event: try it once, never fail on it.
		const dmCandidate = DM_CANDIDATES[0]
		ctx.progress?.({ phase: 'discover-dm' })
		try {
			await page.goto(dmCandidate, { waitUntil: 'none', timeoutMs: 8000 })
		} catch (error) {
			// A heavy or unavailable DM pane must not fail the collection.
		}
		await sleep(3000, signal)
		await pump(page, bag, { timeoutMs: 3000, signal })
		const found = harvestConversationsFromBag(bag)
		if (found.length > 0) {
			conversations = found
			dmUrl = dmCandidate
		}
		if (conversations.length === 0 && settings.backend === 'inner-chrome') {
			// Reload the shell and open the DM pane from inside the SPA: the
			// conversation-list request then fires while the recorder is listening.
			const opened = await openChatViaSpa(page, bag, { signal, delayMs: settings.requestDelayMs ?? 1500 })
			if (opened.length > 0) {
				conversations = opened
				dmUrl = `${ORIGIN}/messages`
				warnings.push('私信会话来自站内 SPA 二次请求（直接加载时首屏接口早于 recorder）')
			}
		}
		if (conversations.length === 0) {
			const slices = await readInitialStateSlices(page, STATE_SLICE_KEYS.chat)
			const harvested = []
			for (const value of Object.values(slices ?? {})) {
				try {
					const records = normalizeCapture(stateCapture('chat', value)).records
					for (const record of records) {
						if (record?.type === 'chat_conversation') harvested.push(record)
					}
				} catch (error) {
					// One malformed slice must not fail the collection.
				}
			}
			const fromState = dedupe(harvested)
			if (fromState.length > 0) {
				conversations = fromState
				warnings.push('私信会话来自页面 SSR 数据（未捕获到会话接口响应）')
			}
		}
		const domItems = await countConversationItems(page)
		if (domItems === 0 && conversations.length > 0) {
			warnings.push('私信面板不可用或未渲染：会话列表来自首页预取，消息体读不到（可用 xhs_probe 打开 /im 确认接口）')
		}
		ctx.progress?.({ phase: 'reading-chat' })
		const collected = []
		const openable = Math.min(limit, conversations.length, domItems)
		for (let index = 0; index < openable; index += 1) {
			throwIfAborted(signal)
			const visible = await clickConversationItem(page, index)
			if (visible === 0) break
			await pump(page, bag, { timeoutMs: 3500, signal })
			const messages = bag.recordsOfType('chat_message')
			if (messages.length === 0) continue
			const conversationId = conversations[index]?.id
				?? conversations[index]?.conversationId
				?? `conversation-${index + 1}`
			await store.saveChat(String(conversationId), messages, {
				peer: conversations[index]?.peer,
				sourceUrl: dmUrl === '' ? ORIGIN : dmUrl
			})
			collected.push({ conversationId: String(conversationId), messages: messages.length })
		}
		// Persist the conversation inventory even when no message payload arrived.
		for (const conversation of conversations.slice(0, limit)) {
			try {
				await store.save(conversation)
			} catch (error) {
				// One malformed record must not fail the whole collection.
			}
		}
		const totalMessages = bag.recordsOfType('chat_message').length
		if (conversations.length === 0) {
			warnings.push('未捕获到私信会话列表：可先用 xhs_probe 打开 https://www.xiaohongshu.com/im 并点击一个会话，录制真实接口后再适配')
		} else if (collected.length === 0) {
			warnings.push('已保存会话列表，但未能打开会话读取消息（DOM 结构未识别）；用 xhs_probe 观察点击会话后的接口可继续适配')
		}
		return {
			mode: 'chat',
			ok: conversations.length > 0,
			dmUrl,
			conversations: conversations.length,
			collected,
			totalMessages,
			endpoints: bag.endpoints(),
			warnings
		}
	} finally {
		await page.close().catch(() => {})
	}
}

/**
 * Count visible conversation list items in the DM pane.
 * @param page - CDP page handle.
 * @returns number of visible items (0 when the pane is not recognized).
 */
async function countConversationItems(page) {
	const source = `(() => {
    const selectors = ['[class*="conversation-item"]', '[class*="chat-item"]', '[class*="session-item"]', '[class*="contact"] li', '[class*="chat-list"] li', '[class*="conversation"] li'];
    let best = 0;
    for (const selector of selectors) {
      try {
        const count = Array.from(document.querySelectorAll(selector)).filter((node) => node.offsetParent !== null).length;
        if (count > best) best = count;
      } catch (error) {}
    }
    return best;
  })()`
	try {
		const count = await page.evaluate(`(${source})()`)
		return typeof count === 'number' ? count : 0
	} catch (error) {
		return 0
	}
}

/**
 * Find private-message entry links in the current page.
 * @param page - CDP page handle.
 * @returns candidate absolute URLs.
 */
async function discoverDmLinks(page) {
	const source = `((labels) => {
    const out = [];
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const href = String(anchor.getAttribute('href') || '');
      const text = (anchor.textContent || '').trim();
      if (/\\/(messages?|im|chat)/i.test(href) || labels.some((label) => text.includes(label))) {
        try { out.push(new URL(href, location.origin).href) } catch (error) {}
      }
    }
    return out.slice(0, 10);
  })`
	try {
		const found = await page.evaluate(callExpression(source, DM_NAV_TEXTS))
		return Array.isArray(found) ? found.filter((item) => typeof item === 'string') : []
	} catch (error) {
		return []
	}
}

/**
 * Harvest conversation records from the accumulated captures.
 * @param bag - accumulating bag.
 * @returns conversation records.
 */
function harvestConversationsFromBag(bag) {
	const out = []
	for (const entry of bag.entries) {
		try {
			const normalized = normalizeCapture(entry)
			for (const record of normalized.records) {
				if (record?.type === 'chat_conversation') out.push(record)
			}
		} catch (error) {
			// Ignore one malformed capture.
		}
	}
	if (out.length === 0) {
		for (const entry of bag.entries) harvestConversations(entry.body, out, 100)
	}
	return dedupe(out)
}

/**
 * Click one conversation in the DM list.
 * @param page - CDP page handle.
 * @param index - zero-based item index.
 * @returns number of visible items found, 0 when the list is not recognized.
 */
async function clickConversationItem(page, index) {
	const source = `((index) => {
    const selectors = [
      '[class*="conversation-item"]',
      '[class*="session-item"]',
      '[class*="chat-item"]',
      '[class*="contact"] li',
      '[class*="chat-list"] li',
      '[class*="conversation"] li'
    ];
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector)).filter((node) => node.offsetParent !== null);
      if (nodes.length > index) {
        nodes[index].click();
        return nodes.length;
      }
    }
    return 0;
  })`
	try {
		const count = await page.evaluate(callExpression(source, index))
		return typeof count === 'number' ? count : 0
	} catch (error) {
		return 0
	}
}

/**
 * Read one note detail out of the page's SSR state.
 *
 * Xiaohongshu renders a note detail from `window.__INITIAL_STATE__` without a
 * feed request, and that store is full of circular references: serialize a
 * selected, JSON-safe slice in the page instead of the whole state.
 *
 * @param page - CDP page handle.
 * @param expectedId - requested note id, or '' for whichever note is current.
 * @returns `{ id, card, comments }`, or undefined when SSR carries no note.
 */
async function readNotePayload(page, expectedId) {
	const expression = `((expectedId) => {
    const state = window.__INITIAL_STATE__ ?? window.__INITIAL_SSR_STATE__ ?? null;
    if (state === null || typeof state !== 'object') return '';
    const noteTree = state.note;
    if (noteTree === null || typeof noteTree !== 'object') return '';
    const map = noteTree.noteDetailMap;
    if (map === null || typeof map !== 'object') return '';
    const ids = Object.keys(map);
    const chosen = expectedId !== '' && ids.indexOf(expectedId) !== -1
      ? expectedId
      : typeof noteTree.currentNoteId === 'string' && ids.indexOf(noteTree.currentNoteId) !== -1
        ? noteTree.currentNoteId
        : ids[0];
    if (chosen === undefined) return '';
    const detail = map[chosen];
    if (detail === null || typeof detail !== 'object') return '';
    const card = detail.note !== undefined && detail.note !== null ? detail.note : detail;
    const comments = detail.comments !== undefined && detail.comments !== null ? detail.comments : null;
    const payload = {
      id: chosen,
      card: card,
      comments: comments === null ? null : {
        list: Array.isArray(comments.list) ? comments.list : [],
        cursor: comments.cursor ?? '',
        hasMore: comments.hasMore === true
      }
    };
    const safe = (value) => {
      try {
        return JSON.stringify(value);
      } catch (error) {
        const seen = new WeakSet();
        try {
          return JSON.stringify(value, (key, item) => {
            if (item !== null && typeof item === 'object') {
              if (seen.has(item)) return undefined;
              seen.add(item);
            }
            return item;
          });
        } catch (error2) {
          return '';
        }
      }
    };
    return safe(payload);
  })(${JSON.stringify(expectedId)})`
	try {
		const text = await page.evaluate(expression)
		if (typeof text !== 'string' || text === '') return undefined
		const parsed = JSON.parse(text)
		if (typeof parsed !== 'object' || parsed === null) return undefined
		return parsed
	} catch (error) {
		return undefined
	}
}

/**
 * Serialize selected `window.__INITIAL_STATE__` slices out of the page.
 *
 * The store is full of Vue refs and circular references, so unwrap refs and
 * serialize each slice in-page with a cycle guard. Slice texts are returned as
 * JSON strings (a slice may itself be a JSON string) and parsed host-side.
 *
 * @param page - page handle.
 * @param keys - top-level state keys to read.
 * @returns key -> parsed slice, or undefined when nothing was readable.
 */
async function readInitialStateSlices(page, keys) {
	const expression = `((keys) => {
    const state = window.__INITIAL_STATE__ ?? window.__INITIAL_SSR_STATE__ ?? null;
    if (state === null || typeof state !== 'object') return '';
    const MAX_TEXT = 1500000;
    const clone = (value, depth) => {
      if (value === null || value === undefined) return value;
      if (typeof value === 'function') return undefined;
      if (typeof value !== 'object') return value;
      if (depth > 7) return undefined;
      if (value.__v_isRef === true) return clone(value.value, depth + 1);
      if (Array.isArray(value)) {
        const list = [];
        const size = Math.min(value.length, 200);
        for (let index = 0; index < size; index += 1) {
          const item = clone(value[index], depth + 1);
          if (item !== undefined) list.push(item);
        }
        return list;
      }
      const output = {};
      let count = 0;
      for (const key of Object.keys(value)) {
        if (count >= 120) break;
        count += 1;
        let item;
        try { item = value[key] } catch (error) { continue }
        if (typeof item === 'function') continue;
        const cloned = clone(item, depth + 1);
        if (cloned !== undefined) output[key] = cloned;
      }
      return output;
    };
    const safe = (value) => {
      try {
        const text = JSON.stringify(value);
        return typeof text === 'string' && text.length <= MAX_TEXT ? text : '';
      } catch (error) { return '' }
    };
    const out = {};
    for (const key of keys) {
      const slice = state[key];
      if (slice === null || slice === undefined) continue;
      const text = safe(clone(slice, 0));
      if (text === '' || text === 'undefined') continue;
      out[key] = text;
    }
    return safe(out);
  })(${JSON.stringify(keys)})`
	try {
		const text = await page.evaluate(expression)
		if (typeof text !== 'string' || text === '') return undefined
		const raw = JSON.parse(text)
		if (raw === null || typeof raw !== 'object') return undefined
		const sliced = {}
		for (const key of Object.keys(raw)) {
			try {
				const parsed = JSON.parse(raw[key])
				if (parsed !== null && parsed !== undefined) sliced[key] = parsed
			} catch (error) {
				// Skip one unreadable slice.
			}
		}
		return Object.keys(sliced).length === 0 ? undefined : sliced
	} catch (error) {
		return undefined
	}
}

/**
 * Find the logged-in user id in the page's SSR stores (`user`, `login`).
 * @param page - page handle.
 * @returns the 24-hex user id, or an empty string.
 */
export async function readStateUserId(page) {
	const source = `(() => {
    const state = window.__INITIAL_STATE__ ?? window.__INITIAL_SSR_STATE__ ?? null;
    if (state === null || typeof state !== 'object') return '';
    const unwrap = (value) => {
      let out = value;
      let guard = 0;
      while (out !== null && typeof out === 'object' && out.__v_isRef === true && guard < 5) { out = out.value; guard += 1 }
      return out;
    };
    const found = [];
    const walk = (value, depth) => {
      if (depth > 5 || value === null || typeof value !== 'object') return;
      for (const key of Object.keys(value)) {
        const item = unwrap(value[key]);
        if (typeof item === 'string' && /^(user_id|userId|userid|userIdStr)$/.test(key) && /^[0-9a-f]{24}$/i.test(item)) {
          found.push(item);
          return;
        }
        if (typeof item === 'object') walk(item, depth + 1);
      }
    };
    walk(unwrap(state.user), 0);
    if (found.length === 0) walk(unwrap(state.login), 0);
    return found[0] ?? '';
  })()`
	try {
		const value = await page.evaluate(source)
		return typeof value === 'string' ? value : ''
	} catch (error) {
		return ''
	}
}

/**
 * Summarize the SSR state for diagnostics.
 * @param page - CDP page handle.
 * @returns `{ keys, noteKeys, noteDetailIds }` or undefined.
 */
async function readInitialStateSummary(page) {
	const expression = `(() => {
    const state = window.__INITIAL_STATE__ ?? window.__INITIAL_SSR_STATE__ ?? null;
    if (state === null || typeof state !== 'object') return '';
    try {
      const note = state.note ?? null;
      const detail = note !== null && typeof note === 'object' ? note.noteDetailMap : null;
      return JSON.stringify({
        keys: Object.keys(state),
        noteKeys: note !== null && typeof note === 'object' ? Object.keys(note) : [],
        noteDetailIds: detail !== null && typeof detail === 'object' ? Object.keys(detail) : []
      });
    } catch (error) { return '' }
  })()`
	try {
		const text = await page.evaluate(expression)
		if (typeof text !== 'string' || text === '') return undefined
		const parsed = JSON.parse(text)
		return typeof parsed === 'object' && parsed !== null ? parsed : undefined
	} catch (error) {
		return undefined
	}
}

/**
 * Open one URL, record all API traffic for a bounded period, and persist it.
 * This is the adaptation tool for endpoints whose payloads are unknown (today:
 * private messages).
 *
 * @param ctx - { browser, store, settings, log, signal }.
 * @param options - { url, seconds?, scroll? }.
 * @returns endpoint inventory and the raw capture path.
 */
export async function probePage(ctx, options = {}) {
	const { browser, store, settings, signal } = ctx
	const url = typeof options.url === 'string' && options.url !== '' ? options.url : HOME_URL
	const seconds = clamp(options.seconds ?? 12, 2, 120)
	const page = await openPage(browser, undefined)
	const bag = new CaptureBag()
	try {
		await page.goto(url)
		await pump(page, bag, { timeoutMs: seconds * 1000, signal })
		if (options.scroll === true) {
			await scrollAndDrain(page, bag, { times: 4, distance: 1000, delayMs: settings.requestDelayMs ?? 1200, signal })
		}
		const trimmed = bag.entries.map((entry) => {
			const text = JSON.stringify(entry.body ?? null)
			const size = typeof text === 'string' ? text.length : 0
			return {
				url: entry.url,
				method: entry.method,
				status: entry.status,
				capturedAt: entry.capturedAt,
				size,
				body: size > RAW_BODY_PREVIEW ? { truncated: true, preview: text.slice(0, RAW_BODY_PREVIEW) } : entry.body,
				reqBody: entry.reqBody
			}
		})
		let pageUrl = ''
		try {
			pageUrl = await page.getLocationHref()
		} catch (error) {
			pageUrl = ''
		}
		const initialState = await readInitialStateSummary(page)
		const slug = safeSlug(url)
		const rawPath = await store.saveRaw(`probe-${slug}`, { url, pageUrl, capturedAt: new Date().toISOString(), entries: trimmed, initialState })
		return {
			mode: 'probe',
			ok: true,
			url,
			pageUrl,
			initialState,
			captures: trimmed.length,
			inventory: bag.endpoints().slice(0, 40),
			rawPath,
			hint: 'inventory 里挑出目标接口后，用 data/raw/ 下的完整响应扩展 lib/normalize.mjs 的 classify/normalizeCapture'
		}
	} finally {
		await page.close().catch(() => {})
	}
}

/**
 * Read the note id out of an explore/note URL.
 * @param value - URL text.
 * @returns the note id, or an empty string.
 */
function noteIdFromUrl(value) {
	if (typeof value !== 'string' || value === '') return ''
	try {
		const url = new URL(value, ORIGIN)
		const match = url.pathname.match(/\/(?:explore|note|discovery\/item)\/([0-9a-zA-Z_-]+)/)
		if (match !== null) return match[1]
		const fromQuery = url.searchParams.get('note_id')
		return typeof fromQuery === 'string' ? fromQuery : ''
	} catch (error) {
		return ''
	}
}

/**
 * Slugify a URL for a file name.
 * @param value - URL or text.
 * @returns a filesystem-safe slug.
 */
function safeSlug(value) {
	return String(value)
		.replace(/^https?:\/\//, '')
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80) || 'page'
}

/**
 * Clamp a number into an inclusive range.
 * @param value - candidate number.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns the clamped integer.
 */
function clamp(value, min, max) {
	const number = Number(value)
	if (!Number.isFinite(number)) return min
	return Math.min(max, Math.max(min, Math.trunc(number)))
}

export { dedupe, assembleComments, countComments, harvestNoteCards, CaptureBag, pump, sleep }
