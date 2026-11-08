"""Surgical OOXML edits. Unrelated ZIP entries retain their original bytes."""
import sys, json, hashlib, zipfile, posixpath, copy, difflib, base64, io
from pathlib import Path
from lxml import etree as E
from pptx import Presentation
from PIL import Image

NS = {'p':'http://schemas.openxmlformats.org/presentationml/2006/main', 'a':'http://schemas.openxmlformats.org/drawingml/2006/main', 'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
REL='http://schemas.openxmlformats.org/package/2006/relationships'
CT='http://schemas.openxmlformats.org/package/2006/content-types'
EMU=914400

def require(ok, message):
    if not ok: raise ValueError(message)

def xml(data):
    require(b'<!DOCTYPE' not in data.upper(), '不支持 DTD')
    return E.fromstring(data, E.XMLParser(resolve_entities=False, no_network=True))

def dump(root): return E.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
def hash_bytes(data): return hashlib.sha256(data).hexdigest()
def canonical(node): return E.tostring(node, method='c14n')

def read_package(path):
    with zipfile.ZipFile(path) as z:
        info=z.infolist()
        require(len(info)<20000 and sum(i.file_size for i in info)<300*1024*1024, 'PPTX 解压体积超过限制')
        require(len({i.filename for i in info})==len(info),'PPTX 包含重复条目')
        require(all(not n.filename.startswith('/') and '..' not in n.filename.split('/') for n in info),'非法 PPTX 部件路径')
        parts={i.filename:z.read(i) for i in info}
    require('ppt/presentation.xml' in parts, '请选择有效的 PPTX 文件')
    return parts,info

def slide_entries(parts):
    root=xml(parts['ppt/presentation.xml']); rels=xml(parts['ppt/_rels/presentation.xml.rels'])
    mapping={r.get('Id'):posixpath.normpath(posixpath.join('ppt',r.get('Target'))).lstrip('/') for r in rels if r.get('TargetMode')!='External'}
    size=root.find('p:sldSz',NS)
    entries=[(x.get('id'),mapping[x.get('{'+NS['r']+'}id')]) for x in root.findall('p:sldIdLst/p:sldId',NS)]
    return entries, {'width':int(size.get('cx')), 'height':int(size.get('cy'))}

def shapes(root):
    tree=root.find('p:cSld/p:spTree',NS)
    return [n for n in tree if n.tag in [f'{{{NS["p"]}}}{s}' for s in ['sp','pic','graphicFrame','grpSp','cxnSp']]]

def shape_id(node):
    c=node.find('.//p:cNvPr',NS)
    return c.get('id') if c is not None else None

def text_of(node):
    body=node.find('p:txBody',NS)
    if body is None:return None
    return '\n'.join(''.join((n.text or '') if n.tag==f'{{{NS["a"]}}}t' else '\v' for n in p.iter() if n.tag in [f'{{{NS["a"]}}}t',f'{{{NS["a"]}}}br']) for p in body.findall('a:p',NS))

def xfrm(node): return node.find('p:spPr/a:xfrm',NS)
def geometry(node):
    x=xfrm(node)
    if x is None:return None
    off=x.find('a:off',NS); ext=x.find('a:ext',NS)
    if off is None or ext is None:return None
    return {'x':int(off.get('x')), 'y':int(off.get('y')), 'width':int(ext.get('cx')), 'height':int(ext.get('cy')), 'rotation':int(x.get('rot','0'))}

def describe(node,sid):
    c=node.find('.//p:cNvPr',NS); text=text_of(node); geo=geometry(node)
    kind=E.QName(node).localname
    supported=kind in ['sp','pic'] and geo is not None and geo['rotation']==0
    return {'id':sid+':'+shape_id(node), 'name':c.get('name','对象'), 'kind':kind, 'text':text,'geometry':geo, 'fingerprint':hash_bytes(canonical(node)), 'editable':supported, 'textEditable':supported and text is not None and node.find('.//a:fld',NS) is None and node.find('.//a:br',NS) is None}

def inspect(path):
    parts,_=read_package(path); entries,size=slide_entries(parts)
    # Independent library checks readability without rewriting any source bytes.
    prs=Presentation(path)
    require(len(prs.slides)==len(entries),'页面数不一致')
    return {'sha256':hash_bytes(Path(path).read_bytes()), 'size':size,'slides':[{'id':sid,'page':i+1,'objects':[describe(n,sid) for n in shapes(xml(parts[part]))]} for i,(sid,part) in enumerate(entries)]}

def set_text(node, text):
    require(isinstance(text,str) and len(text)<=20000,'文字必须为不超过 20000 字符的字符串')
    require('\v' not in text and '\r' not in text,'请使用换行符分段')
    body=node.find('p:txBody',NS); paragraphs=body.findall('a:p',NS); lines=text.split('\n')
    template=copy.deepcopy(paragraphs[-1])
    while len(paragraphs)<len(lines):
        p=copy.deepcopy(template);body.append(p);paragraphs.append(p)
    for p in paragraphs[len(lines):]: body.remove(p)
    for p,line in zip(paragraphs,lines):
        runs=p.findall('a:r',NS); texts=[r.find('a:t',NS) for r in runs]
        if not texts:
            r=E.SubElement(p,'{'+NS['a']+'}r'); t=E.SubElement(r,'{'+NS['a']+'}t');t.text=line;continue
        old=''.join(t.text or '' for t in texts); owners=[]
        for i,t in enumerate(texts):owners.extend([i]*len(t.text or ''))
        result=['']*len(texts)
        for tag,a,b,c,d in difflib.SequenceMatcher(None,old,line,autojunk=False).get_opcodes():
            if tag=='equal':
                for k,ch in enumerate(line[c:d]):result[owners[a+k]]+=ch
            elif tag in ('replace','insert'):
                owner=owners[min(a,len(owners)-1)] if owners else 0
                result[owner]+=line[c:d]
        for t,value in zip(texts,result):t.text=value

def set_geometry(node, **values):
    x=xfrm(node);off=x.find('a:off',NS);ext=x.find('a:ext',NS)
    for k,v in values.items():
        require(isinstance(v,(int,float)) and not isinstance(v,bool) and abs(v)<100*EMU,'位置或尺寸无效')
        if k in ('width','height'):require(v>0,'尺寸必须大于零')
        (off if k in ('x','y') else ext).set({'width':'cx','height':'cy'}.get(k,k),str(round(v)))

def edit(source, output, operations, expected_sha):
    before=inspect(source);require(before['sha256']==expected_sha,'CONFLICT: 文稿已变化，请重新读取')
    require(isinstance(operations,list) and 0<len(operations)<=100,'操作清单应有 1–100 条操作')
    parts,info=read_package(source); originals=dict(parts); entries,size=slide_entries(parts)
    roots={sid:xml(parts[p]) for sid,p in entries}; paths=dict(entries)
    objects={sid+':'+shape_id(n):(sid,n) for sid,r in roots.items() for n in shapes(r)}
    lookup={o['id']:o for s in before['slides'] for o in s['objects']}; affected=set(); touched=set(); extra=set()
    def target(oid):
        require(oid in objects,'目标不存在：'+str(oid));require(lookup[oid]['editable'],'首版不支持该对象（组合、继承布局、旋转或复杂对象）')
        touched.add(oid);sid,n=objects[oid];affected.add(sid);return n
    # Validate every precondition against the round baseline, not intermediate mutations.
    for op in operations:
        require(isinstance(op,dict),'无效操作')
        ids=op.get('targets');require(isinstance(ids,list) and ids and len(ids)==len(set(ids)),'目标必须非空且不能重复')
        require(all(i in lookup for i in ids),'目标不存在')
        require(len({objects[i][0] for i in ids})==1,'一次操作只能包含同一页的对象')
        expected=op.get('expected',{})
        require(all(expected.get(i)==lookup[i]['fingerprint'] for i in ids),'CONFLICT: 目标当前值已变化')
    for op in operations:
        ids=op['targets'];nodes=[target(i) for i in ids];kind=op.get('type')
        if kind=='text':
            require(len(ids)==1 and lookup[ids[0]]['textEditable'],'请选择一个可编辑文本对象')
            set_text(nodes[0],op.get('text'))
        elif kind=='resize':
            require('width' in op and 'height' in op,'请指定宽度和高度')
            for n in nodes:set_geometry(n,width=op['width'],height=op['height'])
        elif kind=='align':
            require(len(ids)>=2 and op.get('reference') in ids,'请指定选中对象中的对齐基准')
            ref=geometry(objects[op['reference']][1]); mode=op.get('mode');require(mode in ['left','right','top','bottom','center','middle'],'无效对齐方式')
            for n in nodes:
                g=geometry(n)
                key='x' if mode in ['left','right','center'] else 'y'
                value={'left':ref['x'],'right':ref['x']+ref['width']-g['width'],'center':ref['x']+(ref['width']-g['width'])/2,'top':ref['y'],'bottom':ref['y']+ref['height']-g['height'],'middle':ref['y']+(ref['height']-g['height'])/2}[mode]
                set_geometry(n,**{key:value})
        elif kind=='distribute':
            require(len(nodes)>=3 and op.get('axis') in ['horizontal','vertical'],'等距需要至少三个对象和有效方向')
            axis='x' if op['axis']=='horizontal' else 'y';dim='width' if axis=='x' else 'height'
            ordered=sorted(nodes,key=lambda n:geometry(n)[axis]);first,last=geometry(ordered[0]),geometry(ordered[-1])
            gap=(last[axis]+last[dim]-first[axis]-sum(geometry(n)[dim] for n in ordered))/(len(nodes)-1)
            require(gap>=0,'可用空间不足，等距排列将发生重叠');cursor=first[axis]
            for n in ordered:set_geometry(n,**{axis:cursor});cursor+=geometry(n)[dim]+gap
        elif kind=='image':
            require(len(nodes)==1 and lookup[ids[0]]['kind']=='pic','请选择一个图片对象')
            raw=base64.b64decode(op.get('imageBase64',''),validate=True);require(0<len(raw)<=20*1024*1024,'图片大小须在 20 MiB 内')
            with Image.open(io.BytesIO(raw)) as im:
                require(im.format in ['PNG','JPEG'],'首版换图支持 PNG/JPEG');fmt=im.format;im.verify()
            ext='png' if fmt=='PNG' else 'jpg';sid=objects[ids[0]][0];part=paths[sid]
            media='ppt/media/ultra-'+hash_bytes(raw)+'.'+ext;parts[media]=raw;extra.add(media)
            relpath=posixpath.join(posixpath.dirname(part),'_rels',posixpath.basename(part)+'.rels')
            relroot=xml(parts[relpath]) if relpath in parts else E.Element('{'+REL+'}Relationships',nsmap={None:REL})
            rid='rIdUltra'+hash_bytes(raw)[:16];existing={r.get('Id') for r in relroot}
            while rid in existing:rid+='x'
            E.SubElement(relroot,'{'+REL+'}Relationship',Id=rid,Type=NS['r']+'/image',Target='../media/'+posixpath.basename(media))
            blip=nodes[0].find('p:blipFill/a:blip',NS);require(blip is not None,'图片没有可替换的嵌入素材')
            blip.set('{'+NS['r']+'}embed',rid);blip.attrib.pop('{'+NS['r']+'}link',None)
            parts[relpath]=dump(relroot);extra.add(relpath)
            ct=xml(parts['[Content_Types].xml'])
            if not any(n.get('Extension')==ext for n in ct):
                E.SubElement(ct,'{'+CT+'}Default',Extension=ext,ContentType='image/'+('jpeg' if ext=='jpg' else ext));parts['[Content_Types].xml']=dump(ct);extra.add('[Content_Types].xml')
        else:raise ValueError('不支持的操作类型：'+str(kind))
    for sid in affected:parts[paths[sid]]=dump(roots[sid])
    allowed={paths[s] for s in affected}|extra
    require(all(parts[n]==raw for n,raw in originals.items() if n not in allowed),'受保护部件发生变化')
    # Compare the affected slide with each selected object removed, including animations.
    for sid in affected:
        a=xml(originals[paths[sid]]);b=xml(parts[paths[sid]])
        for root in [a,b]:
            for n in shapes(root):
                if sid+':'+shape_id(n) in touched:n.getparent().remove(n)
        require(canonical(a)==canonical(b),'非目标对象或幻灯片结构发生变化')
    with zipfile.ZipFile(output,'w') as z:
        for i in info:z.writestr(i,parts[i.filename])
        for n in parts.keys()-originals.keys():z.writestr(n,parts[n],compress_type=zipfile.ZIP_DEFLATED)
    after=inspect(output);expected_objects={sid+':'+shape_id(n):describe(n,sid) for sid,r in roots.items() for n in shapes(r)}
    require(len(after['slides'])==len(before['slides']),'保存后页数变化')
    for s in after['slides']:
        for o in s['objects']:require(o==expected_objects[o['id']],'保存后对象属性不一致')
    checks=[{'level':'pass','message':'已重开 PPTX，页数和目标属性一致；非目标对象与受保护部件保持不变。'}]
    for oid in touched:
        sid,node=objects[oid];g=geometry(node)
        if g['x']<0 or g['y']<0 or g['x']+g['width']>size['width'] or g['y']+g['height']>size['height']:
            checks.append({'level':'warning','pageId':sid,'objectId':oid,'message':'对象边界超出页面，请检查裁切。'})
    return {'document':after,'affected':list(affected),'checks':checks,'changedParts':sorted(n for n,v in parts.items() if originals.get(n)!=v)}

def validate_render(path, images):
    document=inspect(path)
    for image in images:
        page=image['page'];require(isinstance(page,int) and 1<=page<=len(document['slides']),'渲染页码无效')
        objects=document['slides'][page-1]['objects']
        has_content=any((o['text'] and o['text'].strip()) or o['kind']=='pic' for o in objects)
        with Image.open(image['path']) as img:
            require(img.width>0 and img.height>0,'渲染图片尺寸无效')
            rgba=img.convert('RGBA');background=Image.new('RGBA',rgba.size,'white');background.alpha_composite(rgba)
            uniform=all(lo==hi for lo,hi in background.convert('RGB').getextrema())
            require(not (has_content and uniform),'渲染结果为空白，视觉检查未完成')
    return {'valid':True}

def main():
    request=json.load(sys.stdin);command=request['command']
    if command=='inspect':result=inspect(request['path'])
    elif command=='validate_render':result=validate_render(request['path'],request['images'])
    elif command=='edit':result=edit(request['source'],request['output'],request['operations'],request['expectedSha'])
    else:raise ValueError('未知命令')
    print(json.dumps({'ok':True,'value':result},ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as error:print(json.dumps({'ok':False,'error':str(error)},ensure_ascii=False));sys.exit(1)
