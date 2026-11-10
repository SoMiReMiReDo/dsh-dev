#!/usr/bin/env bash
# interview-research 一键安装：skill + dsh-xhs-check / dsh-inner-chrome 插件
#
# 用法（在仓库内）：
#   bash install.sh                     # 安装到默认 desktop profile
#   bash install.sh --profile web
#   bash install.sh --dry-run           # 只打印将要执行的命令
#   bash install.sh --check             # 只检查安装状态
#   bash install.sh --uninstall         # 卸载 skill（插件需按提示手动移除）
#
# 用法（远程一条命令，从 GitHub 拉取本仓库）：
#   curl -fsSL https://raw.githubusercontent.com/SoMiReMiReDo/dsh-dev/dev/interview-research/install.sh | bash
#
# 环境变量覆盖：
#   DSH_HOME        默认 ~/.dsh
#   DSH_PROFILE     默认 desktop（可选 web 等）
#   DSH_CLI         dsh CLI 绝对路径（默认自动探测）
#   DSH_SKILLS_DIR  默认 $DSH_HOME/skills
#   DSH_DEV_REPO    默认 https://github.com/SoMiReMiReDo/dsh-dev.git
#   DSH_DEV_REF     默认 dev/interview-research
#   DSH_DEV_DIR     默认 $DSH_HOME/plugins/dsh-dev（远程安装时的本地仓库缓存）

set -euo pipefail

SKILL_NAME="interview-research"
PLUGINS=("inner-chrome" "xhs-check")   # 顺序有意义：xhs-check 依赖 inner-chrome 的浏览器服务
REPO_URL="${DSH_DEV_REPO:-https://github.com/SoMiReMiReDo/dsh-dev.git}"
REF="${DSH_DEV_REF:-dev/interview-research}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SKILLS_DIR="${DSH_SKILLS_DIR:-$DSH_HOME_DIR/skills}"
PROFILE="${DSH_PROFILE:-desktop}"
CACHE_DIR="${DSH_DEV_DIR:-$DSH_HOME_DIR/plugins/dsh-dev}"
DSH_CLI="${DSH_CLI:-}"

MODE="install"
DRY_RUN=0
FORCE=0
REPO_DIR=""
SKILL_DST="$SKILLS_DIR/$SKILL_NAME"

usage() {
  cat <<'USAGE'
interview-research 一键安装：skill + dsh-inner-chrome + dsh-xhs-check 插件

用法：
  bash install.sh                     # 安装到默认 desktop profile
  bash install.sh --profile web       # 指定 profile
  bash install.sh --repo <仓库目录>    # 用本地仓库（否则从 GitHub 克隆/用缓存）
  bash install.sh --skill-dir <目录>   # skill 安装目录（默认 $DSH_HOME/skills）
  bash install.sh --dry-run           # 只打印将执行的命令
  bash install.sh --check             # 只检查安装状态（全装好返回 0）
  bash install.sh --uninstall         # 卸载 skill（插件需按提示手动移除）
  bash install.sh --force             # 覆盖非本安装器创建的同名 skill 目录
  bash install.sh --help

远端一条命令：
  curl -fsSL https://raw.githubusercontent.com/SoMiReMiReDo/dsh-dev/dev/interview-research/install.sh | bash

环境变量：DSH_HOME / DSH_PROFILE / DSH_CLI / DSH_SKILLS_DIR / DSH_DEV_REPO / DSH_DEV_REF / DSH_DEV_DIR
USAGE
}

log() { printf '[install] %s\n' "$*"; }
warn() { printf '[install] 警告：%s\n' "$*" >&2; }
die() { printf '[install] 错误：%s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile 需要参数}"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --repo) REPO_DIR="${2:?--repo 需要参数}"; shift 2 ;;
    --repo=*) REPO_DIR="${1#*=}"; shift ;;
    --skill-dir) SKILLS_DIR="${2:?--skill-dir 需要参数}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --check) MODE="check"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done
SKILL_DST="$SKILLS_DIR/$SKILL_NAME"

