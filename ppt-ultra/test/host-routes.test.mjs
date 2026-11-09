import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/**
 * The Host transport registers preview images as an exact Fetch route. The DSH
 * connection bridge picks its body mode from `requestBody`: an omitted field is
 * treated as streaming, which tries to attach a body to the GET/HEAD request
 * and throws (`Request with GET/HEAD method cannot have body`); the web server
 * catch-all then answers 400 with an empty body, so every `<img>` preview is a
 * broken image. Keep `requestBody: 'buffered'` pinned here.
 */
test('preview asset route is a buffered GET/HEAD exact route', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ppt-ultra-routes-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const routes = new Map(), tools = [], effects = []
  const ctx = {
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => {} } } },
    tools: { register: tool => { tools.push(tool); return () => {} } },
    effect: fn => { effects.push(fn()); return () => {} },
  }
  await apply(ctx, { dataDir })
  const asset = routes.get('/api/ppt-ultra.asset')
  assert.ok(asset, 'asset route must be registered')
  assert.deepEqual([...asset.methods], ['GET', 'HEAD'])
  assert.equal(asset.requestBody, 'buffered', 'GET bridge needs buffered body mode')
  assert.equal(typeof asset.fetch, 'function')
  // JSON actions stay POST routes without a body mode override.
  for (const action of ['open', 'list', 'state', 'propose', 'apply', 'cancel', 'undo', 'export', 'runtime']) {
    const route = routes.get('/api/ppt-ultra.' + action)
    assert.ok(route, action + ' route must be registered')
    assert.deepEqual([...route.methods], ['POST'])
  }
  assert.equal(tools.length, 4, 'four agent tools stay registered')
})

/**
 * The right panel adds file selection and conversation tabs. Their Host routes
 * stay authenticated POSTs with a buffered JSON body, like the existing actions;
 * the preview asset route keeps its GET/HEAD contract.
 */
test('file browser and conversation routes are buffered POST routes', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ppt-ultra-routes-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const routes = new Map(), tools = [], effects = []
  const ctx = {
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => {} } } },
    tools: { register: tool => { tools.push(tool); return () => {} } },
    effect: fn => { effects.push(fn()); return () => {} },
  }
  await apply(ctx, { dataDir })
  for (const action of ['workspaces', 'browse', 'openPath', 'conversation']) {
    const route = routes.get('/api/ppt-ultra.' + action)
    assert.ok(route, action + ' route must be registered')
    assert.deepEqual([...route.methods], ['POST'])
    assert.equal(route.requestBody, 'buffered', action + ' route must buffer its JSON body')
    assert.equal(typeof route.fetch, 'function')
  }
  const asset = routes.get('/api/ppt-ultra.asset')
  assert.deepEqual([...asset.methods], ['GET', 'HEAD'])
  assert.equal(asset.requestBody, 'buffered')
  assert.equal(tools.length, 4, 'four agent tools stay registered')
})

/**
 * Browse must stay inside a registered workspace: hidden entries and non-PPTX
 * files are filtered, directories sort first, and traversal/foreign roots are
 * rejected with the shared 400 envelope.
 */
test('browse and workspaces stay inside registered workspaces', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-ultra-browse-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'ppt-ultra-data-'))
  const outside = await mkdtemp(join(tmpdir(), 'ppt-ultra-outside-'))
  t.after(() => Promise.all([root, dataDir, outside].map(dir => rm(dir, { recursive: true, force: true }))))
  await mkdir(join(root, 'slides'))
  await writeFile(join(root, 'deck.pptx'), 'deck')
  await writeFile(join(root, 'notes.txt'), 'notes')
  await writeFile(join(root, '.hidden.pptx'), 'hidden')
  await writeFile(join(root, 'slides', 'inner.pptx'), 'inner')
  await writeFile(join(outside, 'outside.pptx'), 'outside')
  const routes = new Map()
  const ctx = {
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => {} } } },
    tools: { register: () => () => {} },
    effect: fn => { fn(); return () => {} },
    workspaceRegistry: { list: () => [{ id: 'w1', title: '项目', path: root }] },
  }
  await apply(ctx, { dataDir })
  const call = async (action, body) => {
    const request = new Request('http://ppt-ultra.local/api/ppt-ultra.' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const response = await routes.get('/api/ppt-ultra.' + action).fetch(request)
    return { status: response.status, payload: await response.json() }
  }
  const listed = await call('workspaces', {})
  assert.deepEqual(listed.payload, { ok: true, value: { items: [{ id: 'w1', title: '项目', path: root }] } })
  const browsed = await call('browse', { root })
  assert.equal(browsed.status, 200)
  assert.deepEqual(browsed.payload.value.entries.map(entry => [entry.name, entry.type]), [['slides', 'dir'], ['deck.pptx', 'file']])
  assert.equal(browsed.payload.value.entries[1].size, 4)
  const nested = await call('browse', { root, dir: 'slides' })
  assert.equal(nested.status, 200)
  assert.deepEqual(nested.payload.value.entries.map(entry => entry.name), ['inner.pptx'])
  assert.equal((await call('browse', { root, dir: '..' })).status, 400, 'dir must stay inside root')
  assert.equal((await call('browse', { root: outside })).status, 400, 'root must be a registered workspace')
  const wrongType = await call('openPath', { sessionId: 's', path: join(root, 'notes.txt') })
  assert.equal(wrongType.status, 400)
  assert.match(wrongType.payload.error, /\.pptx/)
})
