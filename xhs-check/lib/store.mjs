/**
 * Disk store for dsh-xhs-check.
 *
 * Layout under `dataDir` (all paths returned to callers are POSIX relative):
 *
 * ```
 * data/
 *   notes/<noteId>.json
 *   comments/<noteId>.json            { noteId, comments:[...], collectedAt, sourceUrl }
 *   searches/<slug>-<ts>.json         { query, notes:[...], collectedAt, sourceUrl }
 *   profiles/<userId>-<tab>.json      { userId, tab, notes:[...], collectedAt, sourceUrl }
 *   chats/<conversationId>.json       { conversationId, peer, messages:[...], collectedAt }
 *   notifications/<ts>.json           { items:[...], collectedAt }
 *   raw/<ts>-<slug>.json              probe captures
 *   index.json                        { updatedAt, entries:[...] }
 * ```
 *
 * Guarantees:
 * - every write is atomic (same-directory temp file + `rename`);
 * - `index.json` is maintained incrementally, rebuilt from the data files when
 *   missing or corrupt, and only `index.json` is read by `list()`/`counts()`;
 * - all mutations are serialized through one promise chain (single process),
 *   so concurrent `save()`/`saveMany()` calls cannot interleave read-modify-
 *   write cycles;
 * - index entries carry extra `author`/`snippet` fields (superset of the
 *   contract) so `list()` can fuzzy-match title/body/nickname without touching
 *   the data files.
 *
 * @module dsh-xhs-check/store
 */

import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

import { mergeRecord } from './normalize.mjs'

/** Directories created by `init()`. */
const DATA_DIRS = ['notes', 'comments', 'searches', 'profiles', 'chats', 'notifications', 'raw']

/** Types the panel always expects in `counts()`. */
const CONTRACT_TYPES = ['note', 'comment', 'chat_conversation', 'chat_message', 'notification', 'search', 'profile']

/** Types whose index `count` sums multiple records (others count entries). */
const AGGREGATE_TYPES = new Set(['comment', 'chat_message', 'notification'])

/** Accepted aliases for record types. */
const TYPE_ALIASES = {
	notes: 'note',
	comments: 'comment',
	profiles: 'profile',
	profile: 'profile',
	user: 'user',
	users: 'user',
	searches: 'search',
	search: 'search',
	chats: 'chat_conversation',
	chat: 'chat_conversation',
	conversation: 'chat_conversation',
	conversations: 'chat_conversation',
	messages: 'chat_message',
	message: 'chat_message',
	chat_messages: 'chat_message',
	notifications: 'notification'
}

/** @returns {boolean} whether value is a plain object. */
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns {string} trimmed string coercion ('' for non-strings). */
function textValue(value) {
	return typeof value === 'string' ? value.trim() : ''
}

/** @returns {string} first non-empty text among candidates. */
function firstText(...values) {
	for (const value of values) {
		const out = textValue(value)
		if (out) return out
	}
	return ''
}

