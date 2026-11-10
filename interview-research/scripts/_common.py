#!/usr/bin/env python3
"""interview-research skill 的公共工具：路径解析、JSON 读写、project.json 默认值。

仅使用 Python 3.9+ 标准库。脚本之间通过 import _common 共享，安装位置任意，
所有路径都相对「工作目录」（--dir）与脚本自身位置解析，不写死任何用户路径。
"""

import json
import os
import re
import sys

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS_DIR = os.path.join(SKILL_DIR, "assets")

CONTENT_NAME = "content.json"
PROJECT_NAME = "project.json"
DATA_DIRNAME = "data"

DEFAULT_PROJECT = {
    "slug": "example",
    "company": "目标公司",
    "city": "",
    "role": "",
    "topic": "面经",
    "titleMain": "",
    "titleThin": "面试准备手册",
    "pageTitle": "",
    "brand": "",
    "themeKey": "interview-theme",
    "storageKey": "interview",
    "sourceLabel": "小红书",
    "dateRange": "",
    "timelineTitle": "真实面试时间线",
    "englishPage": "",
    "accent": "#d81f3f",
    "accentSoft": "#fdeef1",
    "accentLine": "#f6c9d3",
    "offtopicLabel": "非主题 · 同业对比",
    "sourceNote": "数据来源：小红书公开笔记，仅用于个人面试准备 · 观点与信息归原作者所有",
    "methodDesc": "",
    "keywords": {"core": [], "expanded": [], "searchMatch": []},
    "topicPattern": "",
    "tagRules": [
        {"name": "流程", "pattern": "流程|几面|轮|环节|宣讲|投递|网申"},
        {"name": "一面", "pattern": "一面|初面"},
        {"name": "二面", "pattern": "二面|复试"},
        {"name": "HR面", "pattern": "hr面|人力"},
        {"name": "终面", "pattern": "终面|三面"},
        {"name": "岗位", "pattern": "岗位|选岗|方向|module|职能"},
        {"name": "薪资", "pattern": "薪资|待遇|月薪|年薪|工资|offer|13薪|14薪"},
        {"name": "英文", "pattern": "英文|英语|english"},
    ],
}

CONTENT_SKELETON = {
    "overview": "",
    "process": [],
    "questions": [],
    "positions": [],
    "timeline": [],
    "salary": [],
    "tips": [],
    "pitfalls": [],
    "takeaways": [],
    "checklist": [],
    "appendix": [],
    "salaryNote": "",
    "filteredNotes": [],
    "emptyNotes": [],
}

def die(msg, code=2):
    sys.stderr.write("错误：" + msg + "\n")
    raise SystemExit(code)


def warn(msg):
    sys.stderr.write("警告：" + msg + "\n")


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        die(f"JSON 损坏：{path}（第 {e.lineno} 行第 {e.colno} 列：{e.msg}）。修复或从备份恢复后重试。")
    except OSError as e:
        die(f"无法读取：{path}（{e}）")


def dump_json(path, obj):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def resolve_workdir(arg, must_exist=True):
    """--dir 缺省时用当前目录；必须包含 project.json 或 content.json。"""
    workdir = os.path.abspath(arg or os.getcwd())
    if must_exist and not os.path.isdir(workdir):
        die(f"工作目录不存在：{workdir}")
    return workdir


def load_project(workdir, required=True):
    path = os.path.join(workdir, PROJECT_NAME)
    project = load_json(path)
    if project is None:
        if required:
            die(f"找不到 {path}。先运行 scripts/init_project.py --dir <工作目录> 生成项目骨架。")
        return dict(DEFAULT_PROJECT)
    merged = dict(DEFAULT_PROJECT)
    merged.update(project or {})
    merged["keywords"] = {**DEFAULT_PROJECT["keywords"], **(project.get("keywords") or {})}
    if not merged.get("topicPattern"):
        parts = [merged.get("company", ""), merged.get("topic", "")]
        words = [w for w in re.split(r"[\s,，/]+", " ".join(parts)) if w]
        merged["topicPattern"] = "|".join(re.escape(w) for w in words) or "."
    return merged


def find_xhs_data(arg, project):
    """定位 dsh-xhs-check 的 data 目录。

    优先级：--xhs-data 参数 > 环境变量 XHS_DATA / XHS_CHECK_DATA_DIR > project.json 的
    xhsData > 常见安装位置。DSH 里应优先调用 xhs_status 工具拿到 dataDir 再传 --xhs-data。
    """
    if arg:
        explicit = os.path.abspath(arg)
        if not os.path.isdir(os.path.join(explicit, "searches")):
            die(
                f"--xhs-data 指向的目录无效（应包含 searches/ 子目录）：{explicit}\n"
                "  先用 xhs_status 工具确认插件数据目录，再原样传入。"
            )
        return explicit
    candidates = []
    for env in ("XHS_DATA", "XHS_CHECK_DATA_DIR"):
        if os.environ.get(env):
            candidates.append(os.environ[env])
    if project.get("xhsData"):
        candidates.append(project["xhsData"])
    home = os.path.expanduser("~")
    candidates.extend(
        [
            os.path.join(ASSETS_DIR, "..", "..", "xhs-check", "data"),
            os.path.join(home, ".dsh", "plugins", "dsh-dev", "xhs-check", "data"),
            os.path.expanduser("~/dsh-dev/xhs-check/data"),
        ]
    )
    for c in candidates:
        if c and os.path.isdir(os.path.join(c, "searches")):
            return os.path.abspath(c)
    return None


def require_xhs_data(arg, project):
    data = find_xhs_data(arg, project)
    if not data:
        die(
            "找不到小红书采集数据目录（应包含 searches/ 子目录）。\n"
            "  传参：--xhs-data /path/to/xhs-check/data\n"
            "  或先调用 xhs_status 工具，把返回的 dataDir 传进来（DSH 内置浏览器采集的数据默认在插件目录下）。"
        )
    return data


def text_of_note(note):
    parts = [note.get("title") or "", note.get("desc") or ""]
    for c in note.get("comments") or []:
        parts.append(c.get("content") or "")
    return " ".join(parts)


def compile_rules(project):
    rules = []
    for rule in project.get("tagRules") or []:
        try:
            rules.append((rule["name"], re.compile(rule["pattern"], re.I)))
        except (KeyError, re.error):
            warn(f"忽略非法 tagRules 规则：{rule!r}")
    return rules


def tag_note(note, rules):
    text = text_of_note(note).lower()
    return [name for name, pat in rules if pat.search(text)]


def topic_pattern(project):
    try:
        return re.compile(project.get("topicPattern") or ".", re.I)
    except re.error:
        warn(f"project.json 的 topicPattern 非法，退化为全匹配：{project.get('topicPattern')!r}")
        return re.compile(".")
