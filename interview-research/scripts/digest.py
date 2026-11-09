#!/usr/bin/env python3
"""content.json → 面试摘要.md（纯文本版，便于检索/打印/喂给其他模型）。

用法：
    python3 scripts/digest.py --dir <工作目录> [--out 面试摘要.md]

content.json 是唯一内容源；report.html 与 面试摘要.md 都由它生成，改内容只改 content.json。
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402


def src(source, note_count):
    items = [str(x) for x in (source or []) if isinstance(x, int) and 0 <= x < note_count]
    return f"　[{', '.join(items)}]" if items else ""


def main(argv=None):
    ap = argparse.ArgumentParser(description="content.json → 面试摘要.md")
    ap.add_argument("--dir", help="项目工作目录（默认当前目录）")
    ap.add_argument("--out", default="面试摘要.md", help="输出文件名")
    args = ap.parse_args(argv)

    workdir = C.resolve_workdir(args.dir)
    project = C.load_project(workdir)
    content = C.load_json(os.path.join(workdir, C.CONTENT_NAME))
    if content is None:
        C.die(f"找不到 {C.CONTENT_NAME}；先运行 init_project.py 并完成抽取。")
    notes = C.load_json(os.path.join(workdir, C.DATA_DIRNAME, "notes.json")) or []
    meta = C.load_json(os.path.join(workdir, C.DATA_DIRNAME, "meta.json")) or {}
    total = len(notes)

    used = set()
    for key in ("process", "positions", "timeline", "salary", "tips", "pitfalls"):
        for row in content.get(key) or []:
            used.update(x for x in (row.get("source") or []) if isinstance(x, int))
    for cat in content.get("questions") or []:
        for row in cat.get("items") or []:
            used.update(x for x in (row.get("source") or []) if isinstance(x, int))

    company = project.get("company") or ""
    city = project.get("city") or ""
    head = f"{company}（{city}）" if city else company
    lines = [f"# {head}面试准备摘要", ""]
    lines.append(
        f"> 数据源：{project.get('sourceLabel') or '小红书'}「{project.get('topic') or ''}」相关笔记 "
        f"{total} 条，其中 {len(used)} 条作为来源保留"
        f"（{len(content.get('filteredNotes') or [])} 条无关已过滤，"
        f"{len(content.get('emptyNotes') or [])} 条无实质内容未引用；"
        f"另有 {len(meta.get('missing') or [])} 条只在搜索结果中出现、没取到正文）。"
        "内容忠于原帖，原文没提到的不补充，不确定处标注「（存疑）」。"
        "方括号里的数字是 notes.json 里的笔记序号，便于回查。"
    )
    lines.append("")

    takeaways = content.get("takeaways") or []
    if takeaways:
        lines += ["## 核心结论", ""]
        for it in takeaways:
            lines.append(f"- **{it.get('t', '')}**：{it.get('d', '')}" if it.get("d") else f"- **{it.get('t', '')}**")
        lines.append("")

    lines += ["## 一、总览", "", content.get("overview") or "", ""]

    lines += ["## 二、面试流程", ""]
    for i, it in enumerate(content.get("process") or [], 1):
        srctxt = src(it.get("source"), total).strip()
        lines.append(f"**{i}. {it.get('round', '')}**" + (f"　来源 {srctxt}" if srctxt else ""))
        lines.append("")
        if it.get("timing"):
            lines.append(f"- 时间：{it['timing']}")
        if it.get("format"):
            lines.append(f"- 形式：{it['format']}")
        lines.append("")

    lines += ["## 三、面试问题", ""]
    lines.append("> 同一问题只保留一次，来源合并；「提示」是原帖给的回答思路或提醒，没有就留空。")
    lines.append("")
    for cat in content.get("questions") or []:
        items = cat.get("items") or []
        if not items:
            continue
        lines += [f"### {cat.get('category', '')}（{len(items)} 题）", ""]
        for it in items:
            q = it.get("q", "")
            hint = it.get("hint") or ""
            tail = src(it.get("source"), total)
            lines.append(f"- **{q}**　— {hint}{tail}" if hint else f"- **{q}**{tail}")
        lines.append("")

    lines += ["## 四、岗位与方向差异", ""]
    for it in content.get("positions") or []:
        lines += [f"### {it.get('name', '')}{src(it.get('source'), total)}", "", it.get("notes") or "", ""]

    lines += ["## 五、时间线", ""]
    lines += ["| 阶段 | 时间／结果 | 来源 |", "| --- | --- | --- |"]
    for it in content.get("timeline") or []:
        srcs = [str(x) for x in (it.get("source") or []) if isinstance(x, int) and 0 <= x < total]
        lines.append(f"| {it.get('stage', '')} | {it.get('info', '')} | [{', '.join(srcs)}] |")
    lines.append("")

    lines += ["## 六、薪资与待遇", ""]
    for it in content.get("salary") or []:
        lines.append(f"- {it.get('text', '')}{src(it.get('source'), total)}")
    lines.append("")
    if content.get("salaryNote"):
        lines += [f"> {content['salaryNote']}", ""]

    lines += ["## 七、准备建议", ""]
    for it in content.get("tips") or []:
        lines.append(f"- {it.get('text', '')}{src(it.get('source'), total)}")
    lines.append("")

    lines += ["## 八、踩坑与失败教训", ""]
    for it in content.get("pitfalls") or []:
        lines.append(f"- {it.get('text', '')}{src(it.get('source'), total)}")
    lines.append("")

    checklist = content.get("checklist") or []
    if checklist:
        lines += ["## 九、面试前清单", ""]
        for i, item in enumerate(checklist, 1):
            lines.append(f"{i}. {item}")
        lines.append("")

    appendix = content.get("appendix") or []
    if appendix:
        lines += ["## 附：未采用与过滤说明", ""]
        for item in appendix:
            lines.append(f"- {item}")
        lines.append("")

    out = os.path.join(workdir, args.out)
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).rstrip() + "\n")
    print(f"{args.out} {os.path.getsize(out)} bytes; notes {total}; sources used {len(used)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
