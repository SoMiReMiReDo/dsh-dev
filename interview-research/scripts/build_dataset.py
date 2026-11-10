#!/usr/bin/env python3
"""把 dsh-xhs-check 的采集数据聚合成本项目的分析用数据。

输入：xhs-check/data/{searches,notes,comments}
输出（全部写到 <工作目录>/data/）：
    notes.json    合并后的笔记（正文 + 评论 + 本地图片路径 + 标签 + 是否偏题）
    meta.json     检索关键词命中、统计、缺失清单、构建时间、标签清单
    digest-*.md   分块文本，供抽取阶段（或子代理）阅读
    images/       笔记配图本地化（避免小红书 CDN 签名过期）

用法：
    python3 scripts/build_dataset.py --dir <工作目录> --xhs-data <xhs-check/data> [--no-images]

要点：
- 笔记序号（content.json 里 source 引用的 [n]）以 notes.json 下标为准；已有 notes.json 时
  旧序号保持不变、新笔记追加到末尾，保证历史引用不漂移。
- 图片 CDN 链接带时间签名，过期后 403，无法补下；采集完应尽快跑本脚本本地化。
"""

import argparse
import glob
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402

IMAGE_HEADERS = {
    "Referer": "https://www.xiaohongshu.com/",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
}


def flatten_comments(comments):
    rows = []
    for c in comments or []:
        rows.append(
            {
                "author": (c.get("author") or {}).get("nickname"),
                "content": c.get("content"),
                "like": c.get("likeCount"),
                "createdAt": c.get("createdAt"),
                "ip": c.get("ipLocation"),
                "reply": False,
            }
        )
        for s in c.get("subComments") or []:
            rows.append(
                {
                    "author": (s.get("author") or {}).get("nickname"),
                    "content": s.get("content"),
                    "like": s.get("likeCount"),
                    "createdAt": s.get("createdAt"),
                    "ip": s.get("ipLocation"),
                    "reply": True,
                }
            )
    return rows


def match_search(query, search_match):
    if not search_match:
        return True
    q = (query or "").lower()
    return any(term.lower() in q for term in search_match if term)


def list_searches(data_dir, search_match):
    out, skipped = [], []
    for path in sorted(glob.glob(os.path.join(data_dir, "searches", "*.json"))):
        doc = C.load_json(path, strict=False) or {}
        if not doc:
            continue
        if not match_search(doc.get("query"), search_match):
            skipped.append({"file": os.path.basename(path), "query": doc.get("query")})
            continue
        out.append((path, doc))
    if skipped:
        C.warn(
            f"{len(skipped)} 个搜索文件被 project.json 的 keywords.searchMatch 过滤；"
            "如要全部纳入，把 searchMatch 设为空数组 []"
        )
    return out, skipped


def fetch_image(url, dst, retries=3):
    for _ in range(retries):
        try:
            req = Request(url, headers=IMAGE_HEADERS)
            with urlopen(req, timeout=25) as resp:
                data = resp.read()
            if len(data) > 800:
                with open(dst, "wb") as f:
                    f.write(data)
                return True
        except Exception:  # noqa: BLE001 - 网络/403/超时都按失败重试
            continue
    if os.path.exists(dst):
        try:
            os.remove(dst)
        except OSError:
            pass
    return False


def image_ext(url):
    low = (url or "").lower()
    if "webp" in low:
        return ".webp"
    if "png" in low:
        return ".png"
    return ".jpg"


