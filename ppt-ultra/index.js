import { homedir } from 'node:os'
import { join, basename, isAbsolute, relative, sep } from 'node:path'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { Store } from './lib/store.mjs'
export const name = 'ppt-ultra'
export const inject = ['connection','tools','fs','workingDirectory','sessions','workspaceRegistry','agents']
/** 工作台文件选择与对话面板：只接受 .pptx，且必须落在已注册工作区内。 */
const PPTX_NAME=/\.pptx$/i
/** 与 store.open 的限制保持一致（Host 本地直读，不经浏览器上传）。 */
const MAX_OPEN_BYTES=50*1024*1024
/** 单次目录浏览最多返回的条目数。 */
const MAX_BROWSE_ENTRIES=500
export async function apply(ctx, config = {}) {
  const store = new Store(config.dataDir || join(homedir(),'.dsh','ppt-ultra'),config)
  await store.initialize()
  // 对话面板的实时回复：agent/assistant-stream 是全局事件，按 sessionId 累积。
  // fake ctx（dev-server/单测）没有 ctx.on，跳过注册即可。
  const streams=new Map(), streamAttempts=new Map(), streamErrors=new Map()
  const onAssistantStream=({agent,frame})=>{
    const sessionId=agent?.id
    if(typeof sessionId!=='string' || sessionId==='') return
    if(frame?.type==='start') { streamAttempts.set(sessionId,frame.attemptId);streams.set(sessionId,'');streamErrors.delete(sessionId);return }
    if(frame?.type==='end') { streamAttempts.delete(sessionId);streams.delete(sessionId);return }
    if(frame?.type!=='chunk' || streamAttempts.get(sessionId)!==frame.attemptId) return
    const chunk=frame.chunk
    if(chunk?.type==='text-delta' && typeof chunk.text==='string') streams.set(sessionId,(streams.get(sessionId) || '')+chunk.text)
  }
  const onAgentError=({agent,error})=>{
    const sessionId=agent?.id
    if(typeof sessionId==='string' && sessionId!=='') streamErrors.set(sessionId,String(error?.message ?? error))
  }
  ctx.effect(()=>{ if(typeof ctx.on!=='function') return;return ctx.on('agent/assistant-stream',onAssistantStream,{global:true}) },'ppt-ultra: assistant stream')
  ctx.effect(()=>{ if(typeof ctx.on!=='function') return;return ctx.on('agent/error',onAgentError,{global:true}) },'ppt-ultra: assistant error')
  const actions = {
    open: ({sessionId,name,base64}) => store.open({sessionId,name,base64}),
    list: ({sessionId}) => [...store.records.values()].filter(r=>r.sessionId===sessionId).map(r=>({id:r.id,name:r.name,updatedAt:r.updatedAt})),
    state: ({id,sessionId}) => store.view(store.get(id,sessionId)),
    propose: body => store.propose(body), apply: body => store.apply(body), cancel: body => store.cancel(body), undo: body => store.undo(body), export: body => store.export(body),
    runtime: () => store.rt.available,
    workspaces: () => ({items:workspaceItems(ctx)}),
    browse: body => browseWorkspace(ctx,body),
    openPath: body => openWorkspacePath(ctx,store,body),
    conversation: body => conversationSnapshot(ctx,streams,streamErrors,body),
  }
  for(const [action,handler] of Object.entries(actions)) ctx.effect(()=>ctx.connection.fetch.register({
    path:'/api/ppt-ultra.'+action,methods:['POST'],requestBody:'buffered',
    async fetch(request) {
      try {
        if(!request.headers.get('content-type')?.includes('application/json')) throw new Error('请求必须使用 JSON')
        const text=await request.text();if(text.length>72*1024*1024) throw new Error('请求超过大小限制')
        const body=JSON.parse(text);return Response.json({ok:true,value:await handler(body)})
      } catch(error) { return Response.json({ok:false,error:error.message},{status:400}) }
    }
  }),'ppt-ultra: '+action)
  // 预览图片走精确 GET 路由。必须声明 requestBody:'buffered'：不声明时
  // connection 的 bridge 会按 streaming 处理，给 GET 请求挂上 body 并抛
  // “Request with GET/HEAD method cannot have body”，webServer 捕获后统一
  // 回 400 空响应，于是所有 <img> 预览都显示为裂图。
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/ppt-ultra.asset',methods:['GET','HEAD'],requestBody:'buffered',async fetch(request){
    try {
      const headers={'content-type':'image/png','cache-control':'private, no-store','x-content-type-options':'nosniff'}
      if(request.method==='HEAD') return new Response(null,{headers})
      return new Response(await store.asset(Object.fromEntries(new URL(request.url).searchParams)),{headers})
    } catch { return new Response('Not found',{status:404}) }
  }}),'ppt-ultra: images')
  const tool = (name, description, properties, required, execute) => ctx.effect(()=>ctx.tools.register({name,description,timeoutMs:240000,
    parameters:{type:'object',properties,required,additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute,
  }),'ppt-ultra: '+name)
  const session = exec => { if(!exec.agent?.id) throw new Error('此工具需要会话');return exec.agent.id }
  tool('ppt_ultra_open','打开会话中的本地 PPTX 附件副本。返回稳定的页面和对象 ID。用户从左侧栏「PPT 工作台」进入工作台，打开文稿后界面会自动切换过去；不得改写原文件。', {path:{type:'string'}},['path'],async({path},exec)=>{
    const cwd=await ctx.workingDirectory.ensure(exec.agent,exec.signal)
    const target=await ctx.fs.resolve(path,{cwd,signal:exec.signal})
    const bytes=await ctx.fs.readBytes(target,exec.signal,50*1024*1024)
    const sourcePath=ctx.fs.processPath(target)
    return store.open({sessionId:session(exec),name:basename(path),base64:Buffer.from(bytes).toString('base64'),sourcePath})
  })
  tool('ppt_ultra_read','读取当前会话的 PPT Ultra 文稿及目标对象当前值。必须先读后生成操作，歧义时向用户询问。',{id:{type:'string'}},[],async({id},exec)=>{
    const sessionId=session(exec)
    if(!id) return {documents:actions.list({sessionId})}
    return actions.state({id,sessionId})
  })
  tool('ppt_ultra_clarify','目标含混时在 PPT Ultra 工作台显示问题与候选对象。不要猜测；用户会选择对象后补充指令。',{id:{type:'string'},revision:{type:'integer'},question:{type:'string'},candidates:{type:'array',items:{type:'string'}}},['id','revision','question','candidates'],async(args,exec)=>store.clarify({...args,sessionId:session(exec)}))
  tool('ppt_ultra_propose','为已打开的 PPTX 生成待应用操作与真实预览，不提交修改。每条操作必须含 type、targets 和 expected（对象 ID 到 fingerprint）。type=text 使用 text；align 使用 mode(left/right/top/bottom/center/middle) 和 reference；distribute 使用 axis(horizontal/vertical)；resize 使用 width/height（EMU，914400=1英寸）；image 使用 imageBase64（PNG/JPEG）。禁止猜测目标 ID；仅用户在工作台点击应用后写入草稿。',{
    id:{type:'string'},revision:{type:'integer'},operations:{type:'array',items:{type:'object',additionalProperties:true}}
  },['id','revision','operations'],async(args,exec)=>store.propose({...args,sessionId:session(exec)}))
}

