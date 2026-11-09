#!/usr/bin/env python3
"""interview-research skill 端到端自测（仅标准库，离线可跑）。

运行：
    python3 -m unittest discover -s test -v
或：
    python3 test/test_pipeline.py

覆盖：init_project → build_dataset（含序号稳定性/追加）→ validate_content
      → digest → render_report 全链路，以及模板占位符替换。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
SCRIPTS = os.path.join(SKILL, "scripts")
FIXTURES = os.path.join(HERE, "fixtures")


def run(script, *args, check=True):
    cmd = [sys.executable, os.path.join(SCRIPTS, script), *map(str, args)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise AssertionError(f"{script} 失败（{proc.returncode}）\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return proc


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="interview-research-test-")
        self.workdir = os.path.join(self.tmp, "project")
        self.xhs = os.path.join(self.tmp, "xhs-data")
        os.makedirs(self.workdir)
        shutil.copytree(os.path.join(FIXTURES, "xhs"), self.xhs)
        shutil.copy2(os.path.join(FIXTURES, "project.json"), os.path.join(self.workdir, "project.json"))
        shutil.copy2(os.path.join(FIXTURES, "content.json"), os.path.join(self.workdir, "content.json"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def build(self):
        return run("build_dataset.py", "--dir", self.workdir, "--xhs-data", self.xhs, "--no-images")

    def test_full_pipeline(self):
        # 1) 聚合
        proc = self.build()
        self.assertIn("notes", proc.stdout)
        notes = json.load(open(os.path.join(self.workdir, "data", "notes.json"), encoding="utf-8"))
        self.assertEqual(len(notes), 3)
        # 按发布时间倒序：ids[0] 最新
        self.assertEqual(notes[0]["id"], "000000000000000000000001")
        self.assertEqual(notes[2]["id"], "000000000000000000000003")
        # 派生字段
        self.assertTrue(notes[2]["offtopic"])
        self.assertFalse(notes[0]["offtopic"])
        self.assertIn("一面", notes[0]["tags2"])
        self.assertTrue(notes[0]["comments"][0]["reply"] is False)
        self.assertTrue(any(c["reply"] for c in notes[0]["comments"]))
        # meta / digest
        meta = json.load(open(os.path.join(self.workdir, "data", "meta.json"), encoding="utf-8"))
        self.assertEqual(meta["noteCount"], 3)
        self.assertEqual(meta["commentCount"], 4)  # 3 条一级 + 1 条楼中楼
        self.assertTrue(os.path.exists(os.path.join(self.workdir, "data", "digest.md")))
        parts = [p for p in os.listdir(os.path.join(self.workdir, "data")) if p.startswith("digest-")]
        self.assertGreaterEqual(len(parts), 1)

        # 2) 校验
        proc = run("validate_content.py", "--dir", self.workdir)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

        # 3) markdown 摘要
        run("digest.py", "--dir", self.workdir)
        md = open(os.path.join(self.workdir, "面试摘要.md"), encoding="utf-8").read()
        self.assertIn("示例半导体（大连）", md)
        self.assertIn("核心结论", md)
        self.assertIn("反问", md)

        # 4) HTML 渲染
        run("render_report.py", "--dir", self.workdir)
        html = open(os.path.join(self.workdir, "report.html"), encoding="utf-8").read()
        self.assertNotIn("__PAGE_TITLE__", html)
        self.assertNotIn("__THEME_KEY__", html)
        self.assertNotIn("__STORAGE_KEY__", html)
        self.assertIn("const DATA = ", html)
        self.assertIn("示例半导体（大连）面试准备手册 · 面经汇总", html)
        self.assertIn("example-semi-theme", html)
        self.assertIn("示例半导体", html)
        self.assertNotIn("https://cdn", html)  # 无外部 CDN
        self.assertIn("@media print", html)
        self.assertIn("data-theme-toggle", html)

    def test_numbering_stable_when_appending(self):
        self.build()
        before = json.load(open(os.path.join(self.workdir, "data", "notes.json"), encoding="utf-8"))
        new_id = "000000000000000000000004"
        # 追加一条搜索结果 + 详情
        search_path = os.path.join(self.xhs, "searches", "示例半导体-新增-20261110-120000-003.json")
        json.dump(
            {
                "query": "示例半导体 追加",
                "sort": "latest",
                "notes": [{"id": new_id, "title": "追加的笔记"}],
                "collectedAt": "2026-11-10T12:00:00+08:00",
            },
            open(search_path, "w", encoding="utf-8"),
            ensure_ascii=False,
        )
        detail = {
            "type": "note",
            "id": new_id,
            "url": "https://www.xiaohongshu.com/explore/" + new_id,
            "title": "追加的笔记",
            "desc": "示例半导体新帖，用于测试序号追加。",
            "author": {"id": "u5", "nickname": "新人"},
            "images": [],
            "stats": {"liked": 1, "collected": 0, "comments": 0},
            "publishedAt": "2026-11-10T08:00:00+08:00",
            "ipLocation": "辽宁",
            "noteType": "normal",
        }
        json.dump(detail, open(os.path.join(self.xhs, "notes", new_id + ".json"), "w", encoding="utf-8"), ensure_ascii=False)
        self.build()
        after = json.load(open(os.path.join(self.workdir, "data", "notes.json"), encoding="utf-8"))
        self.assertEqual([n["id"] for n in after[:3]], [n["id"] for n in before])
        self.assertEqual(after[3]["id"], new_id)
        # content.json 里的旧引用仍然合法
        proc = run("validate_content.py", "--dir", self.workdir)
        self.assertEqual(proc.returncode, 0, proc.stdout)

    def test_validate_detects_bad_source_and_duplicates(self):
        self.build()
        content_path = os.path.join(self.workdir, "content.json")
        content = json.load(open(content_path, encoding="utf-8"))
        content["tips"][0]["source"] = [999]
        content["questions"][0]["items"].append({"q": "为什么选择我们公司？", "source": [0]})
        json.dump(content, open(content_path, "w", encoding="utf-8"), ensure_ascii=False)
        proc = run("validate_content.py", "--dir", self.workdir, check=False)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("越界序号", proc.stdout)
        self.assertIn("问题重复", proc.stdout)

    def test_init_project(self):
        target = os.path.join(self.tmp, "new-project")
        run("init_project.py", "--dir", target, "--company", "测试公司", "--city", "苏州", "--role", "研发")
        self.assertTrue(os.path.exists(os.path.join(target, "project.json")))
        self.assertTrue(os.path.exists(os.path.join(target, "content.json")))
        self.assertTrue(os.path.exists(os.path.join(target, "README.md")))
        project = json.load(open(os.path.join(target, "project.json"), encoding="utf-8"))
        self.assertEqual(project["company"], "测试公司")
        self.assertEqual(project["city"], "苏州")
        self.assertIn("测试公司", project["pageTitle"])
        self.assertEqual(project["storageKey"], "测试公司-苏州")


if __name__ == "__main__":
    unittest.main(verbosity=2)
