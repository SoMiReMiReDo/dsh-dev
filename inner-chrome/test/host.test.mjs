/**
 * Host-half tests for `dsh-inner-chrome` (CONTRACT.md §3.5).
 *
 * Zero dependencies: only `node:*` modules and the plugin's own pure ESM
 * modules. The fake `ctx` captures registered routes and tools, and each test
 * drives the real broker end-to-end over those captured handlers.
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../index.js'
import { createBroker, normalizeCommandArgs, TIMEOUT_MESSAGE } from '../lib/broker.mjs'
import { assertHttpUrl } from '../lib/url.mjs'

/** Browser client identity used by every route/tool test. */
const CLIENT = {
  clientId: 'client-1',
  protocol: 1,
  platform: 'desktop',
  capabilities: ['open', 'read', 'click', 'screenshot', 'tabs', 'navigate'],
  version: '0.2.0',
}

const ROUTE_PATHS = {
  hello: '/api/inner-chrome.hello',
  poll: '/api/inner-chrome.poll',
  result: '/api/inner-chrome.result',
  status: '/api/inner-chrome.status',
}

/**
 * Minimal fake Cordis plugin context: captures route/tool registrations,
 * provided services and effect disposers.
 * @returns the fake context plus its captured registries.
 */
function createFakeCtx() {
  const routes = new Map()
  const tools = new Map()
  const services = new Map()
  const registrations = []
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
    provide(serviceName, value) {
      services.set(serviceName, value)
    },
    effect(callback) {
      const disposer = callback()
      registrations.push(disposer)
      return disposer
    },
  }
  return { ctx, routes, tools, services, registrations }
}

/**
 * Apply the plugin on a fresh fake context with an isolated screenshot dir.
 * @param options - broker config overrides.
 * @returns the fake context, captured registries and a cleanup callback.
 */
async function setupPlugin(options = {}) {
  const screenshotsDir = options.screenshotsDir ?? await mkdtemp(join(tmpdir(), 'inner-chrome-test-'))
  const host = createFakeCtx()
  apply(host.ctx, {
    screenshotsDir,
    commandTimeoutMs: options.commandTimeoutMs ?? 2000,
    clientTimeoutMs: options.clientTimeoutMs ?? 30000,
    sweepIntervalMs: options.sweepIntervalMs ?? 5000,
  })
  let cleaned = false
  return {
    ...host,
    screenshotsDir,
    async cleanup() {
      if (cleaned) return
      cleaned = true
      for (const disposer of [...host.registrations].reverse()) {
        if (typeof disposer === 'function') await disposer()
      }
      await rm(screenshotsDir, { recursive: true, force: true })
    },
  }
}

/**
 * Read the provided `innerChrome` Host service from a plugin instance.
 * @param plugin - `setupPlugin()` result.
 * @returns the provided service (CONTRACT.md §8.2).
 */
function innerChromeService(plugin) {
  const service = plugin.services.get('innerChrome')
  assert.ok(service !== undefined, 'apply must provide the innerChrome service')
  return service
}

/**
 * Build one tool execution context.
 * @param sessionId - session id reported to the plugin.
 * @returns `{ exec, controller }`.
 */
function createExec(sessionId = 'session-1') {
  const controller = new AbortController()
  return {
    exec: {
      agent: { session: { id: sessionId } },
      signal: controller.signal,
    },
    controller,
  }
}

/**
 * Call one captured route through a real `Request` and return its JSON body.
 * @param routes - captured route map.
 * @param path - route path.
 * @param body - JSON-serializable body, or a raw string.
 * @returns the parsed JSON payload (always HTTP 200).
 */
async function callRoute(routes, path, body) {
  const route = routes.get(path)
  assert.ok(route !== undefined, `route ${path} is not registered`)
  const request = new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  })
  const response = await route.fetch(request)
  assert.equal(response.status, 200, `${path} must answer HTTP 200`)
  return await response.json()
}

/**
 * Poll once, asserting that a command is waiting, and return it.
 * @param routes - captured route map.
 * @returns the delivered command.
 */
async function nextCommand(routes) {
  const payload = await callRoute(routes, ROUTE_PATHS.poll, { clientId: CLIENT.clientId, waitMs: 1000 })
  assert.equal(payload.ok, true)
  assert.ok(payload.command !== null && payload.command !== undefined, 'expected a queued command')
  return payload.command
}

/**
 * Send one successful command result.
 * @param routes - captured route map.
 * @param command - the delivered command.
 * @param value - client result value.
 * @returns the route payload.
 */
async function sendResult(routes, command, value) {
  return await callRoute(routes, ROUTE_PATHS.result, {
    clientId: CLIENT.clientId,
    id: command.id,
    ok: true,
    value,
  })
}

/**
 * Create a broker with test-friendly timing bounds.
 * @param overrides - broker option overrides.
 * @returns the broker.
 */
