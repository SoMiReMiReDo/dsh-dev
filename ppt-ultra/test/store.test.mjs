import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Store } from '../lib/store.mjs'
const hash=b=>createHash('sha256').update(b).digest('hex')
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),'ppt-ultra-test-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  let failRender=false
  const engine=async r=>{
    if(r.command==='inspect'){const b=await readFile(r.path);return {sha256:hash(b),slides:[{id:'256',page:1,objects:[]}],size:{width:100,height:100}}}
    const b=await readFile(r.source);if(hash(b)!==r.expectedSha)throw new Error('CONFLICT');await writeFile(r.output,Buffer.concat([b,Buffer.from(JSON.stringify(r.operations))]));return {document:await engine({command:'inspect',path:r.output}),affected:['256'],checks:[],changedParts:['ppt/slides/slide1.xml']}
  }
  const render=async()=>{if(failRender)throw new Error('renderer unavailable');return {images:[{page:1,path:join(dir,'image.png')}],missingFonts:['Test Font']}}
  const store=new Store(dir,{}, {engine,render});await store.initialize()
  const s=await store.open({sessionId:'s',name:'deck.pptx',base64:Buffer.from('source').toString('base64')})
  return {store,s,setFailure:v=>{failRender=v}}
}
test('two rounds, undo, export and persisted recovery use exact verified snapshots',async t=>{
  const {store,s}=await setup(t),base={id:s.id,sessionId:'s'}
  const original=store.get(s.id,'s').current.document.sha256
  let p=await store.propose({...base,revision:0,operations:[{type:'text',text:'one'}]})
  await assert.rejects(store.apply({...base,revision:0,proposalId:p.proposal.id}),/预览/)
  let a=await store.apply({...base,revision:0,proposalId:p.proposal.id,visualConfirmed:true});const first=a.current.document.sha256
  assert.equal(a.before.document.sha256,original)
  p=await store.propose({...base,revision:1,operations:[{type:'text',text:'two'}]})
  a=await store.apply({...base,revision:1,proposalId:p.proposal.id,visualConfirmed:true});assert.equal(a.before.document.sha256,first)
  a=await store.undo({...base,revision:2});assert.equal(a.current.document.sha256,first);assert.equal(a.history.length,1)
  const exported=await store.export(base);assert.equal(hash(Buffer.from(exported.base64,'base64')),first)
  const restarted=new Store(store.directory);await restarted.initialize();assert.equal(restarted.view(restarted.get(s.id,'s')).current.document.sha256,first)
})
test('failed render cannot apply or export and does not replace last draft',async t=>{
  const {store,s,setFailure}=await setup(t),base={id:s.id,sessionId:'s',revision:0};setFailure(true)
  const p=await store.propose({...base,operations:[{type:'text'}]});assert.equal(p.proposal.ready,false)
  await assert.rejects(store.apply({...base,proposalId:p.proposal.id,visualConfirmed:true}),/预览/)
  assert.equal(store.get(s.id,'s').current.document.sha256,s.current.document.sha256)
  await assert.rejects(store.export(base),/检查/)
})
test('stale revision, cross-session access and externally changed file are rejected',async t=>{
  const {store,s}=await setup(t),base={id:s.id,sessionId:'s'}
  assert.throws(()=>store.get(s.id,'other'),/不属于/)
  await assert.rejects(store.propose({...base,revision:8,operations:[{}]}),/CONFLICT/)
  await writeFile(store.get(s.id,'s').current.file,'external change')
  await assert.rejects(store.propose({...base,revision:0,operations:[{}]}),/CONFLICT/)
})
test('stale proposal cannot apply and concurrent mutations are refused',async t=>{
  const {store,s}=await setup(t),base={id:s.id,sessionId:'s',revision:0}
  const p=await store.propose({...base,operations:[{}]});await store.propose({...base,operations:[{type:'new'}]})
  await assert.rejects(store.apply({...base,proposalId:p.proposal.id,visualConfirmed:true}),/CONFLICT/)
  store.locks.add(s.id);await assert.rejects(store.cancel(base),/正在处理/)
})
test('render failure during final apply preserves the current draft and proposal',async t=>{
  const {store,s,setFailure}=await setup(t),base={id:s.id,sessionId:'s',revision:0}
  const p=await store.propose({...base,operations:[{type:'text'}]});setFailure(true)
  await assert.rejects(store.apply({...base,proposalId:p.proposal.id,visualConfirmed:true}),/视觉检查未完成/)
  const current=store.get(s.id,'s');assert.equal(current.revision,0);assert.equal(current.current.document.sha256,s.current.document.sha256);assert.equal(current.proposal.id,p.proposal.id)
})
test('clarification validates candidate IDs and keeps the pending proposal',async t=>{
  const {store,s}=await setup(t),base={id:s.id,sessionId:'s',revision:0}
  const p=await store.propose({...base,operations:[{}]})
  const c=await store.clarify({...base,question:'请选择目标页',candidates:[]});assert.equal(c.proposal.id,p.proposal.id);assert.equal(c.clarification.question,'请选择目标页')
  await assert.rejects(store.clarify({...base,question:'请选择对象',candidates:['missing']}),/不存在/)
})
