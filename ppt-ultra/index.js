import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { Store } from './lib/store.mjs'
export const name = 'ppt-ultra'
export const inject = ['connection','tools','fs','workingDirectory']
export async function apply(ctx, config = {}) {
  const store = new Store(config.dataDir || join(homedir(),'.dsh','ppt-ultra'),config)
  await store.initialize()
  const actions = {
    open: ({sessionId,name,base64}) => store.open({sessionId,name,base64}),
    list: ({sessionId}) => [...store.records.values()].filter(r=>r.sessionId===sessionId).map(r=>({id:r.id,name:r.name,updatedAt:r.updatedAt})),
    state: ({id,sessionId}) => store.view(store.get(id,sessionId)),
    propose: body => store.propose(body), apply: body => store.apply(body), cancel: body => store.cancel(body), undo: body => store.undo(body), export: body => store.export(body),
    runtime: () => store.rt.available,
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
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/ppt-ultra.asset',methods:['GET'],async fetch(request){
    try { return new Response(await store.asset(Object.fromEntries(new URL(request.url).searchParams)),{headers:{'content-type':'image/png','cache-control':'private, no-store','x-content-type-options':'nosniff'}}) }
    catch { return new Response('Not found',{status:404}) }
  }}),'ppt-ultra: images')
  const tool = (name, description, properties, required, execute) => ctx.effect(()=>ctx.tools.register({name,description,timeoutMs:240000,
    parameters:{type:'object',properties,required,additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute,
  }),'ppt-ultra: '+name)
  const session = exec => { if(!exec.agent?.id) throw new Error('此工具需要会话');return exec.agent.id }
  tool('ppt_ultra_open','打开会话中的本地 PPTX 附件副本。返回稳定的页面和对象 ID。用户通过会话顶栏“打开 PPT Ultra”进入工作台；不得改写原文件。', {path:{type:'string'}},['path'],async({path},exec)=>{
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