function createTestBroker(overrides = {}) {
  return createBroker({
    protocol: 1,
    version: '0.2.0',
    screenshotsDir: '/tmp/inner-chrome-test/screenshots',
    commandTimeoutMs: 1000,
    clientTimeoutMs: 30000,
    sweepIntervalMs: 5000,
    minPollWaitMs: 20,
    maxPollWaitMs: 200,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Entry shape
// ---------------------------------------------------------------------------

test('index.js exports the contract entry shape', () => {
  assert.equal(name, 'inner-chrome')
  assert.deepEqual(inject, ['connection', 'tools'])
  assert.equal(typeof apply, 'function')
})

// ---------------------------------------------------------------------------
// URL validation (lib/url.mjs)
// ---------------------------------------------------------------------------

test('assertHttpUrl normalizes bare hosts and keeps http(s) urls', () => {
  assert.equal(assertHttpUrl('example.com'), 'https://example.com/')
  assert.equal(assertHttpUrl('example.com/a/b?x=1#y'), 'https://example.com/a/b?x=1#y')
  assert.equal(assertHttpUrl('http://example.com'), 'http://example.com/')
  assert.equal(assertHttpUrl(' HTTPS://Example.COM/Path '), 'https://example.com/Path')
  assert.equal(assertHttpUrl('//example.com/x'), 'https://example.com/x')
  assert.equal(assertHttpUrl('localhost:3000/app'), 'https://localhost:3000/app')
  assert.equal(assertHttpUrl('example.com:8080/x'), 'https://example.com:8080/x')
  assert.equal(assertHttpUrl('http://127.0.0.1:8080/health'), 'http://127.0.0.1:8080/health')
})

test('assertHttpUrl rejects non-http, credentialed and oversized urls', () => {
  const rejected = [
    'javascript:alert(1)',
    'javascript:123',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hi',
    'mailto:a@b.com',
    'ftp://example.com',
    'about:blank',
    'chrome://settings',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'http://:secret@example.com/',
    '',
    '   ',
    'not a url',
    'http://',
    'https://example.com:99999/',
    null,
    undefined,
    42,
    {},
    ['example.com'],
  ]
  for (const value of rejected) {
    assert.throws(
      () => assertHttpUrl(value),
      (error) => {
        assert.equal(error.code, 'BAD_ARGS', `expected BAD_ARGS for ${String(value)}`)
        assert.equal(typeof error.message, 'string')
        assert.ok(error.message.length > 0)
        return true
      },
      `expected ${String(value)} to be rejected`,
    )
  }
  assert.throws(
    () => assertHttpUrl(`https://example.com/${'a'.repeat(2048)}`),
    (error) => error.code === 'BAD_ARGS',
  )
})

// ---------------------------------------------------------------------------
// Broker lifecycle (lib/broker.mjs)
// ---------------------------------------------------------------------------

test('broker hello registers the client and status reports it', async (t) => {
  const broker = createTestBroker()
  t.after(() => broker.dispose())

  assert.deepEqual(broker.hello(CLIENT), {
    protocol: 1,
    version: '0.2.0',
    screenshotsDir: '/tmp/inner-chrome-test/screenshots',
  })

  const status = broker.status()
  assert.equal(status.protocol, 1)
  assert.equal(status.version, '0.2.0')
  assert.equal(status.screenshotsDir, '/tmp/inner-chrome-test/screenshots')
  assert.equal(status.pendingCommands, 0)
  assert.equal(status.client.connected, true)
  assert.equal(status.client.clientId, 'client-1')
  assert.equal(status.client.platform, 'desktop')
  assert.deepEqual(status.client.capabilities, CLIENT.capabilities)
  assert.equal(typeof status.client.lastSeenAgoMs, 'number')
  assert.ok(status.client.lastSeenAgoMs >= 0)
})

test('broker hands a queued command to poll and resolves it with the result', async (t) => {
  const broker = createTestBroker()
  t.after(() => broker.dispose())
  broker.hello(CLIENT)

  const pending = broker.enqueue(
    'open',
    { url: 'example.com', newTab: true },
    { sessionId: 'session-1', tabId: 'tab-1' },
  )
  assert.equal(broker.status().pendingCommands, 1)

  const { command, serverTime } = await broker.poll({ clientId: CLIENT.clientId, waitMs: 100 })
  assert.ok(command !== null)
  assert.equal(command.kind, 'open')
  assert.equal(command.args.url, 'https://example.com/')
  assert.equal(command.args.newTab, true)
  assert.equal(command.sessionId, 'session-1')
  assert.equal(command.tabId, 'tab-1')
  assert.equal(typeof command.id, 'string')
  assert.equal(typeof command.createdAt, 'number')
  assert.equal(typeof serverTime, 'number')

  assert.deepEqual(
    broker.result({
      clientId: CLIENT.clientId,
      id: command.id,
      ok: true,
      value: { tabId: 'tab-1', url: 'https://example.com/', title: 'Example Domain', loading: false },
    }),
    { ok: true },
  )
  assert.deepEqual(await pending, {
    tabId: 'tab-1',
    url: 'https://example.com/',
    title: 'Example Domain',
    loading: false,
  })
  assert.equal(broker.status().pendingCommands, 0)

  // Repeated results are idempotent, unknown ids are acknowledged.
  assert.deepEqual(
    broker.result({ clientId: CLIENT.clientId, id: command.id, ok: true, value: { ignored: true } }),
    { ok: true },
  )
  assert.deepEqual(
    broker.result({ clientId: CLIENT.clientId, id: 'does-not-exist', ok: false, error: { code: 'NAV_FAILED' } }),
    { ok: true },
  )
})

test('broker poll resolves null after waitMs when nothing is queued', async (t) => {
  const broker = createTestBroker({ minPollWaitMs: 10, maxPollWaitMs: 100 })
  t.after(() => broker.dispose())
  broker.hello(CLIENT)

  const startedAt = Date.now()
  const { command, serverTime } = await broker.poll({ clientId: CLIENT.clientId, waitMs: 10 })
  assert.equal(command, null)
  assert.equal(typeof serverTime, 'number')
  assert.ok(Date.now() - startedAt >= 5)
})

test('broker poll is woken by a newly enqueued command', async (t) => {
  const broker = createTestBroker({ minPollWaitMs: 10, maxPollWaitMs: 1000 })
  t.after(() => broker.dispose())
  broker.hello(CLIENT)

  const polling = broker.poll({ clientId: CLIENT.clientId, waitMs: 1000 })
  const pending = broker.enqueue('tabs', {}, {})
  const { command } = await polling
  assert.equal(command.kind, 'tabs')
  assert.deepEqual(command.args, {})
  broker.result({ clientId: CLIENT.clientId, id: command.id, ok: true, value: { tabs: [] } })
  assert.deepEqual(await pending, { tabs: [] })
})

test('broker rejects an unanswered command with TIMEOUT and the contract wording', async (t) => {
  const broker = createTestBroker({ commandTimeoutMs: 40 })
  t.after(() => broker.dispose())
  broker.hello(CLIENT)

  await assert.rejects(broker.enqueue('read', {}, {}), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(error.message, TIMEOUT_MESSAGE)
    return true
  })
  assert.equal(broker.status().pendingCommands, 0)
})

test('broker rejects with NO_CLIENT before any client connects', async (t) => {
  const broker = createTestBroker()
  t.after(() => broker.dispose())
  await assert.rejects(broker.enqueue('tabs', {}, {}), (error) => error.code === 'NO_CLIENT')
})

test('broker validates command arguments with BAD_ARGS before queueing', async (t) => {
  const broker = createTestBroker()
  t.after(() => broker.dispose())
  broker.hello(CLIENT)

  await assert.rejects(broker.enqueue('open', { url: 'javascript:alert(1)' }), (error) => error.code === 'BAD_ARGS')
  await assert.rejects(broker.enqueue('navigate', { action: 'goto' }), (error) => error.code === 'BAD_ARGS')
  await assert.rejects(broker.enqueue('navigate', { action: 'sideways' }), (error) => error.code === 'BAD_ARGS')
  await assert.rejects(broker.enqueue('click', {}), (error) => error.code === 'BAD_ARGS')
  await assert.rejects(broker.enqueue('teleport', {}), (error) => error.code === 'BAD_ARGS')
  assert.equal(broker.status().pendingCommands, 0)
})

test('broker expires a silent client and rejects pending commands with CLIENT_GONE', async (t) => {
  const broker = createTestBroker({ clientTimeoutMs: 30, sweepIntervalMs: 10, commandTimeoutMs: 5000 })
  t.after(() => broker.dispose())
  broker.hello(CLIENT)

  const pending = broker.enqueue('tabs', {}, {})
  assert.equal(broker.status().pendingCommands, 1)
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'CLIENT_GONE')
    return true
  })
  const status = broker.status()
  assert.equal(status.client.connected, false)
  assert.equal(status.client.clientId, null)
  assert.equal(status.pendingCommands, 0)
})

