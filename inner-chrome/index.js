/**
 * Host half of `dsh-inner-chrome`.
 *
 * The plugin gives DSH a real built-in browser in the right sidebar. The Host
 * process (DSH Electron main process, plain Node) never touches Electron: it
 * keeps the in-memory command broker, exposes four POST routes the browser
 * client polls, and registers six Agent tools that enqueue browser commands and
 * wait for the client's result.
 *
 * Wire contract (CONTRACT.md §3):
 * - `/api/inner-chrome.hello`  register the client, return protocol/version.
 * - `/api/inner-chrome.poll`   long poll for commands.
 * - `/api/inner-chrome.result` settle one command.
 * - `/api/inner-chrome.status` heartbeat snapshot.
 *
 * Agent tools: `inner_chrome_open`, `inner_chrome_read`, `inner_chrome_click`,
 * `inner_chrome_screenshot`, `inner_chrome_tabs`, `inner_chrome_navigate`.
 *
 * Other Host plugins can reuse the same browser through the `innerChrome`
 * service provided by `apply` (page script execution, closing tabs, navigation
 * with an injected script; CONTRACT.md §8.2) — no extra Agent tools are added
 * for it.
 *
 * Screenshots are written lazily to `<data dir>/screenshots`; every other piece
 * of state is process-local and vanishes on plugin unload (the client reconnects
 * and re-hellos).
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  createBroker,
  DEFAULT_EVAL_TIMEOUT_MS,
  MAX_EVAL_TIMEOUT_MS,
  MIN_EVAL_TIMEOUT_MS,
} from './lib/broker.mjs'

/** Plugin name shown by the loader. */
export const name = 'inner-chrome'

/** Services required before activation. */
export const inject = ['connection', 'tools']

/** Wire protocol version shared with `client.js`. */
const PROTOCOL = 1

/** Plugin version echoed by `hello`/`status` (matches package.json). */
const VERSION = '0.2.0'

/** Bounded request body size: 16 MiB. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/** Default data directory; nothing is written until a screenshot arrives. */
const DEFAULT_DATA_DIR = join(homedir(), '.dsh', 'inner-chrome')

/** Default screenshot directory. */
const DEFAULT_SCREENSHOTS_DIR = join(DEFAULT_DATA_DIR, 'screenshots')

/** Route paths, kept in one place for tests and for the client contract. */
const ROUTES = {
  hello: '/api/inner-chrome.hello',
  poll: '/api/inner-chrome.poll',
  result: '/api/inner-chrome.result',
  status: '/api/inner-chrome.status',
}

/** Error codes the Host itself may produce (CONTRACT.md §3.3). */
const HOST_ERROR_CODES = new Set(['NO_CLIENT', 'TIMEOUT', 'CLIENT_GONE', 'BAD_ARGS', 'INTERNAL'])

/** Error codes produced by the browser client and relayed verbatim. */
const CLIENT_ERROR_CODES = new Set([
  'NO_TAB',
  'NO_WEBVIEW',
  'READ_UNSUPPORTED',
  'SCREENSHOT_FAILED',
  'NAV_FAILED',
  'CLICK_NOT_FOUND',
  'UNSUPPORTED_URL',
  'EVAL_FAILED',
  'EVAL_TIMEOUT',
])

/**
 * Build an error carrying one protocol error code.
 * @param code - error code.
 * @param message - model-facing reason.
 * @returns the error.
 */
function pluginError(code, message) {
  const error = new Error(message)
  error.name = 'InnerChromeError'
  error.code = code
  return error
}

/**
 * Project an arbitrary thrown value onto the plugin error shape.
 * @param error - caught value.
 * @returns an Error with a protocol `code`.
 */
function asPluginError(error) {
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? error.code : ''
    if (HOST_ERROR_CODES.has(code) || CLIENT_ERROR_CODES.has(code)) return error
    return pluginError('INTERNAL', error.message === '' ? '内置浏览器操作失败。' : error.message)
  }
  if (typeof error === 'string' && error !== '') return pluginError('INTERNAL', error)
  return pluginError('INTERNAL', '内置浏览器操作失败。')
}

/**
 * Project a value onto lossless JSON: drop `undefined` keys and non-finite
 * numbers so the tool pipeline accepts the result.
 * @param value - arbitrary tool return value.
 * @returns the JSON-safe projection.
 */
function jsonValue(value) {
  if (value === undefined) return null
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item) => jsonValue(item))
  if (typeof value === 'object') {
    const output = {}
    for (const key of Object.keys(value)) {
      const item = value[key]
      if (item === undefined) continue
      output[key] = jsonValue(item)
    }
    return output
  }
  return String(value)
}

/**
 * Read a bounded JSON body, never throwing past the route wrapper.
 * @param request - buffered request.
 * @returns the parsed object (empty for an empty body).
 */
