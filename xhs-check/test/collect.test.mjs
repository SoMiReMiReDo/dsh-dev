/**
 * Integration tests for the collection orchestration.
 *
 * A fake CDP browser replays scripted Xiaohongshu API captures so the full
 * path (recorder drain → normalize → store) runs without a real Chrome, which
 * the bash sandbox cannot launch.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectNote, collectSearch } from '../lib/collect.mjs'
import { Store } from '../lib/store.mjs'

/** Build one recorded capture the way the in-page recorder emits it. */
function capture(url, body) {
	return {
		url,
		method: 'POST',
		status: 200,
		capturedAt: new Date().toISOString(),
		body,
	}
}

/** A realistic feed note_card shared by feed/search/profile responses. */
function noteCard(id, title) {
	return {
		note_id: id,
		type: 'normal',
		display_title: title,
		desc: `${title} 的正文`,
		user: { user_id: 'user-1', nickname: '小明', avatar: 'https://sns-avatar.example/u1.jpg' },
		interact_info: { liked_count: '1.2万', collected_count: '36', comment_count: '5', share_count: '0' },
		image_list: [
			{ url_default: 'https://sns-img.example/a.jpg', width: 1080, height: 1440 },
			{ url_default: 'https://sns-img.example/b.jpg', width: 1080, height: 1440 },
		],
		tag_list: [{ name: '测试', type: 'topic' }],
		time: 1700000000000,
		ip_location: '上海',
	}
}

/** Scripted page: each navigation/scroll pushes captures the collector drains. */
class FakePage {
	constructor(plan) {
		this.plan = plan
		this.pending = []
		this.url = ''
		this.scrollCount = 0
		this.closed = false
	}

	async addInitScript() {}

	async goto(url) {
		this.url = url
		this.pending.push(...(this.plan.onGoto?.(url) ?? []))
	}

	async evaluate(expression) {
		if (expression.includes('__XHS_TAKE__')) {
			const drained = this.pending.splice(0, this.pending.length)
			return JSON.stringify(drained)
		}
		if (expression.includes('location.href')) return this.url
		const planned = this.plan.onEvaluate?.(expression)
		return planned === undefined ? '' : planned
	}

	async scrollToLoadMore() {
		this.scrollCount += 1
		this.pending.push(...(this.plan.onScroll?.(this.scrollCount) ?? []))
	}

	async bringToFront() {}

	async close() {
		this.closed = true
	}
}

/** Fake browser handing out the scripted page. */
class FakeBrowser {
	constructor(plan) {
		this.plan = plan
		this.pages = []
	}

	async newPage() {
		const page = new FakePage(this.plan)
		this.pages.push(page)
		return page
	}
}

/** Test settings: fast delays, tiny budgets. */
const SETTINGS = { requestDelayMs: 10, maxComments: 5, maxScrolls: 2 }

/**
 * Create one collector context backed by a temp store and fake browser.
 * @param plan - fake page script.
 * @returns { root, store, browser, ctx }.
 */
async function createContext(plan) {
	const root = await mkdtemp(join(tmpdir(), 'xhs-collect-'))
	const store = new Store(root)
	await store.init()
	const browser = new FakeBrowser(plan)
	return { root, store, browser, ctx: { browser, store, settings: SETTINGS } }
}

test('collectNote drains feed + comments, normalizes, and persists JSON', async () => {
	const feed = capture('https://www.xiaohongshu.com/api/sns/web/v1/feed', {
		code: 0,
		success: true,
		data: { items: [{ id: 'feed-1', model_type: 'note', note_card: noteCard('note-1', '测试笔记') }] },
	})
	const comments = capture('https://www.xiaohongshu.com/api/sns/web/v2/comment/page', {
		data: {
			comments: [
				{
					id: 'comment-1',
					content: '第一条评论',
					create_time: 1700000000001,
					user_info: { user_id: 'user-2', nickname: '路人甲', image: '' },
					like_count: '2',
					sub_comment_count: 1,
					sub_comments: [
						{ id: 'comment-1-1', content: '作者回复', user_info: { user_id: 'user-1', nickname: '小明' }, like_count: '0', create_time: 1700000000002 },
					],
				},
			],
			has_more: false,
		},
	})
	const { root, ctx } = await createContext({
		onGoto: () => [feed],
		onScroll: (count) => (count === 1 ? [comments] : []),
	})
	try {
		const result = await collectNote(ctx, { url: 'https://www.xiaohongshu.com/explore/note-1' })

		assert.equal(result.ok, true)
		assert.equal(result.mode, 'note')
		assert.equal(result.note.id, 'note-1')
		assert.equal(result.note.title, '测试笔记')
		assert.equal(result.note.author, '小明')
		assert.equal(result.comments.top, 1)
		assert.equal(result.comments.sub, 1)

		const noteJson = JSON.parse(await readFile(join(root, result.paths.note), 'utf8'))
		assert.equal(noteJson.id, 'note-1')
		assert.equal(noteJson.title, '测试笔记')
		assert.equal(noteJson.author.nickname, '小明')
		assert.equal(noteJson.images.length, 2)
		assert.equal(noteJson.images[0].url, 'https://sns-img.example/a.jpg')

		const commentsJson = JSON.parse(await readFile(join(root, result.paths.comments), 'utf8'))
		assert.equal(commentsJson.noteId, 'note-1')
		assert.equal(commentsJson.comments.length, 1)
		assert.equal(commentsJson.comments[0].content, '第一条评论')
		assert.equal(commentsJson.comments[0].subComments.length, 1)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('collectNote degrades gracefully when no note payload arrives', async () => {
	const { root, ctx } = await createContext({ onGoto: () => [], onScroll: () => [] })
	try {
		const result = await collectNote(ctx, { url: 'https://www.xiaohongshu.com/explore/missing' })
		assert.equal(result.ok, false)
		assert.equal(result.paths.note, '')
		assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('collectSearch keeps the requested limit and writes the result file', async () => {
	const search = capture('https://www.xiaohongshu.com/api/sns/web/v1/search/notes', {
		data: {
			items: [
				{ id: 'feed-a', model_type: 'note', note_card: noteCard('note-a', '笔记 A') },
				{ id: 'feed-b', model_type: 'note', note_card: noteCard('note-b', '笔记 B') },
				{ id: 'feed-c', model_type: 'note', note_card: noteCard('note-c', '笔记 C') },
			],
		},
	})
	const { root, ctx } = await createContext({ onGoto: () => [search], onScroll: () => [] })
	try {
		const result = await collectSearch(ctx, { keyword: '测试', limit: 2 })
		assert.equal(result.ok, true)
		assert.equal(result.query, '测试')
		assert.equal(result.total, 2)
		assert.deepEqual(result.notes.map((note) => note.id), ['note-a', 'note-b'])

		const stored = JSON.parse(await readFile(join(root, result.path), 'utf8'))
		assert.equal(stored.query, '测试')
		assert.equal(stored.notes.length, 2)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
