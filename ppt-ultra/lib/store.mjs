import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { runtime, engine, render } from './runtime.mjs'
const digest = data => createHash('sha256').update(data).digest('hex')
const check = (ok, text) => { if (!ok) throw new Error(text) }
export class Store {
  constructor(directory, config = {}, adapters = {}) { this.directory = directory; this.rt = runtime(config); this.engine = adapters.engine || (r => engine(this.rt,r)); this.render = adapters.render || ((...a) => render(this.rt,...a)); this.validateRender = adapters.engine ? async()=>{} : r=>this.engine(r); this.records = new Map(); this.locks = new Set() }
  async initialize() {
    await mkdir(this.directory,{recursive:true,mode:0o700})
    for (const id of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue
      try { const r = JSON.parse(await readFile(join(this.directory,id,'state.json'),'utf8')); if(r.id===id) this.records.set(id,r) } catch {}
    }
  }
  async save(r) { const path = join(this.directory,r.id,'state.json'); await writeFile(path+'.tmp',JSON.stringify(r),{mode:0o600});await rename(path+'.tmp',path);this.records.set(r.id,r) }
  get(id, sessionId) { const r=this.records.get(id);check(r && r.sessionId===sessionId,'文稿不存在或不属于当前会话');return r }
  async locked(id, action) { check(!this.locks.has(id),'文稿正在处理，请稍后重试');this.locks.add(id);try{return await action()}finally{this.locks.delete(id)} }
  async verify(r) {
    check(digest(await readFile(r.current.file))===r.current.document.sha256,'CONFLICT: 草稿被外部修改，请重新导入')
    if (r.sourcePath) check(digest(await readFile(r.sourcePath))===r.sourceSha,'CONFLICT: 原文件被外部修改，请重新导入')
  }
  async makeRender(file, dir, pages) {
    try {
      const m=await this.render(file,dir,pages)
      check(m.images?.length && (!pages || JSON.stringify(m.images.map(i=>i.page).sort((a,b)=>a-b))===JSON.stringify([...pages].sort((a,b)=>a-b))),'渲染结果缺页或页码不符')
      await this.validateRender({command:'validate_render',path:file,images:m.images})
      return { images:m.images.map(i=>({page:i.page,path:i.path})), missingFonts:m.missingFonts || [], ok:true }
    } catch(error) { return { images:[],missingFonts:[],ok:false,error:error.message } }
  }
  async open({sessionId,name,base64,sourcePath}) {
    check(typeof sessionId==='string' && sessionId.length>0,'缺少会话标识')
    check(typeof name==='string' && /\.pptx$/i.test(name),'首版仅支持 .pptx 文件')
    const bytes=Buffer.from(base64,'base64');check(bytes.length>0 && bytes.length<=50*1024*1024,'文件须小于 50 MiB')
    const id=randomUUID(), dir=join(this.directory,id);await mkdir(dir,{recursive:true,mode:0o700})
    const original=join(dir,'original.pptx');await writeFile(original,bytes,{mode:0o600})
    const document=await this.engine({command:'inspect',path:original});const rendered=await this.makeRender(original,join(dir,'original-render'),document.slides.map(s=>s.page))
    const r={id,sessionId,name:basename(name),sourcePath,sourceSha:digest(bytes),revision:0,proposal:null,history:[],current:{file:original,document,rendered},comparison:null,updatedAt:Date.now()}
    await this.save(r);return this.view(r)
  }
  view(r) {
    const project = snap => snap && ({ document:snap.document,rendered:{...snap.rendered,images:snap.rendered.images.map(i=>({page:i.page,url:this.assetUrl(r,i.path)}))} })
    return {id:r.id,name:r.name,sessionId:r.sessionId,revision:r.revision,updatedAt:r.updatedAt,clarification:r.clarification || null,busy:this.locks.has(r.id),current:project(r.current),before:project(r.proposal?.before || r.comparison || r.current),after:project(r.proposal?.candidate || r.current),proposal:r.proposal && {id:r.proposal.id,operations:r.proposal.operations,checks:r.proposal.checks,affected:r.proposal.affected,ready:r.proposal.ready},history:r.history.map((h,i)=>({round:i+1,operations:h.operations,affected:h.affected,at:h.at})),exportable:r.history.length>0 && !r.proposal && r.current.rendered.ok}
  }
  assetUrl(r,path) { return '/api/ppt-ultra.asset?'+new URLSearchParams({id:r.id,sessionId:r.sessionId,asset:Buffer.from(path).toString('base64url')}) }
  async asset({id,sessionId,asset}) {
    const r=this.get(id,sessionId),path=Buffer.from(asset,'base64url').toString();const snapshots=[r.current,r.comparison,r.proposal?.before,r.proposal?.candidate,...r.history.flatMap(h=>[h.before,h.after])].filter(Boolean)
    check(snapshots.some(s=>s.rendered.images.some(i=>i.path===path)),'图片不存在');return readFile(path)
  }
  async clarify({id,sessionId,revision,question,candidates}) {
    return this.locked(id,async()=>{
      const old=this.get(id,sessionId);check(old.revision===revision,'CONFLICT: 文稿版本已变化')
      check(typeof question==='string' && question.trim() && question.length<2000,'请提供简短的确认问题')
      const ids=new Set(old.current.document.slides.flatMap(s=>s.objects.map(o=>o.id)))
      check(Array.isArray(candidates) && candidates.length<=50 && candidates.every(id=>ids.has(id)),'候选对象不存在')
      const r={...old,clarification:{question,candidates},updatedAt:Date.now()};await this.save(r);return this.view(r)
    })
  }
  async propose({id,sessionId,revision,operations}) {
    return this.locked(id,async()=>{
      const old=this.get(id,sessionId);check(old.revision===revision,'CONFLICT: 文稿版本已变化，请刷新');await this.verify(old)
      check(Array.isArray(operations) && operations.length>0 && operations.length<=100,'请添加 1–100 条操作')
      const proposalId=randomUUID(),dir=join(this.directory,id,proposalId);await mkdir(dir,{mode:0o700})
      const file=join(dir,'candidate.pptx')
      const edited=await this.engine({command:'edit',source:old.current.file,output:file,operations,expectedSha:old.current.document.sha256})
      const pages=edited.document.slides.filter(s=>edited.affected.includes(s.id)).map(s=>s.page)
      const fresh=await this.makeRender(file,join(dir,'render'),pages)
      const prior=old.current.rendered.images.filter(i=>!pages.includes(i.page))
      const rendered={...fresh,images:[...prior,...fresh.images].sort((a,b)=>a.page-b.page)}
      const checks=[...edited.checks]
      if(!fresh.ok) checks.push({level:'error',message:'视觉检查未完成：'+fresh.error})
      const missingFonts=[...new Set([...old.current.rendered.missingFonts,...fresh.missingFonts])]
      if(missingFonts.length) checks.push({level:'warning',message:'缺失字体：'+missingFonts.join('、')+'。预览可能使用替代字体；文件保留原字体设置。'})
      checks.push({level:'review',message:'请对照预览检查文字溢出、遮挡和图片裁切。渲染成功不等于视觉检查通过。'})
      await this.verify(old)
      const r={...old,clarification:null,updatedAt:Date.now(),proposal:{id:proposalId,operations,checks,affected:edited.affected,before:old.current,candidate:{file,document:edited.document,rendered},ready:fresh.ok && old.current.rendered.ok}}
      await this.save(r);return this.view(r)
    })
  }
  async apply({id,sessionId,revision,proposalId,visualConfirmed}) {
    return this.locked(id,async()=>{
      const old=this.get(id,sessionId);check(old.revision===revision,'CONFLICT: 文稿版本已变化');await this.verify(old)
      const p=old.proposal;check(p && p.id===proposalId,'CONFLICT: 预览已变化，请重新检查');check(p.ready && visualConfirmed===true,'请完成预览检查并确认字体提醒后应用')
      const verified=await this.engine({command:'inspect',path:p.candidate.file});check(verified.sha256===p.candidate.document.sha256,'CONFLICT: 预览文件被修改')
      const rerender=await this.makeRender(p.candidate.file,join(this.directory,id,randomUUID()),verified.slides.filter(s=>p.affected.includes(s.id)).map(s=>s.page))
      check(rerender.ok,'视觉检查未完成，已保留上一份草稿')
      const imagePages=new Set(rerender.images.map(i=>i.page));const current={...p.candidate,rendered:{...rerender,images:[...p.candidate.rendered.images.filter(i=>!imagePages.has(i.page)),...rerender.images]}}
      await this.verify(old)
      check(digest(await readFile(p.candidate.file))===verified.sha256,'CONFLICT: 预览文件在渲染期间变化')
      const r={...old,current,comparison:p.before,proposal:null,revision:old.revision+1,updatedAt:Date.now(),history:[...old.history,{before:p.before,after:current,operations:p.operations,affected:p.affected,at:new Date().toISOString()}]}
      await this.save(r);return this.view(r)
    })
  }
  async cancel({id,sessionId,revision}) { return this.locked(id,async()=>{const old=this.get(id,sessionId);check(old.revision===revision,'CONFLICT: 版本已变化');const r={...old,proposal:null,updatedAt:Date.now()};await this.save(r);return this.view(r)}) }
  async undo({id,sessionId,revision}) {return this.locked(id,async()=>{
    const old=this.get(id,sessionId);check(old.revision===revision,'CONFLICT: 版本已变化');check(!old.proposal,'请先取消待应用修改');check(old.history.length,'没有可撤销的轮次');await this.verify(old)
    const h=old.history.at(-1), verified=await this.engine({command:'inspect',path:h.before.file});check(verified.sha256===h.before.document.sha256,'历史草稿被修改')
    const r={...old,current:h.before,comparison:null,history:old.history.slice(0,-1),revision:old.revision+1,updatedAt:Date.now()};await this.save(r);return this.view(r)
  })}
  async export({id,sessionId}) {return this.locked(id,async()=>{
    const r=this.get(id,sessionId);check(this.view(r).exportable,'请先应用修改并通过检查');await this.verify(r)
    const bytes=await readFile(r.current.file);check(digest(bytes)===r.current.document.sha256,'CONFLICT: 导出文件已变化')
    return {name:r.name.replace(/\.pptx$/i,'-已编辑.pptx'),base64:bytes.toString('base64'),changes:r.history.map((h,i)=>({round:i+1,at:h.at,operations:h.operations.map(({imageBase64,...op})=>op),affected:h.affected}))}
  })}
}
