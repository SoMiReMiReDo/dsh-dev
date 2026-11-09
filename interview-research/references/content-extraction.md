# 结构化抽取：content schema、prompt、质量门槛

`content.json` 是**唯一内容源**：`report.html` 与 `面试摘要.md` 都由它生成。改内容只改它，改完重新生成。

## 1. 输入：digest 分块

`build_dataset.py` 产出 `data/digest-01.md`、`data/digest-02.md`…（每块 ≤60k 字符，按笔记边界切）。每条笔记格式：

```text
## [12] 标题
- 作者：xxx ｜ 发布：2025-10-20 ｜ IP：辽宁 ｜ 赞120/评8/藏30
- 命中检索：海力士 大连 面经、海力士 大连 二面
- 标签：一面、英文
正文：
（正文全文，过长会截断并标注）
评论（8 条，展示前 8 条）：
- 作者：xxx：一级评论…
↳ 作者：xxx：楼中楼…
```

`[n]` 就是 `notes.json` 下标，也是 `content.json` 里 `source` 要引用的序号。**只引用 digest 里出现过的序号**，不要自己编号。

## 2. 输出 schema（严格照抄键名）

```json
{
  "overview": "400-900 字总览：几轮、形式、难度、面试官风格、最该准备什么",
  "process": [
    {"round": "线上一面", "timing": "10 月中旬，约 1 周出结果", "format": "1v1 视频，英文自我介绍 + 简历问题", "source": [0, 3]}
  ],
  "questions": [
    {"category": "通用动机", "items": [
      {"q": "为什么选择我们公司？", "hint": "结合行业、公司与个人规划，别背模板", "source": [0, 12]}
    ]}
  ],
  "positions": [
    {"name": "工艺 / 设备", "notes": "偏工艺原理与设备基础，会问 recipe、工艺窗口、故障排查思路", "source": [7]}
  ],
  "timeline": [
    {"stage": "一面", "info": "10 月中旬，1 周内出结果", "source": [0]}
  ],
  "salary": [
    {"text": "示例帖提到的月薪口径为 xK × 14 薪（存疑）", "source": [11]}
  ],
  "tips": [{"text": "英文自我介绍准备 30s / 1min 两版", "source": [0]}],
  "pitfalls": [{"text": "拒绝倒班/调岗可能直接失去 HR 面", "source": [11]}],
  "takeaways": [{"t": "技术面是分水岭", "d": "专业问题和项目深挖几乎都在线下二面"}],
  "checklist": ["英文自我介绍 30s / 1min 两版练熟", "项目讲稿：背景 → 方案 → 结果 → 复盘"],
  "appendix": ["已过滤 2 条无关帖：[19] 其他公司一面、[22] 其他公司面试"],
  "salaryNote": "薪资多为个人口述/宣讲会转述，数字含存疑，正式谈薪前建议找 HR 或校友核对。",
  "filteredNotes": [19, 22],
  "emptyNotes": [1, 18, 30]
}
```

字段约束（`validate_content.py` 会检查）：

| 字段 | 类型 | 建议条数/长度 | 说明 |
| --- | --- | --- | --- |
| `overview` | string | 400-900 字 | 全页结论，必须写；可含少量 `\n` |
| `process` | array | 8-20 | 每个环节 `round` 必填；`timing`/`format` 无则省略 |
| `questions` | array | 6-8 类 / 60-160 题 | 类别建议：自我介绍、通用动机、项目与简历、专业知识、英文、情景与性格、反问（可按行业增减） |
| `questions[].items[]` | object | — | `q` 必填；`hint` 可空；`source` ≤6 个 |
| `positions` | array | 5-20 | `name` + `notes` |
| `timeline` | array | 5-25 | `stage` + `info` |
| `salary` | array | 5-30 | 写清岗位/学历/城市口径，数字标「（存疑）」 |
| `tips` | array | 10-60 | 可执行的准备建议 |
| `pitfalls` | array | 5-45 | 真实踩坑/失败原因 |
| `takeaways` | array | 3-6 | 首屏 4 张卡；`t` 短标题、`d` 一句话解释 |
| `checklist` | string[] | 6-12 | 可勾选的准备清单 |
| `appendix` | string[] | 3-8 | 过滤/未采用说明、数据口径补充 |
| `salaryNote` | string | 40-150 字 | 薪资口径免责说明 |
| `filteredNotes` | int[] | — | 过滤掉的无关笔记序号 |
| `emptyNotes` | int[] | — | 空帖/无实质内容笔记序号 |
| 所有 `source` | int[] | ≤6 | 必须是 `notes.json` 合法下标 |

硬规则：
- 忠于原文，**不脑补通用面经**；原文没说就不写。
- 同一问题只保留一条（合并来源）；重复问题会被校验器 warn。
- 不确定的数字/流程标「（存疑）」，冲突信息并列或注明来源差异。
- 只写中文；除非是英文原题（可保留英文问法）。

## 3. 抽取子代理 prompt 模板