test('broker dispose rejects pending commands and releases suspended polls', async (t) => {
  const broker = createTestBroker({ minPollWaitMs: 10, maxPollWaitMs: 5000 })
  broker.hello(CLIENT)

  const firstPoll = broker.poll({ clientId: CLIENT.clientId, waitMs: 5000 })
  const secondPoll = broker.poll({ clientId: CLIENT.clientId, waitMs: 5000 })
  const pending = broker.enqueue('tabs', {}, {})
  const rejection = assert.rejects(pending, (error) => error.code === 'CLIENT_GONE')
  broker.dispose()

  await rejection
  const first = await firstPoll
  assert.equal(first.command.kind, 'tabs')
  assert.equal((await secondPoll).command, null)
  await assert.rejects(broker.enqueue('tabs', {}), (error) => error.code === 'CLIENT_GONE')
  broker.dispose() // second dispose is a no-op
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('host registers the four POST buffered routes', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)

  assert.deepEqual([...plugin.routes.keys()].sort(), Object.values(ROUTE_PATHS).sort())
  for (const route of plugin.routes.values()) {
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
  }
})

test('hello and status routes answer HTTP 200 JSON', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)

  const hello = await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)
  assert.equal(hello.ok, true)
  assert.equal(hello.protocol, 1)
  assert.equal(hello.version, '0.2.0')
  assert.equal(hello.screenshotsDir, plugin.screenshotsDir)

  const status = await callRoute(plugin.routes, ROUTE_PATHS.status, {})
  assert.equal(status.ok, true)
  assert.equal(status.protocol, 1)
  assert.equal(status.version, '0.2.0')
  assert.equal(status.client.connected, true)
  assert.equal(status.client.clientId, CLIENT.clientId)
  assert.equal(status.client.platform, 'desktop')
  assert.deepEqual(status.client.capabilities, CLIENT.capabilities)
  assert.equal(typeof status.client.lastSeenAgoMs, 'number')
  assert.equal(status.pendingCommands, 0)
  assert.equal(status.screenshotsDir, plugin.screenshotsDir)
})

test('routes convert invalid bodies into HTTP 200 ok:false errors', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)

  const badJson = await callRoute(plugin.routes, ROUTE_PATHS.hello, '{not json')
  assert.equal(badJson.ok, false)
  assert.equal(badJson.error.code, 'BAD_ARGS')

  const missingClientId = await callRoute(plugin.routes, ROUTE_PATHS.poll, {})
  assert.equal(missingClientId.ok, false)
  assert.equal(missingClientId.error.code, 'BAD_ARGS')

  const missingCommandId = await callRoute(plugin.routes, ROUTE_PATHS.result, {
    clientId: CLIENT.clientId,
    ok: true,
  })
  assert.equal(missingCommandId.ok, false)
  assert.equal(missingCommandId.error.code, 'BAD_ARGS')
})