# ---------- 1. 定位仓库 ----------
find_script_dir() {
  local src="${BASH_SOURCE[0]:-}"
  [ -n "$src" ] && [ -f "$src" ] || return 1
  local dir
  dir="$(cd "$(dirname "$src")" >/dev/null 2>&1 && pwd -P)" || return 1
  printf '%s\n' "$dir"
}

is_repo_root() {
  [ -f "$1/interview-research/SKILL.md" ] && [ -d "$1/xhs-check" ] && [ -d "$1/inner-chrome" ]
}

resolve_repo() {
  if [ -n "$REPO_DIR" ]; then
    REPO_DIR="$(cd "$REPO_DIR" >/dev/null 2>&1 && pwd -P)" || die "--repo 目录不存在"
    is_repo_root "$REPO_DIR" || die "--repo 指向的目录不是 dsh-dev 仓库根：$REPO_DIR"
    return 0
  fi
  local script_dir
  if script_dir="$(find_script_dir)" && is_repo_root "$script_dir"; then
    REPO_DIR="$script_dir"
    log "使用当前仓库：$REPO_DIR"
    return 0
  fi
  # 管道执行（curl | bash）：用本地缓存或克隆
  if is_repo_root "$CACHE_DIR"; then
    REPO_DIR="$CACHE_DIR"
    log "使用本地仓库缓存：$REPO_DIR"
    if [ -d "$CACHE_DIR/.git" ] && [ -f "$CACHE_DIR/.install-cache" ]; then
      if [ "$DRY_RUN" -eq 0 ] && [ "$MODE" = "install" ]; then
        log "更新仓库缓存到 origin/$REF ..."
        git -C "$CACHE_DIR" fetch --depth 1 origin "$REF" >/dev/null 2>&1 || warn "git fetch 失败，沿用现有缓存"
        git -C "$CACHE_DIR" checkout -q -f FETCH_HEAD 2>/dev/null || true
      fi
    fi
    return 0
  fi
  if [ -e "$CACHE_DIR" ]; then
    die "$CACHE_DIR 已存在但不是可识别的 dsh-dev 仓库缓存；用 --repo 指定本地仓库，或先手动删除该目录。"
  fi
  command -v git >/dev/null 2>&1 || die "未找到 git，无法从 GitHub 安装；请改用本地仓库并传 --repo。"
  log "克隆 ${REPO_URL}（${REF}）→ $CACHE_DIR"
  if [ "$DRY_RUN" -eq 1 ]; then
    REPO_DIR="$CACHE_DIR"
    return 0
  fi
  mkdir -p "$(dirname "$CACHE_DIR")"
  if ! git clone --depth 1 --branch "$REF" "$REPO_URL" "$CACHE_DIR"; then
    die "克隆失败：${REPO_URL}（分支 ${REF}）。检查网络、分支是否存在、或改用 --repo 指定本地仓库。"
  fi
  printf 'source=%s\nref=%s\ninstalledAt=%s\n' "$REPO_URL" "$REF" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CACHE_DIR/.install-cache"
  REPO_DIR="$CACHE_DIR"
  is_repo_root "$REPO_DIR" || die "克隆完成但仓库结构不符合预期：$REPO_DIR"
}

resolve_repo_soft() {
  local script_dir
  if [ -n "$REPO_DIR" ] && is_repo_root "$REPO_DIR"; then
    REPO_DIR="$(cd "$REPO_DIR" >/dev/null 2>&1 && pwd -P)"
    return 0
  fi
  if script_dir="$(find_script_dir)" && is_repo_root "$script_dir"; then
    REPO_DIR="$script_dir"
    return 0
  fi
  if is_repo_root "$CACHE_DIR"; then
    REPO_DIR="$CACHE_DIR"
    return 0
  fi
  return 1
}

