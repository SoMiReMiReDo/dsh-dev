/**
 * Contract tests for `lib/normalize.mjs`.
 *
 * Fixtures mirror the public Xiaohongshu web responses (feed/search/comment/
 * sub-comment/user/IM/notification) and intentionally include missing fields,
 * empty bodies and non-JSON strings so the defensive contract is pinned.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
	classify,
	commentsFromPage,
	mergeRecord,
	messagesFromAny,
	noteFromCard,
	normalizeCapture,
	summarizeRecords
} from '../lib/normalize.mjs'

/** Load one JSON fixture relative to this test file. */
function fixture(name) {
	return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

const FEED = fixture('feed.json')
const SEARCH = fixture('search.json')
const COMMENTS = fixture('comments.json')
const COMMENTS_SUB = fixture('comments-sub.json')
const USER_ME = fixture('user-me.json')
const USER_GUEST = fixture('user-guest.json')
const CHAT_MESSAGES = fixture('chat-messages.json')
const CHAT_CONVERSATIONS = fixture('chat-conversations.json')
const CHAT_SKELETON = fixture('chat-unknown-skeleton.json')
const NOTIFICATIONS = fixture('notifications.json')
const EMPTY = fixture('empty.json')

const XHS = 'https://www.xiaohongshu.com'
const CAPTURED_AT = '2026-11-05T09:00:00.000Z'

/** Build one capture object from a fixture body. */
function capture(url, body, extra = {}) {
	return { url, method: 'GET', status: 200, capturedAt: CAPTURED_AT, body, ...extra }
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

test('classify 识别主要接口与模糊路径', () => {
	assert.equal(classify(`${XHS}/api/sns/web/v1/feed`), 'note')
	assert.equal(classify(`${XHS}/api/sns/web/v1/feed?cursor=1`), 'note')
	assert.equal(classify(`${XHS}/api/sns/web/v1/note/detail?note_id=x`), 'note_detail_by_id')
	assert.equal(classify(`${XHS}/api/sns/web/v2/comment/page?note_id=x`), 'comments')
	assert.equal(classify(`${XHS}/api/sns/web/v2/comment/sub/page?note_id=x`), 'subcomments')
	assert.equal(classify(`${XHS}/api/sns/web/v1/search/notes?keyword=x`), 'search')
	assert.equal(classify(`${XHS}/api/sns/web/v1/user_posted?num=30`), 'user_notes')
	assert.equal(classify(`${XHS}/api/sns/web/v2/user/me`), 'user_me')
	assert.equal(classify(`${XHS}/api/sns/web/v1/im/message/list`), 'chat_messages')
	assert.equal(classify(`${XHS}/api/sns/web/v1/im/session/list`), 'chat_conversations')
	assert.equal(classify(`${XHS}/api/sns/web/v1/chat/history`), 'chat_messages')
	assert.equal(classify(`${XHS}/api/sns/web/v1/notification/list`), 'notifications')
	// 模糊规则：多一层版本段 / 无 /api 前缀
	assert.equal(classify(`${XHS}/api/sns/web/v9/some/search/anything`), 'search')
	assert.equal(classify(`${XHS}/x/user_posted_v2`), 'user_notes')
	assert.equal(classify(`${XHS}/x/message/list`), 'chat_messages')
	assert.equal(classify(`${XHS}/x/conversation/list`), 'chat_conversations')
	assert.equal(classify(`${XHS}/x/comment/sub/list`), 'subcomments')
	assert.equal(classify(`${XHS}/x/comment/list`), 'comments')
	// 非 URL / 非字符串 / 未知路径
	assert.equal(classify('https://example.com/data.json'), 'unknown')
	assert.equal(classify(''), 'unknown')
	assert.equal(classify(null), 'unknown')
	assert.equal(classify(42), 'unknown')
})

// ---------------------------------------------------------------------------
// note_card
// ---------------------------------------------------------------------------

test('noteFromCard 解析正常卡片（数量字符串、图片、标签、作者）', () => {
	const card = FEED.data.items[0].note_card
	const note = noteFromCard(card, { url: `${XHS}/api/sns/web/v1/feed`, collectedAt: CAPTURED_AT })
	assert.ok(note)
	assert.equal(note.type, 'note')
	assert.equal(note.id, '66f0a1b2c3d4e5f60718293a')
	assert.equal(note.title, '周末露营装备清单｜新手也能抄作业')
	assert.ok(note.desc.startsWith('第一次露营别乱买'))
	assert.equal(note.author.id, '5f1e2d3c4b5a69788796a5b4')
	assert.equal(note.author.nickname, '山野小满')
	assert.ok(note.author.avatarUrl.endsWith('/abc.jpg'))
	assert.equal(note.images.length, 3)
	assert.ok(note.images[0].url.endsWith('/aaa.jpg'))
	assert.ok(note.images[1].url.endsWith('/bbb-pre.jpg'))
	// info_list 优先选 WB_DFT 场景
	assert.ok(note.images[2].url.endsWith('/ccc-dft.jpg'))
	assert.equal(note.images[0].width, 1080)
	assert.equal(note.stats.liked, 12000)
	assert.equal(note.stats.collected, 3456)
	assert.equal(note.stats.comments, 128)
	assert.equal(note.stats.shared, 89)
	assert.deepEqual(note.tags, ['露营', '周末去哪儿'])
	assert.equal(note.video, null)
	assert.equal(note.noteType, 'normal')
	assert.equal(note.ipLocation, '浙江')
	assert.equal(note.publishedAt, new Date(1727180000000).toISOString())
	assert.equal(note.sourceUrl, `${XHS}/api/sns/web/v1/feed`)
	assert.equal(note.collectedAt, CAPTURED_AT)
	assert.ok(note.url.startsWith('https://www.xiaohongshu.com/explore/66f0a1b2c3d4e5f60718293'))
})

test('noteFromCard 解析视频卡片并回退封面', () => {
	const video = noteFromCard(FEED.data.items[1].note_card)
	assert.ok(video)
	assert.equal(video.noteType, 'video')
	assert.equal(video.video.url, 'https://video.example.com/stream/coffee.mp4')
	assert.equal(video.video.duration, 185)
	assert.ok(video.video.coverUrl.endsWith('/cover.jpg'))
})

test('noteFromCard 容忍缺字段 / 空卡片 / 非对象', () => {
	const partial = noteFromCard(FEED.data.items[2].note_card)
	assert.ok(partial)
	assert.equal(partial.id, '66f0a1b2c3d4e5f60718293c')
	assert.equal(partial.title, '只有正文没有标题，也没有计数。')
	assert.equal(partial.stats.liked, undefined)
	assert.equal(partial.video, null)
	assert.deepEqual(partial.images, [])
	assert.deepEqual(partial.tags, [])
	assert.equal(partial.author.id, undefined)
	assert.equal(noteFromCard(null), undefined)
	assert.equal(noteFromCard(undefined), undefined)
	assert.equal(noteFromCard('not-a-card'), undefined)
	assert.equal(noteFromCard({}), undefined)
	assert.equal(noteFromCard([]), undefined)
})

test('noteFromCard 支持 feed 包裹对象并带上 xsec_token', () => {
	const note = noteFromCard(FEED.data.items[0])
	assert.ok(note)
	assert.equal(note.id, '66f0a1b2c3d4e5f60718293a')
	assert.ok(note.url.includes('xsec_token=ABtoken123'))
})

// ---------------------------------------------------------------------------
// normalizeCapture
// ---------------------------------------------------------------------------

test('normalizeCapture(feed) 产出 note 记录并保留来源', () => {
	const result = normalizeCapture(capture(`${XHS}/api/sns/web/v1/feed`, FEED))
	assert.equal(result.kind, 'note')
	assert.equal(result.raw, FEED)
	assert.equal(result.sourceUrl, `${XHS}/api/sns/web/v1/feed`)
	assert.equal(result.records.length, 3)
	for (const record of result.records) {
		assert.equal(record.type, 'note')
		assert.equal(record.collectedAt, CAPTURED_AT)
		assert.equal(record.sourceUrl, result.sourceUrl)
	}
	assert.equal(result.records[0].stats.liked, 12000)
})

test('normalizeCapture(search) 解析 items[].note_card', () => {
	const result = normalizeCapture(capture(`${XHS}/api/sns/web/v1/search/notes`, SEARCH))
	assert.equal(result.kind, 'search')
	assert.equal(result.records.length, 2)
	assert.equal(result.records[0].id, 'note-search-1')
	assert.equal(result.records[0].title, '上海咖啡地图｜12 家私藏小店')
	assert.ok(result.records[0].url.includes('xsec_token=SEARCHtoken1'))
	assert.equal(result.records[1].id, 'note-search-2')
})

test('normalizeCapture(comments) 保留楼中楼嵌套结构', () => {
	const result = normalizeCapture(capture(`${XHS}/api/sns/web/v2/comment/page`, COMMENTS))
	assert.equal(result.kind, 'comments')
	assert.equal(result.records.length, 3)
	const top = result.records[0]
	assert.equal(top.id, 'c1')
	assert.equal(top.noteId, undefined)
	assert.equal(top.parentId, null)
	assert.equal(top.likeCount, 12000)
	assert.equal(top.subCommentCount, 3)
	assert.equal(top.ipLocation, '广东')
	assert.equal(top.createdAt, new Date(1727180100000).toISOString())
	assert.equal(top.subComments.length, 2)
	assert.equal(top.subComments[0].parentId, 'c1')
	assert.equal(top.subComments[0].type, 'comment')
	assert.equal(top.subComments[1].content, '楼主回复：记得买天幕')
	assert.equal(result.records[2].id, 'c3')
	assert.equal(result.records[2].content, '')
})

test('normalizeCapture(subcomments) 从 reqBody 补 noteId / parentId', () => {
	const result = normalizeCapture(capture(`${XHS}/api/sns/web/v2/comment/sub/page`, COMMENTS_SUB, {
		reqBody: { note_id: 'note-x', root_comment_id: 'c1', cursor: '' }
	}))
	assert.equal(result.kind, 'subcomments')
	assert.equal(result.records.length, 1)
	assert.equal(result.records[0].id, 'c1-3')
	assert.equal(result.records[0].noteId, 'note-x')
	assert.equal(result.records[0].parentId, 'c1')
})

test('normalizeCapture(user_me) 产出 user 记录，guest 返回空数组', () => {
	const me = normalizeCapture(capture(`${XHS}/api/sns/web/v2/user/me`, USER_ME))
	assert.equal(me.kind, 'user_me')
	assert.equal(me.records.length, 1)
	assert.equal(me.records[0].type, 'user')
	assert.equal(me.records[0].id, '5f1e2d3c4b5a69788796a5b4')
	assert.equal(me.records[0].nickname, '山野小满')
	assert.ok(me.records[0].avatarUrl.endsWith('/me.jpg'))

	const guest = normalizeCapture(capture(`${XHS}/api/sns/web/v2/user/me`, USER_GUEST))
	assert.equal(guest.kind, 'user_me')
	assert.deepEqual(guest.records, [])
})

test('normalizeCapture(chat) 同时产出消息与会话记录', () => {
	const messagesResult = normalizeCapture(capture(`${XHS}/api/sns/web/v1/im/message/list`, CHAT_MESSAGES))
	assert.equal(messagesResult.kind, 'chat_messages')
	const messages = messagesResult.records.filter((record) => record.type === 'chat_message')
	assert.equal(messages.length, 3)
	assert.equal(messages[0].id, 'm1')
	assert.equal(messages[0].conversationId, 'conv-1')
	assert.equal(messages[0].from.nickname, '山野小满')
	assert.equal(messages[0].text, '你好，露营灯还有吗？')
	assert.equal(messages[0].createdAt, new Date(1727600000000).toISOString())
	assert.equal(messages[1].text, '有的，还剩两个')
	assert.equal(messages[1].images.length, 1)
	assert.equal(messages[2].text, '那我要一个')

	const sessionsResult = normalizeCapture(capture(`${XHS}/api/sns/web/v1/im/session/list`, CHAT_CONVERSATIONS))
	assert.equal(sessionsResult.kind, 'chat_conversations')
	const conversations = sessionsResult.records.filter((record) => record.type === 'chat_conversation')
	assert.equal(conversations.length, 2)
	assert.equal(conversations[0].id, 'conv-1')
	assert.equal(conversations[0].peer.nickname, '山野小满')
	assert.equal(conversations[0].unreadCount, 2)
	assert.equal(conversations[0].lastMessage, '那我要一个')
	assert.equal(conversations[1].id, 'conv-2')
	assert.equal(conversations[1].unreadCount, 0)
})

test('normalizeCapture(notifications) 解析通知列表', () => {
	const result = normalizeCapture(capture(`${XHS}/api/sns/web/v1/notification/list`, NOTIFICATIONS))
	assert.equal(result.kind, 'notifications')
	assert.equal(result.records.length, 3)
	const first = result.records[0]
	assert.equal(first.type, 'notification')
	assert.equal(first.id, 'n1')
	assert.equal(first.category, 'like')
	assert.equal(first.title, '赞了你的笔记')
	assert.equal(first.actor.id, 'u1')
	assert.equal(first.actor.nickname, '山野小满')
	assert.equal(first.noteId, 'note-1')
	assert.equal(first.createdAt, new Date(1727700000000).toISOString())
	assert.ok(result.records[2].id.startsWith('ntf_'))
})

test('normalizeCapture 对空 body / 非 JSON / 畸形输入不抛错', () => {
	const empty = normalizeCapture(capture(`${XHS}/api/sns/web/v1/feed`, EMPTY))
	assert.equal(empty.kind, 'note')
	assert.deepEqual(empty.records, [])

	const emptyComments = normalizeCapture(capture(`${XHS}/api/sns/web/v2/comment/page`, EMPTY))
	assert.equal(emptyComments.kind, 'comments')
	assert.deepEqual(emptyComments.records, [])

	const unknown = normalizeCapture(capture('https://example.com/data.json', { anything: true }))
	assert.equal(unknown.kind, 'unknown')
	assert.deepEqual(unknown.records, [])
	assert.deepEqual(unknown.raw, { anything: true })

	const cases = [
		null,
		undefined,
		{},
		{ url: null, body: null },
		capture(`${XHS}/api/sns/web/v1/feed`, 'not json at all'),
		capture(`${XHS}/api/sns/web/v1/feed`, []),
		capture(`${XHS}/api/sns/web/v2/comment/page`, 'plain text'),
		capture(`${XHS}/api/sns/web/v1/im/message/list`, CHAT_SKELETON),
		capture(`${XHS}/api/sns/web/v1/notification/list`, 42)
	]
	for (const sample of cases) {
		let result
		assert.doesNotThrow(() => {
			result = normalizeCapture(sample)
		})
		assert.ok(Array.isArray(result.records))
		assert.equal(typeof result.kind, 'string')
	}
})

// ---------------------------------------------------------------------------
// isolated extractors
// ---------------------------------------------------------------------------

test('commentsFromPage 容忍 null / 字符串 / 畸形评论项', () => {
	assert.deepEqual(commentsFromPage(null), [])
	assert.deepEqual(commentsFromPage(undefined), [])
	assert.deepEqual(commentsFromPage('x'), [])
	assert.deepEqual(commentsFromPage({ data: { comments: 'nope' } }), [])
	const records = commentsFromPage({ data: { comments: [null, 1, 'a', { id: 'cx' }] } }, 'note-z')
	assert.equal(records.length, 1)
	assert.equal(records[0].id, 'cx')
	assert.equal(records[0].noteId, 'note-z')
	assert.equal(records[0].content, '')
})

test('messagesFromAny 启发式找消息，找不到返回 []', () => {
	const messages = messagesFromAny(CHAT_MESSAGES)
	assert.equal(messages.length, 3)
	assert.equal(messages[0].type, 'chat_message')
	assert.equal(messages[0].from.nickname, '山野小满')

	const withConversation = messagesFromAny(CHAT_MESSAGES, 'conv-override')
	assert.equal(withConversation[0].conversationId, 'conv-override')

	assert.deepEqual(messagesFromAny(CHAT_SKELETON), [])
	assert.deepEqual(messagesFromAny(null), [])
	assert.deepEqual(messagesFromAny('x'), [])
	assert.deepEqual(messagesFromAny([]), [])
	assert.deepEqual(messagesFromAny({ data: { list: [{ content: 'no sender' }] } }), [])
})

// ---------------------------------------------------------------------------
// mergeRecord
// ---------------------------------------------------------------------------

test('mergeRecord 保留更完整字段、互动数取 max、数组去重合并', () => {
	const existing = {
		type: 'note',
		id: 'n1',
		title: '旧标题',
		desc: '',
		stats: { liked: 10, comments: 5 },
		images: [{ url: 'https://img/a.jpg', width: 1, height: 1 }],
		tags: ['旧'],
		collectedAt: '2026-01-01T00:00:00.000Z',
		raw: { capture: 'first' }
	}
	const incoming = {
		type: 'note',
		id: 'n1',
		title: '新标题',
		desc: '补上的描述',
		stats: { liked: 20, comments: 8 },
		images: [{ url: 'https://img/a.jpg', width: 2, height: 2 }, { url: 'https://img/b.jpg' }],
		tags: ['旧', '新'],
		collectedAt: '2026-02-01T00:00:00.000Z',
		raw: { capture: 'second' }
	}
	const merged = mergeRecord(existing, incoming)
	assert.equal(merged.title, '新标题')
	assert.equal(merged.desc, '补上的描述')
	assert.equal(merged.stats.liked, 20)
	assert.equal(merged.stats.comments, 8)
	assert.equal(merged.images.length, 2)
	assert.equal(merged.images[0].width, 2)
	assert.deepEqual(merged.tags, ['旧', '新'])
	assert.equal(merged.collectedAt, '2026-02-01T00:00:00.000Z')
	assert.ok(Array.isArray(merged.raw))
	assert.equal(merged.raw.length, 2)
	// 空值不覆盖已有内容
	const kept = mergeRecord({ title: 'A', desc: 'D' }, { title: '', desc: '' })
	assert.equal(kept.title, 'A')
	assert.equal(kept.desc, 'D')
	// null 兜底
	assert.deepEqual(mergeRecord(null, incoming), incoming)
	assert.deepEqual(mergeRecord(existing, null), existing)
	assert.equal(mergeRecord('x', { id: 'y' }).id, 'y')
})

test('mergeRecord 合并楼中楼 subComments（按 id 取更完整者）', () => {
	const existing = {
		type: 'comment',
		id: 'c1',
		parentId: null,
		content: '旧内容',
		subComments: [{ id: 's1', parentId: 'c1', content: 's1 旧', likeCount: 1 }]
	}
	const incoming = {
		type: 'comment',
		id: 'c1',
		parentId: null,
		content: '新内容',
		subComments: [
			{ id: 's1', parentId: 'c1', content: 's1 新', likeCount: 9 },
			{ id: 's2', parentId: 'c1', content: 's2 新增' }
		]
	}
	const merged = mergeRecord(existing, incoming)
	assert.equal(merged.content, '新内容')
	assert.equal(merged.subComments.length, 2)
	assert.equal(merged.subComments.find((item) => item.id === 's1').content, 's1 新')
	assert.equal(merged.subComments.find((item) => item.id === 's1').likeCount, 9)
	assert.ok(merged.subComments.find((item) => item.id === 's2'))
})

// ---------------------------------------------------------------------------
// summarizeRecords
// ---------------------------------------------------------------------------

test('summarizeRecords 每行一条并带作者/互动数', () => {
	const records = normalizeCapture(capture(`${XHS}/api/sns/web/v1/feed`, FEED)).records
	const summary = summarizeRecords(records)
	const lines = summary.split('\n')
	assert.equal(lines.length, 3)
	assert.ok(lines[0].startsWith('[note]'))
	assert.ok(lines[0].includes('露营'))
	assert.ok(lines[0].includes('@山野小满'))
	assert.ok(lines[0].includes('赞1.2万'))
	assert.ok(lines[0].includes('66f0a1b2c3d4e5f60718293a'))
	assert.ok(lines[1].includes('@咖啡阿哲'))
})

test('summarizeRecords 遵守 maxChars 并追加省略提示', () => {
	const records = normalizeCapture(capture(`${XHS}/api/sns/web/v1/feed`, FEED)).records
	const limited = summarizeRecords(records, 120)
	assert.ok(limited.length <= 120)
	assert.ok(limited.includes('…'))
	assert.ok(limited.includes('另有'))
})

test('summarizeRecords 对空输入/非数组返回空串且不抛错', () => {
	assert.equal(summarizeRecords([]), '')
	assert.equal(summarizeRecords(null), '')
	assert.equal(summarizeRecords(undefined), '')
	assert.equal(summarizeRecords('x'), '')
	assert.equal(summarizeRecords([null, 1, 'a']), '')
})
