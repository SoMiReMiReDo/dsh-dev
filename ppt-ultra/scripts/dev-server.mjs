/** Local verification harness for the exact production Client and Host routes. */
import http from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
const root=dirname(dirname(fileURLToPath(import.meta.url))),routes=new Map(),effects=[]
const ctx={connection:{fetch:{register:route=>{routes.set(route.path,route);return()=>routes.delete(route.path)}}},tools:{register:()=>()=>{}},effect:fn=>{effects.push(fn())},on:()=>()=>{},workspaceRegistry:{list:()=>[{id:'dev-workspace',title:'dsh-dev',path:root}]},sessions:{get:()=>undefined},agents:{get:()=>undefined}}
await apply(ctx,{dataDir:process.env.PPT_ULTRA_DATA || join(tmpdir(),'ppt-ultra-dev-data')})
// Reuse the React version from installed DSH; no CDN or downloaded runtime.
async function runtimeAssets(){
  const asar=await readFile(process.env.DSH_ASAR || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
  const header=JSON.parse(asar.subarray(16,16+asar.readUInt32LE(12)).toString()),base=8+asar.readUInt32LE(4)
  let entry=header;for(const part of ['dsh','node_modules','@deepseek-ai','dsh-web-frontend','dist','assets'])entry=entry.files[part]
  const assets=new Map()
  for(const [name,v] of Object.entries(entry.files)) if(name.endsWith('.js')&&!v.files&&!v.unpacked)assets.set('/'+name,asar.subarray(base+Number(v.offset),base+Number(v.offset)+v.size).toString())
  const index=[...assets].find(([name])=>/^\/index-.*\.js$/.test(name))
  if(!index || !index[1].includes('const Gs=globalThis.dshDesktopBoot')) throw new Error('Unsupported DSH frontend build; use the installed desktop for UI verification')
  assets.set('/runtime.js',index[1].slice(0,index[1].indexOf('const Gs=globalThis.dshDesktopBoot'))+';export {YZ as modules};')
  return assets
}
const assets=await runtimeAssets()
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PPT Ultra · 本地验证</title><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><body><div id="root"></div><script type="module">import {modules} from '/runtime.js';const registry=modules();window.__ModuleLoader__={load({factory}){const plugin=factory(name=>registry[name]);const React=registry.react;registry['react-dom/client'].createRoot(document.getElementById('root')).render(React.createElement(plugin.Workbench,{sessionId:'dev-session',sessionTitle:'本地验证对话',sessionReady:false,sessionCwd:'/Users/seal/Desktop/myNote/dsh-dev',onExit:()=>location.reload(),onNewConversation:async()=>{throw new Error('开发服务器不支持新建对话')}}));}};await import('/client.js');</script></body></html>`
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1'),route=routes.get(url.pathname)
    if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`) {res.writeHead(403);res.end();return}
    if(url.pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(html);return}
    if(assets.has(url.pathname)||url.pathname==='/client.js'){res.setHeader('content-type','application/javascript');res.end(assets.get(url.pathname)||await readFile(join(root,'client.js')));return}
    if(!route || !route.methods.includes(req.method)){res.writeHead(404);res.end();return}
    const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>72*1024*1024)throw new Error('Request too large');chunks.push(b)}
    const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})})
    const response=await route.fetch(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()))
  }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:e.message}))}
})
server.listen(Number(process.env.PORT||4177),'127.0.0.1',()=>console.log('PPT Ultra dev: http://127.0.0.1:'+server.address().port))