# ---------- 2. 定位 dsh CLI 与 profile ----------
find_dsh_cli() {
  if [ -n "$DSH_CLI" ]; then
    [ -x "$DSH_CLI" ] || die "DSH_CLI 不可执行：$DSH_CLI"
    printf '%s\n' "$DSH_CLI"
    return 0
  fi
  local candidate
  candidate="$(command -v dsh 2>/dev/null || true)"
  if [ -n "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  for candidate in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh"; do
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

profile_manifest() { printf '%s/profiles/%s/package.json\n' "$DSH_HOME_DIR" "$PROFILE"; }

plugin_installed() { # $1 = package name
  local manifest; manifest="$(profile_manifest)"
  [ -f "$manifest" ] || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$manifest" "$1" <<'PY'
import json, sys
manifest, name = sys.argv[1], sys.argv[2]
try:
    doc = json.load(open(manifest, encoding="utf-8"))
except Exception:
    sys.exit(1)
deps = doc.get("dependencies") or {}
bundles = ((doc.get("dsh") or {}).get("profile") or {}).get("bundles") or []
sys.exit(0 if (name in deps and name in bundles) else 1)
PY
  else
    # 没有 python3 时无法可靠区分 deps 与 bundles：按“未安装”处理，让 CLI 幂等重装；
    # 只有明确同时出现在依赖与 bundles 列表里才算已安装（grep 近似判断）。
    if grep -q "\"$1\"" "$manifest" && grep -q "dsh-$1" "$manifest"; then
      return 1
    fi
    return 1
  fi
}

show_status() {
  local cli manifest
  manifest="$(profile_manifest)"
  log "DSH_HOME: $DSH_HOME_DIR"
  log "profile:  $PROFILE"
  [ -f "$manifest" ] && log "profile 已初始化：$manifest" || warn "profile 未初始化：${manifest}（先打开一次 DSH Desktop）"
  cli="$(find_dsh_cli || true)"
  if [ -n "$cli" ]; then log "dsh CLI:  $cli"; else warn "未找到 dsh CLI（可用 DSH_CLI=/path/to/dsh 指定）"; fi
  if [ -f "$SKILL_DST/SKILL.md" ]; then
    log "skill:    已安装 $SKILL_DST"
  else
    log "skill:    未安装（目标 ${SKILL_DST}）"
  fi
  local miss=0
  for p in "${PLUGINS[@]}"; do
    if plugin_installed "dsh-$p"; then
      log "插件:     dsh-$p 已安装"
    else
      log "插件:     dsh-$p 未安装"
      miss=1
    fi
  done
  [ -f "$SKILL_DST/SKILL.md" ] && [ "$miss" -eq 0 ] && [ -n "$cli" ]
}

# ---------- 3. 安装 / 卸载 ----------
install_skill() {
  local src="$REPO_DIR/$SKILL_NAME"
  if [ "$DRY_RUN" -eq 1 ] && [ ! -f "$src/SKILL.md" ]; then
    log "  [dry-run] 将先克隆 ${REPO_URL}（${REF}）→ ${REPO_DIR}"
    log "  [dry-run] mkdir -p ${SKILL_DST} && cp -R ${src}/. ${SKILL_DST}/"
    return 0
  fi
  [ -f "$src/SKILL.md" ] || die "仓库里找不到 skill：$src"
  if [ -d "$SKILL_DST" ] && [ ! -f "$SKILL_DST/.install-source" ] && [ "$FORCE" -ne 1 ]; then
    die "$SKILL_DST 已存在且不是本安装器装的（无 .install-source）。确认要覆盖请加 --force。"
  fi
  log "安装 skill → $SKILL_DST"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] rm -rf $SKILL_DST && mkdir -p $SKILL_DST && cp -R $src/. $SKILL_DST/"
    return 0
  fi
  rm -rf "$SKILL_DST"
  mkdir -p "$SKILL_DST"
  if command -v tar >/dev/null 2>&1; then
    (cd "$src" && tar cf - --exclude '__pycache__' --exclude '*.pyc' .) | (cd "$SKILL_DST" && tar xf -)
  else
    cp -R "$src/." "$SKILL_DST/"
    find "$SKILL_DST" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  fi
  printf 'source=%s\nref=%s\ninstalledAt=%s\n' "$REPO_URL" "$REF" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$SKILL_DST/.install-source"
  [ -f "$SKILL_DST/SKILL.md" ] || die "skill 安装后缺少 SKILL.md"
  log "skill 已安装（含 scripts/assets/references，重新运行本脚本即可升级）"
}

install_plugins() {
  local cli manifest missing=()
  manifest="$(profile_manifest)"
  if [ ! -f "$manifest" ]; then
    die "profile 未初始化：${manifest}。先打开一次 DSH Desktop（或对应 profile 的 DSH）再重试。"
  fi
  cli="$(find_dsh_cli || true)"
  if [ -z "$cli" ]; then
    die "未找到 dsh CLI。macOS 默认在 /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh；也可 export DSH_CLI=/path/to/dsh。只装 skill 可用 --check 查看状态后手动复制。"
  fi
  for p in "${PLUGINS[@]}"; do
    plugin_installed "dsh-$p" || missing+=("$p")
  done
  if [ ${#missing[@]} -eq 0 ]; then
    log "插件已安装：${PLUGINS[*]}（跳过）"
    return 0
  fi
  for p in "${missing[@]}"; do
    log "安装插件 dsh-$p ← link:$REPO_DIR/$p"
    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [dry-run] \"$cli\" plugin --profile \"$PROFILE\" add \"link:$REPO_DIR/$p\""
      continue
    fi
    local out rc=0
    out="$("$cli" plugin --profile "$PROFILE" add "link:$REPO_DIR/$p" 2>&1)" || rc=$?
    printf '%s\n' "$out"
    if [ "$rc" -ne 0 ]; then
      if printf '%s' "$out" | grep -q "installation rejected"; then
        die "插件 dsh-$p 被 DSH 版本闸门拒绝（引擎版本不匹配）。按上面提示运行 allow-version 后重试；不建议在非受控环境放宽版本限制。"
      fi
      die "插件 dsh-$p 安装失败（exit ${rc}）。若提示 profile 被占用/文件锁，请完全退出 DeepSeek Harness Desktop 后重跑本脚本；完整日志见 profile 下 .plugin-manager/logs/。"
    fi
    plugin_installed "dsh-$p" || warn "dsh-$p 安装后未出现在 profile bundles 中，请检查 $manifest"
  done
  if [ "$DRY_RUN" -eq 0 ]; then
    log "插件安装完成；插件代码是 link 引用，缓存目录 $REPO_DIR 不要删除。"
  fi
}

uninstall_all() {
  if [ -d "$SKILL_DST" ]; then
    if [ -f "$SKILL_DST/.install-source" ] || [ "$FORCE" -eq 1 ]; then
      log "删除 skill：$SKILL_DST"
      [ "$DRY_RUN" -eq 1 ] || rm -rf "$SKILL_DST"
    else
      warn "$SKILL_DST 不是本安装器装的，跳过（--force 强制删除）"
    fi
  else
    log "skill 未安装，跳过"
  fi
  log "插件不自动卸载。如需移除，执行："
  log "  \"${DSH_CLI:-dsh}\" plugin --profile $PROFILE remove ${PLUGINS[*]/#/dsh-}"
}

# ---------- 主流程 ----------
case "$MODE" in
  check)
    resolve_repo_soft 2>/dev/null || true
    if show_status; then
      exit 0
    else
      exit 1
    fi
    ;;
  uninstall)
    uninstall_all
    exit 0
    ;;
  install)
    resolve_repo
    install_skill
    install_plugins
    echo
    log "完成。接下来："
    log "  1) 重启 DeepSeek Harness Desktop（插件 package.json / cordis.patch.yml 改动需重启；仅 client 改动刷新页面即可）"
    log "  2) 新开一个会话，skill 列表里应出现 $SKILL_NAME"
    log "  3) 设置 → 小红书采集 → 打开浏览器并登录（首次），然后对 Agent 说："
    log "     「用 interview-research 调研 <公司> <岗位> 的面经，整理成结构化内容并生成 report.html」"
    log "  4) 校验安装：bash install.sh --check"
    ;;
esac
