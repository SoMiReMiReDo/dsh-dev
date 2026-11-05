/**
 * Xiaohongshu web-response normalization for dsh-xhs-check.
 *
 * The recorder captures raw `fetch`/XHR responses; this module turns them into
 * the flat record shapes the rest of the plugin (store, tools, panel) consumes.
 *
 * Defensive contract: every exported function tolerates `null`/`undefined`
 * bodies, missing fields, non-objects and plain-string bodies. Nothing throws;
 * fields that cannot be derived stay `undefined` (references such as
 * `parentId` use `null`) so callers can test presence cheaply.
 *
 * Counts: Xiaohongshu renders counts as display strings ("1.2万", "10+",
 * "1,234"). `parseCount` converts them to numbers (1.2万 -> 12000, 10+ -> 10).
 * The untouched payload is always kept in `record.raw`, so the exact display
 * text is never lost. Numeric fields in records are therefore `number |
 * undefined`, not strings.
 *
 * Times: epoch fields (`time`, `create_time`, `last_update_time`) are
 * millisecond timestamps on the web API. They are converted to ISO-8601
 * strings in `publishedAt` / `createdAt`; the raw number remains in `raw`.
 *
 * Unpublished endpoints: the DM/message API is not documented. Chat payloads
 * are recovered with structural heuristics (`messagesFromAny` /
 * `conversationsFromAny`): find an array whose elements look like messages
 * (sender + text + time) or conversations (peer + last message/time). When the
 * shape cannot be recognised the functions return `[]` instead of guessing.
 *
 * @module dsh-xhs-check/normalize
 */

import { createHash } from 'node:crypto'

/**
 * Response category derived from the request URL.
 * @typedef {'note'|'comments'|'subcomments'|'search'|'user_notes'|'note_detail_by_id'
 *   |'user_me'|'chat_conversations'|'chat_messages'|'notifications'|'unknown'} CaptureKind
 */

/**
 * One recorder capture. `body` is already JSON-parsed when the response was
 * JSON; otherwise it is the raw string (or anything the recorder stored).
 * @typedef {object} Capture
 * @property {string} [url] request URL.
 * @property {string} [method] HTTP method.
 * @property {number} [status] HTTP status.
 * @property {string} [capturedAt] ISO capture time.
 * @property {unknown} [body] parsed response body (or raw string).
 * @property {unknown} [reqBody] parsed request body, when captured.
 */

/**
 * @typedef {object} NormalizedCapture
 * @property {CaptureKind} kind resolved capture kind.
 * @property {object[]} records normalized records (may be empty).
 * @property {unknown} raw original body.
 * @property {string} sourceUrl original request URL ('' when unknown).
 */

/** Image scenes preferred by the web client, most useful first. */
const IMAGE_SCENES = ['WB_DFT', 'WB_PRV', 'CRD_WM_JPG', 'CRD_PRV', 'CRD_WM_WEBP']

/** Scalar fields that should never shrink when two captures are merged. */
const MAX_FIELDS = new Set(['likeCount', 'subCommentCount', 'unreadCount', 'count'])

/** @returns {string} current ISO time. */
function nowIso() {
	return new Date().toISOString()
}

/**
 * Plain-object test (arrays and null excluded).
 * @param {unknown} value candidate.
 * @returns {boolean} whether value is a plain object.
 */
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Object coercion used by tolerant readers.
 * @param {unknown} value candidate.
 * @returns {Record<string, any>} the value when plain object, else `{}`.
 */
function asObject(value) {
	return isPlainObject(value) ? value : {}
}

/**
 * Array coercion used by tolerant readers.
 * @param {unknown} value candidate.
 * @returns {any[]} the value when array, else `[]`.
 */
function asArray(value) {
	return Array.isArray(value) ? value : []
}

/**
 * Trimmed string coercion; numbers are stringified, everything else -> ''.
 * @param {unknown} value candidate.
 * @returns {string} normalized text.
 */
function text(value) {
	if (typeof value === 'string') return value.trim()
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	return ''
}

/**
 * First non-empty text among candidates.
 * @param {...unknown} values candidates.
 * @returns {string} first non-empty text, or ''.
 */
function firstText(...values) {
	for (const value of values) {
		const out = text(value)
		if (out) return out
	}
	return ''
}

/**
 * First defined candidate (empty string counts as defined).
 * @param {...unknown} values candidates.
 * @returns {unknown} first defined value.
 */
function firstDefined(...values) {
	for (const value of values) {
		if (value !== undefined && value !== null) return value
	}
	return undefined
}

/**
 * Lenient count parser. Xiaohongshu shows "1.2万", "10+", "1,234" or plain
 * numbers; this returns the numeric value where possible.
 * @param {unknown} value raw count.
 * @returns {number|undefined} parsed count.
 */
function parseCount(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
	if (typeof value === 'string') {
		const raw = value.trim().toLowerCase().replace(/,/g, '')
		if (!raw) return undefined
		const match = raw.match(/(-?\d+(?:\.\d+)?)\s*(万|亿|w|k|千|m)?/)
		if (!match) return undefined
		const base = Number(match[1])
		if (!Number.isFinite(base)) return undefined
		const unit = match[2]
		const factor = unit === '万' || unit === 'w'
			? 10000
			: unit === '亿'
				? 100000000
				: unit === '千' || unit === 'k'
					? 1000
					: unit === 'm'
						? 1000000
						: 1
		return Math.round(base * factor)
	}
	return undefined
}

/**
 * Epoch/date-string -> ISO string. Accepts milliseconds (web default),
 * seconds (heuristic: below 1e11) and parseable date strings.
 * @param {unknown} value timestamp.
 * @returns {string|undefined} ISO time.
 */
function toIso(value) {
	if (value === undefined || value === null || value === '') return undefined
	if (typeof value === 'number' && Number.isFinite(value)) {
		const ms = value > 0 && value < 1e11 ? value * 1000 : value
		const date = new Date(ms)
		return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
	}
	if (typeof value === 'string') {
		const raw = value.trim()
		if (!raw) return undefined
		if (/^\d+$/.test(raw)) return toIso(Number(raw))
		const ms = Date.parse(raw)
		return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
	}
	return undefined
}

/**
 * Deterministic synthetic id for payloads that omit one.
 * @param {string} prefix id prefix, e.g. 'c' or 'msg'.
 * @param {unknown[]} parts identity ingredients.
 * @returns {string} stable synthetic id.
 */
function stableId(prefix, parts) {
	const signature = safeStringify(parts)
	const digest = createHash('sha1').update(signature).digest('hex').slice(0, 16)
	return `${prefix}_${digest}`
}

/**
 * JSON.stringify that never throws.
 * @param {unknown} value candidate.
 * @returns {string} serialized value ('' on failure).
 */
