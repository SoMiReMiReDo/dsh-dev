import unittest, tempfile, sys, zipfile, copy, base64, io
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from pptx_engine import inspect,edit,xml,canonical,NS
from pptx import Presentation
from pptx.util import Inches,Pt
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from PIL import Image

class EditingTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.dir=Path(self.tmp.name);self.file=self.dir/'source.pptx'
        prs=Presentation();s=prs.slides.add_slide(prs.slide_layouts[6]);text=s.shapes.add_textbox(Inches(.5),Inches(.3),Inches(8),Inches(.8));p=text.text_frame.paragraphs[0]
        a=p.add_run();a.text='Hello ';a.font.bold=True;a.font.name='Missing-Test-Font'
        b=p.add_run();b.text='World';b.font.italic=True
        image=io.BytesIO();Image.new('RGB',(30,20),'red').save(image,format='PNG');image.seek(0)
        s.shapes.add_picture(image,Inches(1),Inches(2),Inches(1),Inches(1));image.seek(0)
        s.shapes.add_picture(image,Inches(3),Inches(3),Inches(1),Inches(1));image.seek(0)
        s.shapes.add_picture(image,Inches(6),Inches(4),Inches(1),Inches(1))
        chart=CategoryChartData();chart.categories=['A','B'];chart.add_series('Series',[1,2]);s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED,Inches(5),Inches(.1),Inches(3),Inches(1),chart)
        s.notes_slide.notes_text_frame.text='Keep speaker notes'
        prs.slides.add_slide(prs.slide_layouts[6]);prs.save(self.file);self.before=inspect(self.file)
    def tearDown(self):self.tmp.cleanup()
    def op(self,kind,indices,**kwargs):
        objects=self.before['slides'][0]['objects'];chosen=[objects[i] for i in indices]
        return dict(type=kind,targets=[o['id'] for o in chosen],expected={o['id']:o['fingerprint'] for o in chosen},**kwargs)
    def apply(self,ops):
        out=self.dir/'edited.pptx';result=edit(str(self.file),str(out),ops,self.before['sha256']);return out,result
    def test_text_and_alignment_preserve_unrelated_parts_and_mixed_styles(self):
        op=self.op('align',[1,2],mode='top',reference=self.before['slides'][0]['objects'][1]['id'])
        out,result=self.apply([self.op('text',[0],text='Hello Earth'),op]);after=inspect(out)
        self.assertEqual(after['slides'][0]['objects'][0]['text'],'Hello Earth')
        self.assertEqual(after['slides'][0]['objects'][1]['geometry']['y'],after['slides'][0]['objects'][2]['geometry']['y'])
        self.assertEqual(result['changedParts'],['ppt/slides/slide1.xml'])
        with zipfile.ZipFile(self.file) as a,zipfile.ZipFile(out) as b:
            for n in a.namelist():
                if n!='ppt/slides/slide1.xml':self.assertEqual(a.read(n),b.read(n),n)
        runs=Presentation(out).slides[0].shapes[0].text_frame.paragraphs[0].runs
        self.assertTrue(runs[0].font.bold);self.assertTrue(runs[1].font.italic);self.assertEqual(runs[0].font.name,'Missing-Test-Font')
    def test_shared_image_replacement_does_not_change_other_picture(self):
        image=io.BytesIO();Image.new('RGB',(40,40),'blue').save(image,format='PNG')
        out,result=self.apply([self.op('image',[1],imageBase64=base64.b64encode(image.getvalue()).decode())])
        old=Presentation(self.file);new=Presentation(out)
        self.assertNotEqual(old.slides[0].shapes[1].image.blob,new.slides[0].shapes[1].image.blob)
        self.assertEqual(old.slides[0].shapes[2].image.blob,new.slides[0].shapes[2].image.blob)
    def test_distribute_and_resize(self):
        out,result=self.apply([self.op('distribute',[1,2,3],axis='horizontal'),self.op('resize',[0],width=5000000,height=500000)])
        shapes=inspect(out)['slides'][0]['objects'];a,b,c=[x['geometry'] for x in shapes[1:4]]
        self.assertEqual(b['x']-a['x']-a['width'],c['x']-b['x']-b['width']);self.assertEqual(shapes[0]['geometry']['width'],5000000)
    def test_stale_document_rejected(self):
        with self.assertRaisesRegex(ValueError,'CONFLICT'):edit(str(self.file),str(self.dir/'out.pptx'),[self.op('text',[0],text='X')],'stale')
    def test_stale_object_and_unsupported_chart_rejected(self):
        op=self.op('text',[0],text='X');op['expected']={}
        with self.assertRaisesRegex(ValueError,'CONFLICT'):self.apply([op])
        with self.assertRaisesRegex(ValueError,'不支持'):self.apply([self.op('resize',[4],width=1,height=1)])
    def test_invalid_batch_never_creates_output(self):
        with self.assertRaises(ValueError):self.apply([self.op('text',[0],text='X'),self.op('resize',[1],width=-1,height=1)])
        self.assertFalse((self.dir/'edited.pptx').exists());self.assertEqual(inspect(self.file),self.before)
    def test_reference_decks(self):
        files=list((Path(__file__).parent/'fixtures').glob('*.pptx'))
        if not files:self.skipTest('未提供本地参考 PPTX')
        for file in files:
            before=inspect(file);obj=next((o for s in before['slides'] for o in s['objects'] if o['textEditable'] and o['text']),None)
            self.assertIsNotNone(obj,file.name)
            out=self.dir/(file.stem+'-checked.pptx');op={'type':'text','targets':[obj['id']],'expected':{obj['id']:obj['fingerprint']},'text':obj['text']+' · 测试'}
            result=edit(str(file),str(out),[op],before['sha256']);self.assertEqual(len(result['changedParts']),1,file.name)
            self.assertEqual(len(result['document']['slides']),len(before['slides']))

if __name__=='__main__':unittest.main()