async function readBody(request) {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw pluginError('BAD_ARGS', '请求体过大（上限 16 MiB）。')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw pluginError('BAD_ARGS', '请求体必须是 JSON。')
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
}

/**
 * Read a config number, falling back to a default.
 * @param value - candidate.
 * @param fallback - value used when the candidate is not a finite positive number.
 * @returns the number.
 */
function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/**
 * Coerce an optional integer to a non-negative integer.
 * @param value - candidate.
 * @returns the integer, or 0.
 */
function nonNegativeInteger(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.trunc(number)
}

/**
 * Clamp an optional number into `[min, max]`, falling back when it is not
 * a finite number.
 * @param value - candidate.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - value used when the candidate is not finite.
 * @returns the bounded integer.
 */
function clampInteger(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * Coerce an optional string field.
 * @param value - candidate.
 * @param fallback - value used when the candidate is not a string.
 * @returns the string.
 */
function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/**
 * Render a page title/URL line.
 * @param title - page title.
 * @param url - page URL.
 * @returns the joined text.
 */
function titleAndUrl(title, url) {
  const label = typeof title === 'string' && title !== '' ? title : '(无标题)'
  return `${label} ${typeof url === 'string' ? url : ''}`.trim()
}

/**
 * Activate the Host plugin.
 *
 * @param ctx - Host plugin context (`connection`, `tools`, `effect`).
 * @param config - optional Loader config. Only tests set it today:
 *   `{ screenshotsDir?, commandTimeoutMs?, clientTimeoutMs?, sweepIntervalMs? }`.
 */
export function apply(ctx, config) {
  const screenshotsDir = resolve(
    typeof config?.screenshotsDir === 'string' && config.screenshotsDir !== ''
      ? config.screenshotsDir
      : DEFAULT_SCREENSHOTS_DIR,
  )

  const broker = createBroker({
    protocol: PROTOCOL,
    version: VERSION,
    screenshotsDir,
    commandTimeoutMs: positiveNumber(config?.commandTimeoutMs, 25000),
    clientTimeoutMs: positiveNumber(config?.clientTimeoutMs, 30000),
    sweepIntervalMs: positiveNumber(config?.sweepIntervalMs, 5000),
  })

  // -------------------------------------------------------------------
  // HTTP routes (CONTRACT.md §3.2): always HTTP 200 + JSON so the client
  // poll loop can never be broken by a transport error.
  // -------------------------------------------------------------------

  /**
   * Register one POST JSON route.
   * @param path - route path.
   * @param handler - receives the parsed body, returns the JSON payload.
   */
  function registerRoute(path, handler) {
    ctx.effect(() => ctx.connection.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readBody(request)
          return Response.json(await handler(body))
        } catch (error) {
          const failure = asPluginError(error)
          return Response.json(
            { ok: false, error: { code: failure.code, message: failure.message } },
            { status: 200 },
          )
        }
      },
    }), `inner-chrome: route ${path}`)
  }

  registerRoute(ROUTES.hello, async (body) => ({ ok: true, ...broker.hello(body) }))
  registerRoute(ROUTES.poll, async (body) => ({ ok: true, ...(await broker.poll(body)) }))
  registerRoute(ROUTES.result, async (body) => ({ ok: true, ...broker.result(body) }))
  registerRoute(ROUTES.status, async () => ({ ok: true, ...broker.status() }))

  // Process-local state: unloading the plugin rejects every pending command.
  ctx.effect(() => () => { broker.dispose() }, 'inner-chrome: dispose broker')

  // -------------------------------------------------------------------
  // Host service for other Host plugins (CONTRACT.md §8.2)
  // -------------------------------------------------------------------

  /**
   * Enqueue one command for a Host-plugin caller and project its value onto
   * JSON. Every service method goes through here so errors always carry a
   * protocol `code`.
   * @param kind - command kind.
   * @param args - command arguments (validated by the broker).
   * @param options - `{ sessionId?, tabId?, timeoutMs?, signal? }`.
   * @returns the client-provided command value.
   */
  async function serviceCommand(kind, args, options = {}) {
    try {
      return jsonValue(await broker.enqueue(kind, args ?? {}, {
        sessionId: options?.sessionId,
        tabId: options?.tabId,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      }))
    } catch (error) {
      throw asPluginError(error)
    }
  }

  /**
   * Execute one expression in the page's main world (CONTRACT.md §8.1/§8.2).
   *
   * The broker waits 5 s longer than the client timeout so the client can
   * report `EVAL_TIMEOUT` before the host reports its generic `TIMEOUT`.
   *
   * @param expression - JS expression for the page.
   * @param options - `{ sessionId?, tabId?, timeoutMs?, signal? }`.
   * @returns `{ tabId, url, title, value }` with the JSON-safe page value.
   */
  async function evaluateInPage(expression, options = {}) {
    const clientTimeoutMs = clampInteger(
      options?.timeoutMs,
      MIN_EVAL_TIMEOUT_MS,
      MAX_EVAL_TIMEOUT_MS,
      DEFAULT_EVAL_TIMEOUT_MS,
    )
    const value = await serviceCommand('eval', { expression, timeoutMs: clientTimeoutMs }, {
      sessionId: options?.sessionId,
      tabId: options?.tabId,
      timeoutMs: clientTimeoutMs + 5000,
      signal: options?.signal,
    })
    return {
      tabId: stringOr(value?.tabId, ''),
      url: stringOr(value?.url, ''),
      title: stringOr(value?.title, ''),
      value: value?.value ?? null,
    }
  }

  /**
   * Build the `innerChrome` service consumed by other Host plugins
   * (CONTRACT.md §8.2).
   * @returns the service object provided on the plugin context.
   */
  function createInnerChromeService() {
    return {
      protocol: PROTOCOL,
      version: VERSION,
      status: () => broker.status(),
      isConnected: () => broker.status().client.connected === true,
      capabilities: () => [...broker.status().client.capabilities],
      command: (kind, args, options) => serviceCommand(kind, args, options),
      open: (url, options = {}) => serviceCommand('open', {
        url,
        newTab: options?.newTab,
        injectScript: options?.injectScript,
        waitForLoad: options?.waitForLoad,
      }, options),
      read: (args = {}, options) => serviceCommand('read', args, options),
      click: (args = {}, options) => serviceCommand('click', args, options),
      screenshot: (args = {}, options) => serviceCommand('screenshot', args, options),
      tabs: (options) => serviceCommand('tabs', {}, options),
      navigate: (args = {}, options) => serviceCommand('navigate', args, options),
      evaluate: (expression, options) => evaluateInPage(expression, options),
      close: (tabId, options = {}) => serviceCommand('close', { tabId }, {
        ...options,
        tabId: typeof tabId === 'string' && tabId !== '' ? tabId : options?.tabId,
      }),
    }
  }

  // Cordis recycles provided services when the plugin fiber unloads.
  ctx.provide('innerChrome', createInnerChromeService())

  // -------------------------------------------------------------------
  // Agent tools (CONTRACT.md §3.4)
  // -------------------------------------------------------------------

  /**
   * Read the session id carried by a tool execution.
   * @param exec - tool run context.
   * @returns the session id, or undefined.
   */
  function sessionIdOf(exec) {
    const id = exec?.agent?.session?.id
    if (typeof id === 'string' && id !== '') return id
    const fallback = exec?.agent?.id
    return typeof fallback === 'string' && fallback !== '' ? fallback : undefined
  }

  /**
   * Enqueue one browser command and wait for its result.
   * @param kind - command kind.
   * @param args - tool arguments.
   * @param exec - tool run context (session id + abort signal).
   * @returns the client-provided command value.
   */
  async function runCommand(kind, args, exec) {
    try {
      return await broker.enqueue(kind, args, {
        sessionId: sessionIdOf(exec),
        signal: exec?.signal,
      })
    } catch (error) {
      throw asPluginError(error)
    }
  }

  /**
   * Persist one screenshot result returned by the client.
   * @param value - `screenshot` command value with `base64`.
   * @returns the tool-facing result (`path`, `bytes`, `width`, `height`, ...).
   */
  async function saveScreenshot(value) {
    const encoded = stringOr(value?.base64, '').replace(/^data:[^,]*,/, '')
    if (encoded === '') throw pluginError('INTERNAL', '内置浏览器没有返回截图数据。')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length === 0) throw pluginError('INTERNAL', '内置浏览器返回的截图数据为空。')
    await mkdir(screenshotsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(screenshotsDir, `${stamp}-${randomUUID().slice(0, 8)}.jpg`)
    await writeFile(file, bytes)
    return jsonValue({
      path: file,
      bytes: bytes.length,
      width: nonNegativeInteger(value?.width),
      height: nonNegativeInteger(value?.height),
      url: stringOr(value?.url, ''),
      title: stringOr(value?.title, ''),
    })
  }

  ctx.effect(() => ctx.tools.register({
    name: 'inner_chrome_open',
    description: `在 DSH 内置浏览器（右侧栏）里打开一个 HTTP(S) 网页。浏览网页请优先使用本工具：需要用户看到页面、需要点击/交互、需要保持登录态的网页，都不要用 web_fetch 代替。地址可以写裸域名，会自动补全 https://。`,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网址，例如 example.com 或 https://example.com/path。' },
        newTab: { type: 'boolean', description: '是否在新标签页打开；默认沿用当前标签页。' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const title = typeof value?.title === 'string' && value.title !== ''
          ? value.title
          : stringOr(value?.url, '')
        return [{ type: 'text', text: `已在内置浏览器打开：${title}\n${stringOr(value?.url, '')}` }]
      },
    },
    async execute(args, exec) {
      return jsonValue(await runCommand('open', args, exec))
    },
  }), 'inner-chrome: tool inner_chrome_open')

  ctx.effect(() => ctx.tools.register({
    name: 'inner_chrome_read',
    description: `读取内置浏览器当前标签页的正文纯文本（需要 DSH Desktop；Web 端会提示不可用）。需要网页正文时优先用它，而不是 web_fetch。`,
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', description: '最多返回的字符数，默认 20000。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const text = stringOr(value?.text, '')
        const hint = value?.truncated === true ? '\n\n（正文已截断，可调大 maxChars 再读一次。）' : ''
        return [{
          type: 'text',
          text: `标题: ${stringOr(value?.title, '')}\nURL: ${stringOr(value?.url, '')}\n\n${text}${hint}`,
        }]
      },
    },
    async execute(args, exec) {
      return jsonValue(await runCommand('read', args, exec))
    },
  }), 'inner-chrome: tool inner_chrome_read')

  ctx.effect(() => ctx.tools.register({
    name: 'inner_chrome_click',
    description: `在内置浏览器当前标签页里点击一个元素：按 CSS selector 或精确文本查找链接/按钮并点击。selector 与 text 至少提供一个；点击后页面可能变化，可再用 inner_chrome_read 查看结果。`,
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器，例如 "a.more" 或 "#submit"。' },
        text: { type: 'string', description: '要点击元素的精确文本，例如 "下一页"。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const page = titleAndUrl(value?.title, value?.url)
        if (value?.found === false) {
          return [{ type: 'text', text: `没有找到可点击的元素（CLICK_NOT_FOUND）。当前页面：${page}` }]
        }
        const tag = stringOr(value?.tag, '元素')
        const target = stringOr(value?.text, '') || stringOr(args?.text, '') || stringOr(args?.selector, '')
        return [{ type: 'text', text: `已点击 ${tag}「${target}」。当前页面：${page}` }]
      },
    },
    async execute(args, exec) {
      return jsonValue(await runCommand('click', args, exec))
    },
  }), 'inner-chrome: tool inner_chrome_click')

  ctx.effect(() => ctx.tools.register({
    name: 'inner_chrome_screenshot',
    description: `对内置浏览器当前标签页截图（JPEG），保存到本地并返回文件路径。需要让用户看到页面效果、或排查页面渲染问题时优先使用本工具。`,
    parameters: {
      type: 'object',
      properties: {
        maxWidth: { type: 'integer', description: '截图的最大宽度（像素），默认沿用客户端设置。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{
          type: 'text',
          text: `截图已保存: ${stringOr(value?.path, '')}（${nonNegativeInteger(value?.width)}x${nonNegativeInteger(value?.height)}，${nonNegativeInteger(value?.bytes)}B）`,
        }]
      },
    },
    async execute(args, exec) {
      const value = await runCommand('screenshot', args, exec)
      return await saveScreenshot(value)
    },
  }), 'inner-chrome: tool inner_chrome_screenshot')

  ctx.effect(() => ctx.tools.register({
    name: 'inner_chrome_tabs',
    description: `列出内置浏览器当前打开的所有标签页（标题、URL、所属会话、是否活跃）。不确定当前页面时先调用它。`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const tabs = Array.isArray(value?.tabs) ? value.tabs : []
        if (tabs.length === 0) return [{ type: 'text', text: '内置浏览器当前没有打开的标签页。' }]
        const lines = tabs.map((tab) => {
          const marker = tab?.active === true ? '[active] ' : ''
          const title = stringOr(tab?.title, '') || '(无标题)'
          return `${marker}${title} — ${stringOr(tab?.url, '')}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      return jsonValue(await runCommand('tabs', args, exec))
    },
  }), 'inner-chrome: tool inner_chrome_tabs')

  ctx.effect(() => ctx.tools.register({
    name: 'inner_chrome_navigate',
    description: `控制内置浏览器当前标签页的导航：back 后退、forward 前进、reload 刷新、goto 跳转到指定网址（goto 必须带 url）。`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['back', 'forward', 'reload', 'goto'],
          description: '导航动作。',
        },
        url: { type: 'string', description: 'goto 时要跳转的网址；裸域名会自动补全 https://。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: `当前页面：${titleAndUrl(value?.title, value?.url)}` }]
      },
    },
    async execute(args, exec) {
      return jsonValue(await runCommand('navigate', args, exec))
    },
  }), 'inner-chrome: tool inner_chrome_navigate')
}