def upload_images(notes, image_dir, rel_root, workers=8, enabled=True):
    """下载/复用本地图片。**不清空已有图片**：小红书 CDN 签名过期后旧图不可重下，
    因此已存在且大小正常的文件直接复用，只补缺失的。"""
    if not enabled:
        for n in notes:
            n["localImages"] = []
        return 0, 0
    os.makedirs(image_dir, exist_ok=True)
    local, jobs = {}, []
    planned = 0
    for n in notes:
        for i, url in enumerate(n.get("images") or []):
            if not url:
                continue
            planned += 1
            name = f"{n['id']}_{i}{image_ext(url)}"
            dst = os.path.join(image_dir, name)
            rel = os.path.relpath(dst, rel_root).replace(os.sep, "/")
            if os.path.exists(dst) and os.path.getsize(dst) > 800:
                local[url] = rel
                continue
            jobs.append((url, dst, rel))
    if jobs:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(lambda job: fetch_image(job[0], job[1]), jobs))
        for (url, dst, rel), good in zip(jobs, results):
            if good and os.path.exists(dst) and os.path.getsize(dst) > 800:
                local[url] = rel
    for n in notes:
        n["localImages"] = [local[u] for u in (n.get("images") or []) if u in local]
    return len(local), planned


def note_digest(idx, note, max_desc=2500, max_comments=8, max_comment_chars=200):
    lines = [f"## [{idx}] {note.get('title') or '（无标题）'}"]
    stats = note.get("stats") or {}
    meta = [
        f"作者：{note.get('author') or '—'}",
        f"发布：{(note.get('publishedAt') or '')[:10] or '—'}",
        f"IP：{note.get('ip') or '—'}",
        f"赞{stats.get('liked', '—')}/评{stats.get('comments', '—')}/藏{stats.get('collected', '—')}",
    ]
    lines.append("- " + " ｜ ".join(meta))
    if note.get("queries"):
        lines.append("- 命中检索：" + "、".join(note["queries"][:3]))
    tags = list(note.get("tags") or []) + list(note.get("tags2") or [])
    if tags:
        lines.append("- 标签：" + "、".join(dict.fromkeys(tags)))
    desc = (note.get("desc") or "").strip()
    if desc:
        lines.append("正文：")
        lines.append(desc[:max_desc] + ("…（截断）" if len(desc) > max_desc else ""))
    else:
        lines.append("正文：〔空，内容为图片帖〕")
    comments = note.get("comments") or []
    if comments:
        lines.append(f"评论（{len(comments)} 条，展示前 {min(len(comments), max_comments)} 条）：")
        for c in comments[:max_comments]:
            content = re.sub(r"\s+", " ", (c.get("content") or "")).strip()
            if not content:
                continue
            prefix = "↳ " if c.get("reply") else "- "
            lines.append(f"{prefix}{c.get('author') or '—'}：{content[:max_comment_chars]}")
    lines.append("")
    return "\n".join(lines)


