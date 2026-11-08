import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
export const root = dirname(dirname(fileURLToPath(import.meta.url)))
export function runtime(config = {}) {
  const resources = process.resourcesPath || '/Applications/DeepSeek Harness.app/Contents/Resources'
  const python = config.python || process.env.PPT_ULTRA_PYTHON || join(homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3')
  const node = config.node || process.env.PPT_ULTRA_NODE || join(resources, 'runtime/primary-runtime/dependencies/node/bin/node')
  let cli = config.renderCli || process.env.PPT_ULTRA_RENDER_CLI
  if (!cli) { try { cli = require.resolve('@deepseek-ai/libreoffice-kit/cli').replace('app.asar/', 'app.asar.unpacked/') } catch {} }
  cli ||= join(resources, 'app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js')
  return { python, node, cli, available: { python: existsSync(python), renderer: existsSync(node) && existsSync(cli) } }
}
export function run(executable, args, input, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe','pipe','pipe'], shell: false })
    let stdout = '', stderr = '', settled = false
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value) }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('处理超时，请重试；已通过检查的草稿未变更。')) }, timeout)
    child.on('error', e => finish(e))
    child.stdout.on('data', b => { stdout += b; if (stdout.length > 32 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('处理输出超过限制')) } })
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000) })
    child.on('close', code => {
      try { const data = JSON.parse(stdout.trim()); if (code || data.ok === false) throw new Error(data.error || stderr || `处理失败 (${code})`); finish(null, data.value ?? data) }
      catch (e) { finish(new Error(e instanceof SyntaxError ? stderr || stdout.slice(-2000) || '无法启动处理程序' : e.message)) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
  })
}
export function engine(rt, request) { return run(rt.python, [join(root,'python/pptx_engine.py')], request) }
let renderQueue = Promise.resolve()
export function render(rt, file, directory, pages) {
  const next = renderQueue.catch(() => {}).then(() => run(rt.node, [rt.cli, 'render', '--input', file, '--output-dir', directory, ...(pages ? ['--pages', pages.join(',')] : [])]))
  renderQueue = next
  return next
}