test('the result route relays client errors and settles the tool wait', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const pending = plugin.tools.get('inner_chrome_tabs').execute({}, createExec().exec)
  const command = await nextCommand(plugin.routes)
  const ack = await callRoute(plugin.routes, ROUTE_PATHS.result, {
    clientId: CLIENT.clientId,
    id: command.id,
    ok: false,
    error: { code: 'NO_TAB', message: '没有可用的标签页。' },
  })
  assert.equal(ack.ok, true)
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'NO_TAB')
    assert.equal(error.message, '没有可用的标签页。')
    return true
  })
})

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

test('six Agent tools are registered with contract names and schemas', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)

  assert.deepEqual([...plugin.tools.keys()].sort(), [
    'inner_chrome_click',
    'inner_chrome_navigate',
    'inner_chrome_open',
    'inner_chrome_read',
    'inner_chrome_screenshot',
    'inner_chrome_tabs',
  ])
  assert.equal(plugin.tools.has('run_code'), false)

  const open = plugin.tools.get('inner_chrome_open')
  assert.match(open.description, /内置浏览器/)
  assert.match(open.description, /优先/)
  assert.match(open.description, /web_fetch/)
  assert.equal(open.parameters.type, 'object')
  assert.deepEqual(open.parameters.required, ['url'])
  assert.equal(open.parameters.properties.url.type, 'string')
  assert.equal(open.parameters.properties.newTab.type, 'boolean')

  const read = plugin.tools.get('inner_chrome_read')
  assert.equal(read.parameters.properties.maxChars.type, 'integer')
  assert.deepEqual(read.parameters.required, undefined)

  const click = plugin.tools.get('inner_chrome_click')
  assert.equal(click.parameters.properties.selector.type, 'string')
  assert.equal(click.parameters.properties.text.type, 'string')

  const screenshot = plugin.tools.get('inner_chrome_screenshot')
  assert.equal(screenshot.parameters.properties.maxWidth.type, 'integer')

  const tabs = plugin.tools.get('inner_chrome_tabs')
  assert.deepEqual(tabs.parameters.properties, {})

  const navigate = plugin.tools.get('inner_chrome_navigate')
  assert.deepEqual(navigate.parameters.properties.action.enum, ['back', 'forward', 'reload', 'goto'])
  assert.deepEqual(navigate.parameters.required, ['action'])
  assert.equal(navigate.parameters.properties.url.type, 'string')

  for (const tool of plugin.tools.values()) {
    assert.equal(typeof tool.description, 'string')
    assert.match(tool.description, /[\u4e00-\u9fa5]/, `${tool.name} description must be Chinese`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
  }
})

// ---------------------------------------------------------------------------
// Tools end-to-end over routes
// ---------------------------------------------------------------------------

test('inner_chrome_open opens a page through the broker and renders it', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const tool = plugin.tools.get('inner_chrome_open')
  const pending = tool.execute({ url: 'example.com', newTab: true }, createExec('session-42').exec)

  const status = await callRoute(plugin.routes, ROUTE_PATHS.status, {})
  assert.equal(status.pendingCommands, 1)

  const command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'open')
  assert.equal(command.args.url, 'https://example.com/')
  assert.equal(command.args.newTab, true)
  assert.equal(command.sessionId, 'session-42')

  await sendResult(plugin.routes, command, {
    tabId: 'tab-1',
    sessionId: 'session-42',
    url: 'https://example.com/',
    title: 'Example Domain',
    loading: false,
  })
  const value = await pending
  assert.deepEqual(value, {
    tabId: 'tab-1',
    sessionId: 'session-42',
    url: 'https://example.com/',
    title: 'Example Domain',
    loading: false,
  })

  const rendered = tool.output.render({ url: 'example.com' }, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /已在内置浏览器打开：Example Domain/)
  assert.match(rendered[0].text, /https:\/\/example\.com\//)
})

test('inner_chrome_open surfaces the contract TIMEOUT wording', async (t) => {
  const plugin = await setupPlugin({ commandTimeoutMs: 60 })
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const tool = plugin.tools.get('inner_chrome_open')
  await assert.rejects(tool.execute({ url: 'example.com' }, createExec().exec), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(error.message, TIMEOUT_MESSAGE)
    return true
  })
})

test('tools reject with NO_CLIENT when the browser client never connected', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await assert.rejects(
    plugin.tools.get('inner_chrome_open').execute({ url: 'example.com' }, createExec().exec),
    (error) => error.code === 'NO_CLIENT',
  )
})

test('inner_chrome_open rejects invalid urls with BAD_ARGS', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com/', '']) {
    await assert.rejects(
      plugin.tools.get('inner_chrome_open').execute({ url }, createExec().exec),
      (error) => error.code === 'BAD_ARGS',
    )
  }
})

test('inner_chrome_read clamps maxChars and renders title, url and text', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const tool = plugin.tools.get('inner_chrome_read')
  const pending = tool.execute({ maxChars: 5000 }, createExec('session-7').exec)
  const command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'read')
  assert.deepEqual(command.args, { maxChars: 5000 })
  assert.equal(command.sessionId, 'session-7')

  await sendResult(plugin.routes, command, {
    tabId: 'tab-1',
    url: 'https://example.com/',
    title: '示例页',
    text: '这里是正文内容。',
    chars: 8,
    truncated: true,
  })
  const value = await pending
  assert.equal(value.text, '这里是正文内容。')

  const rendered = tool.output.render({ maxChars: 5000 }, value)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /标题: 示例页/)
  assert.match(rendered[0].text, /URL: https:\/\/example\.com\//)
  assert.match(rendered[0].text, /这里是正文内容。/)
  assert.match(rendered[0].text, /已截断/)
})

