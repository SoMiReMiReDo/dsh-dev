/**
 * Page-side network recorder injected before every navigation.
 *
 * Xiaohongshu's web API is signed by the page's own JavaScript, so the only
 * stable way to read it is to let the site issue its own requests and record
 * the responses. This source patches `window.fetch` and
 * `XMLHttpRequest.prototype.{open,send}` inside the page's main world, keeps a
 * bounded ring buffer of `/api/` responses, and exposes
 * `window.__XHS_TAKE__()` for the Host to drain it.
 *
 * The source is a plain string because it is evaluated in the page, not in the
 * Host process. It must stay dependency-free and idempotent.
 */

/** Max recorded entries per page. */
const MAX_ENTRIES = 300

/** Max recorded bytes per page (approximate, JSON text length). */
const MAX_BYTES = 8 * 1024 * 1024

/** Largest single response kept verbatim; larger ones keep only a prefix. */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024

/** Only same-page API traffic is interesting. */
const API_PATTERN = '/api/'

/** Telemetry/CDN hosts whose `/api/` paths are pure noise for collection. */
const API_BLOCKLIST = ['t2.xiaohongshu.com', 'apm-fe.xiaohongshu.com', '/api/v2/collect', '/api/data']

/** The injected recorder source (IIFE, safe to run twice). */
export const RECORDER_SOURCE = `(() => {
  if (window.__XHS_NET__) return;
  const MAX_ENTRIES = ${MAX_ENTRIES};
  const MAX_BYTES = ${MAX_BYTES};
  const MAX_ENTRY_BYTES = ${MAX_ENTRY_BYTES};
  const API_PATTERN = ${JSON.stringify(API_PATTERN)};
  const API_BLOCKLIST = ${JSON.stringify(API_BLOCKLIST)};
  const buffer = [];
  let bytes = 0;
  window.__XHS_NET__ = buffer;

  const isApi = (url) => {
    if (typeof url !== 'string' || url.indexOf(API_PATTERN) === -1) return false;
    for (const blocked of API_BLOCKLIST) {
      if (url.indexOf(blocked) !== -1) return false;
    }
    return true;
  };

  const parseBody = (text) => {
    if (typeof text !== 'string' || text.length === 0) return '';
    const clipped = text.length > MAX_ENTRY_BYTES ? text.slice(0, MAX_ENTRY_BYTES) : text;
    try { return JSON.parse(clipped) } catch { return clipped }
  };

  const remember = (entry) => {
    const size = entry.textLength || 0;
    if (buffer.length >= MAX_ENTRIES || (bytes + size > MAX_BYTES && buffer.length > 0)) {
      const removed = buffer.shift();
      bytes -= removed ? (removed.textLength || 0) : 0;
    }
    buffer.push(entry);
    bytes += size;
    if (bytes > MAX_BYTES) {
      while (buffer.length > 1 && bytes > MAX_BYTES) {
        const removed = buffer.shift();
        bytes -= removed ? (removed.textLength || 0) : 0;
      }
    }
  };

  const record = (url, method, status, text, reqBody) => {
    const body = parseBody(text);
    remember({
      url: String(url),
      method: String(method || 'GET').toUpperCase(),
      status: Number(status) || 0,
      capturedAt: new Date().toISOString(),
      textLength: typeof text === 'string' ? text.length : 0,
      body: body,
      reqBody: typeof reqBody === 'string' && reqBody.length <= 20000 ? reqBody : undefined
    });
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const reqBody = init && typeof init.body === 'string' ? init.body : undefined;
      const promise = originalFetch.apply(this, arguments);
      if (!isApi(url)) return promise;
      return promise.then((response) => {
        try {
          const clone = response.clone();
          clone.text().then((text) => record(url, method, response.status, text, reqBody), () => {});
        } catch (error) {
          // A response body can only be consumed once; a failed clone is harmless.
        }
        return response;
      });
    };
  }

  const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (proto && typeof proto.open === 'function' && typeof proto.send === 'function') {
    const originalOpen = proto.open;
    const originalSend = proto.send;
    proto.open = function (method, url) {
      try {
        this.__xhsRecorder = { method: method, url: String(url) };
      } catch (error) {
        this.__xhsRecorder = undefined;
      }
      return originalOpen.apply(this, arguments);
    };
    proto.send = function () {
      const meta = this.__xhsRecorder;
      if (meta && isApi(meta.url)) {
        try {
          const request = this;
          request.addEventListener('load', () => {
            let text = '';
            try {
              text = request.responseType === '' || request.responseType === 'text' ? request.responseText : '';
            } catch (error) {
              text = '';
            }
            record(meta.url, meta.method, request.status, text, undefined);
          }, { once: true });
        } catch (error) {
          // Recording is best-effort; never break the page's own request.
        }
      }
      return originalSend.apply(this, arguments);
    };
  }

  window.__XHS_TAKE__ = () => {
    const drained = buffer.splice(0, buffer.length);
    bytes = 0;
    return drained;
  };
})();`

/** Expression that drains the recorder buffer and returns it as JSON text. */
export const TAKE_EXPRESSION = 'JSON.stringify(window.__XHS_TAKE__ ? window.__XHS_TAKE__() : [])'
