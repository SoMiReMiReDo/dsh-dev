#!/usr/bin/env python3
"""初始化一个「面经调研 → 单页 HTML 报告」项目骨架。

用法：
    python3 scripts/init_project.py --dir ~/notes/interview/hynix-dalian \
        --company "SK海力士" --city "大连" --role "工艺/设备/整合" \
        --topic "海力士 大连 面经" [--slug hynix-dalian] [--force]

生成：
    <dir>/project.json   课题配置（公司/城市/关键词/主题色/标签规则）
    <dir>/content.json   唯一内容源骨架（由抽取阶段填写）
    <dir>/data/          聚合数据目录（build_dataset.py 写入）
    <dir>/README.md      本项目的重新生成说明
"""

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402

README_TMPL = """# {topic} · 面经调研项目

由 `interview-research` skill 初始化。数据源：{source_label}公开笔记（dsh-xhs-check 采集）。

## 文件

| 文件 | 说明 |
|---|---|
| `project.json` | 课题配置：公司/城市/关键词/主题色/标签规则 |
| `content.json` | **唯一内容源**，由抽取阶段写入；改内容只改这里 |
| `data/notes.json` `data/meta.json` | 聚合后的笔记、评论与检索元数据（生成物） |
| `data/digest-*.md` | 分块文本，供抽取用（生成物） |
| `data/images/` | 本地化配图（生成物） |
| `report.html` | **主交付物**：单文件离线面试准备手册（生成物） |
| `面试摘要.md` | 纯文本摘要（生成物） |

## 重新生成

```bash
python3 {skill}/scripts/build_dataset.py --dir . --xhs-data <xhs-check/data 路径>
python3 {skill}/scripts/validate_content.py --dir .
python3 {skill}/scripts/digest.py --dir .
python3 {skill}/scripts/render_report.py --dir .
```

`content.json` 由 Agent/人工按 `references/content-extraction.md` 的结构化规则填写；
`面试摘要.md` 与 `report.html` 都是生成物，不要手改。
"""


def slugify(text):
    text = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", text.strip().lower())
    return text.strip("-") or "interview-project"


def main(argv=None):
    ap = argparse.ArgumentParser(description="初始化面经调研项目骨架")
    ap.add_argument("--dir", help="项目目录（默认当前目录）")
    ap.add_argument("--company", required=True, help="公司名，如 SK海力士")
    ap.add_argument("--city", default="", help="城市，如 大连；可空")
    ap.add_argument("--role", default="", help="岗位/方向，如 工艺/设备/整合；可空")
    ap.add_argument("--topic", default="", help="课题名/检索主题，如 海力士 大连 面经")
    ap.add_argument("--slug", default="", help="项目 slug（默认由公司+城市生成）")
    ap.add_argument("--keywords", default="", help="额外的核心关键词，逗号分隔")
    ap.add_argument("--accent", default="", help="主题强调色（默认 #d81f3f）")
    ap.add_argument("--xhs-data", default="", help="xhs-check data 目录，写入 project.json")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的 project.json/content.json")
    args = ap.parse_args(argv)

    workdir = C.resolve_workdir(args.dir, must_exist=False)
    os.makedirs(workdir, exist_ok=True)
    project_path = os.path.join(workdir, C.PROJECT_NAME)
    content_path = os.path.join(workdir, C.CONTENT_NAME)
    if os.path.exists(project_path) and not args.force:
        C.die(f"{project_path} 已存在。换目录或加 --force 覆盖。")

    slug = args.slug or slugify(f"{args.company}-{args.city or ''}")
    topic = args.topic or " ".join(x for x in [args.company, args.city, "面经"] if x)
    core = [topic]
    for extra in [x.strip() for x in args.keywords.split(",") if x.strip()]:
        if extra not in core:
            core.append(extra)
    keywords = {
        "core": core,
        "expanded": [],
        # 默认收集全部搜索结果；只有显式填写时才按词过滤（避免静默丢掉行业泛化搜索）
        "searchMatch": [],
    }
    project = dict(C.DEFAULT_PROJECT)
    project.update(
        {
            "slug": slug,
            "company": args.company,
            "city": args.city,
            "role": args.role,
            "topic": topic,
            "brand": " · ".join(x for x in [args.company, args.city] if x) + "面经"
            if args.city
            else args.company,
            "pageTitle": f"{args.company}{('（' + args.city + '）') if args.city else ''}面试准备手册 · 面经汇总",
            "themeKey": f"{slug}-theme",
            "storageKey": slug,
            "keywords": keywords,
            "accent": args.accent or C.DEFAULT_PROJECT["accent"],
            "accentSoft": C.DEFAULT_PROJECT["accentSoft"],
            "accentLine": C.DEFAULT_PROJECT["accentLine"],
        }
    )
    if args.xhs_data:
        project["xhsData"] = os.path.abspath(args.xhs_data)
    C.dump_json(project_path, project)

    if not os.path.exists(content_path) or args.force:
        C.dump_json(content_path, dict(C.CONTENT_SKELETON))

    os.makedirs(os.path.join(workdir, C.DATA_DIRNAME), exist_ok=True)
    readme = os.path.join(workdir, "README.md")
    if not os.path.exists(readme) or args.force:
        with open(readme, "w", encoding="utf-8") as f:
            f.write(
                README_TMPL.format(
                    topic=topic,
                    source_label=project.get("sourceLabel") or "小红书",
                    skill=C.SKILL_DIR,
                )
            )

    added = [p for p in (project_path, content_path) if os.path.exists(p)]
    print("已初始化项目：", workdir)
    print("配置：", project_path)
    print("内容骨架：", content_path)
    print("下一步：")
    print("  1) 用 dsh-xhs-check 检索/采集（建议先 xhs_status 拿 dataDir）")
    print(f"  2) python3 {os.path.join(C.SKILL_DIR, 'scripts', 'build_dataset.py')} --dir {workdir} --xhs-data <dataDir>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