test('inner_chrome_click renders both the clicked element and the not-found hint', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const tool = plugin.tools.get('inner_chrome_click')
  const pending = tool.execute({ text: '下一页' }, createExec().exec)
  const command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'click')
  assert.deepEqual(command.args, { text: '下一页' })

  await sendResult(plugin.routes, command, {
    tabId: 'tab-1',
    url: 'https://example.com/2',
    title: '第二页',
    found: true,
    tag: 'a',
    text: '下一页',
  })
  const value = await pending
  const rendered = tool.output.render({ text: '下一页' }, value)
  assert.match(rendered[0].text, /已点击 a「下一页」/)
  assert.match(rendered[0].text, /当前页面：第二页 https:\/\/example\.com\/2/)

  // The contract's click value does not require `text`; fall back to the args.
  const fromArgs = tool.output.render({ text: '下一页' }, {
    tabId: 'tab-1',
    url: 'https://example.com/2',
    title: '第二页',
    found: true,
    tag: 'a',
  })
  assert.match(fromArgs[0].text, /已点击 a「下一页」/)

  const notFound = tool.output.render({ text: '不存在' }, {
    tabId: 'tab-1',
    url: 'https://example.com/',
    title: '示例页',
    found: false,
  })
  assert.match(notFound[0].text, /CLICK_NOT_FOUND/)
  assert.match(notFound[0].text, /当前页面：示例页 https:\/\/example\.com\//)

  await assert.rejects(
    tool.execute({}, createExec().exec),
    (error) => error.code === 'BAD_ARGS',
  )
})

test('inner_chrome_screenshot writes the returned JPEG into screenshotsDir', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const bytes = Buffer.from('fake-jpeg-payload-0123456789')
  const tool = plugin.tools.get('inner_chrome_screenshot')
  const pending = tool.execute({ maxWidth: 800 }, createExec('session-7').exec)
  const command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'screenshot')
  assert.deepEqual(command.args, { maxWidth: 800 })

  await sendResult(plugin.routes, command, {
    tabId: 'tab-1',
    url: 'https://example.com/',
    title: '示例页',
    mime: 'image/jpeg',
    base64: bytes.toString('base64'),
    width: 800,
    height: 600,
  })
  const value = await pending

  assert.equal(typeof value.path, 'string')
  assert.ok(value.path.startsWith(`${plugin.screenshotsDir}/`), 'screenshot must live under screenshotsDir')
  assert.match(value.path, /\.jpg$/)
  assert.equal(value.bytes, bytes.length)
  assert.equal(value.width, 800)
  assert.equal(value.height, 600)
  assert.equal(value.url, 'https://example.com/')
  assert.equal(value.title, '示例页')
  assert.equal(value.base64, undefined, 'base64 must not leak into the tool result')

  const onDisk = await readFile(value.path)
  assert.deepEqual(onDisk, bytes)

  const rendered = tool.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /截图已保存/)
  assert.match(rendered[0].text, new RegExp(`800x600，${bytes.length}B`))
})

test('inner_chrome_screenshot strips a data-url prefix and rejects empty payloads', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const bytes = Buffer.from('second-jpeg-payload')
  const tool = plugin.tools.get('inner_chrome_screenshot')
  const pending = tool.execute({}, createExec().exec)
  const command = await nextCommand(plugin.routes)
  await sendResult(plugin.routes, command, {
    tabId: 'tab-1',
    url: 'https://example.com/',
    title: '示例页',
    mime: 'image/jpeg',
    base64: `data:image/jpeg;base64,${bytes.toString('base64')}`,
    width: 10,
    height: 20,
  })
  const value = await pending
  assert.equal(value.bytes, bytes.length)
  assert.deepEqual(await readFile(value.path), bytes)

  const failing = tool.execute({}, createExec().exec)
  const failingCommand = await nextCommand(plugin.routes)
  await sendResult(plugin.routes, failingCommand, {
    tabId: 'tab-1',
    url: 'https://example.com/',
    title: '示例页',
    mime: 'image/jpeg',
    base64: '',
    width: 10,
    height: 20,
  })
  await assert.rejects(failing, (error) => error.code === 'INTERNAL')
})

test('inner_chrome_tabs renders the tab list', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const tool = plugin.tools.get('inner_chrome_tabs')
  const pending = tool.execute({}, createExec('session-7').exec)
  const command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'tabs')
  assert.deepEqual(command.args, {})

  await sendResult(plugin.routes, command, {
    tabs: [
      { tabId: 'tab-1', sessionId: 'session-7', url: 'https://a.example/', title: 'A 页', active: true },
      { tabId: 'tab-2', sessionId: 'session-7', url: 'https://b.example/', title: 'B 页', active: false },
    ],
  })
  const value = await pending
  const rendered = tool.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.match(rendered[0].text, /\[active\] A 页 — https:\/\/a\.example\//)
  assert.match(rendered[0].text, /B 页 — https:\/\/b\.example\//)
})

