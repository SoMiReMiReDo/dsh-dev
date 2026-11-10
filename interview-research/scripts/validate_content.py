#!/usr/bin/env python3
"""校验 content.json：结构、条数、来源序号、重复问题、引用完整性。

用法：
    python3 scripts/validate_content.py --dir <工作目录> [--strict] [--json]

退出码：0 = 通过（可能有 warning）；1 = 有 error。--strict 时 warning 也算失败。
设计目标：抽取阶段的自动质量门槛。历史项目里这些数字经过实际校准，
偏离默认范围会给 warning 而不是 error，允许按主题裁剪。
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402

# (key, 最小条数, 最大条数, 是否强制)；数值来自历史项目实测（见 references/content-extraction.md）
RANGES = [
    ("process", 8, 20, True),
    ("positions", 5, 20, False),
    ("timeline", 5, 25, False),
    ("salary", 5, 30, False),
    ("tips", 10, 60, False),
    ("pitfalls", 5, 45, False),
]
QUESTION_TOTAL = (60, 160)
CHECKLIST_TOTAL = (6, 12)
APPENDIX_TOTAL = (3, 8)
TAKEAWAY_TOTAL = (3, 6)
OVERVIEW_TOTAL = (400, 900)
SALARY_NOTE_TOTAL = (40, 150)
SOURCE_MAX = 6

REQUIRED_TOP = ["overview", "process", "questions", "positions", "timeline", "salary", "tips", "pitfalls"]


def norm_q(text):
    return re.sub(r"[\s，。！？、,.!?；;：:\"'“”‘’（）()【】\[\]-]+", "", (text or "").lower())


class Report:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def err(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)


def check_source(path, rows, note_count, rep, limit_ok=True):
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            rep.err(f"{path}[{i}] 不是对象")
            continue
        src = row.get("source")
        if src is None:
            continue
        if not isinstance(src, list) or not all(isinstance(x, int) for x in src):
            rep.err(f"{path}[{i}].source 必须是整数数组（notes.json 的下标）")
            continue
        for x in src:
            if not (0 <= x < note_count):
                rep.err(f"{path}[{i}].source 含越界序号 {x}（共 {note_count} 篇笔记）")
        if limit_ok and len(src) > SOURCE_MAX:
            rep.warn(f"{path}[{i}].source 有 {len(src)} 个来源，建议 ≤{SOURCE_MAX}")


def validate(workdir):
    rep = Report()
    content = C.load_json(os.path.join(workdir, C.CONTENT_NAME))
    if content is None:
        rep.err(f"找不到 {C.CONTENT_NAME}")
        return rep, {}
    data_dir = os.path.join(workdir, C.DATA_DIRNAME)
    notes = C.load_json(os.path.join(data_dir, "notes.json"))
    if notes is None:
        rep.err(f"找不到 {C.DATA_DIRNAME}/notes.json；先运行 build_dataset.py")
        notes = []
    meta = C.load_json(os.path.join(data_dir, "meta.json")) or {}
    note_count = len(notes)

    for key in REQUIRED_TOP:
        if key not in content:
            rep.err(f"缺少顶层字段 {key}")
    if not isinstance(content.get("overview"), str) or not content.get("overview").strip():
        rep.err("overview 不能为空（400-600 字总览）")
    elif not (OVERVIEW_TOTAL[0] <= len(content["overview"]) <= OVERVIEW_TOTAL[1]):
        rep.warn(f"overview 长度 {len(content['overview'])} 字，建议 {OVERVIEW_TOTAL[0]}-{OVERVIEW_TOTAL[1]} 字")

    for key, lo, hi, must in RANGES:
        rows = content.get(key)
        if not isinstance(rows, list):
            if must:
                rep.err(f"{key} 必须是数组")
            continue
        if must and not rows:
            rep.err(f"{key} 不能为空")
        if rows and not (lo <= len(rows) <= hi):
            rep.warn(f"{key} 有 {len(rows)} 条，建议 {lo}-{hi}")
        check_source(key, rows, note_count, rep)

    qcats = content.get("questions")
    if not isinstance(qcats, list) or not qcats:
        rep.err("questions 必须是非空数组（每项 {category, items}）")
        qcats = []
    total_q, seen, dup = 0, {}, 0
    for ci, cat in enumerate(qcats):
        if not isinstance(cat, dict) or not cat.get("category"):
            rep.err(f"questions[{ci}] 缺少 category")
            continue
        items = cat.get("items")
        if not isinstance(items, list) or not items:
            rep.warn(f"问题类别「{cat.get('category')}」没有题目")
            continue
        for ii, it in enumerate(items):
            total_q += 1
            if not isinstance(it, dict) or not (it.get("q") or "").strip():
                rep.err(f"questions[{ci}].items[{ii}] 缺少 q")
                continue
            key = norm_q(it.get("q"))
            if key in seen:
                dup += 1
                rep.warn(f"问题重复：{it.get('q')!r}（与 {seen[key]!r} 相同）")
            else:
                seen[key] = it.get("q")
            check_source(f"questions[{ci}].items[{ii}]", [it], note_count, rep, limit_ok=False)
    if qcats and not (QUESTION_TOTAL[0] <= total_q <= QUESTION_TOTAL[1]):
        rep.warn(f"问题总数 {total_q}，建议 {QUESTION_TOTAL[0]}-{QUESTION_TOTAL[1]}")

    for key in ("filteredNotes", "emptyNotes"):
        arr = content.get(key)
        if arr is None:
            continue
        if not isinstance(arr, list) or not all(isinstance(x, int) for x in arr):
            rep.err(f"{key} 必须是整数数组")
        else:
            for x in arr:
                if not (0 <= x < note_count):
                    rep.err(f"{key} 含越界序号 {x}")
    inter = set(content.get("filteredNotes") or []) & set(content.get("emptyNotes") or [])
    if inter:
        rep.warn(f"filteredNotes 与 emptyNotes 有交集：{sorted(inter)[:10]}")

    # 报告图片必须本地：检查 notes[].localImages 不是外链/绝对路径，且文件存在
    for i, n in enumerate(notes):
        for rel in n.get("localImages") or []:
            if re.match(r"^(?:https?:)?//", str(rel)) or os.path.isabs(str(rel)):
                rep.err(f"notes[{i}].localImages 含非本地路径：{rel}（报告必须离线可用）")
            elif not os.path.exists(os.path.join(workdir, str(rel))):
                rep.warn(f"notes[{i}].localImages 文件不存在：{rel}（图片可能在采集时未下载成功）")

    checklist = content.get("checklist") or []
    if checklist and not all(isinstance(x, str) for x in checklist):
        rep.err("checklist 必须是字符串数组")
    salary_note = content.get("salaryNote")
    if salary_note is not None and not isinstance(salary_note, str):
        rep.err("salaryNote 必须是字符串")
    elif isinstance(salary_note, str) and salary_note and not (SALARY_NOTE_TOTAL[0] <= len(salary_note) <= SALARY_NOTE_TOTAL[1]):
        rep.warn(f"salaryNote 长度 {len(salary_note)} 字，建议 {SALARY_NOTE_TOTAL[0]}-{SALARY_NOTE_TOTAL[1]} 字")

    takeaways = content.get("takeaways") or []
    if takeaways:
        for i, it in enumerate(takeaways):
            if not isinstance(it, dict) or not (it.get("t") or "").strip():
                rep.err(f"takeaways[{i}] 缺少 t（结论标题）")
        if not (TAKEAWAY_TOTAL[0] <= len(takeaways) <= TAKEAWAY_TOTAL[1]):
            rep.warn(f"takeaways 有 {len(takeaways)} 条，建议 {TAKEAWAY_TOTAL[0]}-{TAKEAWAY_TOTAL[1]} 条")

    checklist = content.get("checklist") or []
    if checklist and not (CHECKLIST_TOTAL[0] <= len(checklist) <= CHECKLIST_TOTAL[1]):
        rep.warn(f"checklist 有 {len(checklist)} 条，建议 {CHECKLIST_TOTAL[0]}-{CHECKLIST_TOTAL[1]} 条")
    appendix = content.get("appendix") or []
    if appendix and not (APPENDIX_TOTAL[0] <= len(appendix) <= APPENDIX_TOTAL[1]):
        rep.warn(f"appendix 有 {len(appendix)} 条，建议 {APPENDIX_TOTAL[0]}-{APPENDIX_TOTAL[1]} 条")

    summary = {
        "workdir": workdir,
        "noteCount": note_count,
        "missingDetails": len(meta.get("missing") or []),
        "queries": len(meta.get("queries") or []),
        "questions": total_q,
        "questionCategories": len(qcats),
        "duplicateQuestions": dup,
        "counts": {k: (len(content.get(k) or []) if isinstance(content.get(k), list) else None) for k in
                   ["process", "positions", "timeline", "salary", "tips", "pitfalls"]},
        "errors": len(rep.errors),
        "warnings": len(rep.warnings),
    }
    return rep, summary


def main(argv=None):
    ap = argparse.ArgumentParser(description="校验 content.json")
    ap.add_argument("--dir", help="项目工作目录（默认当前目录）")
    ap.add_argument("--strict", action="store_true", help="warning 也视为失败")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出摘要")
    args = ap.parse_args(argv)

    workdir = C.resolve_workdir(args.dir)
    rep, summary = validate(workdir)
    if args.json:
        summary = dict(summary, errorList=rep.errors, warningList=rep.warnings)
        print(json.dumps(summary, ensure_ascii=False, indent=1))
    else:
        print("content.json 校验")
        if summary:
            print(
                f"  笔记 {summary['noteCount']} 篇 / 缺失详情 {summary['missingDetails']} / 问题 {summary['questions']} 题"
                f"（{summary['questionCategories']} 类，重复 {summary['duplicateQuestions']}）/ 检索 {summary['queries']} 组"
            )
            print("  分区：" + "，".join(f"{k}={v}" for k, v in (summary.get("counts") or {}).items()))
        for w in rep.warnings:
            print("  [warn] " + w)
        for e in rep.errors:
            print("  [error] " + e)
        print(f"结果：{len(rep.errors)} error / {len(rep.warnings)} warning")
    failed = bool(rep.errors) or (args.strict and bool(rep.warnings))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