def build_digests(notes, out_dir, chunk_chars=60000):
    parts, cur = [], []
    size = 0
    for idx, note in enumerate(notes):
        text = note_digest(idx, note)
        if cur and size + len(text) > chunk_chars:
            parts.append("".join(cur))
            cur, size = [], 0
        cur.append(text)
        size += len(text)
    if cur:
        parts.append("".join(cur))
    # 先清掉旧分块，避免残留上一轮的 digest-03
    for old in glob.glob(os.path.join(out_dir, "digest-*.md")):
        os.remove(old)
    paths = []
    for i, text in enumerate(parts, 1):
        path = os.path.join(out_dir, f"digest-{i:02d}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        paths.append(path)
    header = os.path.join(out_dir, "digest.md")
    with open(header, "w", encoding="utf-8") as f:
        f.write(
            f"# 面经采集 digest（{len(notes)} 篇，{len(parts)} 个分块）\n\n"
            + "\n".join(f"- `{os.path.basename(p)}`：约 {os.path.getsize(p)//1000} KB" for p in paths)
            + "\n\n按分块阅读后，按 `references/content-extraction.md` 的 schema 写入 `content.json`。\n"
        )
    return paths


def main(argv=None):
    ap = argparse.ArgumentParser(description="聚合 xhs-check 采集数据为分析用数据")
    ap.add_argument("--dir", help="项目工作目录（默认当前目录）")
    ap.add_argument("--xhs-data", help="xhs-check 的 data 目录（建议先用 xhs_status 查）")
    ap.add_argument("--no-images", action="store_true", help="跳过图片下载（本地快速验证用）")
    ap.add_argument("--max-images", type=int, default=0, help="最多下载多少张图（0=不限）")
    ap.add_argument("--chunk-chars", type=int, default=60000, help="digest 单块字符上限")
    args = ap.parse_args(argv)

    workdir = C.resolve_workdir(args.dir)
    project = C.load_project(workdir)
    data_dir = C.require_xhs_data(args.xhs_data, project)
    out_dir = os.path.join(workdir, C.DATA_DIRNAME)
    os.makedirs(out_dir, exist_ok=True)

    rules = C.compile_rules(project)
    topic = C.topic_pattern(project)
    searches, skipped_searches = list_searches(data_dir, project["keywords"].get("searchMatch") or [])

    queries = []
    note_index = {}
    for path, doc in searches:
        query = doc.get("query")
        queries.append(
            {
                "query": query,
                "sort": doc.get("sort") or "default",
                "file": os.path.basename(path),
                "count": len(doc.get("notes") or []),
                "collectedAt": doc.get("collectedAt"),
            }
        )
        for card in doc.get("notes") or []:
            nid = card.get("id") or card.get("noteId")
            if not nid:
                continue
            rec = note_index.setdefault(nid, {"card": card, "queries": []})
            if query and query not in rec["queries"]:
                rec["queries"].append(query)

    notes, missing = [], []
    for nid, rec in note_index.items():
        np_ = os.path.join(data_dir, "notes", nid + ".json")
        if not os.path.exists(np_):
            missing.append(nid)
            continue
        n = C.load_json(np_)
        if not n or not n.get("publishedAt"):
            missing.append(nid)
            continue
        comments = []
        cp = os.path.join(data_dir, "comments", nid + ".json")
        if os.path.exists(cp):
            comments = flatten_comments((C.load_json(cp) or {}).get("comments") or [])
        note = {
            "id": nid,
            "title": n.get("title") or rec["card"].get("title") or None,
            "author": (n.get("author") or {}).get("nickname"),
            "authorId": (n.get("author") or {}).get("id"),
            "publishedAt": n.get("publishedAt"),
            "ip": n.get("ipLocation"),
            "url": n.get("url"),
            "stats": n.get("stats") or {},
            "desc": n.get("desc") or "",
            "tags": n.get("tags") or [],
            "noteType": n.get("noteType"),
            "images": [i.get("url") for i in (n.get("images") or []) if i.get("url")],
            "comments": comments,
            "queries": rec["queries"],
        }
        note["tags2"] = C.tag_note(note, rules)
        note["offtopic"] = not bool(topic.search(C.text_of_note(note)))
        note["publishedShort"] = (note["publishedAt"] or "")[:10]
        notes.append(note)

    # 序号稳定：旧笔记保持原有顺序；本次采集里已不存在的旧笔记保留占位（标记 droppedFromData），
    # 新笔记追加到末尾（按发布时间倒序）。这样即使换 dataDir / 少采到某篇，历史 source 序号也不漂移。
    old_path = os.path.join(out_dir, "notes.json")
    old_notes = C.load_json(old_path) or []
    order = [n.get("id") for n in old_notes]
    old_by_id = {n.get("id"): n for n in old_notes}
    current_by_id = {n["id"]: n for n in notes}
    retained = []
    if order:
        merged = []
        for nid in order:
            if nid in current_by_id:
                merged.append(current_by_id[nid])
            elif nid in old_by_id:
                old_note = dict(old_by_id[nid])
                old_note["droppedFromData"] = True
                merged.append(old_note)
                retained.append(nid)
        new_part = [n for n in notes if n["id"] not in set(order)]
        new_part.sort(key=lambda n: n.get("publishedAt") or "", reverse=True)
        notes = merged + new_part
        print(f"序号：保留旧笔记 {len(merged) - len(retained)} 条，追加新笔记 {len(new_part)} 条")
        if retained:
            C.warn(
                f"{len(retained)} 篇旧笔记本次采集数据里不存在，已保留占位以稳定序号（标记 droppedFromData）："
                + "、".join(retained[:5]) + ("…" if len(retained) > 5 else "")
            )
    else:
        notes.sort(key=lambda n: n.get("publishedAt") or "", reverse=True)

    # 图片预算：显式 --max-images 时按总量截断（后续笔记置空，避免超预算）
    max_images = args.max_images
    if max_images:
        left = max_images
        for n in notes:
            imgs = n.get("images") or []
            n["images"] = imgs[: max(0, left)]
            left -= len(n["images"])
        print(f"图片预算：最多下载/复用 {max_images} 张")
    # 兼容旧版本 notes.json 里保留占位的笔记：补齐派生字段，避免下游 KeyError
    for n in notes:
        n.setdefault("publishedShort", (n.get("publishedAt") or "")[:10])
        n.setdefault("tags2", C.tag_note(n, rules))
        n.setdefault("offtopic", not bool(topic.search(C.text_of_note(n))))
        n.setdefault("comments", [])
        n.setdefault("queries", [])
    img_total = sum(len(n.get("images") or []) for n in notes)
    img_ok, img_jobs = upload_images(
        notes, os.path.join(out_dir, "images"), workdir, enabled=not args.no_images
    )
    for n in notes:
        n.pop("images", None)

    tag_names = [name for name, _ in rules]
    tag_counts = {name: sum(1 for n in notes if name in (n.get("tags2") or [])) for name in tag_names}
    published = sorted(n["publishedAt"][:7] for n in notes if n.get("publishedAt"))
    date_range = ""
    if published:
        a, b = published[0].replace("-", "."), published[-1].replace("-", ".")
        date_range = a if a == b else f"{a}—{b}"

    meta = {
        "topic": project.get("topic"),
        "source": "小红书 / dsh-xhs-check 采集",
        "xhsData": data_dir,
        "builtAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "queries": queries,
        "queryCount": len(queries),
        "noteCount": len(notes),
        "commentCount": sum(len(n["comments"]) for n in notes),
        "imageCount": img_ok,
        "imageTotal": img_total,
        "totalLikes": sum((n.get("stats") or {}).get("liked") or 0 for n in notes),
        "missing": missing,
        "searchFiltered": skipped_searches,
        "retainedMissingFromData": retained,
        "dateRange": date_range,
        "noteTags": [name for name in tag_names if tag_counts.get(name)],
        "tagCounts": tag_counts,
        "noteIndex": [
            {
                "id": n["id"],
                "title": n["title"],
                "author": n["author"],
                "publishedAt": n["publishedAt"],
                "liked": (n.get("stats") or {}).get("liked"),
                "commentTotal": (n.get("stats") or {}).get("comments"),
                "offtopic": n.get("offtopic", False),
            }
            for n in notes
        ],
    }
    C.dump_json(os.path.join(out_dir, "notes.json"), notes)
    C.dump_json(os.path.join(out_dir, "meta.json"), meta)
    parts = build_digests(notes, out_dir, chunk_chars=args.chunk_chars)

    print(
        json.dumps(
            {
                "queries": len(queries),
                "notes": len(notes),
                "comments": meta["commentCount"],
                "images": f"{img_ok}/{img_total}",
                "missing": len(missing),
                "offtopic": sum(1 for n in notes if n["offtopic"]),
                "digestParts": len(parts),
            },
            ensure_ascii=False,
        )
    )
    print("输出：", out_dir)
    if missing:
        print(f"缺失详情 {len(missing)} 篇（可重采）：", ", ".join(missing[:5]) + ("…" if len(missing) > 5 else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
