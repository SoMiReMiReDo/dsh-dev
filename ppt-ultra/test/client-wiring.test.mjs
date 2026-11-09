import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * The workbench entry was redesigned on 2026-11-09: it is a root-scoped DSH
 * page reached from the left sidebar, not a session overlay triggered by an
 * Agent preset, and the right panel was narrowed to the file picker and the
 * chat. Removed wiring is easy to reintroduce; pin the observable names here.
 */
test('client enters as a root page instead of a session overlay or preset trigger', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

  // Entry wiring that must stay: sidebar row + keyed main panel + document watcher.
  assert.match(source, /name:'sidebar\.panellist'/, 'sidebar entry must stay registered')
  assert.match(source, /name:'main',key:PANEL_ID/, 'workbench must own a keyed main panel')
  assert.match(source, /name:'shell\.overlay'/, 'document watcher must mount at the root overlay')

  // Top-right actions confirmed with the user.
  assert.match(source, /导出 PPTX/)
  assert.match(source, /退出 PPT/)

  // Right panel: only the file picker and the chat stay.
  assert.match(source, /文件选择/)
  assert.match(source, /新建对话/)
  assert.match(source, /api\('workspaces'/)
  assert.match(source, /api\('browse'/)
  assert.match(source, /api\('openPath'/)
  assert.match(source, /api\('conversation'/)
  assert.doesNotMatch(source, /编辑范围/)
  assert.doesNotMatch(source, /待应用操作/)
  assert.doesNotMatch(source, /变更记录/)

  // Old entry mechanisms and preset coupling must not come back.
  assert.doesNotMatch(source, /conversation\.session\.header\.actions/)
  assert.doesNotMatch(source, /conversation\.input\.dock/)
  assert.doesNotMatch(source, /createPortal/)
  assert.doesNotMatch(source, /autoOpen/)
  assert.doesNotMatch(source, /ppt-edit/)
})