```text
你在协助整理「{公司} {城市} {岗位}面经」数据，用于做面试准备报告。只做内容抽取和结构化，不改动其他文件。

输入：<workdir>/data/digest-<NN>.md（第 <k>/<M> 块）。格式：每条笔记以 `## [序号] 标题` 开头，
随后是作者/发布/IP/赞评藏、命中检索、标签、正文、评论（`-` 一级，`↳` 楼中楼）。
序号 = notes.json 下标，source 里只能引用这些序号。

输出：<workdir>/.work/extract-<NN>.json，只包含本块能支撑的部分：
{"process":[…],"questions":[…],"positions":[…],"timeline":[…],"salary":[…],"tips":[…],"pitfalls":[…],
 "overviewNotes":"本块可支撑总览的要点（≤200字）","filteredNotes":[…],"emptyNotes":[…],"conflicts":[…]}

要求：
- 全部中文，忠于原文，不要编造；原文没提到的不写，不确定标「（存疑）」。
- 每条必须带 source（digest 序号数组，≤6 个）。
- 同一问题合并去重；记录与正文/既有结论冲突之处（conflicts）。
- 无关帖、空帖、广告/题库引流帖分别记 filteredNotes / emptyNotes；图片面经单独列出需人工看。
- 不要修改 content.json，不要动 data/ 下其他文件。

完成后回复：本块来源笔记数、要点数、过滤数、需要人工确认的 3-5 条。
```

主 agent 收齐片段后合并写 `content.json`（可用一次性 Python 脚本拼装 + 统计，保证可复现），再跑：

```bash
python3 "<skill>/scripts/validate_content.py" --dir "<workdir>" --strict
```

## 4. 过滤、去重、存疑口径

| 情况 | 处理 | 落点 |
| --- | --- | --- |
| 其他公司/其他岗位面经 | 不进 content | `filteredNotes` + `appendix` |
| 空帖/仅话题/一句话提问 | 不进 content | `emptyNotes` + `appendix` |
| 广告/内推/入职日记/卖题库引流帖 | 不当作亲历面经；有价值原句可标存疑引用 | `appendix` |
| 只有题量没有题目的资料帖 | 不引用或仅作补充 | `appendix` |
| 行业通用面试问题 | 可作补充框架，标来源 | 对应 category |
| 纯图帖（正文为空） | 标"见配图，需人工"；必要时 read_image 看 1-2 张 | `appendix` |
| 冲突信息（轮次命名/offer 机制/英文是否必考） | 并列呈现或注明口径差异，**不要静默覆盖** | 相关条目 + `appendix` |
| 数字/流程不确定 | 标「（存疑）」；薪资单列 `salaryNote` | 原文条目 |

## 5. 增量更新（delta 模板）

面经是动态语料：新帖会推翻旧结论（轮次命名、offer 机制、英文是否必考都出现过修正）。增量流程：

1. 新笔记导出 `.work/new_notes_batchN.md`（每条带 **24 位 note id**，不是序号）；
2. 子代理读旧 `content.json` + 上一批 `delta_batch{N-1}.md` 作基线，写 `delta_batchN.md`；
3. 主 agent 合并，冲突显式记录，重新 validate/digest/render。

`delta_batchN.md` 固定分节（合并脚本/人都按此读）：

```markdown
## process
## questions
## positions
## timeline
## salary
## tips
## pitfalls
## english
## overview_update
## irrelevant
## duplicate
```

增量 prompt 关键句：

```text
你是「{公司}{城市}面经整理」项目的分析员。项目目录：<workdir>
背景：已有基于 {N} 篇笔记的 content.json / 面试摘要.md / notes.json；
上一轮增量分析在 .work/delta_batch{N-1}.md（先读作基线）。
本批 {M} 篇新笔记：.work/new_notes_batch{N}.md（每条标题行是 24 位 note id）。

只读 + 只写 .work/delta_batch{N}.md，分节对应 content.json 的 key：
## process / ## questions / ## positions / ## timeline / ## salary / ## tips / ## pitfalls /
## english / ## overview_update / ## irrelevant / ## duplicate

硬性要求：
- 忠于原文，不脑补；不确定标「（存疑）」；每条带 24 位 note id。
- 区分届别/批次（如 27 届秋招 / 春招 / 社招 / 往届）。
- 与旧内容或上一批 delta 冲突处必须显式写出（不要静默覆盖）。
- 图片面经（正文只有图）单独列出，标注需人工看图。
完成后回复 ≤300 字：最有价值 5-10 条增量、广告/无关清单、需要更正的旧结论。
```

## 6. 质量门槛（交付前逐条过）

- `json.loads` 通过；键名与 schema 完全一致。
- 各数组条数在建议区间内（`validate_content.py --strict` 无 warning）。
- 所有 `source` 是合法整数下标；来源引用覆盖率（distinct sources / noteCount）≥50%，抽取后剩余无关帖有记录。
- 重复问题 0；问题分类合理（每类 ≥2 题，避免"其他"桶过大）。
- `takeaways` 3-6 条且能概括最有价值的结论；`checklist` 6-12 条可勾选。
- `overview` 与各区块不互相矛盾；数字口径一致。
- `filteredNotes` / `emptyNotes` 与 `appendix` 对得上。
- 增量的冲突项已写进 `appendix` 或修正说明。
