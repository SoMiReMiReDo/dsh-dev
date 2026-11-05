/**
 * HTTP(S) URL validation and normalization for the Host half of
 * `inner-chrome`.
 *
 * The contract for `assertHttpUrl` (see CONTRACT.md §3.3):
 * - a bare host (`example.com`, `example.com:8080/x`) gets an `https://`
 *   prefix; a protocol-relative URL (`//host/path`) gets `https:`;
 * - anything that is not `http:`/`https:` is rejected (`javascript:`, `file:`,
 *   `data:`, `mailto:`, ...);
 * - URLs carrying a username or password are rejected;
 * - URLs longer than 2048 characters are rejected.
 *
 * Every rejection throws an `Error` with `code === 'BAD_ARGS'`, which is the
 * Host-side error code CONTRACT.md prescribes for invalid tool arguments.
 */

/** Maximum accepted URL length, in characters. */
export const MAX_URL_LENGTH = 2048

/** Error code attached to every rejection. */
export const INVALID_URL_CODE = 'BAD_ARGS'

/**
 * Schemes that must never be normalized or opened. They are also schemes that
 * look like `host:port` to a naive parser, so they are denied explicitly.
 */
const REJECTED_SCHEMES = new Set([
  'about',
  'blob',
  'chrome',
  'chrome-extension',
  'data',
  'devtools',
  'file',
  'ftp',
  'ftps',
  'javascript',
  'mailto',
  'tel',
  'vbscript',
  'view-source',
  'ws',
  'wss',
])

/**
 * Build one validation error.
 * @param message - model-facing reason.
 * @returns the error, carrying the Host-side `BAD_ARGS` code.
 */
function invalidUrl(message) {
  const error = new Error(message)
  error.name = 'InnerChromeUrlError'
  error.code = INVALID_URL_CODE
  return error
}

/**
 * Validate and normalize an HTTP(S) URL.
 *
 * Throws instead of returning a sentinel: callers in this plugin map the
 * thrown `code` straight onto the command/result error protocol.
 *
 * @param value - untrusted URL candidate (tool argument or command payload).
 * @returns the normalized absolute URL string.
 */
export function assertHttpUrl(value) {
  if (typeof value !== 'string') throw invalidUrl('url 必须是字符串。')
  let candidate = value.trim()
  if (candidate === '') throw invalidUrl('url 不能为空。')
  if (candidate.length > MAX_URL_LENGTH) {
    throw invalidUrl(`url 太长（上限 ${MAX_URL_LENGTH} 个字符）。`)
  }

  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`
  } else {
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(candidate)
    if (schemeMatch !== null) {
      const scheme = schemeMatch[1].toLowerCase()
      if (scheme === 'http' || scheme === 'https') {
        // Keep the explicit scheme; the URL parser normalizes it.
      } else if (REJECTED_SCHEMES.has(scheme)) {
        throw invalidUrl(`只支持 http(s) 网址，不支持 ${scheme}: 协议。`)
      } else {
        // `example.com:8080/path` and `localhost:3000` parse as an unknown
        // scheme plus digits; the leading label is really a host. Anything
        // else (`javascript:alert(1)`, `foo:bar`) stays rejected.
        const rest = candidate.slice(schemeMatch[0].length)
        if (!/^\d+([/?#]|$)/.test(rest)) {
          throw invalidUrl(`只支持 http(s) 网址，不支持 ${scheme}: 协议。`)
        }
        candidate = `https://${candidate}`
      }
    } else {
      candidate = `https://${candidate}`
    }
  }

  if (candidate.length > MAX_URL_LENGTH) {
    throw invalidUrl(`url 太长（上限 ${MAX_URL_LENGTH} 个字符）。`)
  }

  let parsed
  try {
    parsed = new URL(candidate)
  } catch (error) {
    throw invalidUrl('不是合法的网址。')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidUrl(`只支持 http(s) 网址，不支持 ${parsed.protocol}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalidUrl('url 不能包含用户名或密码。')
  }
  if (parsed.hostname === '') throw invalidUrl('url 缺少主机名。')
  return parsed.toString()
}