test('inner_chrome_navigate validates the action and normalizes goto urls', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const tool = plugin.tools.get('inner_chrome_navigate')
  const pending = tool.execute({ action: 'goto', url: 'example.com/next' }, createExec().exec)
  const command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'navigate')
  assert.deepEqual(command.args, { action: 'goto', url: 'https://example.com/next' })

  await sendResult(plugin.routes, command, {
    tabId: 'tab-1',
    url: 'https://example.com/next',
    title: 'Next',
  })
  const value = await pending
  const rendered = tool.output.render({ action: 'goto' }, value)
  assert.match(rendered[0].text, /当前页面：Next https:\/\/example\.com\/next/)

  await assert.rejects(
    tool.execute({ action: 'goto' }, createExec().exec),
    (error) => error.code === 'BAD_ARGS',
  )
  await assert.rejects(
    tool.execute({ action: 'sideways' }, createExec().exec),
    (error) => error.code === 'BAD_ARGS',
  )
})

test('navigate without an action and navigate back need no url', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const tool = plugin.tools.get('inner_chrome_navigate')
  await assert.rejects(tool.execute({}, createExec().exec), (error) => error.code === 'BAD_ARGS')

  const pending = tool.execute({ action: 'back' }, createExec().exec)
  const command = await nextCommand(plugin.routes)
  assert.deepEqual(command.args, { action: 'back' })
  await sendResult(plugin.routes, command, { tabId: 'tab-1', url: 'https://example.com/', title: 'A' })
  const value = await pending
  assert.equal(value.url, 'https://example.com/')
})

test('tool execution forwards the abort signal to the broker', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const { exec, controller } = createExec()
  const pending = plugin.tools.get('inner_chrome_open').execute({ url: 'example.com' }, exec)
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'INTERNAL')
})

test('unloading the plugin rejects pending commands with CLIENT_GONE', async (t) => {
  const plugin = await setupPlugin()
  try {
    await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)
    const pending = plugin.tools.get('inner_chrome_tabs').execute({}, createExec().exec)
    const rejection = assert.rejects(pending, (error) => error.code === 'CLIENT_GONE')
    await plugin.cleanup()
    await rejection
  } finally {
    await plugin.cleanup()
  }
})

// ---------------------------------------------------------------------------
// v0.2 command arguments: eval / close / open injection (CONTRACT.md §8.1)
// ---------------------------------------------------------------------------

test('normalizeCommandArgs accepts eval/close and clamps eval timeouts', () => {
  assert.deepEqual(normalizeCommandArgs('eval', { expression: 'window.__T__ = 1' }), {
    expression: 'window.__T__ = 1',
    timeoutMs: 15000,
  })
  assert.deepEqual(
    normalizeCommandArgs('eval', { expression: 'document.title', timeoutMs: 2500 }),
    { expression: 'document.title', timeoutMs: 2500 },
  )
  // Out-of-contract timeouts are clamped so the client only ever accepts a
  // value inside 100..60000 (CONTRACT.md §8.1) instead of failing the command.
  assert.equal(normalizeCommandArgs('eval', { expression: '1', timeoutMs: 1 }).timeoutMs, 100)
  assert.equal(normalizeCommandArgs('eval', { expression: '1', timeoutMs: 999999 }).timeoutMs, 60000)
  assert.equal(normalizeCommandArgs('eval', { expression: '1', timeoutMs: 'nope' }).timeoutMs, 15000)
  assert.equal(
    normalizeCommandArgs('eval', { expression: 'x'.repeat(262144) }).expression.length,
    262144,
  )
  assert.deepEqual(normalizeCommandArgs('close', { tabId: ' tab-1 ' }), { tabId: 'tab-1' })
})

test('normalizeCommandArgs rejects malformed eval/close arguments with BAD_ARGS', () => {
  for (const args of [{}, { expression: '' }, { expression: 42 }, { expression: 'x'.repeat(262145) }]) {
    assert.throws(
      () => normalizeCommandArgs('eval', args),
      (error) => error.code === 'BAD_ARGS',
      `eval args ${JSON.stringify(args)} must be rejected`,
    )
  }
  for (const args of [{}, { tabId: '' }, { tabId: '   ' }, { tabId: 42 }]) {
    assert.throws(
      () => normalizeCommandArgs('close', args),
      (error) => error.code === 'BAD_ARGS',
      `close args ${JSON.stringify(args)} must be rejected`,
    )
  }
  assert.throws(() => normalizeCommandArgs('close'), (error) => error.code === 'BAD_ARGS')
})

test('normalizeCommandArgs forwards the new open options', () => {
  assert.deepEqual(
    normalizeCommandArgs('open', {
      url: 'example.com',
      injectScript: 'window.__T__ = 1',
      waitForLoad: false,
    }),
    {
      url: 'https://example.com/',
      newTab: false,
      waitForLoad: false,
      injectScript: 'window.__T__ = 1',
    },
  )
  assert.deepEqual(normalizeCommandArgs('open', { url: 'example.com' }), {
    url: 'https://example.com/',
    newTab: false,
    waitForLoad: true,
  })
  assert.throws(
    () => normalizeCommandArgs('open', { url: 'example.com', injectScript: '' }),
    (error) => error.code === 'BAD_ARGS',
  )
  assert.throws(
    () => normalizeCommandArgs('open', { url: 'example.com', injectScript: 'x'.repeat(262145) }),
    (error) => error.code === 'BAD_ARGS',
  )
  assert.throws(
    () => normalizeCommandArgs('open', { url: 'javascript:alert(1)', injectScript: 'window.__T__ = 1' }),
    (error) => error.code === 'BAD_ARGS',
  )
})