/** 已注册工作区到文件面板条目的投影；实体提供 id/title/path getter。 */
function workspaceItems(ctx) {
  const registry=ctx.workspaceRegistry
  if(registry===undefined || typeof registry.list!=='function') throw new Error('工作区服务不可用')
  return registry.list().map(workspace=>({id:workspace.id,title:workspace.title,path:workspace.path}))
}

/** 注册工作区的规范化根目录；已消失的目录不参与后续包含校验。 */
async function workspaceRoots(ctx) {
  const roots=[]
  for(const item of workspaceItems(ctx)){
    if(typeof item.path!=='string' || item.path==='') continue
    try { roots.push(await realpath(item.path)) } catch {}
  }
  return roots
}

/** 目标是否等于根目录或位于其下（按路径段比较，避免 /a/b 命中 /a/bc）。 */
function isWithin(root,target) {
  const path=relative(root,target)
  return path==='' || path!=='..' && !path.startsWith('..'+sep) && !isAbsolute(path)
}

/** 浏览与打开只接受已注册工作区内的路径，realpath 之后再做包含校验。 */
async function assertInsideWorkspace(ctx,target) {
  const roots=await workspaceRoots(ctx)
  if(!roots.some(root=>isWithin(root,target))) throw new Error('路径不在已注册工作区内')
}

/** 解析为一个真实目录；失败统一回 400 JSON（外层路由 catch）。 */
async function resolveDirectory(input,label) {
  let resolved
  try { resolved=await realpath(input) } catch { throw new Error(label+' 路径不存在或无法访问') }
  const info=await stat(resolved).catch(()=>null)
  if(info===null) throw new Error(label+' 路径不存在或无法访问')
  if(!info.isDirectory()) throw new Error(label+' 不是目录')
  return resolved
}

