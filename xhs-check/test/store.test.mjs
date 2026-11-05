/**
 * Contract tests for `lib/store.mjs`.
 *
 * Every test uses a fresh temporary directory under `os.tmpdir()` (cleaned up
 * through `t.after`) so the suite never touches the real data directory.
 * Coverage: first write, repeated-write merge, index corruption recovery,
 * list filtering/pagination, comment dedupe, concurrent `saveMany`, counts,
 * raw dumps, profile/notification extensions and relative-path guarantees.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../lib/store.mjs'
import { normalizeCapture } from '../lib/normalize.mjs'

const XHS = 'https://www.xiaohongshu.com'
const CAPTURED_AT = '2026-11-05T09:00:00.000Z'

/** Load one JSON fixture relative to this test file. */
function fixture(name) {
	return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

const FEED = fixture('feed.json')
const COMMENTS = fixture('comments.json')
const CHAT_MESSAGES = fixture('chat-messages.json')
const NOTIFICATIONS = fixture('notifications.json')
const USER_ME = fixture('user-me.json')

/** Feed captures normalized once; each save test clones records it mutates. */
function noteRecords() {
	return normalizeCapture({
		url: `${XHS}/api/sns/web/v1/feed`,
		capturedAt: CAPTURED_AT,
		body: FEED
	}).records
}

/** Comment records from the comment-page fixture. */
function commentRecords() {
	return normalizeCapture({
		url: `${XHS}/api/sns/web/v2/comment/page`,
		capturedAt: CAPTURED_AT,
		body: COMMENTS
	}).records
}

/** Chat message records from the IM fixture. */
function chatMessageRecords() {
	return normalizeCapture({
		url: `${XHS}/api/sns/web/v1/im/message/list`,
		capturedAt: CAPTURED_AT,
		body: CHAT_MESSAGES
	}).records.filter((record) => record.type === 'chat_message')
}

/** Notification records from the notification fixture. */
function notificationRecords() {
	return normalizeCapture({
		url: `${XHS}/api/sns/web/v1/notification/list`,
		capturedAt: CAPTURED_AT,
		body: NOTIFICATIONS
	}).records
}

/** Create an initialized store in a fresh temp dir, auto-cleaned after test. */
async function tempStore(t) {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-xhs-store-'))
	t.after(async () => {
		await rm(dir, { recursive: true, force: true })
	})
	const store = new Store(dir)
	await store.init()
	return { dir, store }
}

/** Read a JSON file under the temp dir. */
async function readJson(dir, rel) {
	return JSON.parse(await readFile(join(dir, rel), 'utf8'))
}

/** Assert a returned path is relative and points at a real file. */
async function assertRelativeFile(dir, rel) {
	assert.equal(typeof rel, 'string')
	assert.ok(rel.length > 0)
	assert.ok(!rel.startsWith('/'), `absolute path leaked: ${rel}`)
	assert.ok(!rel.includes('..'), `traversal path leaked: ${rel}`)
	assert.ok(!rel.includes(dir), `data dir leaked: ${rel}`)
	const info = await stat(join(dir, rel))
	assert.ok(info.isFile(), `file missing: ${rel}`)
}

// ---------------------------------------------------------------------------
// init / first write
// ---------------------------------------------------------------------------

test('init 创建目录布局与空 index', async (t) => {
	const { dir, store } = await tempStore(t)
	for (const name of ['notes', 'comments', 'searches', 'profiles', 'chats', 'notifications', 'raw']) {
		const info = await stat(join(dir, name))
		assert.ok(info.isDirectory(), `${name} should be a directory`)
	}
	const index = await readJson(dir, 'index.json')
	assert.deepEqual(index.entries, [])
	const counts = await store.counts()
	for (const key of ['note', 'comment', 'chat_conversation', 'chat_message', 'notification', 'search', 'profile']) {
		assert.equal(counts[key], 0, `${key} should start at 0`)
	}
	// 幂等
	await store.init()
	assert.deepEqual((await store.list()).total, 0)
})

test('首次保存 note：原子文件、get、index、list', async (t) => {
	const { dir, store } = await tempStore(t)
	const [record] = noteRecords()
	const rel = await store.save(record)
	assert.equal(rel, `notes/${record.id}.json`)
	await assertRelativeFile(dir, rel)

	const doc = await readJson(dir, rel)
	assert.equal(doc.type, 'note')
	assert.equal(doc.title, record.title)
	assert.equal(doc.stats.liked, 12000)
	assert.equal(doc.id, record.id)

	const fromGet = await store.get('note', record.id)
	assert.equal(fromGet.id, record.id)
	assert.equal(fromGet.author.nickname, '山野小满')

	assert.equal((await store.get('note', 'missing-id')), undefined)
	const counts = await store.counts()
	assert.equal(counts.note, 1)
	assert.equal(counts.comment, 0)

	const listed = await store.list({ type: 'note' })
	assert.equal(listed.total, 1)
	assert.deepEqual(listed.items[0], {
		type: 'note',
		id: record.id,
		title: record.title,
		count: 1,
		collectedAt: CAPTURED_AT,
		path: rel
	})
})

test('重复保存同一 note 合并字段/互动数/图片/raw', async (t) => {
	const { dir, store } = await tempStore(t)
	const [record] = noteRecords()
	await store.save(record)

	const richer = {
		...record,
		desc: '第二次采集补上的完整描述',
		stats: { ...record.stats, comments: 999 },
		images: [...record.images, { url: 'https://img.example.com/extra.jpg', width: 1, height: 1 }],
		raw: { capture: 'second' }
	}
	await store.save(richer)

	const doc = await readJson(dir, `notes/${record.id}.json`)
	assert.equal(doc.desc, '第二次采集补上的完整描述')
	assert.equal(doc.stats.comments, 999)
	assert.equal(doc.stats.liked, 12000)
	assert.equal(doc.images.length, 4)
	assert.ok(Array.isArray(doc.raw))
	assert.equal(doc.raw.length, 2)

	const index = await readJson(dir, 'index.json')
	assert.equal(index.entries.filter((entry) => entry.type === 'note').length, 1)
	assert.equal((await store.counts()).note, 1)
})

// ---------------------------------------------------------------------------
// index recovery
// ---------------------------------------------------------------------------

test('index.json 损坏后 init 能重建', async (t) => {
	const { dir, store } = await tempStore(t)
	const [note] = noteRecords()
	await store.save(note)
	await store.saveComments('note-1', commentRecords())
	await writeFile(join(dir, 'index.json'), '{ this is not json', 'utf8')

	const fresh = new Store(dir)
	await fresh.init()
	const counts = await fresh.counts()
	assert.equal(counts.note, 1)
	assert.equal(counts.comment, 5)

	const listed = await fresh.list({ type: 'note' })
	assert.equal(listed.total, 1)
	assert.equal(listed.items[0].id, note.id)

	const rebuilt = await readJson(dir, 'index.json')
	assert.ok(Array.isArray(rebuilt.entries))
	assert.ok(rebuilt.entries.some((entry) => entry.type === 'note' && entry.id === note.id))
	assert.ok(rebuilt.entries.some((entry) => entry.type === 'comment' && entry.id === 'note-1'))
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('list 支持类型过滤、模糊查询与分页', async (t) => {
	const { store } = await tempStore(t)
	const [n1, n2, n3] = noteRecords()
	await store.save({ ...n1, collectedAt: '2026-01-01T00:00:00.000Z' })
	await store.save({ ...n2, collectedAt: '2026-01-02T00:00:00.000Z' })
	await store.save({ ...n3, collectedAt: '2026-01-03T00:00:00.000Z' })
	await store.saveComments('note-1', commentRecords())

	const page1 = await store.list({ type: 'note', limit: 2, offset: 0 })
	assert.equal(page1.total, 3)
	assert.equal(page1.items.length, 2)
	assert.equal(page1.items[0].id, n3.id) // newest first
	assert.equal(page1.items[1].id, n2.id)

	const page2 = await store.list({ type: 'note', limit: 2, offset: 2 })
	assert.equal(page2.total, 3)
	assert.equal(page2.items.length, 1)
	assert.equal(page2.items[0].id, n1.id)

	const beyond = await store.list({ type: 'note', limit: 2, offset: 10 })
	assert.deepEqual(beyond.items, [])
	assert.equal(beyond.total, 3)

	const byTitle = await store.list({ query: '露营' })
	assert.equal(byTitle.total, 1)
	assert.equal(byTitle.items[0].id, n1.id)

	const byAuthor = await store.list({ query: '咖啡阿哲' })
	assert.equal(byAuthor.total, 1)
	assert.equal(byAuthor.items[0].id, n2.id)

	const byDesc = await store.list({ query: '水流控制' })
	assert.equal(byDesc.total, 1)
	assert.equal(byDesc.items[0].id, n2.id)

	const comments = await store.list({ type: 'comment' })
	assert.equal(comments.total, 1)
	assert.equal(comments.items[0].id, 'note-1')
	assert.equal(comments.items[0].count, 5)
	assert.equal((await store.list({ limit: 2 })).total, 4)
})

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

test('saveComments 按 noteId 合并去重（含楼中楼）', async (t) => {
	const { dir, store } = await tempStore(t)
	const first = commentRecords()
	const firstResult = await store.saveComments('note-1', first)
	assert.equal(firstResult.path, 'comments/note-1.json')
	assert.equal(firstResult.saved, 3)
	await assertRelativeFile(dir, firstResult.path)

	const second = [
		{
			...first[0],
			content: '更新后的内容',
			subComments: [
				{ ...first[0].subComments[0], content: '已下单两次', likeCount: 30 },
				{ ...first[0].subComments[1] },
				{
					id: 'c1-3',
					type: 'comment',
					noteId: 'note-1',
					parentId: 'c1',
					content: '新增楼中楼',
					author: { id: 'user-f', nickname: '新朋友' },
					subComments: []
				}
			]
		},
		{ ...first[1] }, // 完全重复
		{
			id: 'c4',
			type: 'comment',
			noteId: 'note-1',
			parentId: null,
			content: '新增评论',
			author: { id: 'user-g', nickname: '新用户' },
			subComments: []
		}
	]
	const secondResult = await store.saveComments('note-1', second)
	assert.equal(secondResult.saved, 3)

	const doc = await readJson(dir, 'comments/note-1.json')
	assert.equal(doc.noteId, 'note-1')
	assert.equal(doc.comments.length, 4)
	const c1 = doc.comments.find((comment) => comment.id === 'c1')
	assert.equal(c1.content, '更新后的内容')
	assert.equal(c1.subComments.length, 3)
	assert.equal(c1.subComments.find((sub) => sub.id === 'c1-1').likeCount, 30)
	assert.equal(c1.subComments.find((sub) => sub.id === 'c1-1').content, '已下单两次')
	assert.ok(c1.subComments.find((sub) => sub.id === 'c1-3'))
	assert.equal(doc.comments.filter((comment) => comment.id === 'c2').length, 1)

	// 单独保存一条楼中楼会挂到父评论下
	await store.save({
		id: 'c1-4',
		type: 'comment',
		noteId: 'note-1',
		parentId: 'c1',
		content: '单独采集的楼中楼',
		author: { id: 'user-h', nickname: '单独' }
	})
	const after = await readJson(dir, 'comments/note-1.json')
	const parent = after.comments.find((comment) => comment.id === 'c1')
	assert.equal(parent.subComments.length, 4)
	assert.ok(parent.subComments.find((sub) => sub.id === 'c1-4'))

	const counts = await store.counts()
	assert.equal(counts.comment, 8) // 4 顶层 + 4 楼中楼
	const listed = await store.list({ type: 'comment' })
	assert.equal(listed.items[0].count, 8)
})

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

test('并发 saveMany 串行合并，index 无重复', async (t) => {
	const { dir, store } = await tempStore(t)
	const [base] = noteRecords()
	const make = (index) => ({
		...base,
		id: `note-concurrent-${index}`,
		title: `并发笔记 ${index}`,
		desc: `并发描述 ${index}`,
		collectedAt: `2026-03-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
	})
	const batches = [[0, 1, 2], [3, 4, 5], [6, 7, 8]]
	const results = await Promise.all(batches.map((batch) => store.saveMany(batch.map(make))))
	assert.equal(results.reduce((sum, result) => sum + result.saved, 0), 9)
	for (const result of results) {
		assert.equal(result.paths.length, 3)
		for (const rel of result.paths) await assertRelativeFile(dir, rel)
	}

	const noteFiles = (await readdir(join(dir, 'notes'))).filter((name) => name.endsWith('.json'))
	assert.equal(noteFiles.length, 9)
	const index = await readJson(dir, 'index.json')
	const noteEntries = index.entries.filter((entry) => entry.type === 'note')
	assert.equal(noteEntries.length, 9)
	assert.equal(new Set(noteEntries.map((entry) => entry.id)).size, 9)
	assert.equal((await store.counts()).note, 9)

	// 并发保存同一条记录也只会合并成一个文件
	await Promise.all([
		store.save({ ...base, title: '并发合并 A' }),
		store.save({ ...base, title: '并发合并 B' })
	])
	const merged = await readJson(dir, `notes/${base.id}.json`)
	assert.ok(['并发合并 A', '并发合并 B'].includes(merged.title))
	assert.equal((await store.counts()).note, 10)
})

// ---------------------------------------------------------------------------
// counts
// ---------------------------------------------------------------------------

test('counts 汇总各类型数量', async (t) => {
	const { store } = await tempStore(t)
	const notes = noteRecords()
	await store.save(notes[0])
	await store.saveComments('note-1', commentRecords())
	await store.saveSearch('露营装备', notes.slice(0, 2))
	await store.saveProfile('user-1', 'notes', notes.slice(0, 2), {
		sourceUrl: `${XHS}/user/profile/user-1`
	})
	await store.saveChat('conv-1', chatMessageRecords(), {
		peer: { id: 'u1', nickname: '山野小满' },
		lastMessage: '那我要一个'
	})
	await store.saveNotifications(notificationRecords())

	const counts = await store.counts()
	assert.equal(counts.note, 2) // notes[0] + notes[1]（search/profile 复用同一批 id）
	assert.equal(counts.comment, 5)
	assert.equal(counts.search, 1)
	assert.equal(counts.profile, 1)
	assert.equal(counts.chat_conversation, 1)
	assert.equal(counts.chat_message, 3)
	assert.equal(counts.notification, 3)
})

// ---------------------------------------------------------------------------
// raw
// ---------------------------------------------------------------------------

test('saveRaw 生成 slug + 时间戳的相对路径', async (t) => {
	const { dir, store } = await tempStore(t)
	const rel = await store.saveRaw('Feed Response! 001', { hello: 'world' })
	assert.match(rel, /^raw\/\d{8}-\d{6}-\d{3}-feed-response-001\.json$/)
	await assertRelativeFile(dir, rel)
	assert.deepEqual(await readJson(dir, rel), { hello: 'world' })

	const second = await store.saveRaw('Feed Response! 001', { hello: 'again' })
	assert.notEqual(second, rel)
	await assertRelativeFile(dir, second)
	assert.deepEqual(await readJson(dir, second), { hello: 'again' })
	assert.equal((await readdir(join(dir, 'raw'))).filter((name) => name.endsWith('.json')).length, 2)
})

// ---------------------------------------------------------------------------
// searches / chats
// ---------------------------------------------------------------------------

test('saveSearch / saveChat 落盘、合并与索引', async (t) => {
	const { dir, store } = await tempStore(t)
	const notes = noteRecords()
	const searchRel = await store.saveSearch('手冲咖啡 教程', notes.slice(0, 2), {
		sourceUrl: `${XHS}/search_result?keyword=coffee`
	})
	assert.ok(searchRel.startsWith('searches/'))
	await assertRelativeFile(dir, searchRel)
	const searchDoc = await readJson(dir, searchRel)
	assert.equal(searchDoc.query, '手冲咖啡 教程')
	assert.equal(searchDoc.notes.length, 2)
	assert.ok(searchDoc.sourceUrl.includes('search_result'))

	const searched = await store.list({ type: 'search' })
	assert.equal(searched.total, 1)
	assert.equal(searched.items[0].count, 2)
	assert.equal(searched.items[0].title, '手冲咖啡 教程')
	// 与 saveSearch 一致：命中的 note 也各自进 notes/
	const noteFiles = (await readdir(join(dir, 'notes'))).filter((name) => name.endsWith('.json'))
	assert.equal(noteFiles.length, 2)

	const messages = chatMessageRecords()
	const chatRel = await store.saveChat('conv-1', messages.slice(0, 2), {
		peer: { id: 'u1', nickname: '山野小满' }
	})
	assert.equal(chatRel, 'chats/conv-1.json')
	await assertRelativeFile(dir, chatRel)
	await store.saveChat('conv-1', [
		{ ...messages[0], text: '你好，露营灯还有吗？（补采）' },
		{
			id: 'm4',
			type: 'chat_message',
			conversationId: 'conv-1',
			text: '新的消息',
			from: { id: 'u2', nickname: '咖啡阿哲' },
			createdAt: '2026-11-05T09:10:00.000Z'
		}
	], {
		peer: { id: 'u1', nickname: '山野小满' },
		lastMessage: '新的消息'
	})
	const chatDoc = await readJson(dir, 'chats/conv-1.json')
	assert.equal(chatDoc.conversationId, 'conv-1')
	assert.equal(chatDoc.messages.length, 3)
	assert.equal(chatDoc.messages.find((message) => message.id === 'm1').text, '你好，露营灯还有吗？（补采）')
	assert.equal(chatDoc.peer.nickname, '山野小满')
	assert.equal(chatDoc.lastMessage, '新的消息')

	const counts = await store.counts()
	assert.equal(counts.chat_conversation, 1)
	assert.equal(counts.chat_message, 3)
	const listedChat = await store.list({ type: 'chat_message' })
	assert.equal(listedChat.total, 1)
	assert.equal(listedChat.items[0].count, 3)
	const gotChat = await store.get('chat_conversation', 'conv-1')
	assert.equal(gotChat.conversationId, 'conv-1')
})

// ---------------------------------------------------------------------------
// profile / notifications / user (lead extension)
// ---------------------------------------------------------------------------

test('saveProfile 写 profiles/<userId>-<tab>.json 并同步 notes', async (t) => {
	const { dir, store } = await tempStore(t)
	const notes = noteRecords().slice(0, 2)
	const rel = await store.saveProfile('user-1', 'notes', notes, {
		sourceUrl: `${XHS}/user/profile/user-1`,
		nickname: '山野小满'
	})
	assert.equal(rel, 'profiles/user-1-notes.json')
	await assertRelativeFile(dir, rel)
	const doc = await readJson(dir, rel)
	assert.equal(doc.userId, 'user-1')
	assert.equal(doc.tab, 'notes')
	assert.equal(doc.notes.length, 2)
	assert.ok(doc.collectedAt)
	assert.ok(doc.sourceUrl.includes('user/profile'))
	assert.equal(doc.nickname, '山野小满')

	// 同一 tab 二次采集：notes 合并不重复
	await store.saveProfile('user-1', 'notes', [notes[0]], {})
	const again = await readJson(dir, rel)
	assert.equal(again.notes.length, 2)

	const profiles = await store.list({ type: 'profile' })
	assert.equal(profiles.total, 1)
	assert.equal(profiles.items[0].id, 'user-1-notes')
	assert.equal(profiles.items[0].title, 'user-1')
	assert.equal((await store.counts()).profile, 1)
})

test('saveNotifications 写 notifications/<ts>.json 并计数', async (t) => {
	const { dir, store } = await tempStore(t)
	const items = notificationRecords()
	const rel = await store.saveNotifications(items, {
		sourceUrl: `${XHS}/notification`
	})
	assert.match(rel, /^notifications\/\d{8}-\d{6}-\d{3}\.json$/)
	await assertRelativeFile(dir, rel)
	const doc = await readJson(dir, rel)
	assert.equal(doc.items.length, 3)
	assert.equal(doc.items[0].type, 'notification')
	assert.ok(doc.sourceUrl.includes('notification'))

	const listed = await store.list({ type: 'notification' })
	assert.equal(listed.total, 1)
	assert.equal(listed.items[0].count, 3)
	assert.equal((await store.counts()).notification, 3)

	// 再写一批不会被合并，而是新文件
	const secondRel = await store.saveNotifications(notificationRecords(), {})
	assert.notEqual(secondRel, rel)
	assert.equal((await store.counts()).notification, 6)
})

test('user 记录可保存并通过 get 读取', async (t) => {
	const { dir, store } = await tempStore(t)
	const [user] = normalizeCapture({
		url: `${XHS}/api/sns/web/v2/user/me`,
		capturedAt: CAPTURED_AT,
		body: USER_ME
	}).records
	assert.equal(user.type, 'user')
	const rel = await store.save(user)
	assert.equal(rel, `profiles/${user.id}.json`)
	await assertRelativeFile(dir, rel)
	const doc = await readJson(dir, rel)
	assert.equal(doc.type, 'user')
	assert.equal(doc.nickname, '山野小满')
	const got = await store.get('user', user.id)
	assert.equal(got.nickname, '山野小满')
	assert.equal((await store.counts()).user, 1)
})

// ---------------------------------------------------------------------------
// path hygiene
// ---------------------------------------------------------------------------

test('所有落盘返回值都是 dataDir 内的相对路径', async (t) => {
	const { dir, store } = await tempStore(t)
	const notes = noteRecords()
	const paths = []
	paths.push(await store.save(notes[0]))
	paths.push((await store.saveComments('note-1', commentRecords())).path)
	paths.push(await store.saveSearch('露营', notes.slice(0, 1)))
	paths.push(await store.saveProfile('user-1', 'notes', notes.slice(0, 1), {}))
	paths.push(await store.saveChat('conv-1', chatMessageRecords(), {
		peer: { id: 'u1', nickname: '山野小满' }
	}))
	paths.push(await store.saveNotifications(notificationRecords(), {}))
	paths.push(await store.saveRaw('probe', { ok: true }))
	paths.push((await store.saveMany(notes.slice(1, 3))).paths[0])

	for (const rel of paths) await assertRelativeFile(dir, rel)
	const index = await readJson(dir, 'index.json')
	for (const entry of index.entries) {
		assert.ok(!entry.path.startsWith('/'))
		assert.ok(!entry.path.includes('..'))
		assert.ok(!entry.path.includes(dir))
	}
})