test('broker hands out an eval command and resolves it with the client result', async (t) => {
  const broker = createTestBroker()
  t.after(() => broker.dispose())
  broker.hello(CLIENT)

  const pending = broker.enqueue(
    'eval',
    { expression: 'document.title', timeoutMs: 1234 },
    { tabId: 'tab-1' },
  )
  const { command } = await broker.poll({ clientId: CLIENT.clientId, waitMs: 100 })
  assert.equal(command.kind, 'eval')
  assert.deepEqual(command.args, { expression: 'document.title', timeoutMs: 1234 })
  assert.equal(command.tabId, 'tab-1')

  const value = {
    tabId: 'tab-1',
    url: 'https://example.com/',
    title: 'Example Domain',
    value: 'Example Domain',
  }
  broker.result({ clientId: CLIENT.clientId, id: command.id, ok: true, value })
  assert.deepEqual(await pending, value)
})

test('broker hands out a close command and rejects a missing tabId', async (t) => {
  const broker = createTestBroker()
  t.after(() => broker.dispose())
  broker.hello(CLIENT)

  await assert.rejects(broker.enqueue('close', {}), (error) => error.code === 'BAD_ARGS')
  const pending = broker.enqueue('close', { tabId: 'tab-3' })
  const { command } = await broker.poll({ clientId: CLIENT.clientId, waitMs: 100 })
  assert.equal(command.kind, 'close')
  assert.deepEqual(command.args, { tabId: 'tab-3' })
  broker.result({
    clientId: CLIENT.clientId,
    id: command.id,
    ok: true,
    value: { tabId: 'tab-3', closed: true },
  })
  assert.deepEqual(await pending, { tabId: 'tab-3', closed: true })
})

// ---------------------------------------------------------------------------
// Host service `ctx.innerChrome` (CONTRACT.md §8.2)
// ---------------------------------------------------------------------------

test('apply provides the innerChrome service with the contract surface', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  const service = innerChromeService(plugin)

  assert.equal(service.protocol, 1)
  assert.equal(service.version, '0.2.0')
  for (const method of [
    'status',
    'isConnected',
    'capabilities',
    'command',
    'open',
    'read',
    'click',
    'screenshot',
    'tabs',
    'navigate',
    'evaluate',
    'close',
  ]) {
    assert.equal(typeof service[method], 'function', `${method} must be a function`)
  }

  assert.equal(service.isConnected(), false)
  assert.deepEqual(service.capabilities(), [])
  const status = service.status()
  assert.equal(status.ok, undefined, 'status() is the broker payload without the route envelope')
  assert.equal(status.protocol, 1)
  assert.equal(status.version, '0.2.0')
  assert.equal(status.pendingCommands, 0)
  assert.equal(status.client.connected, false)
  assert.equal(typeof status.screenshotsDir, 'string')

  const capabilities = [...CLIENT.capabilities, 'eval', 'close', 'inject']
  await callRoute(plugin.routes, ROUTE_PATHS.hello, { ...CLIENT, capabilities })
  assert.equal(service.isConnected(), true)
  assert.deepEqual(service.capabilities(), capabilities)

  const pending = service.tabs()
  assert.equal(service.status().pendingCommands, 1)
  const command = await nextCommand(plugin.routes)
  await sendResult(plugin.routes, command, { tabs: [] })
  assert.deepEqual(await pending, { tabs: [] })
  assert.equal(service.status().pendingCommands, 0)
})

test('service evaluate clamps the client timeout and waits 5s longer at the broker', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)
  const service = innerChromeService(plugin)

  const requested = [5, 1234, 999999, undefined]
  const delays = []
  const realSetTimeout = globalThis.setTimeout
  let pending
  globalThis.setTimeout = (callback, delay, ...rest) => {
    delays.push(delay)
    return realSetTimeout(callback, delay, ...rest)
  }
  try {
    pending = requested.map((timeoutMs) => service.evaluate('document.title', { timeoutMs }))
    for (const promise of pending) promise.catch(() => {})
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  // Worker: client timeout + 5000 ms, in the same order as the queued calls.
  assert.deepEqual(delays, [5100, 6234, 65000, 20000])

  const expectedArgs = [100, 1234, 60000, 15000]
  for (const [index, clientTimeout] of expectedArgs.entries()) {
    const command = await nextCommand(plugin.routes)
    assert.equal(command.kind, 'eval')
    assert.equal(command.args.expression, 'document.title')
    assert.equal(command.args.timeoutMs, clientTimeout)
    const value = {
      tabId: 'tab-1',
      url: 'https://example.com/',
      title: 'Example Domain',
      value: index,
    }
    await sendResult(plugin.routes, command, value)
    assert.deepEqual(await pending[index], value)
  }
})

test('service evaluate surfaces the EVAL_TIMEOUT and EVAL_FAILED client codes', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)
  const service = innerChromeService(plugin)

  const timedOut = service.evaluate('neverResolves()')
  const timeoutCommand = await nextCommand(plugin.routes)
  await callRoute(plugin.routes, ROUTE_PATHS.result, {
    clientId: CLIENT.clientId,
    id: timeoutCommand.id,
    ok: false,
    error: { code: 'EVAL_TIMEOUT', message: '页面脚本执行超时。' },
  })
  await assert.rejects(timedOut, (error) => {
    assert.equal(error.code, 'EVAL_TIMEOUT')
    assert.equal(error.message, '页面脚本执行超时。')
    return true
  })

  const failed = service.evaluate('throw new Error("boom")')
  const failedCommand = await nextCommand(plugin.routes)
  await callRoute(plugin.routes, ROUTE_PATHS.result, {
    clientId: CLIENT.clientId,
    id: failedCommand.id,
    ok: false,
    error: { code: 'EVAL_FAILED', message: 'boom' },
  })
  await assert.rejects(failed, (error) => error.code === 'EVAL_FAILED')
})