/** @returns {string} first line, flattened and clipped. */
function firstLine(value, max) {
	const raw = typeof value === 'string' ? value : textValue(value)
	const line = raw.split(/\r?\n/)[0] ?? ''
	const flat = line.replace(/\s+/g, ' ').trim()
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** @returns {string} filename-safe lowercase slug preserving unicode letters. */
function slugify(value, maxLength = 60, fallback = 'item') {
	const raw = typeof value === 'string' ? value : String(value ?? '')
	const slug = raw
		.normalize('NFKC')
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase()
	if (!slug) return fallback
	const clipped = slug.slice(0, maxLength).replace(/-+$/g, '')
	return clipped || fallback
}

/** @returns {string} short stable hash suffix. */
function hashSuffix(value) {
	return createHash('sha1').update(String(value)).digest('hex').slice(0, 8)
}

/**
 * Safe path segment for ids. Deterministic: the same id always maps to the
 * same segment; disallowed characters are replaced and a hash suffix keeps the
 * mapping collision-free.
 * @param {unknown} value raw id.
 * @returns {string} safe segment.
 */
function safeSegment(value) {
	const raw = typeof value === 'string' ? value.trim() : String(value ?? '')
	if (!raw) return `item-${hashSuffix('')}`
	const cleaned = raw
		.replace(/[^\p{L}\p{N}._-]+/gu, '_')
		.replace(/^[._-]+|[._-]+$/g, '')
		.slice(0, 120)
	if (!cleaned) return `item-${hashSuffix(raw)}`
	return cleaned === raw ? cleaned : `${cleaned}-${hashSuffix(raw)}`
}

/** @returns {string} synthetic id for payloads without one. */
function hashId(prefix, parts) {
	return `${prefix}_${hashSuffix(JSON.stringify(parts))}`
}

/** @returns {string} `YYYYMMDD-HHmmss-SSS` UTC compact stamp. */
function compactStamp(date = new Date()) {
	const iso = date.toISOString()
	return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}-${iso.slice(20, 23)}`
}

/** @returns {string} normalized record type (aliases resolved, lower-cased). */
function normalizeType(type) {
	if (typeof type !== 'string') return ''
	const key = type.trim()
	if (!key) return ''
	return TYPE_ALIASES[key] ?? TYPE_ALIASES[key.toLowerCase()] ?? key.toLowerCase()
}

/** @returns {string} required record id. */
function requireId(record) {
	const id = record?.id
	if (typeof id === 'string' && id.trim()) return id.trim()
	if (typeof id === 'number' && Number.isFinite(id)) return String(id)
	throw new TypeError(`record.id is required (type: ${String(record?.type)})`)
}

/** @returns {number} integer option with fallback and lower bound. */
function toInt(value, fallback, minimum = 0) {
	const parsed = typeof value === 'number'
		? value
		: typeof value === 'string' && value.trim()
			? Number(value)
			: Number.NaN
	if (!Number.isFinite(parsed)) return fallback
	return Math.max(minimum, Math.trunc(parsed))
}

/** @returns {object} index entry for one note file. */
function noteEntry(record, rel) {
	const id = String(record?.id ?? '')
	const collectedAt = typeof record?.collectedAt === 'string' ? record.collectedAt : ''
	const author = isPlainObject(record?.author) ? firstLine(record.author.nickname, 30) : ''
	return {
		type: 'note',
		id,
		title: firstLine(record?.title, 60) || firstLine(record?.desc, 40) || id,
		count: 1,
		path: rel,
		collectedAt,
		author,
		snippet: firstLine(record?.desc, 120)
	}
}

/** @returns {number} number of comments including nested sub-comments. */
function countComments(comments) {
	let total = 0
	for (const comment of Array.isArray(comments) ? comments : []) {
		if (!isPlainObject(comment)) continue
		total += 1
		total += countComments(comment.subComments ?? comment.sub_comments)
	}
	return total
}

/** @returns {object} index entry for one comments file. */
function commentEntryFor(noteId, comments, rel, collectedAt, noteTitle) {
	const count = countComments(comments)
	const title = noteTitle ? `${count} 条评论 · ${noteTitle}` : `${count} 条评论`
	const snippet = (Array.isArray(comments) ? comments : [])
		.slice(0, 3)
		.map((comment) => firstLine(comment?.content, 40))
		.filter(Boolean)
		.join(' / ')
	return {
		type: 'comment',
		id: String(noteId ?? ''),
		title: firstLine(title, 80) || String(noteId ?? ''),
		count,
		path: rel,
		collectedAt: typeof collectedAt === 'string' ? collectedAt : '',
		author: '',
		snippet
	}
}

/** Upsert one sub-comment into a subComments list. */
function upsertSubComment(subs, comment) {
	const list = Array.isArray(subs) ? [...subs] : []
	const index = list.findIndex((item) => isPlainObject(item) && item.id === comment.id)
	if (index >= 0) {
		const merged = mergeRecord(list[index], comment)
		merged.parentId = comment.parentId ?? list[index].parentId ?? null
		merged.subComments = Array.isArray(merged.subComments) ? merged.subComments : []
		list[index] = merged
	} else {
		const created = mergeRecord(
			{ type: 'comment', id: comment.id, parentId: comment.parentId ?? null, subComments: [] },
			comment
		)
		created.subComments = Array.isArray(created.subComments) ? created.subComments : []
		list.push(created)
	}
	return list
}

/** Merge a subComments list into another, deduplicating by comment id. */
function mergeSubCommentLists(existing, incoming) {
	let subs = Array.isArray(existing) ? existing.filter(isPlainObject) : []
	for (const comment of Array.isArray(incoming) ? incoming : []) {
		if (!isPlainObject(comment)) continue
		subs = upsertSubComment(subs, comment)
	}
	return subs
}

/**
 * Insert/merge a top-level comment. Comments previously stored as orphan
 * top-level entries (their `parentId` now matches) are absorbed into
 * `subComments`.
 */
function upsertTopLevelComment(list, comment) {
	const comments = Array.isArray(list) ? [...list] : []
	const index = comments.findIndex((item) => isPlainObject(item) && item.id === comment.id)
	let merged
	if (index >= 0) {
		merged = mergeRecord(comments[index], comment)
		merged.subComments = mergeSubCommentLists(comments[index].subComments, comment.subComments)
	} else {
		merged = mergeRecord(
			{ type: 'comment', id: comment.id, parentId: null, subComments: [] },
			comment
		)
		merged.subComments = mergeSubCommentLists([], comment.subComments)
	}
	merged.parentId = null
	merged.subComments = Array.isArray(merged.subComments) ? merged.subComments : []
	for (const item of comments) {
		if (!isPlainObject(item)) continue
		if (item.id === comment.id) continue
		if (item.parentId !== comment.id) continue
		merged.subComments = upsertSubComment(merged.subComments, item)
	}
	const next = []
	comments.forEach((item, position) => {
		if (position === index) {
			next.push(merged)
			return
		}
		if (!isPlainObject(item)) return
		if (item.id !== comment.id && item.parentId === comment.id) return
		next.push(item)
	})
	if (index === -1) next.push(merged)
	return next
}

/** Build the two index entries (conversation + message counters) for a chat file. */
function chatEntries(doc, rel, fallbackId) {
	const id = String(doc?.conversationId ?? fallbackId ?? '')
	const messages = Array.isArray(doc?.messages) ? doc.messages.filter(isPlainObject) : []
	const peer = isPlainObject(doc?.peer) ? doc.peer : {}
	const peerName = firstLine(peer.nickname, 30)
	const title = peerName || id
	const collectedAt = typeof doc?.collectedAt === 'string' ? doc.collectedAt : ''
	const lastMessage = firstLine(doc?.lastMessage ?? messages.at(-1)?.text, 120)
	const author = peerName
	const entries = [
		{ type: 'chat_conversation', id, title, count: 1, path: rel, collectedAt, author, snippet: lastMessage }
	]
	// A conversation saved without message bodies must not claim a message row.
	if (messages.length > 0) entries.push({ type: 'chat_message', id, title, count: messages.length, path: rel, collectedAt, author, snippet: lastMessage })
	return entries
}

/** Disk store bound to one `dataDir`. */
export class Store {
	#root

	#index = { updatedAt: '', entries: [] }

	#ready = false

	#initPromise

	#queue = Promise.resolve()

	#defer = 0

	#dirty = false

	/**
	 * @param {string} rootDir data directory (created on `init()`).
	 */
	constructor(rootDir) {
		if (typeof rootDir !== 'string' || !rootDir.trim()) {
			throw new TypeError('Store requires a non-empty dataDir path')
		}
		this.#root = resolve(rootDir)
	}

	/** Absolute data directory (kept internal to paths returned by the API). */
	get rootDir() {
		return this.#root
	}

	/**
	 * Create the directory layout and load (or rebuild) `index.json`.
	 * Idempotent and safe to call before every public method.
	 * @returns {Promise<void>} resolves when the store is ready.
	 */
	async init() {
		if (this.#ready) return
		await mkdir(this.#root, { recursive: true })
		for (const dir of DATA_DIRS) await mkdir(join(this.#root, dir), { recursive: true })
		const loaded = await this.#loadIndexFile()
		if (loaded) {
			this.#index = loaded
			this.#ready = true
			return
		}
		this.#index = await this.#rebuildIndex()
		await this.#writeJsonAtomic('index.json', {
			updatedAt: this.#index.updatedAt,
			entries: this.#index.entries
		})
		this.#ready = true
	}

	/**
	 * Save or merge one record. Returns the relative path written.
	 * @param {object} record normalized record.
	 * @returns {Promise<string>} relative path under `dataDir`.
	 */
	async save(record) {
		await this.#ensureReady()
		return this.#run(() => this.#saveOne(record))
	}

	/**
	 * Save many records sequentially. Invalid entries are skipped; I/O errors
	 * propagate.
	 * @param {object[]} records normalized records.
	 * @returns {Promise<{saved: number, paths: string[]}>} saved count and paths.
	 */
	async saveMany(records) {
		await this.#ensureReady()
		const list = Array.isArray(records) ? records : []
		return this.#run(() => this.#withDeferred(async () => {
			const paths = []
			let saved = 0
			for (const record of list) {
				if (!isPlainObject(record)) continue
				try {
					const path = await this.#saveOne(record)
					if (path) {
						saved += 1
						paths.push(path)
					}
				} catch (error) {
					if (!(error instanceof TypeError)) throw error
				}
			}
			return { saved, paths }
		}))
	}

	/**
	 * Read a stored document by type + id (index lookup, with a deterministic
	 * path fallback for note/comment/profile/chat docs).
	 * @param {string} type record type.
	 * @param {string} id record id.
	 * @returns {Promise<any|undefined>} parsed document.
	 */
	async get(type, id) {
		await this.#ensureReady()
		const normalized = normalizeType(type)
		const key = String(id ?? '')
		if (!normalized || !key) return undefined
		const entry = this.#index.entries.find((item) => item.type === normalized && item.id === key)
		const rel = entry?.path ?? this.#fallbackPath(normalized, key)
		if (!rel) return undefined
		return this.#readJson(rel)
	}

	/**
	 * Query the index only (never scans data directories).
	 * @param {{type?: string, query?: string, limit?: number, offset?: number}} [options]
	 *   type filter, fuzzy text (title/body/nickname) and pagination.
	 * @returns {Promise<{items: object[], total: number}>} page of compact rows.
	 */
	async list({ type, query, limit = 30, offset = 0 } = {}) {
		await this.#ensureReady()
		const typeFilter = typeof type === 'string' && type.trim() && type.trim() !== 'all'
			? normalizeType(type)
			: ''
		const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
		const matched = this.#index.entries.filter((entry) => {
			if (typeFilter && entry.type !== typeFilter) return false
			if (!needle) return true
			const haystack = `${entry.title ?? ''} ${entry.author ?? ''} ${entry.snippet ?? ''}`.toLowerCase()
			return haystack.includes(needle)
		})
		matched.sort((a, b) => String(b.collectedAt ?? '').localeCompare(String(a.collectedAt ?? ''))
			|| String(a.id ?? '').localeCompare(String(b.id ?? '')))
		const pageOffset = toInt(offset, 0)
		const pageLimit = toInt(limit, 30)
		return {
			items: matched.slice(pageOffset, pageOffset + pageLimit).map((entry) => ({
				type: entry.type,
				id: entry.id,
				title: entry.title,
				count: entry.count,
				collectedAt: entry.collectedAt,
				path: entry.path
			})),
			total: matched.length
		}
	}

	/**
	 * Count stored records per type. Comment/chat_message/notification counts
	 * are sums of the per-file record counts; other types count index entries.
	 * @returns {Promise<Record<string, number>>} counts.
	 */
	async counts() {
		await this.#ensureReady()
		const counts = Object.fromEntries(CONTRACT_TYPES.map((type) => [type, 0]))
		for (const entry of this.#index.entries) {
			const type = entry.type
			const count = Number.isFinite(entry.count) ? entry.count : 1
			counts[type] = (counts[type] ?? 0) + (AGGREGATE_TYPES.has(type) ? count : 1)
		}
		return counts
	}

	/**
	 * Persist a raw probe capture under `raw/`.
	 * @param {string} name descriptive name (slugified).
	 * @param {unknown} value payload (written as JSON).
	 * @returns {Promise<string>} relative path.
	 */
	async saveRaw(name, value) {
		await this.#ensureReady()
		return this.#run(async () => {
			const slug = slugify(name, 60, 'raw')
			const stamp = compactStamp()
			let rel = `raw/${stamp}-${slug}.json`
			let suffix = 1
			while (await this.#exists(rel)) {
				rel = `raw/${stamp}-${slug}-${suffix}.json`
				suffix += 1
			}
			await this.#writeJsonAtomic(rel, value === undefined ? null : value)
			return rel
		})
	}

	/**
	 * Merge comment records into `comments/<noteId>.json`, deduplicating by id
	 * and merging nested `subComments`. Replies (records with `parentId`) are
	 * nested under their parent when it is present in the file.
	 * @param {string} noteId owning note id.
	 * @param {object[]} comments comment records.
	 * @returns {Promise<{saved: number, path: string}>} accepted count and path.
	 */
	async saveComments(noteId, comments) {
		await this.#ensureReady()
		return this.#run(() => this.#saveCommentsLocked(noteId, comments))
	}

	/**
	 * Write one search capture and persist the found notes into `notes/`.
	 * @param {string} query search keyword.
	 * @param {object[]} records note records.
	 * @param {object} [meta] extra metadata (sourceUrl, ...).
	 * @returns {Promise<string>} relative path.
	 */
	async saveSearch(query, records, meta) {
		await this.#ensureReady()
		return this.#run(() => this.#withDeferred(() => this.#saveSearchLocked(query, records, meta)))
	}

	/**
	 * Merge a conversation capture into `chats/<conversationId>.json`.
	 * @param {string} conversationId conversation id.
	 * @param {object[]} records chat_message (or chat_conversation) records.
	 * @param {object} [meta] extra metadata ({peer, lastMessage, ...}).
	 * @returns {Promise<string>} relative path.
	 */
	async saveChat(conversationId, records, meta) {
		await this.#ensureReady()
		return this.#run(() => this.#withDeferred(() => this.#saveChatLocked(conversationId, records, meta)))
	}

	/**
	 * Write one profile tab capture (`profiles/<userId>-<tab>.json`) and persist
	 * its notes into `notes/`, mirroring `saveSearch`.
	 * @param {string} userId profile user id.
	 * @param {string} tab tab name, e.g. `'notes'` / `'fav'`.
	 * @param {object[]} notes note records.
	 * @param {object} [meta] extra metadata (sourceUrl, nickname, ...).
	 * @returns {Promise<string>} relative path.
	 */
	async saveProfile(userId, tab, notes, meta) {
		await this.#ensureReady()
		return this.#run(() => this.#withDeferred(() => this.#saveProfileLocked(userId, tab, notes, meta)))
	}

	/**
	 * Write one notification batch to `notifications/<ts>.json`.
	 * @param {object[]} items notification records.
	 * @param {object} [meta] extra metadata ({title, sourceUrl, ...}).
	 * @returns {Promise<string>} relative path.
	 */
	async saveNotifications(items, meta) {
		await this.#ensureReady()
		return this.#run(() => this.#withDeferred(() => this.#saveNotificationsLocked(items, meta)))
	}

	// ------------------------------------------------------------------
	// Internal: lifecycle / serialization / atomic IO
	// ------------------------------------------------------------------

	/** @returns {Promise<void>} resolves once the store is initialized. */
	#ensureReady() {
		if (this.#ready) return Promise.resolve()
		if (!this.#initPromise) {
			this.#initPromise = this.init().catch((error) => {
				this.#initPromise = undefined
				this.#ready = false
				throw error
			})
		}
		return this.#initPromise
	}

	/** Serialize one mutation on the internal promise chain. */
	#run(task) {
		const next = this.#queue.then(task)
		this.#queue = next.then(() => undefined, () => undefined)
		return next
	}

	/** Run a multi-file mutation with one index flush at the end. */
	async #withDeferred(task) {
		this.#defer += 1
		try {
			return await task()
		} finally {
			this.#defer = Math.max(0, this.#defer - 1)
			if (this.#defer === 0 && this.#dirty) await this.#writeIndex()
		}
	}

	/** Read one JSON file; `undefined` when missing or unparseable. */
	async #readJson(rel) {
		try {
			const raw = await readFile(join(this.#root, rel), 'utf8')
			return JSON.parse(raw)
		} catch {
			return undefined
		}
	}

	/** Atomically write one JSON file. */
	async #writeJsonAtomic(rel, value) {
		const absolute = join(this.#root, rel)
		await mkdir(dirname(absolute), { recursive: true })
		const temp = `${absolute}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
		try {
			await writeFile(temp, `${JSON.stringify(value, null, '\t')}\n`, 'utf8')
			await rename(temp, absolute)
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {})
			throw error
		}
	}

	/** Whether a relative path exists. */
	async #exists(rel) {
		try {
			await access(join(this.#root, rel))
			return true
		} catch {
			return false
		}
	}

	/** Persist the in-memory index (deferred inside batch mutations). */
	async #writeIndex() {
		if (this.#defer > 0) {
			this.#dirty = true
			return
		}
		this.#dirty = false
		this.#index.updatedAt = new Date().toISOString()
		await this.#writeJsonAtomic('index.json', {
			updatedAt: this.#index.updatedAt,
			entries: this.#index.entries
		})
	}

	/** Upsert index entries keyed by (type, id). */
	#upsertEntries(entries) {
		for (const entry of entries) {
			if (!isPlainObject(entry) || !entry.type || !entry.id) continue
			const index = this.#index.entries.findIndex(
				(item) => item.type === entry.type && item.id === entry.id
			)
			if (index >= 0) {
				this.#index.entries[index] = { ...this.#index.entries[index], ...entry }
			} else {
				this.#index.entries.push({ ...entry })
			}
		}
	}

	/** Read and validate `index.json`; `undefined` when missing/corrupt. */
	async #loadIndexFile() {
		const doc = await this.#readJson('index.json')
		if (!isPlainObject(doc) || !Array.isArray(doc.entries)) return undefined
		const entries = []
		for (const raw of doc.entries) {
			if (!isPlainObject(raw)) continue
			const type = normalizeType(raw.type)
			const id = typeof raw.id === 'string' ? raw.id : String(raw.id ?? '')
			const path = typeof raw.path === 'string' ? raw.path : ''
			if (!type || !id || !path) continue
			const count = Number(raw.count)
			entries.push({
				type,
				id,
				path,
				title: typeof raw.title === 'string' ? raw.title : id,
				count: Number.isFinite(count) ? count : 1,
				collectedAt: typeof raw.collectedAt === 'string' ? raw.collectedAt : '',
				author: typeof raw.author === 'string' ? raw.author : '',
				snippet: typeof raw.snippet === 'string' ? raw.snippet : ''
			})
		}
		return {
			updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : '',
			entries
		}
	}

	/** Rebuild the index by scanning the data directories. */
	async #rebuildIndex() {
		const entries = []
		const noteTitles = new Map()
		const listFileNames = async (dir) => {
			try {
				const dirents = await readdir(join(this.#root, dir), { withFileTypes: true })
				return dirents
					.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
					.map((entry) => entry.name)
			} catch {
				return []
			}
		}
		for (const name of await listFileNames('notes')) {
			const rel = `notes/${name}`
			const doc = await this.#readJson(rel)
			if (!isPlainObject(doc)) continue
			const id = typeof doc.id === 'string' && doc.id ? doc.id : name.slice(0, -'.json'.length)
			const entry = noteEntry({ ...doc, id }, rel)
			noteTitles.set(id, entry.title)
			entries.push(entry)
		}
		for (const name of await listFileNames('comments')) {
			const rel = `comments/${name}`
			const doc = await this.#readJson(rel)
			if (!isPlainObject(doc)) continue
			const noteId = typeof doc.noteId === 'string' && doc.noteId
				? doc.noteId
				: name.slice(0, -'.json'.length)
			const comments = Array.isArray(doc.comments) ? doc.comments : []
			entries.push(commentEntryFor(noteId, comments, rel, doc.collectedAt, noteTitles.get(noteId)))
		}
		for (const name of await listFileNames('profiles')) {
			const rel = `profiles/${name}`
			const doc = await this.#readJson(rel)
			if (!isPlainObject(doc)) continue
			const fallbackId = name.slice(0, -'.json'.length)
			const type = normalizeType(doc.type) === 'user' ? 'user' : 'profile'
			const nickname = firstLine(doc.nickname, 30)
			const id = type === 'user'
				? (typeof doc.id === 'string' && doc.id ? doc.id : fallbackId)
				: (typeof doc.userId === 'string' && doc.userId && typeof doc.tab === 'string' && doc.tab
					? `${doc.userId}-${doc.tab}`
					: (typeof doc.id === 'string' && doc.id ? doc.id : fallbackId))
			entries.push({
				type,
				id,
				title: type === 'profile' ? (textValue(doc.userId) || fallbackId) : (nickname || id),
				count: 1,
				path: rel,
				collectedAt: typeof doc.collectedAt === 'string' ? doc.collectedAt : '',
				author: nickname,
				snippet: firstLine(doc.desc, 120)
			})
		}
		for (const name of await listFileNames('searches')) {
			const rel = `searches/${name}`
			const doc = await this.#readJson(rel)
			if (!isPlainObject(doc)) continue
			const id = name.slice(0, -'.json'.length)
			const notes = Array.isArray(doc.notes) ? doc.notes : []
			entries.push({
				type: 'search',
				id,
				title: firstLine(doc.query, 60) || id,
				count: notes.length,
				path: rel,
				collectedAt: typeof doc.collectedAt === 'string' ? doc.collectedAt : '',
				author: '',
				snippet: notes.slice(0, 3).map((note) => firstLine(note?.title, 40)).filter(Boolean).join(' / ')
			})
		}
		for (const name of await listFileNames('chats')) {
			const rel = `chats/${name}`
			const doc = await this.#readJson(rel)
			if (!isPlainObject(doc)) continue
			entries.push(...chatEntries(doc, rel, name.slice(0, -'.json'.length)))
		}
		for (const name of await listFileNames('notifications')) {
			const rel = `notifications/${name}`
			const doc = await this.#readJson(rel)
			if (!isPlainObject(doc)) continue
			const id = name.slice(0, -'.json'.length)
			const items = Array.isArray(doc.items) ? doc.items.filter(isPlainObject) : []
			entries.push({
				type: 'notification',
				id,
				title: `${items.length} 条通知`,
				count: items.length,
				path: rel,
				collectedAt: typeof doc.collectedAt === 'string' ? doc.collectedAt : '',
				author: '',
				snippet: items
					.slice(0, 3)
					.map((item) => firstLine(item.title ?? item.content, 40))
					.filter(Boolean)
					.join(' / ')
			})
		}
		for (const name of await listFileNames('misc')) {
			const rel = `misc/${name}`
			const doc = await this.#readJson(rel)
			if (!isPlainObject(doc)) continue
			const type = normalizeType(doc.type)
			const id = typeof doc.id === 'string' ? doc.id : name.slice(0, -'.json'.length)
			if (!type || !id) continue
			entries.push({
				type,
				id,
				title: firstLine(doc.title, 60) || id,
				count: 1,
				path: rel,
				collectedAt: typeof doc.collectedAt === 'string' ? doc.collectedAt : '',
				author: '',
				snippet: ''
			})
		}
		return { updatedAt: new Date().toISOString(), entries }
	}

	/** Deterministic fallback path for `get()` when the index entry is missing. */
	#fallbackPath(type, id) {
		const segment = safeSegment(id)
		switch (type) {
			case 'note':
				return `notes/${segment}.json`
			case 'comment':
				return `comments/${segment}.json`
			case 'profile':
			case 'user':
				return `profiles/${segment}.json`
			case 'chat_conversation':
			case 'chat_message':
				return `chats/${segment}.json`
			default:
				return undefined
		}
	}

	// ------------------------------------------------------------------
	// Internal: per-type writers
	// ------------------------------------------------------------------

	/** Dispatch one record to its writer. */
	async #saveOne(record) {
		if (!isPlainObject(record)) throw new TypeError('store.save expects a plain record object')
		const type = normalizeType(record.type) || 'note'
		switch (type) {
			case 'note':
				return this.#saveNote(record)
			case 'comment':
				return this.#saveComment(record)
			case 'profile':
				return this.#saveProfileRecord(record)
			case 'user':
				return this.#saveUserRecord(record)
			case 'chat_message':
				return this.#saveChatLocked(
					firstText(record.conversationId, record.conversation_id) || 'unassigned',
					[record],
					{}
				)
			case 'chat_conversation':
				return this.#saveChatLocked(requireId(record), [], {
					peer: record.peer,
					lastMessage: record.lastMessage,
					unreadCount: record.unreadCount,
					updatedAt: record.updatedAt,
					sourceUrl: record.sourceUrl
				})
			case 'notification':
				return this.#saveNotificationRecord(record)
			case 'search':
				return this.#saveSearchLocked(record.query ?? record.title ?? '', record.notes ?? [], {
					sourceUrl: record.sourceUrl
				})
			default:
				return this.#saveMisc(record, type)
		}
	}

	/** Write or merge one note file. */
	async #saveNote(record) {
		const id = requireId(record)
		const rel = `notes/${safeSegment(id)}.json`
		const previous = await this.#readJson(rel)
		const collectedAt = textValue(record.collectedAt) || new Date().toISOString()
		const merged = isPlainObject(previous) ? mergeRecord(previous, record) : { ...record }
		merged.type = 'note'
		merged.id = id
		merged.collectedAt = collectedAt
		merged.stats = isPlainObject(merged.stats) ? merged.stats : {}
		await this.#writeJsonAtomic(rel, merged)
		this.#upsertEntries([noteEntry(merged, rel)])
		await this.#writeIndex()
		return rel
	}

	/** Save a single comment record (grouped by its note). */
	async #saveComment(record) {
		const noteId = firstText(record.noteId, record.note_id) || requireId(record)
		const { path } = await this.#saveCommentsLocked(noteId, [record])
		return path
	}

	/** Write or merge one legacy profile record (no tab). */
	async #saveProfileRecord(record) {
		const id = requireId(record)
		const rel = `profiles/${safeSegment(id)}.json`
		const previous = await this.#readJson(rel)
		const merged = isPlainObject(previous) ? mergeRecord(previous, record) : { ...record }
		merged.type = 'profile'
		merged.id = id
		merged.collectedAt = textValue(record.collectedAt) || new Date().toISOString()
		await this.#writeJsonAtomic(rel, merged)
		const nickname = firstLine(merged.nickname, 30)
		this.#upsertEntries([{
			type: 'profile',
			id,
			title: nickname || id,
			count: 1,
			path: rel,
			collectedAt: merged.collectedAt,
			author: nickname,
			snippet: firstLine(merged.desc, 120)
		}])
		await this.#writeIndex()
		return rel
	}

	/** Write or merge one logged-in user record. */
	async #saveUserRecord(record) {
		const id = requireId(record)
		const rel = `profiles/${safeSegment(id)}.json`
		const previous = await this.#readJson(rel)
		const merged = isPlainObject(previous) ? mergeRecord(previous, record) : { ...record }
		merged.type = 'user'
		merged.id = id
		merged.collectedAt = textValue(record.collectedAt) || new Date().toISOString()
		await this.#writeJsonAtomic(rel, merged)
		const nickname = firstLine(merged.nickname, 30)
		this.#upsertEntries([{
			type: 'user',
			id,
			title: nickname || id,
			count: 1,
			path: rel,
			collectedAt: merged.collectedAt,
			author: nickname,
			snippet: ''
		}])
		await this.#writeIndex()
		return rel
	}

	/** Merge one notification record into its own notification batch file. */
	async #saveNotificationRecord(record) {
		const id = requireId(record)
		return this.#saveNotificationsLocked([{ ...record, id, type: 'notification' }], {
			sourceUrl: record.sourceUrl,
			title: firstLine(record.title, 60)
		})
	}

	/** Write or merge an unknown record type under `misc/`. */
	async #saveMisc(record, type) {
		const id = requireId(record)
		const rel = `misc/${slugify(type, 30, 'misc')}-${safeSegment(id)}.json`
		const previous = await this.#readJson(rel)
		const merged = isPlainObject(previous) ? mergeRecord(previous, record) : { ...record }
		merged.type = type
		merged.id = id
		merged.collectedAt = textValue(record.collectedAt) || new Date().toISOString()
		await this.#writeJsonAtomic(rel, merged)
		this.#upsertEntries([{
			type,
			id,
			title: firstLine(merged.title, 60) || id,
			count: 1,
			path: rel,
			collectedAt: merged.collectedAt,
			author: '',
			snippet: ''
		}])
		await this.#writeIndex()
		return rel
	}

	/** Merge comments into `comments/<noteId>.json`. */
	async #saveCommentsLocked(noteId, comments) {
		const id = String(noteId ?? '').trim() || 'unassigned'
		const rel = `comments/${safeSegment(id)}.json`
		const previous = await this.#readJson(rel)
		const doc = isPlainObject(previous) ? { ...previous } : { noteId: id, comments: [], collectedAt: '' }
		if (typeof doc.noteId !== 'string' || !doc.noteId) doc.noteId = id
		doc.comments = Array.isArray(doc.comments) ? doc.comments.filter(isPlainObject) : []
		const incoming = Array.isArray(comments) ? comments.filter(isPlainObject) : []
		let accepted = 0
		for (const raw of incoming) {
			if (raw.type && raw.type !== 'comment') continue
			const comment = { ...raw, type: 'comment' }
			if (!comment.id) {
				comment.id = hashId('c', [
					comment.noteId,
					comment.parentId,
					comment.content,
					comment.author?.id,
					comment.createdAt
				])
			}
			accepted += 1
			if (comment.parentId) {
				const parentIndex = doc.comments.findIndex((item) => item.id === comment.parentId)
				if (parentIndex >= 0) {
					const parent = doc.comments[parentIndex]
					parent.subComments = upsertSubComment(
						Array.isArray(parent.subComments) ? parent.subComments : [],
						comment
					)
					doc.comments[parentIndex] = parent
				} else {
					doc.comments = upsertTopLevelComment(doc.comments, comment)
				}
			} else {
				doc.comments = upsertTopLevelComment(doc.comments, comment)
			}
		}
		doc.collectedAt = new Date().toISOString()
		doc.sourceUrl = firstText(doc.sourceUrl, ...incoming.map((item) => item.sourceUrl))
		await this.#writeJsonAtomic(rel, doc)
		const noteTitle = this.#index.entries.find(
			(entry) => entry.type === 'note' && entry.id === doc.noteId
		)?.title ?? ''
		this.#upsertEntries([commentEntryFor(doc.noteId, doc.comments, rel, doc.collectedAt, noteTitle)])
		await this.#writeIndex()
		return { saved: accepted, path: rel }
	}

	/** Write one search file and persist its notes. */
	async #saveSearchLocked(query, records, meta) {
		const queryText = typeof query === 'string' ? query.trim() : String(query ?? '').trim()
		const notes = Array.isArray(records) ? records.filter(isPlainObject) : []
		const collectedAt = new Date().toISOString()
		const metaObject = isPlainObject(meta) ? meta : {}
		const slug = slugify(queryText || 'search', 60, 'search')
		const base = `${slug}-${compactStamp()}`
		let rel = `searches/${base}.json`
		let suffix = 1
		while (await this.#exists(rel)) {
			rel = `searches/${base}-${suffix}.json`
			suffix += 1
		}
		const doc = {
			...metaObject,
			query: queryText,
			notes,
			collectedAt,
			sourceUrl: firstText(metaObject.sourceUrl, notes[0]?.sourceUrl)
		}
		await this.#writeJsonAtomic(rel, doc)
		for (const note of notes) {
			try {
				await this.#saveNote(note)
			} catch (error) {
				if (!(error instanceof TypeError)) throw error
			}
		}
		const id = rel.slice('searches/'.length, -'.json'.length)
		this.#upsertEntries([{
			type: 'search',
			id,
			title: queryText || id,
			count: notes.length,
			path: rel,
			collectedAt,
			author: firstLine(notes[0]?.author?.nickname, 30),
			snippet: notes.slice(0, 3).map((note) => firstLine(note.title, 40)).filter(Boolean).join(' / ')
		}])
		await this.#writeIndex()
		return rel
	}

	/** Write/merge one chat file and its two index entries. */
	async #saveChatLocked(conversationId, records, meta) {
		const id = String(conversationId ?? '').trim() || 'unassigned'
		const rel = `chats/${safeSegment(id)}.json`
		const previous = await this.#readJson(rel)
		const doc = isPlainObject(previous) ? { ...previous } : { conversationId: id, peer: null, messages: [], collectedAt: '' }
		doc.conversationId = id
		doc.messages = Array.isArray(doc.messages) ? doc.messages.filter(isPlainObject) : []
		const incoming = Array.isArray(records) ? records.filter(isPlainObject) : []
		const metaObject = isPlainObject(meta) ? meta : {}
		let peer = isPlainObject(metaObject.peer) ? metaObject.peer : undefined
		for (const record of incoming) {
			if (record.type === 'chat_conversation') {
				if (!peer && isPlainObject(record.peer)) peer = record.peer
				continue
			}
			if (record.type && record.type !== 'chat_message') continue
			if (!record.id) continue
			const message = { ...record, type: 'chat_message', conversationId: id }
			const index = doc.messages.findIndex((item) => item.id === message.id)
			if (index >= 0) doc.messages[index] = mergeRecord(doc.messages[index], message)
			else doc.messages.push(message)
		}
		if (peer) doc.peer = isPlainObject(doc.peer) ? mergeRecord(doc.peer, peer) : peer
		for (const key of ['lastMessage', 'unreadCount', 'updatedAt', 'sourceUrl']) {
			if (metaObject[key] !== undefined) doc[key] = metaObject[key]
		}
		const lastMessage = doc.messages.at(-1)
		if (!doc.lastMessage && lastMessage?.text) doc.lastMessage = lastMessage.text
		doc.collectedAt = new Date().toISOString()
		for (const [key, value] of Object.entries(metaObject)) {
			if (value === undefined) continue
			if (key === 'peer' || key === 'messages' || key === 'conversationId' || key === 'collectedAt') continue
			doc[key] = value
		}
		await this.#writeJsonAtomic(rel, doc)
		this.#upsertEntries(chatEntries(doc, rel, id))
		await this.#writeIndex()
		return rel
	}

	/** Write one profile tab file, persist its notes, update the index. */
	async #saveProfileLocked(userId, tab, notes, meta) {
		const uid = String(userId ?? '').trim()
		if (!uid) throw new TypeError('saveProfile requires a userId')
		const tabName = String(tab ?? '').trim() || 'all'
		const id = `${uid}-${tabName}`
		const rel = `profiles/${safeSegment(uid)}-${safeSegment(tabName)}.json`
		const collectedAt = new Date().toISOString()
		const incomingNotes = Array.isArray(notes) ? notes.filter(isPlainObject) : []
		const metaObject = isPlainObject(meta) ? meta : {}
		const previous = await this.#readJson(rel)
		const prior = isPlainObject(previous) ? previous : {}
		const priorNotes = Array.isArray(prior.notes) ? prior.notes : []
		const mergedNotes = mergeRecord({ notes: priorNotes }, { notes: incomingNotes }).notes
		const doc = {
			...prior,
			userId: uid,
			tab: tabName,
			notes: mergedNotes,
			collectedAt,
			sourceUrl: firstText(metaObject.sourceUrl, incomingNotes[0]?.sourceUrl, prior.sourceUrl)
		}
		for (const [key, value] of Object.entries(metaObject)) {
			if (value === undefined) continue
			if (key === 'notes' || key === 'userId' || key === 'tab' || key === 'collectedAt') continue
			doc[key] = value
		}
		await this.#writeJsonAtomic(rel, doc)
		for (const note of incomingNotes) {
			try {
				await this.#saveNote(note)
			} catch (error) {
				if (!(error instanceof TypeError)) throw error
			}
		}
		this.#upsertEntries([{
			type: 'profile',
			id,
			title: uid,
			count: incomingNotes.length,
			path: rel,
			collectedAt,
			author: firstLine(doc.nickname, 30),
			snippet: firstLine(doc.desc, 120)
		}])
		await this.#writeIndex()
		return rel
	}

	/** Write one notification batch file and its index entry. */
	async #saveNotificationsLocked(items, meta) {
		const list = Array.isArray(items) ? items.filter(isPlainObject) : []
		const collectedAt = new Date().toISOString()
		const metaObject = isPlainObject(meta) ? meta : {}
		const stamp = compactStamp()
		let id = stamp
		let rel = `notifications/${id}.json`
		let suffix = 1
		while (await this.#exists(rel)) {
			id = `${stamp}-${suffix}`
			rel = `notifications/${id}.json`
			suffix += 1
		}
		const doc = {
			...metaObject,
			items: list,
			collectedAt,
			sourceUrl: firstText(metaObject.sourceUrl, list[0]?.sourceUrl)
		}
		await this.#writeJsonAtomic(rel, doc)
		this.#upsertEntries([{
			type: 'notification',
			id,
			title: firstText(metaObject.title, `${list.length} 条通知`) || id,
			count: list.length,
			path: rel,
			collectedAt,
			author: '',
			snippet: list.slice(0, 3).map((item) => firstLine(item.title ?? item.content, 40)).filter(Boolean).join(' / ')
		}])
		await this.#writeIndex()
		return rel
	}
}