function safeStringify(value) {
	try {
		return JSON.stringify(value) ?? ''
	} catch {
		return ''
	}
}

/**
 * Flatten text to one readable line and clip it.
 * @param {unknown} value candidate.
 * @param {number} max maximum characters.
 * @returns {string} clipped single-line text.
 */
function clip(value, max) {
	const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
	if (!flat) return ''
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * First line of a value, clipped (used for titles derived from descriptions).
 * @param {unknown} value candidate.
 * @param {number} max maximum characters.
 * @returns {string} clipped first line.
 */
function firstLine(value, max) {
	const raw = typeof value === 'string' ? value : text(value)
	const line = raw.split(/\r?\n/)[0] ?? ''
	return clip(line, max)
}

/**
 * Coerce a numeric-like value to a finite number.
 * @param {unknown} value candidate.
 * @returns {number|undefined} finite number.
 */
function numberOrUndefined(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

/**
 * Pick a remote image URL from one `image_list` entry. Preference order matches
 * the web client: url_default, url_pre, then info_list scenes (WB_DFT first).
 * @param {unknown} raw image entry.
 * @returns {string} remote URL or ''.
 */
function imageUrlFrom(raw) {
	const image = asObject(raw)
	const direct = firstText(image.url_default, image.urlDefault, image.url_pre, image.urlPre, image.url)
	if (direct) return direct
	const infoList = asArray(image.info_list ?? image.infoList)
	for (const scene of IMAGE_SCENES) {
		const hit = infoList
			.map(asObject)
			.find((entry) => firstText(entry.image_scene, entry.imageScene) === scene && text(entry.url))
		if (hit) return text(hit.url)
	}
	for (const entry of infoList) {
		const url = text(asObject(entry).url)
		if (url) return url
	}
	return ''
}

/**
 * Map `image_list` entries to `{url,width,height}` records (remote links only).
 * @param {unknown} raw image list.
 * @returns {Array<{url: string, width?: number, height?: number}>} images.
 */
function imagesFrom(raw) {
	const images = []
	const seen = new Set()
	for (const entry of asArray(raw)) {
		const url = imageUrlFrom(entry)
		if (!url || seen.has(url)) continue
		seen.add(url)
		const image = asObject(entry)
		images.push({
			url,
			width: numberOrUndefined(image.width ?? image.w),
			height: numberOrUndefined(image.height ?? image.h)
		})
	}
	return images
}

/**
 * Collect unique tag names from `tag_list` variants.
 * @param {unknown} raw tag list.
 * @returns {string[]} tag names.
 */
function tagsFrom(raw) {
	const tags = []
	for (const entry of asArray(raw)) {
		const tag = firstText(isPlainObject(entry) ? entry.name ?? entry.tag_name ?? entry.title : entry)
		if (tag && !tags.includes(tag)) tags.push(tag)
	}
	return tags
}

/**
 * Extract the `user` / `user_info` author triple.
 * @param {unknown} raw user object.
 * @returns {{id?: string, nickname?: string, avatarUrl?: string}} author.
 */
function userFrom(raw) {
	const user = asObject(raw)
	const id = firstText(user.user_id, user.userId, user.id, user.uid, user.red_id, user.redId)
	const nickname = firstText(user.nickname, user.nick_name, user.nickName, user.name)
	const avatarUrl = firstText(user.avatar, user.image, user.avatar_url, user.avatarUrl, user.image_url, user.imageUrl)
	return {
		id: id || undefined,
		nickname: nickname || undefined,
		avatarUrl: avatarUrl || undefined
	}
}

/**
 * Resolve a URL from a value that may be a string or `{url}` object.
 * @param {unknown} value candidate.
 * @returns {string} URL or ''.
 */
function urlOf(value) {
	if (typeof value === 'string') return text(value)
	return firstText(asObject(value).url, asObject(value).url_default, asObject(value).urlDefault)
}

/**
 * Extract video info from a note card.
 * @param {Record<string, any>} card note card.
 * @returns {{url?: string, coverUrl?: string, duration?: number}|null} video info or null.
 */
function videoFrom(card) {
	const video = asObject(card.video)
	if (Object.keys(video).length === 0) return null
	const media = asObject(video.media)
	const stream = asObject(media.stream)
	const mediaVideo = asObject(media.video)
	const candidates = [
		...asArray(stream.h264),
		...asArray(stream.h265),
		...asArray(stream.av1),
		...asArray(stream.h264_pre)
	]
	let url = ''
	for (const candidate of candidates) {
		const entry = asObject(candidate)
		url = firstText(
			entry.master_url,
			entry.masterUrl,
			entry.url,
			entry.backup_url,
			entry.backupUrl
		)
		if (url) break
	}
	if (!url) url = firstText(urlOf(video.url), urlOf(media.url), urlOf(video.master_url))
	let coverUrl = firstText(
		urlOf(mediaVideo.cover),
		urlOf(video.cover),
		urlOf(asObject(video.image).first_frame),
		urlOf(asObject(video.image).firstFrame),
		urlOf(asObject(video.image).thumbnail)
	)
	if (!coverUrl) coverUrl = imageUrlFrom(asArray(card.image_list ?? card.imageList)[0])
	const duration = numberOrUndefined(mediaVideo.duration ?? video.duration ?? card.duration)
	if (!url && !coverUrl && duration === undefined) return null
	return { url: url || undefined, coverUrl: coverUrl || undefined, duration }
}

/**
 * Build the public note permalink (only remote links are stored).
 * @param {string} noteId note id.
 * @param {string} [token] xsec_token when the payload exposed one.
 * @returns {string|undefined} note URL.
 */
function noteUrl(noteId, token, kind) {
	const id = text(noteId)
	if (!id) return undefined
	const base = `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}`
	if (!token) return base
	// The token is validated together with xsec_source: a search token opens with
	// pc_search, a feed token with pc_feed, a profile token with pc_user.
	const source = kind === 'search' ? 'pc_search' : kind === 'user_notes' ? 'pc_user' : 'pc_feed'
	return `${base}?xsec_token=${encodeURIComponent(token)}&xsec_source=${source}`
}

/**
 * Map a `note_card` (feed / search / user_posted / note detail) to a note record.
 * Feed wrappers `{id, model_type, note_card}` may be passed as-is.
 *
 * @param {unknown} card the note card (or a wrapper containing `note_card`).
 * @param {{url?: string, kind?: string, collectedAt?: string, xsecToken?: string}} [source]
 *   capture context.
 * @returns {object|undefined} note record, or undefined when nothing usable.
 */
export function noteFromCard(card, source = {}) {
	try {
		const wrapper = asObject(card)
		if (Object.keys(wrapper).length === 0) return undefined
		const inner = isPlainObject(wrapper.note_card)
			? wrapper.note_card
			: isPlainObject(wrapper.noteCard)
				? wrapper.noteCard
				: wrapper
		const noteId = firstText(
			inner.note_id,
			inner.noteId,
			inner.id,
			wrapper.note_id,
			wrapper.id
		)
		const displayTitle = firstText(inner.display_title, inner.displayTitle, inner.title)
		const desc = typeof inner.desc === 'string'
			? inner.desc
			: typeof inner.description === 'string'
				? inner.description
				: ''
		if (!noteId && !displayTitle && !desc) return undefined

		const author = userFrom(inner.user ?? inner.user_info ?? inner.userInfo ?? inner.author)
		const token = firstText(
			inner.xsec_token,
			inner.xsecToken,
			wrapper.xsec_token,
			wrapper.xsecToken,
			source.xsecToken
		)
		const interact = asObject(inner.interact_info ?? inner.interactInfo)
		const stats = {
			liked: parseCount(interact.liked_count ?? interact.likedCount),
			collected: parseCount(interact.collected_count ?? interact.collectedCount),
			comments: parseCount(interact.comment_count ?? interact.commentCount),
			shared: parseCount(interact.share_count ?? interact.shareCount)
		}
		const noteType = firstText(inner.type, inner.note_type, inner.noteType) || (inner.video ? 'video' : undefined)
		const record = {
			type: 'note',
			id: noteId || stableId('note', [displayTitle, desc, author.id]),
			url: noteUrl(noteId, token, source.kind),
			title: displayTitle || firstLine(desc, 40) || undefined,
			desc: desc || undefined,
			author,
			images: imagesFrom(inner.image_list ?? inner.imageList ?? inner.images),
			video: videoFrom(inner),
			tags: tagsFrom(inner.tag_list ?? inner.tagList ?? inner.tags),
			stats,
			publishedAt: toIso(inner.time ?? inner.publish_time ?? inner.publishTime ?? inner.last_update_time),
			ipLocation: firstText(inner.ip_location, inner.ipLocation) || undefined,
			noteType,
			collectedAt: toIso(source.collectedAt) ?? nowIso(),
			sourceUrl: text(source.url) || undefined,
			raw: card
		}
		return record
	} catch {
		return undefined
	}
}

/**
 * Extract comment records (with nested `sub_comments`) from a comment-page body.
 * Top-level comments have `parentId: null`; replies carry their parent id and
 * are nested under `subComments` as well.
 * @param {unknown} body comment page body.
 * @param {string} [noteId] owning note id (often only known from the request).
 * @returns {object[]} comment records.
 */
export function commentsFromPage(body, noteId) {
	try {
		const list = findCommentArray(body)
		const context = {
			noteId: text(noteId) || undefined,
			parentId: null,
			depth: 0,
			sourceUrl: ''
		}
		return list.map((item) => commentFromItem(item, context)).filter(Boolean)
	} catch {
		return []
	}
}

/**
 * Map one comment payload item to a record.
 * @param {unknown} item comment item.
 * @param {{noteId?: string, parentId?: string|null, depth: number, sourceUrl?: string}} context
 *   parent context.
 * @returns {object|undefined} comment record.
 */
function commentFromItem(item, context) {
	try {
		if (!isPlainObject(item)) return undefined
		const explicitId = firstText(item.id, item.comment_id, item.commentId)
		const content = text(item.content ?? item.text ?? item.desc)
		const author = userFrom(item.user_info ?? item.userInfo ?? item.user ?? item.author)
		const parentId = context.parentId ?? null
		const id = explicitId || stableId('c', [
			context.noteId,
			parentId,
			content,
			author.id,
			firstDefined(item.create_time, item.createTime, item.time),
			firstDefined(item.like_count, item.likeCount)
		])
		const record = {
			type: 'comment',
			id,
			noteId: firstText(item.note_id, item.noteId) || context.noteId || undefined,
			parentId,
			content,
			author,
			likeCount: parseCount(item.like_count ?? item.likeCount ?? item.liked_count),
			createdAt: toIso(item.create_time ?? item.createTime ?? item.time ?? item.created_at),
			ipLocation: firstText(item.ip_location, item.ipLocation) || undefined,
			subCommentCount: parseCount(item.sub_comment_count ?? item.subCommentCount),
			subComments: [],
			collectedAt: nowIso(),
			sourceUrl: text(context.sourceUrl) || undefined,
			raw: item
		}
		const cursor = firstText(item.sub_comment_cursor, item.subCommentCursor)
		if (cursor) record.subCommentCursor = cursor
		const hasMore = firstDefined(item.sub_comment_has_more, item.subCommentHasMore)
		if (hasMore !== undefined) record.subCommentHasMore = Boolean(hasMore)
		if (context.depth < 3) {
			record.subComments = asArray(item.sub_comments ?? item.subComments)
				.map((sub) => commentFromItem(sub, { ...context, parentId: id, depth: context.depth + 1 }))
				.filter(Boolean)
		}
		return record
	} catch {
		return undefined
	}
}

/**
 * Locate the comment array inside a comment-page body.
 * @param {unknown} body comment page body.
 * @returns {unknown[]} comment list (possibly empty).
 */
function findCommentArray(body) {
	const root = asObject(body)
	const data = asObject(root.data)
	const nested = asObject(data.data)
	const direct = [
		data.comments,
		root.comments,
		nested.comments,
		data.comment_list,
		data.commentList,
		data.items,
		root.items
	]
	for (const candidate of direct) {
		if (Array.isArray(candidate)) return candidate
	}
	return findArray(root, looksLikeComment, 6)
}

/**
 * Structural comment predicate used as a fallback locator.
 * @param {unknown} item candidate.
 * @returns {boolean} whether the item looks like a comment.
 */
function looksLikeComment(item) {
	if (!isPlainObject(item)) return false
	const hasTime = firstDefined(item.create_time, item.createTime, item.time) !== undefined
	const hasBody = item.content !== undefined || item.user_info !== undefined || item.userInfo !== undefined
	return hasTime && hasBody
}

/**
 * Recursively find the first array with at least one element matching `predicate`.
 * @param {unknown} node JSON node to search.
 * @param {(item: unknown) => boolean} predicate element test.
 * @param {number} [depth] remaining recursion depth.
 * @param {Set<object>} [seen] cycle guard.
 * @returns {unknown[]} matching array, or [].
 */
function findArray(node, predicate, depth = 6, seen = new Set()) {
	if (depth < 0 || node === null || typeof node !== 'object') return []
	if (seen.has(node)) return []
	seen.add(node)
	if (Array.isArray(node)) {
		const objects = node.filter(isPlainObject)
		if (objects.length > 0 && objects.some(predicate)) return node
		for (const child of node) {
			const hit = findArray(child, predicate, depth - 1, seen)
			if (hit.length > 0) return hit
		}
		return []
	}
	for (const value of Object.values(node)) {
		const hit = findArray(value, predicate, depth - 1, seen)
		if (hit.length > 0) return hit
	}
	return []
}

/**
 * Heuristic DM-message extraction: find any array whose entries look like chat
 * messages (sender + text + timestamp) and map them to `chat_message` records.
 * The private-message API is unpublished, so this is best-effort; it never
 * throws and returns `[]` when the shape is not recognised.
 *
 * @param {unknown} body any JSON body.
 * @param {string} [conversationId] conversation id from the request context.
 * @returns {object[]} chat_message records.
 */
export function messagesFromAny(body, conversationId) {
	try {
		if (body === null || body === undefined) return []
		const list = findArray(body, looksLikeMessage, 8)
		if (list.length === 0) return []
		const records = list
			.filter(looksLikeMessage)
			.map((item) => messageFromItem(item, conversationId))
			.filter(Boolean)
		return dedupeById(records)
	} catch {
		return []
	}
}

/**
 * Structural chat-message predicate.
 * @param {unknown} item candidate.
 * @returns {boolean} whether the item looks like a message.
 */
function looksLikeMessage(item) {
	if (!isPlainObject(item)) return false
	if (!senderFromItem(item)) return false
	if (!messageText(item)) return false
	return messageTimeSource(item) !== undefined
}

/**
 * Resolve the sender triple from common message shapes.
 * @param {Record<string, any>} item message candidate.
 * @returns {{id?: string, nickname?: string, avatarUrl?: string}|undefined} sender.
 */
function senderFromItem(item) {
	const candidates = [
		item.from,
		item.sender,
		item.from_user,
		item.fromUser,
		item.sender_info,
		item.senderInfo,
		item.from_user_info,
		item.fromUserInfo
	]
	for (const candidate of candidates) {
		const user = userFrom(candidate)
		if (user.id || user.nickname) return user
	}
	const id = firstText(
		item.sender_id,
		item.senderId,
		item.from_id,
		item.fromId,
		item.from_user_id,
		item.fromUserId,
		item.user_id
	)
	if (!id) return undefined
	return userFrom({
		user_id: id,
		nickname: firstText(item.sender_nickname, item.senderName, item.from_nickname)
	})
}

/**
 * Extract text from a message `content` value (string, blocks or object).
 * @param {unknown} value candidate.
 * @returns {string} extracted text.
 */
function contentText(value) {
	if (typeof value === 'string') return text(value)
	if (typeof value === 'number') return String(value)
	if (Array.isArray(value)) {
		for (const part of value) {
			const out = contentText(part)
			if (out) return out
		}
		return ''
	}
	if (isPlainObject(value)) {
		return firstText(value.text, value.content, value.body, value.desc, value.title)
	}
	return ''
}

/**
 * Best-effort message text.
 * @param {Record<string, any>} item message candidate.
 * @returns {string} message text.
 */
function messageText(item) {
	return firstText(
		typeof item.text === 'string' ? item.text : '',
		contentText(item.content),
		typeof item.body === 'string' ? item.body : contentText(item.body),
		typeof item.message === 'string' ? item.message : contentText(item.message),
		typeof item.msg === 'string' ? item.msg : ''
	)
}

/**
 * First timestamp-like field of a message/notification item.
 * @param {Record<string, any>} item candidate.
 * @returns {unknown} timestamp value.
 */
function messageTimeSource(item) {
	return firstDefined(
		item.create_time,
		item.createTime,
		item.time,
		item.timestamp,
		item.ts,
		item.send_time,
		item.sendTime,
		item.created_at,
		item.createdAt,
		item.update_time,
		item.updateTime
	)
}

/**
 * Collect remote image URLs from message payload variants.
 * @param {Record<string, any>} item message candidate.
 * @returns {string[]} image URLs.
 */
function imageUrlsFrom(item) {
	const urls = []
	const sources = [item.images, item.image_list, item.imageList, item.pics, item.attachments]
	for (const source of sources) {
		for (const entry of asArray(source)) {
			const url = typeof entry === 'string' ? text(entry) : imageUrlFrom(entry)
			if (url && !urls.includes(url)) urls.push(url)
		}
	}
	return urls
}

/**
 * Map one heuristic message item to a `chat_message` record.
 * @param {unknown} raw candidate.
 * @param {string} [fallbackConversationId] conversation id from request context.
 * @returns {object|undefined} chat_message record.
 */
function messageFromItem(raw, fallbackConversationId) {
	try {
		if (!isPlainObject(raw)) return undefined
		const sender = senderFromItem(raw) ?? userFrom(undefined)
		const body = messageText(raw)
		const id = firstText(raw.id, raw.message_id, raw.messageId, raw.msg_id, raw.msgId)
			|| stableId('msg', [fallbackConversationId, sender.id, body, messageTimeSource(raw)])
		return {
			type: 'chat_message',
			id,
			conversationId: firstText(
				raw.conversation_id,
				raw.conversationId,
				raw.chat_id,
				raw.chatId,
				raw.session_id,
				raw.sessionId
			) || text(fallbackConversationId) || undefined,
			seq: numberOrUndefined(raw.seq ?? raw.sequence ?? raw.order ?? raw.index),
			from: sender,
			text: body,
			images: imageUrlsFrom(raw),
			messageType: firstText(
				raw.message_type,
				raw.messageType,
				raw.msg_type,
				raw.msgType,
				raw.type
			) || undefined,
			createdAt: toIso(messageTimeSource(raw)),
			collectedAt: nowIso(),
			sourceUrl: undefined,
			raw
		}
	} catch {
		return undefined
	}
}

/**
 * Heuristic conversation-list extraction for the unpublished DM list API.
 * @param {unknown} body any JSON body.
 * @returns {object[]} chat_conversation records.
 */
function conversationsFromAny(body) {
	try {
		if (body === null || body === undefined) return []
		// Known DM list routes first: they all wrap the list under `data`.
		const root = asObject(body)
		const data = asObject(root.data)
		const direct = []
		for (const key of ['chats', 'user_list', 'conversations', 'sessions', 'chat_list', 'recent_chats', 'list']) {
			const list = asArray(data[key] ?? root[key])
			if (list.length === 0) continue
			for (const item of list) {
				// `user_list` is the recent-chats peer list: a peer without any
				// message metadata is still a conversation.
				if (key === 'user_list' ? !isPlainObject(item) : !looksLikeConversation(item)) continue
				const record = conversationFromItem(item)
				if (record !== undefined) direct.push(record)
			}
			if (direct.length > 0) return dedupeById(direct)
		}
		const list = findArray(body, looksLikeConversation, 8)
		if (list.length === 0) return []
		const records = list.filter(looksLikeConversation).map(conversationFromItem).filter(Boolean)
		return dedupeById(records)
	} catch {
		return []
	}
}

/**
 * Structural conversation predicate (peer + recency/unread/message markers).
 * @param {unknown} item candidate.
 * @returns {boolean} whether the item looks like a conversation.
 */
function looksLikeConversation(item) {
	if (!isPlainObject(item)) return false
	const peer = conversationPeer(item)
	if (!peer || (!peer.id && !peer.nickname)) return false
	return firstDefined(
		item.last_message,
		item.lastMessage,
		item.last_msg_time,
		item.lastMsgTime,
		item.last_msg_content,
		item.lastMsgContent,
		item.unread_count,
		item.unreadCount,
		item.update_time,
		item.updateTime,
		item.updated_at,
		item.updatedAt,
		item.chat_id,
		item.chat_user_id,
		item.chatUserId,
		item.group_id,
		item.groupId,
		item.conversation_id,
		item.session_id
	) !== undefined
}

/**
 * Resolve the peer triple from conversation shapes.
 * @param {Record<string, any>} item conversation candidate.
 * @returns {{id?: string, nickname?: string, avatarUrl?: string}|undefined} peer.
 */
function conversationPeer(item) {
	const candidates = [
		item.peer,
		item.user_info,
		item.userInfo,
		item.user,
		item.to_user,
		item.toUser,
		item.opposite_user,
		item.oppositeUser,
		item.target_user,
		item.targetUser,
		// Private-message conversation list (`/im/web/v3/chats`, group chats).
		item.info,
		item.chat_info,
		item.chatInfo
	]
	for (const candidate of candidates) {
		const user = userFrom(candidate)
		if (user.id || user.nickname) return user
	}
	// Group chats name the peer with `group_name` instead of a nickname.
	const groupName = firstText(item.info?.group_name, item.info?.groupName, item.group_name, item.groupName)
	if (groupName !== '') {
		return {
			id: firstText(item.group_id, item.groupId, item.info?.group_id) || undefined,
			nickname: groupName,
			avatarUrl: firstText(item.info?.avatar, item.avatar) || undefined
		}
	}
	const fallback = userFrom(item)
	return fallback.id || fallback.nickname ? fallback : undefined
}

/**
 * Map one heuristic conversation item to a `chat_conversation` record.
 * @param {unknown} raw candidate.
 * @returns {object|undefined} chat_conversation record.
 */
function conversationFromItem(raw) {
	try {
		if (!isPlainObject(raw)) return undefined
		const peer = conversationPeer(raw) ?? userFrom(undefined)
		const id = firstText(
			raw.conversation_id,
			raw.conversationId,
			raw.chat_id,
			raw.chatId,
			raw.session_id,
			raw.sessionId,
			// DM list: a private chat is keyed by the peer, a group chat by group id.
			raw.chat_user_id,
			raw.chatUserId,
			raw.group_id,
			raw.groupId,
			raw.target_user_id,
			raw.targetUserId,
			raw.id
		)
		return {
			type: 'chat_conversation',
			id: id || stableId('conv', [peer.id, peer.nickname]),
			peer,
			lastMessage: firstText(
				raw.last_message,
				raw.lastMessage,
				contentText(raw.last_msg_content),
				contentText(raw.lastMsgContent),
				contentText(raw.last_message_content),
				contentText(raw.content)
			) || undefined,
			unreadCount: parseCount(raw.unread_count ?? raw.unreadCount ?? raw.unread),
			updatedAt: toIso(
				firstDefined(
					raw.last_msg_time,
					raw.lastMsgTime,
					raw.update_time,
					raw.updateTime,
					raw.updated_at,
					raw.updatedAt,
					raw.time
				)
			),
			collectedAt: nowIso(),
			sourceUrl: undefined,
			raw
		}
	} catch {
		return undefined
	}
}

/**
 * Heuristic notification extraction. Works on the documented-ish
 * `/v1/notification/...` shapes and any body whose list entries look like
 * notifications (title/content + actor/time/category).
 * @param {unknown} body any JSON body.
 * @returns {object[]} notification records.
 */
function notificationsFromAny(body) {
	try {
		if (body === null || body === undefined) return []
		const list = findArray(body, looksLikeNotification, 8)
		if (list.length === 0) return []
		const records = list.filter(looksLikeNotification).map(notificationFromItem).filter(Boolean)
		return dedupeById(records)
	} catch {
		return []
	}
}

/**
 * Structural notification predicate.
 * @param {unknown} item candidate.
 * @returns {boolean} whether the item looks like a notification.
 */
function looksLikeNotification(item) {
	if (!isPlainObject(item)) return false
	if (!firstText(item.title, item.content, item.text, item.desc)) return false
	return firstDefined(
		item.category,
		item.notify_type,
		item.notification_id,
		item.note_id,
		item.user_info,
		item.user,
		item.actor,
		messageTimeSource(item)
	) !== undefined
}

/**
 * Map one notification item to a `notification` record.
 * @param {unknown} raw candidate.
 * @returns {object|undefined} notification record.
 */
function notificationFromItem(raw) {
	try {
		if (!isPlainObject(raw)) return undefined
		const actor = userFrom(raw.user_info ?? raw.userInfo ?? raw.user ?? raw.actor ?? raw.from_user)
		const id = firstText(raw.id, raw.notification_id, raw.notificationId, raw.msg_id, raw.msgId)
			|| stableId('ntf', [
				raw.category,
				raw.title,
				raw.content,
				firstDefined(raw.note_id, raw.noteId, raw.target_id)
			])
		return {
			type: 'notification',
			id,
			category: firstText(raw.category, raw.notify_type, raw.notifyType, raw.type) || undefined,
			title: firstText(raw.title, raw.subject) || undefined,
			content: firstText(raw.content, raw.text, raw.desc) || undefined,
			actor,
			noteId: firstText(
				raw.note_id,
				raw.noteId,
				raw.target_id,
				raw.targetId,
				raw.item_info?.note_id,
				raw.item_info?.noteId,
				raw.itemInfo?.note_id
			) || undefined,
			createdAt: toIso(messageTimeSource(raw)),
			collectedAt: nowIso(),
			sourceUrl: undefined,
			raw
		}
	} catch {
		return undefined
	}
}

/**
 * Build the logged-in user record from `/api/sns/web/v2/user/me`.
 * `guest: true` (not logged in) yields an empty array.
 * @param {unknown} body response body.
 * @param {{sourceUrl?: string, collectedAt?: string}} context capture context.
 * @returns {object[]} zero or one `user` record.
 */
function userRecordsFromBody(body, context) {
	try {
		const root = asObject(body)
		const data = asObject(root.data)
		const flag = firstDefined(data.guest, root.guest)
		if (flag === true) return []
		const user = isPlainObject(data.user)
			? data.user
			: isPlainObject(root.user)
				? root.user
				: data
		const basic = userFrom(user)
		const id = firstText(
			user.user_id,
			user.userId,
			basic.id,
			data.user_id,
			data.userId,
			root.user_id,
			root.userId
		)
		const nickname = firstText(basic.nickname, data.nickname, root.nickname)
		const avatarUrl = firstText(
			basic.avatarUrl,
			data.avatar,
			data.image,
			root.avatar,
			root.image
		)
		if (!id && !nickname) return []
		return [{
			type: 'user',
			id: id || stableId('user', [nickname, avatarUrl]),
			nickname: nickname || undefined,
			avatarUrl: avatarUrl || undefined,
			collectedAt: toIso(context.collectedAt) ?? nowIso(),
			sourceUrl: text(context.sourceUrl) || undefined,
			raw: user
		}]
	} catch {
		return []
	}
}

/**
 * Collect ordered note cards from feed/search/user_posted/note-detail bodies.
 * Feed wrappers carry `xsec_token`; copy it onto the card so permalinks stay
 * valid.
 * @param {unknown} body response body.
 * @returns {unknown[]} note cards (or wrappers).
 */
function cardsFromBody(body) {
	const root = asObject(body)
	const data = asObject(root.data)
	const sources = [
		data.items,
		data.notes,
		data.note_list,
		data.noteList,
		data.list,
		root.items,
		root.notes
	]
	for (const source of sources) {
		const cards = []
		for (const entry of asArray(source)) {
			const item = asObject(entry)
			if (isPlainObject(item.note_card) || isPlainObject(item.noteCard)) {
				const card = isPlainObject(item.note_card) ? item.note_card : item.noteCard
				const token = firstText(item.xsec_token, item.xsecToken)
				// Search/feed wrappers carry the real note id and the xsec_token;
				// the inner card often omits both. Copy them up so permalinks and
				// stable ids survive.
				const wrapperId = firstText(item.id, item.note_id, item.noteId)
				const carryId = wrapperId && firstDefined(card.note_id, card.noteId, card.id) === undefined
				const carryToken = token !== '' && firstText(card.xsec_token, card.xsecToken) === ''
				cards.push(carryId || carryToken
					? { ...card, ...(carryId ? { note_id: wrapperId } : {}), ...(carryToken ? { xsec_token: token } : {}) }
					: card)
			} else if (firstDefined(item.note_id, item.noteId, item.display_title, item.desc) !== undefined) {
				cards.push(item)
			}
		}
		if (cards.length > 0) return cards
	}
	const single = isPlainObject(data.note_card)
		? data.note_card
		: isPlainObject(data.noteCard)
			? data.noteCard
			: undefined
	if (single) return [single]
	return []
}

/**
 * Deduplicate records sharing the same `id`, merging duplicates via
 * `mergeRecord` so the richer capture wins.
 * @param {object[]} records candidate records.
 * @returns {object[]} deduplicated records.
 */
function dedupeById(records) {
	const seen = new Map()
	for (const record of records) {
		if (!isPlainObject(record)) continue
		const id = text(record.id)
		if (!id) continue
		const key = `${text(record.type) || 'record'}:${id}`
		if (!seen.has(key)) {
			seen.set(key, record)
			continue
		}
		seen.set(key, mergeRecord(seen.get(key), record))
	}
	return [...seen.values()]
}

/**
 * Classify a request URL into a capture kind.
 *
 * Exact routes take precedence; then fuzzy path rules keep working when
 * Xiaohongshu adds a version segment or query params. Unknown URLs (and
 * non-string input) return `'unknown'`.
 *
 * @param {unknown} url request URL.
 * @returns {CaptureKind} capture kind.
 */
export function classify(url) {
	if (typeof url !== 'string' || !url.trim()) return 'unknown'
	let path = ''
	try {
		path = new URL(url, 'https://www.xiaohongshu.com').pathname.toLowerCase()
	} catch {
		path = url.toLowerCase().split(/[?#]/)[0]
	}
	if (!path) return 'unknown'

	// Comment pages: the sub-comment route must win over the generic one.
	if (path.includes('/comment/sub/') || path.includes('comment/sub') || path.endsWith('/comment/sub/page')) {
		return 'subcomments'
	}
	if (path.includes('/comment/page') || path.endsWith('/comment/page')) return 'comments'

	// Notes / feeds.
	if (path.includes('/v1/feed')) return 'note'

	// Logged-in user profile.
	if (path.includes('/v2/user/me') || path.includes('/user/me') || path.includes('user_me')) return 'user_me'

	// Search results.
	if (path.includes('/search/notes') || path.includes('/v1/search')) return 'search'

	// User profile notes listing.
	if (path.includes('/user_posted') || path.includes('userposted')) return 'user_notes'

	// Notification list, including the in-app tabs (`/v1/you/mentions`, likes,
	// connections) that the notification page fetches per tab.
	if (path.includes('/notification') || path.includes('/notice')) return 'notifications'
	if (path.includes('/v1/you/') || path.includes('/you/mentions') || path.includes('/you/likes') || path.includes('/you/connections')) {
		return 'notifications'
	}

	// Chat / IM: conversation-list and message routes carry content; emoji,
	// version, following, unread and detect routes are page furniture.
	if (path.includes('/im/') || path.includes('/chat/') || path.includes('/message/')) {
		if (/(?:emoji|redmoji|version|following|unread|config|scripting|detect)/.test(path)) return 'unknown'
		if (/(?:message|msg|history|record)/.test(path)) return 'chat_messages'
		if (/(?:conversation|session|contact|thread|list|chats)/.test(path)) return 'chat_conversations'
		return 'unknown'
	}

	// Note detail endpoints (/v1/note/...).
	if (path.includes('/note/')) return 'note_detail_by_id'

	// Fuzzy fallbacks for versioned / renamed paths.
	if (path.includes('comment')) return path.includes('sub') ? 'subcomments' : 'comments'
	if (path.includes('search')) return 'search'
	if (path.includes('user_posted') || path.includes('userposted')) return 'user_notes'
	if (path.includes('user/me') || path.includes('user_me')) return 'user_me'
	if (path.includes('notification') || path.includes('notice')) return 'notifications'
	if (path.includes('message') || path.includes('msg')) return path.includes('conversation') || path.includes('session')
		? 'chat_conversations'
		: 'chat_messages'
	if (path.includes('conversation') || path.includes('session')) return 'chat_conversations'
	if (path.includes('feed')) return 'note'
	if (path.includes('note')) return 'note_detail_by_id'
	if (/(?:^|[/_-])(?:im|chat)(?:[/_-]|$)/.test(path)) return classifyChatPath(path)
	return 'unknown'
}

/**
 * Decide conversation-list vs message-list for chat paths.
 * @param {string} path lower-cased URL path.
 * @returns {'chat_conversations'|'chat_messages'} chat kind.
 */
function classifyChatPath(path) {
	if (/(?:message|msg|history|record)/.test(path)) return 'chat_messages'
	if (/(?:conversation|session|contact|thread|list)/.test(path)) return 'chat_conversations'
	return 'chat_conversations'
}

/**
 * Extract the note id referenced by a capture request/response.
 * @param {Capture} capture capture.
 * @returns {string|undefined} note id.
 */
function noteIdFromCapture(capture) {
	const reqBody = asObject(capture?.reqBody)
	const data = asObject(asObject(capture?.body).data)
	const firstComment = asObject(asArray(data.comments)[0])
	return firstText(
		reqBody.note_id,
		reqBody.noteId,
		data.note_id,
		data.noteId,
		firstComment.note_id,
		firstComment.noteId
	) || undefined
}

/**
 * Extract the parent comment id for a sub-comment page request.
 * @param {Capture} capture capture.
 * @returns {string|undefined} root comment id.
 */
function parentCommentIdFromCapture(capture) {
	const reqBody = asObject(capture?.reqBody)
	const data = asObject(asObject(capture?.body).data)
	return firstText(
		reqBody.root_comment_id,
		reqBody.rootCommentId,
		reqBody.parent_comment_id,
		reqBody.parentCommentId,
		reqBody.comment_id,
		reqBody.commentId,
		data.root_comment_id,
		data.rootCommentId
	) || undefined
}

/**
 * Extract the conversation id referenced by a capture URL/body.
 * @param {Capture} capture capture.
 * @returns {string|undefined} conversation id.
 */
function conversationIdFromCapture(capture) {
	const reqBody = asObject(capture?.reqBody)
	const data = asObject(asObject(capture?.body).data)
	const direct = firstText(
		reqBody.conversation_id,
		reqBody.conversationId,
		reqBody.chat_id,
		reqBody.chatId,
		reqBody.session_id,
		reqBody.sessionId,
		data.conversation_id,
		data.conversationId,
		data.chat_id,
		data.chatId,
		data.session_id,
		data.sessionId
	)
	if (direct) return direct
	try {
		const url = new URL(text(capture?.url), 'https://www.xiaohongshu.com')
		return firstText(
			url.searchParams.get('conversation_id'),
			url.searchParams.get('chat_id'),
			url.searchParams.get('session_id')
		) || undefined
	} catch {
		return undefined
	}
}

/**
 * Normalize one recorder capture into structured records.
 *
 * Unknown or malformed captures return `{ kind, records: [], raw, sourceUrl }`
 * and never throw. Chat captures intentionally emit both conversation and
 * message records when the shape allows it; callers filter by `record.type`.
 *
 * @param {Capture} capture recorder capture.
 * @returns {NormalizedCapture} normalized capture.
 */
export function normalizeCapture(capture) {
	const sourceUrl = typeof capture === 'object' && capture !== null && typeof capture.url === 'string'
		? capture.url
		: ''
	const body = typeof capture === 'object' && capture !== null ? capture.body : undefined
	const capturedAt = toIso(capture?.capturedAt) ?? nowIso()
	const kind = classify(sourceUrl)
	const withSource = (records) => records.map((record) => ({
		...record,
		collectedAt: capturedAt,
		sourceUrl: sourceUrl || record.sourceUrl
	}))
	try {
		switch (kind) {
			case 'note':
			case 'note_detail_by_id':
			case 'search':
			case 'user_notes': {
				const records = cardsFromBody(body)
					.map((card) => noteFromCard(card, { url: sourceUrl, kind, collectedAt: capturedAt }))
					.filter(Boolean)
				return { kind, records: withSource(dedupeById(records)), raw: body, sourceUrl }
			}
			case 'comments':
				return {
					kind,
					records: withSource(commentsFromPage(body, noteIdFromCapture(capture))),
					raw: body,
					sourceUrl
				}
			case 'subcomments': {
				const noteId = noteIdFromCapture(capture)
				const parentId = parentCommentIdFromCapture(capture)
				const records = commentsFromPage(body, noteId).map((record) => (
					record.parentId
						? record
						: { ...record, parentId: parentId ?? null, subComments: asArray(record.subComments) }
				))
				return { kind, records: withSource(records), raw: body, sourceUrl }
			}
			case 'user_me':
				return {
					kind,
					records: userRecordsFromBody(body, { sourceUrl, collectedAt: capturedAt }),
					raw: body,
					sourceUrl
				}
			case 'chat_conversations':
			case 'chat_messages': {
				const conversationId = conversationIdFromCapture(capture)
				const conversations = conversationsFromAny(body)
				const messages = messagesFromAny(body, conversationId)
				return {
					kind,
					records: withSource(dedupeById([...conversations, ...messages])),
					raw: body,
					sourceUrl
				}
			}
			case 'notifications':
				return {
					kind,
					records: withSource(notificationsFromAny(body)),
					raw: body,
					sourceUrl
				}
			default:
				return { kind, records: [], raw: body, sourceUrl }
		}
	} catch {
		return { kind, records: [], raw: body, sourceUrl }
	}
}

/**
 * Merge two captures of the same record (used by Store#save for notes).
 *
 * Rules:
 * - scalars: the incoming non-empty value wins, so a later capture can add
 *   detail; empty incoming values never erase existing data;
 * - arrays (images, tags, subComments, notes): union, duplicates merged by
 *   id/url/name so nested comments get richer instead of being replaced;
 * - `stats`: per-key maximum (comment/like counters only grow);
 * - `raw`: stacked (array of captures) when the two payloads differ, so no
 *   source payload is lost.
 *
 * @param {any} existing stored record (may be null/undefined).
 * @param {any} incoming new record (may be null/undefined).
 * @returns {any} merged record.
 */
export function mergeRecord(existing, incoming) {
	if (existing === undefined || existing === null) return incoming
	if (incoming === undefined || incoming === null) return existing
	if (!isPlainObject(existing) || !isPlainObject(incoming)) return incoming
	const merged = { ...existing }
	for (const [key, value] of Object.entries(incoming)) {
		if (value === undefined || value === null) continue
		const current = merged[key]
		if (key === 'raw') {
			merged.raw = mergeRaw(current, value)
			continue
		}
		if (key === 'stats') {
			merged.stats = mergeStats(current, value)
			continue
		}
		if (Array.isArray(value)) {
			merged[key] = mergeArrays(current, value)
			continue
		}
		if (isPlainObject(value)) {
			merged[key] = isPlainObject(current) ? mergeRecord(current, value) : value
			continue
		}
		if (typeof value === 'string' && value === '' && typeof current === 'string' && current !== '') continue
		if (MAX_FIELDS.has(key) && typeof current === 'number' && typeof value === 'number') {
			merged[key] = Math.max(current, value)
			continue
		}
		merged[key] = value
	}
	if (!merged.type && incoming.type) merged.type = incoming.type
	if (!merged.id && incoming.id) merged.id = incoming.id
	if (!merged.collectedAt) merged.collectedAt = incoming.collectedAt ?? existing.collectedAt
	return merged
}

/**
 * Merge two stats objects, keeping the larger counter for every key.
 * @param {unknown} current existing stats.
 * @param {unknown} incoming incoming stats.
 * @returns {Record<string, number|undefined>} merged stats.
 */
function mergeStats(current, incoming) {
	const merged = { ...asObject(current) }
	for (const [key, value] of Object.entries(asObject(incoming))) {
		const previous = merged[key]
		const previousNumber = typeof previous === 'number' ? previous : parseCount(previous)
		const nextNumber = typeof value === 'number' ? value : parseCount(value)
		if (previousNumber !== undefined && nextNumber !== undefined) {
			merged[key] = Math.max(previousNumber, nextNumber)
		} else if (nextNumber !== undefined) {
			merged[key] = nextNumber
		} else if (previous === undefined || previous === null || previous === '') {
			merged[key] = value
		}
	}
	return merged
}

/**
 * Stack raw payloads from repeated captures without duplicating identical ones.
 * @param {unknown} current existing raw.
 * @param {unknown} incoming incoming raw.
 * @returns {unknown} raw payload or array of payloads.
 */
function mergeRaw(current, incoming) {
	if (current === undefined || current === null) return incoming
	if (incoming === undefined || incoming === null) return current
	const incomingSignature = safeStringify(incoming)
	if (Array.isArray(current)) {
		return current.some((entry) => safeStringify(entry) === incomingSignature)
			? current
			: [...current, incoming]
	}
	if (safeStringify(current) === incomingSignature) return current
	return [current, incoming]
}

/**
 * Stable identity of an array element for merge purposes.
 * @param {unknown} item array element.
 * @returns {unknown} identity value.
 */
function itemIdentity(item) {
	if (!isPlainObject(item)) return undefined
	return firstDefined(item.id, item.url, item.url_default, item.urlDefault, item.name)
}

/**
 * Union two arrays, merging object duplicates (by id/url/name) recursively.
 * @param {unknown} current existing array (or anything).
 * @param {unknown[]} incoming incoming array.
 * @returns {unknown[]} merged array.
 */
function mergeArrays(current, incoming) {
	const merged = Array.isArray(current) ? [...current] : []
	for (const item of incoming) {
		if (item === undefined || item === null) continue
		if (typeof item === 'object') {
			const identity = itemIdentity(item)
			const signature = identity === undefined ? safeStringify(item) : undefined
			const index = merged.findIndex((existing) => {
				if (!isPlainObject(existing)) return false
				if (identity !== undefined) return itemIdentity(existing) === identity
				return safeStringify(existing) === signature
			})
			if (index === -1) {
				merged.push(item)
			} else {
				merged[index] = mergeRecord(merged[index], item)
			}
			continue
		}
		if (!merged.includes(item)) merged.push(item)
	}
	return merged
}

/**
 * One-line, model-readable rendering of a record.
 * @param {Record<string, any>} record normalized record.
 * @returns {string} summary line.
 */
function formatRecordLine(record) {
	const type = text(record.type) || 'unknown'
	switch (type) {
		case 'note': {
			const stats = asObject(record.stats)
			const author = asObject(record.author)
			return `[note] ${clip(record.title ?? record.desc, 60) || '(untitled)'} | @${clip(author.nickname, 20) || '?'} | 赞${formatCount(stats.liked)} 藏${formatCount(stats.collected)} 评${formatCount(stats.comments)} | ${text(record.id)}`
		}
		case 'comment': {
			const author = asObject(record.author)
			return `[comment] ${clip(record.content, 60) || '(empty)'} | @${clip(author.nickname, 20) || '?'} | 赞${formatCount(record.likeCount)} | ${text(record.id)}`
		}
		case 'chat_message': {
			const from = asObject(record.from)
			return `[chat_message] @${clip(from.nickname, 20) || '?'}: ${clip(record.text, 60)} | ${text(record.createdAt)}`
		}
		case 'chat_conversation': {
			const peer = asObject(record.peer)
			return `[chat_conversation] ${clip(peer.nickname, 30) || '?'} | ${clip(record.lastMessage, 60)} | 未读${formatCount(record.unreadCount)}`
		}
		case 'notification':
			return `[notification] ${clip(record.title, 60)} | ${clip(record.content, 60)} | ${text(record.createdAt)}`
		case 'user':
		case 'profile':
			return `[${type}] @${clip(record.nickname, 30) || '?'} | ${clip(record.desc, 60)} | ${text(record.id)}`
		default:
			return `[${type}] ${clip(firstText(record.title, record.content, record.text, record.id), 60)}`
	}
}

/**
 * Compact counter rendering for summaries (12000 -> '1.2万').
 * @param {unknown} value counter.
 * @returns {string} display counter.
 */
function formatCount(value) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		if (value >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万`
		return String(value)
	}
	const parsed = parseCount(value)
	if (parsed !== undefined) return formatCount(parsed)
	return '-'
}

/**
 * Render records as compact multi-line text for model/tool consumption: one
 * line per record with type, title (or content prefix), author and counters.
 *
 * @param {object[]} records normalized records.
 * @param {number} [maxChars] hard character budget (default 4000).
 * @returns {string} summary text.
 */
export function summarizeRecords(records, maxChars = 4000) {
	try {
		if (!Array.isArray(records)) return ''
		const budget = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0
			? Math.floor(maxChars)
			: 4000
		const lines = []
		let used = 0
		let omitted = 0
		for (const record of records) {
			if (!isPlainObject(record)) continue
			const line = formatRecordLine(record)
			if (!line) continue
			const separator = lines.length > 0 ? 1 : 0
			if (used + separator + line.length > budget) {
				omitted += 1
				continue
			}
			lines.push(line)
			used += separator + line.length
		}
		if (lines.length === 0) return ''
		if (omitted > 0) lines.push(`…另有 ${omitted} 条未展示`)
		const output = lines.join('\n')
		return output.length <= budget ? output : `${output.slice(0, Math.max(0, budget - 1))}…`
	} catch {
		return ''
	}
}
