#!/usr/bin/env python3
"""把 project.json + data/*.json + content.json 打包进模板，生成单文件离线 report.html。

用法：
    python3 scripts/render_report.py --dir <工作目录> [--template <模板路径>] [--out report.html]

模板契约（assets/report.template.html）：
    __PAGE_TITLE__     <title> 内容
    __THEME_KEY__      localStorage 里夜间主题的 key
    __STORAGE_KEY__    其他本地状态（如准备清单勾选）的 key 前缀
    /*__DATA__*/       替换为 const DATA = {"project":…,"meta":…,"content":…,"notes":…};
模板本身不依赖任何外部 CDN / 字体 / 脚本，生成物双击即可离线打开。
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402

DEFAULT_TEMPLATE = os.path.join(C.ASSETS_DIR, "report.template.html")


def fill_notes(notes, project, workdir):
    """兼容旧 notes.json：补上模板需要的派生字段（build_dataset 正常已写好）。"""
    rules = C.compile_rules(project)
    topic = C.topic_pattern(project)
    for n in notes:
        n.setdefault("publishedShort", (n.get("publishedAt") or "")[:10])
        if "tags2" not in n:
            n["tags2"] = C.tag_note(n, rules)
        if "offtopic" not in n:
            n["offtopic"] = not bool(topic.search(C.text_of_note(n)))
        if n.get("title") and len(n["title"]) == 24 and all(ch in "0123456789abcdef" for ch in n["title"]):
            n["title"] = "（无标题 · 纯图帖）"
        # 兼容旧数据：localImages 可能是相对项目根的 images/...，统一改成相对报告目录
        data_dir = os.path.join(workdir, C.DATA_DIRNAME)
        fixed = []
        for rel in n.get("localImages") or []:
            if rel and not os.path.isabs(rel) and not rel.startswith("data/"):
                if os.path.exists(os.path.join(data_dir, rel)):
                    rel = "data/" + rel.replace(os.sep, "/")
            fixed.append(rel)
        n["localImages"] = fixed


def main(argv=None):
    ap = argparse.ArgumentParser(description="生成单文件 report.html")
    ap.add_argument("--dir", help="项目工作目录（默认当前目录）")
    ap.add_argument("--template", default="", help="模板路径（默认 skill 自带 assets/report.template.html）")
    ap.add_argument("--out", default="report.html", help="输出文件名")
    args = ap.parse_args(argv)

    workdir = C.resolve_workdir(args.dir)
    project = C.load_project(workdir)
    content = C.load_json(os.path.join(workdir, C.CONTENT_NAME))
    if content is None:
        C.die(f"找不到 {C.CONTENT_NAME}；先完成抽取并运行 validate_content.py。")
    data_dir = os.path.join(workdir, C.DATA_DIRNAME)
    notes = C.load_json(os.path.join(data_dir, "notes.json"))
    meta = C.load_json(os.path.join(data_dir, "meta.json"))
    if notes is None:
        C.die(f"找不到 {os.path.join(data_dir, 'notes.json')}；先运行 build_dataset.py。")
    meta = meta or {}
    meta.setdefault("noteCount", len(notes))
    fill_notes(notes, project, workdir)

    template_path = os.path.abspath(args.template) if args.template else DEFAULT_TEMPLATE
    if not os.path.exists(template_path):
        C.die(f"找不到模板：{template_path}")
    with open(template_path, encoding="utf-8") as f:
        tpl = f.read()

    city = project.get("city") or ""
    head = f"{project.get('company') or ''}{('（' + city + '）') if city else ''}"
    page_title = project.get("pageTitle") or f"{head}面试准备手册 · 面经汇总"
    theme_key = project.get("themeKey") or "interview-theme"
    storage_key = project.get("storageKey") or project.get("slug") or "interview"

    data = {"project": project, "meta": meta, "content": content, "notes": notes}
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = (
        tpl.replace("__PAGE_TITLE__", page_title)
        .replace("__THEME_KEY__", theme_key)
        .replace("__STORAGE_KEY__", storage_key)
        .replace("/*__DATA__*/", "const DATA = " + raw + ";")
    )
    for marker in ("__PAGE_TITLE__", "__THEME_KEY__", "__STORAGE_KEY__"):
        if marker in html:
            C.die(f"模板替换失败：{marker} 仍存在（模板被改坏了？）")
    if "const DATA = " not in html:
        C.die("模板缺少 /*__DATA__*/ 数据注入占位符。")

    out = os.path.join(workdir, args.out)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(
        json.dumps(
            {
                "report": os.path.basename(out),
                "bytes": os.path.getsize(out),
                "notes": len(notes),
                "questions": sum(len(c.get("items") or []) for c in content.get("questions") or []),
                "template": template_path,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
