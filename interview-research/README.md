# interview-research · 面经调研 → 面试准备页

DSH Skill：调研某公司/岗位的面经（小红书采集 + 网络检索），整理成结构化内容，生成**单文件离线 HTML 面试准备手册**与 Markdown 摘要。

本目录就是 skill 本体。DSH 从文件系统 skill 根目录发现它（`~/.dsh/skills/interview-research/` 或项目 `.dsh/skills/`），入口是 [SKILL.md](SKILL.md)。

## 一条命令安装

从本仓库安装 skill + 依赖插件（`dsh-inner-chrome`、`dsh-xhs-check`）：

```sh
curl -fsSL https://raw.githubusercontent.com/SoMiReMiReDo/dsh-dev/dev/interview-research/install.sh | bash
```

本地仓库内直接跑：

```sh
bash install.sh --profile desktop        # 安装/升级 skill + 插件
bash install.sh --check                  # 只检查安装状态
bash install.sh --dry-run                # 只打印将执行的命令
bash install.sh --uninstall              # 卸载 skill（插件需按提示手动移除）
```

可用环境变量覆盖：`DSH_HOME`、`DSH_PROFILE`、`DSH_CLI`、`DSH_SKILLS_DIR`、`DSH_DEV_REPO`、`DSH_DEV_REF`、`DSH_DEV_DIR`。安装完重启 DSH，新开会话即可在 skill 列表看到 `interview-research`。

## 使用

安装后对 Agent 说：

> 用 interview-research 调研「<公司> <岗位>」的面经，整理成结构化内容并生成 report.html

Agent 会按 SKILL.md 的流水线执行：立项 → 多关键词检索 → 逐篇采集 → 聚合/图片本地化 → 结构化抽取 → 生成 `report.html` + `面试摘要.md` → 验收。

## 结构与数据契约

```text
interview-research/
  SKILL.md                     入口：触发条件、流水线、硬规则
  references/
    pipeline.md                全流程操作手册（含增量更新、验收清单）
    xhs-collection.md          xhs-check 参数、关键词矩阵、风控与失败处理
    content-extraction.md      content.json schema、抽取 prompt、质量门槛
    html-report.md             页面设计规范、模板数据契约、主题与验收
    troubleshooting.md         常见报错与排查
  scripts/                     仅 Python 3.9+ 标准库，无第三方依赖
    init_project.py            初始化项目骨架（project.json/content.json/data/）
    build_dataset.py           xhs-check data → notes.json/meta.json/digest/images
    validate_content.py        content.json 结构与质量校验
    digest.py                  content.json → 面试摘要.md
    render_report.py           模板 + 数据 → report.html
  assets/
    report.template.html       单文件离线模板（浅色默认 + 夜间可选 + 打印浅色）
    project.example.json       项目配置示例
    content.example.json       内容结构示例
  test/
    test_pipeline.py           离线端到端自测（fixtures 假数据）
    fixtures/                  测试数据（不含任何真实用户数据）
```

项目目录约定（由 `init_project.py` 生成）：

```text
<workdir>/
  project.json     课题配置（公司/城市/岗位/关键词/主题色/标签规则）
  content.json     唯一内容源（抽取产物）
  data/            聚合产物：notes.json/meta.json/digest-*.md/images/
  report.html      主交付物（生成物）
  面试摘要.md       纯文本摘要（生成物）
  README.md        重新生成命令
```

## 自测

```sh
python3 -m unittest discover -s test -v
```

离线、仅标准库，覆盖：init → build（含序号稳定性/追加）→ validate → digest → render 全链路。

## 依赖与边界

- **采集**：`dsh-xhs-check` 插件 + 已登录的小红书内置浏览器；插件版本闸门见 `xhs-check/package.json`（DSH >=0.2.1-rc.5 <0.3.0）。
- **HTML**：模板零外部依赖（无 CDN/字体/脚本），图片本地化，`file://` 双击可开。
- **隐私**：采集数据（笔记/评论/图片）是用户本地数据，不随 skill 分发；不要采集私信、他人账号资料；只使用用户有权访问和保存的内容。
- **不承诺穷举**：多关键词扩展 ≠ 全站穷举；`meta.missing`、风控导致的评论缺失、图片 CDN 过期都会如实写进报告口径。
