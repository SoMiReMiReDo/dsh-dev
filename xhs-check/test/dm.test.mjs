/**
 * Regression tests with synthetic values and the private-message and notification
 * payload shapes observed on the site.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { classify, normalizeCapture } from '../lib/normalize.mjs'

/** Wrap a body as the recorder would. */
function capture(url, body) {
	return { url, method: 'GET', status: 200, capturedAt: '2024-10-01T00:00:00.000Z', body }
}

/** One `/im/web/v3/chats` page: a private chat and a group chat. */
const CHATS = {
	data: {
		total: 2,
		chats: [
			{
				user_id: 'self',
				chat_user_id: 'peer-1',
				max_store_id: 10,
				chat_status: 0,
				last_msg_time: 1727740800000,
				last_msg_content: '这是一条测试私信',
				info: { nickname: '测试用户甲', user_name: '测试用户甲', avatar: 'https://img.example/1.jpg' },
			},
			{
				group_id: 'group-1',
				last_msg_time: 1727740740000,
				last_msg_content: '测试用户乙：群聊样例',
				info: { group_name: '测试群', avatar: 'https://img.example/g.png', user_num: 3 },
			},
		],
	},
}

test('classify 认识私信与通知的真实路径', () => {
	assert.equal(classify('https://edith.xiaohongshu.com/api/im/web/v3/chats?limit=100'), 'chat_conversations')
	assert.equal(classify('https://edith.xiaohongshu.com/api/sns/v1/im/web/get_recent_chats'), 'chat_conversations')
	assert.equal(classify('https://edith.xiaohongshu.com/api/im/web/chat/get_unread'), 'unknown')
	assert.equal(classify('https://edith.xiaohongshu.com/api/im/redmoji/version'), 'unknown')
	assert.equal(classify('https://edith.xiaohongshu.com/api/sns/web/v1/you/mentions?num=20&cursor='), 'notifications')
	assert.equal(classify('https://edith.xiaohongshu.com/api/sns/web/v1/you/likes'), 'notifications')
})

test('normalizeCapture 解析私信会话列表（私聊 + 群聊）', () => {
	const result = normalizeCapture(capture('https://edith.xiaohongshu.com/api/im/web/v3/chats?limit=100&page=0', CHATS))
	assert.equal(result.kind, 'chat_conversations')
	const conversations = result.records.filter((record) => record.type === 'chat_conversation')
	assert.equal(conversations.length, 2)
	const [direct, group] = conversations
	assert.equal(direct.id, 'peer-1')
	assert.equal(direct.peer.nickname, '测试用户甲')
	assert.equal(direct.lastMessage, '这是一条测试私信')
	assert.equal(direct.updatedAt, new Date(1727740800000).toISOString())
	assert.equal(group.id, 'group-1')
	assert.equal(group.peer.nickname, '测试群')
	assert.equal(group.lastMessage, '测试用户乙：群聊样例')
})

test('normalizeCapture 解析最近会话 user_list', () => {
	const body = { data: { user_list: [{ user_id: 'peer-2', nickname: '测试用户丙', image: 'https://img.example/2.jpg' }], display_more: true } }
	const result = normalizeCapture(capture('https://edith.xiaohongshu.com/api/sns/v1/im/web/get_recent_chats', body))
	assert.equal(result.kind, 'chat_conversations')
	const conversations = result.records.filter((record) => record.type === 'chat_conversation')
	assert.equal(conversations.length, 1)
	assert.equal(conversations[0].peer.nickname, '测试用户丙')
})

test('normalizeCapture 解析通知页 /v1/you/mentions 的 message_list', () => {
	const body = {
		data: {
			has_more: true,
			cursor: '',
			message_list: [
				{
					title: '回复了你的评论',
					time: 1727740680,
					user_info: { userid: 'u1', nickname: '测试用户丁', image: 'https://img.example/3.jpg' },
					item_info: { note_id: 'note-9', comment_id: 'c-9' },
				},
			],
		},
	}
	const result = normalizeCapture(capture('https://edith.xiaohongshu.com/api/sns/web/v1/you/mentions?num=20&cursor=', body))
	assert.equal(result.kind, 'notifications')
	const notifications = result.records.filter((record) => record.type === 'notification')
	assert.equal(notifications.length, 1)
	assert.equal(notifications[0].title, '回复了你的评论')
	assert.equal(notifications[0].actor.nickname, '测试用户丁')
	assert.equal(notifications[0].noteId, 'note-9')
})