/** 目录在前、同类按名称排序、隐藏项与非 .pptx 文件不返回，最多 500 项。 */
async function browseEntries(directory) {
  const dirents=await readdir(directory,{withFileTypes:true})
  const directories=[],files=[]
  for(const dirent of dirents){
    if(dirent.name.startsWith('.')) continue
    if(dirent.isDirectory()) directories.push(dirent.name)
    else if(dirent.isFile() && PPTX_NAME.test(dirent.name)) files.push(dirent.name)
  }
  const fileEntries=(await Promise.all(files.map(async name=>{
    const path=join(directory,name)
    const info=await stat(path).catch(()=>null)
    return info===null || !info.isFile() ? null : {name,path,type:'file',size:info.size}
  }))).filter(entry=>entry!==null)
  const compare=(a,b)=>a.localeCompare(b)
  return [
    ...directories.sort(compare).map(name=>({name,path:join(directory,name),type:'dir'})),
    ...fileEntries.sort((a,b)=>compare(a.name,b.name)),
  ].slice(0,MAX_BROWSE_ENTRIES)
}

/** POST /api/ppt-ultra.workspaces 之外的文件浏览：root 必须落在注册工作区内。 */
async function browseWorkspace(ctx,body) {
  if(typeof body!=='object' || body===null || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
  const rootInput=typeof body.root==='string' ? body.root.trim() : ''
  if(rootInput==='') throw new Error('缺少 root')
  const root=await resolveDirectory(rootInput,'root')
  await assertInsideWorkspace(ctx,root)
  const dirInput=typeof body.dir==='string' ? body.dir.trim() : ''
  let dir=root
  if(dirInput!=='') {
    dir=await resolveDirectory(isAbsolute(dirInput) ? dirInput : join(root,dirInput),'dir')
    if(!isWithin(root,dir)) throw new Error('dir 不在 root 内')
  }
  return {root,dir,entries:await browseEntries(dir)}
}

/** 直接从 Host 本地读取工作区内的 .pptx（不经浏览器上传 base64）。 */
async function openWorkspacePath(ctx,store,body) {
  if(typeof body!=='object' || body===null || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
  const sessionId=sessionIdOf(body)
  const input=typeof body.path==='string' ? body.path.trim() : ''
  if(input==='') throw new Error('缺少文件路径')
  let target
  try { target=await realpath(input) } catch { throw new Error('文件不存在或无法访问') }
  if(!PPTX_NAME.test(target)) throw new Error('首版仅支持 .pptx 文件')
  const info=await stat(target).catch(()=>null)
  if(info===null) throw new Error('文件不存在或无法访问')
  if(!info.isFile()) throw new Error('路径不是文件')
  if(info.size>MAX_OPEN_BYTES) throw new Error('文件须小于 50 MiB')
  await assertInsideWorkspace(ctx,target)
  const bytes=await readFile(target)
  if(bytes.length>MAX_OPEN_BYTES) throw new Error('文件须小于 50 MiB')
  return store.open({sessionId,name:basename(target),base64:bytes.toString('base64'),sourcePath:target})
}

/** 对话面板投影：人类可见消息 + 当前流式回复 + 运行态。 */
function conversationSnapshot(ctx,streams,errors,body) {
  if(typeof body!=='object' || body===null || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
  const sessionId=sessionIdOf(body)
  const session=ctx.sessions?.get?.(sessionId)
  const available=session!==undefined
  const messages=available ? (session.deriveMessages?.() ?? [])
    .filter(message=>message.role==='assistant' || message.role==='user' && message.source?.kind==='user')
    .map(message=>({id:message.id,role:message.role,text:(message.content ?? []).filter(block=>block?.type==='text').map(block=>typeof block.text==='string'?block.text:'').join('\n')}))
    .filter(message=>message.text.trim()!=='')
    .slice(-100) : []
  const agent=ctx.agents?.get?.(sessionId)
  const error=errors.get(sessionId)
  return {available,messages,stream:streams.get(sessionId) ?? '',running:agent?.status==='running',...(error===undefined?{}:{error})}
}

/** 路由共用的非空会话标识校验。 */
function sessionIdOf(body) {
  const sessionId=body.sessionId
  if(typeof sessionId!=='string' || sessionId.trim()==='') throw new Error('缺少会话标识')
  return sessionId
}