test('service methods reject with NO_CLIENT before the browser connects', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  const service = innerChromeService(plugin)

  for (const operation of [
    () => service.evaluate('document.title'),
    () => service.open('example.com'),
    () => service.close('tab-1'),
    () => service.tabs(),
  ]) {
    await assert.rejects(operation, (error) => error.code === 'NO_CLIENT')
  }
})

test('service evaluate normalizes the page value onto JSON', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)
  const service = innerChromeService(plugin)

  const pending = service.evaluate('undefined')
  const command = await nextCommand(plugin.routes)
  // `JSON.stringify` drops undefined fields: a client that returns no value
  // must surface as `null` on the Host side.
  await sendResult(plugin.routes, command, {
    tabId: 'tab-1',
    url: 'https://example.com/',
    title: 'Example Domain',
  })
  assert.deepEqual(await pending, {
    tabId: 'tab-1',
    url: 'https://example.com/',
    title: 'Example Domain',
    value: null,
  })
})

test('service open forwards injection options and tab routing', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)
  const service = innerChromeService(plugin)

  const pending = service.open('example.com', {
    newTab: true,
    tabId: 'tab-9',
    sessionId: 'session-9',
    injectScript: 'window.__T__ = 1',
    waitForLoad: false,
  })
  const command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'open')
  assert.deepEqual(command.args, {
    url: 'https://example.com/',
    newTab: true,
    waitForLoad: false,
    injectScript: 'window.__T__ = 1',
  })
  assert.equal(command.tabId, 'tab-9')
  assert.equal(command.sessionId, 'session-9')

  const value = {
    tabId: 'tab-9',
    sessionId: 'session-9',
    url: 'https://example.com/',
    title: 'Example Domain',
    loading: true,
    injected: true,
  }
  await sendResult(plugin.routes, command, value)
  assert.deepEqual(await pending, value)
})

test('service close enqueues args.tabId and resolves the closed tab', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)
  const service = innerChromeService(plugin)

  const pending = service.close('tab-7')
  const command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'close')
  assert.deepEqual(command.args, { tabId: 'tab-7' })
  assert.equal(command.tabId, 'tab-7')

  await sendResult(plugin.routes, command, { tabId: 'tab-7', closed: true })
  assert.deepEqual(await pending, { tabId: 'tab-7', closed: true })
  await assert.rejects(service.close(''), (error) => error.code === 'BAD_ARGS')
})

test('service command/read/navigate forward their arguments', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)
  const service = innerChromeService(plugin)

  const read = service.read({ maxChars: 500 })
  let command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'read')
  assert.deepEqual(command.args, { maxChars: 500 })
  await sendResult(plugin.routes, command, {
    tabId: 'tab-1',
    url: 'https://example.com/',
    title: 'A',
    text: 'hi',
    chars: 2,
    truncated: false,
  })
  assert.equal((await read).text, 'hi')

  const navigate = service.navigate({ action: 'goto', url: 'example.com/next' })
  command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'navigate')
  assert.deepEqual(command.args, { action: 'goto', url: 'https://example.com/next' })
  await sendResult(plugin.routes, command, {
    tabId: 'tab-1',
    url: 'https://example.com/next',
    title: 'Next',
  })
  assert.equal((await navigate).url, 'https://example.com/next')

  const raw = service.command('tabs', {})
  command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'tabs')
  assert.deepEqual(command.args, {})
  await sendResult(plugin.routes, command, {
    tabs: [{ tabId: 'tab-1', sessionId: 's', url: 'https://a.example/', title: 'A', active: true }],
  })
  assert.equal((await raw).tabs.length, 1)
})

test('the provided service rejects with CLIENT_GONE after the plugin unloads', async (t) => {
  const plugin = await setupPlugin()
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)
  const service = innerChromeService(plugin)
  try {
    assert.equal(service.isConnected(), true)
  } finally {
    await plugin.cleanup()
  }

  assert.equal(service.isConnected(), false)
  assert.equal(service.status().client.connected, false)
  await assert.rejects(service.evaluate('document.title'), (error) => error.code === 'CLIENT_GONE')
  await assert.rejects(service.tabs(), (error) => error.code === 'CLIENT_GONE')
})

test('inner_chrome_open forwards service-only options without schema changes', async (t) => {
  const plugin = await setupPlugin()
  t.after(plugin.cleanup)
  await callRoute(plugin.routes, ROUTE_PATHS.hello, CLIENT)

  const tool = plugin.tools.get('inner_chrome_open')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['newTab', 'url'])

  const pending = tool.execute(
    { url: 'example.com', injectScript: 'window.__T__ = 1', waitForLoad: false },
    createExec().exec,
  )
  const command = await nextCommand(plugin.routes)
  assert.equal(command.kind, 'open')
  assert.equal(command.args.injectScript, 'window.__T__ = 1')
  assert.equal(command.args.waitForLoad, false)

  await sendResult(plugin.routes, command, {
    tabId: 'tab-1',
    sessionId: 'session-1',
    url: 'https://example.com/',
    title: 'Example Domain',
    loading: true,
    injected: true,
  })
  assert.equal((await pending).injected, true)
})
