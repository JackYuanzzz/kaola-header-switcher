#!/bin/sh
# Update an unpacked installation in place without touching Chrome's stored rules.
set -eu

usage() {
    printf '%s\n' '用法：' \
        '  sh update.sh [--install-dir 旧安装目录] --archive 本地ZIP --sha256 SHA256 [--dry-run]' \
        '  sh update.sh [--install-dir 旧安装目录] --version x.y.z --sha256 SHA256 [--dry-run]' >&2
    exit 2
}

fail() { printf '更新失败：%s\n' "$1" >&2; exit 1; }

install_input=''
archive_input=''
release_version=''
expected_sha=''
dry_run=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --install-dir|--archive|--version|--sha256)
            [ "$#" -ge 2 ] || usage
            case "$1" in
                --install-dir) install_input=$2 ;;
                --archive) archive_input=$2 ;;
                --version) release_version=$2 ;;
                --sha256) expected_sha=$2 ;;
            esac
            shift 2 ;;
        --dry-run) dry_run=1; shift ;;
        *) usage ;;
    esac
done

[ -n "$expected_sha" ] || usage
[ -n "$archive_input" ] && [ -n "$release_version" ] && usage
[ -n "$archive_input" ] || [ -n "$release_version" ] || usage
if [ -z "$install_input" ]; then
    script_dir=$(cd "$(dirname "$0")" && pwd -P)
    [ -f "$script_dir/manifest.json" ] || usage
    install_input=$script_dir
fi
case "$expected_sha" in *[!0-9a-fA-F]*|'') fail 'SHA-256 格式无效。' ;; esac
[ "${#expected_sha}" -eq 64 ] || fail 'SHA-256 应为 64 位十六进制。'
case "$install_input" in /*) ;; *) fail '安装目录必须使用绝对路径。' ;; esac
[ ! -L "$install_input" ] || fail '安装目录是符号链接，未覆盖。'
[ -d "$install_input" ] || fail '原安装目录不存在，未创建新扩展。'
install_dir=$(cd "$install_input" && pwd -P)
[ "$install_dir" != / ] && [ "$install_dir" != "$HOME" ] || fail '拒绝将根目录或用户主目录作为安装目标。'
[ -f "$install_dir/manifest.json" ] && [ ! -L "$install_dir/manifest.json" ] || fail '原目录缺少普通 manifest.json 文件。'
grep -Eq '"name"[[:space:]]*:[[:space:]]*"有问题找kaola"' "$install_dir/manifest.json" || fail '原目录不是「有问题找kaola」扩展。'
old_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$install_dir/manifest.json" | head -n 1)
[ -n "$old_version" ] || fail '无法读取原扩展版本。'

if [ -n "$release_version" ]; then
    printf '%s\n' "$release_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail '目标版本格式无效。'
else
    [ -f "$archive_input" ] || fail '找不到本地 ZIP。'
fi
for dependency in mktemp unzip zipinfo cmp sort grep sed awk mv; do
    command -v "$dependency" >/dev/null 2>&1 || fail "缺少命令：$dependency"
done
if command -v shasum >/dev/null 2>&1; then
    checksum_command=shasum
elif command -v sha256sum >/dev/null 2>&1; then
    checksum_command=sha256sum
else
    fail '缺少 shasum 或 sha256sum。'
fi
if [ -n "$release_version" ]; then
    command -v curl >/dev/null 2>&1 || fail '缺少 curl。'
fi

parent_dir=${install_dir%/*}
work=$(mktemp -d "$parent_dir/.kaola-update.XXXXXXXX") || fail '无法在安装目录旁创建暂存目录。'
backup_dir="$work/previous-$old_version"
moved=0
cleanup() {
    if [ "$moved" -eq 1 ] && [ ! -e "$install_dir" ] && [ -d "$backup_dir" ]; then
        mv "$backup_dir" "$install_dir" || printf '自动恢复失败，旧文件保留在：%s\n' "$backup_dir" >&2
    fi
    if [ "$moved" -ne 2 ] && [ ! -d "$backup_dir" ]; then
        rm -rf "$work"
    fi
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM

archive="$work/extension.zip"
if [ -n "$archive_input" ]; then
    cp "$archive_input" "$archive" || fail '无法复制本地 ZIP。'
else
    url="https://github.com/JackYuanzzz/kaola-header-switcher/releases/download/v$release_version/kaola-header-switcher-$release_version.zip"
    curl --fail --location --silent --show-error \
        --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 \
        --output "$archive" "$url" || fail '下载失败，原安装未更改。'
fi
if [ "$checksum_command" = shasum ]; then
    printf '%s  %s\n' "$expected_sha" "$archive" | shasum -a 256 -c - >/dev/null || fail 'SHA-256 不匹配，原安装未更改。'
else
    printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c - >/dev/null || fail 'SHA-256 不匹配，原安装未更改。'
fi
unzip -tq "$archive" >/dev/null || fail 'ZIP 完整性检查失败。'

# Only known files can be extracted, rejecting paths outside the extension root.
printf '%s\n' \
    manifest.json background.js popup.js content.js popup.html popup.css LICENSES.txt \
    icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png \
    | LC_ALL=C sort > "$work/expected-files"
zipinfo -1 "$archive" | LC_ALL=C sort > "$work/archive-files"
if ! cmp -s "$work/expected-files" "$work/archive-files"; then
    printf '%s\n' update.sh | LC_ALL=C sort >> "$work/expected-files"
    LC_ALL=C sort "$work/expected-files" -o "$work/expected-files"
    cmp -s "$work/expected-files" "$work/archive-files" || fail 'ZIP 文件清单不符合预期，原安装未更改。'
fi

stage="$work/staged"
mkdir "$stage"
unzip -nq "$archive" -d "$stage" || fail '解压失败，原安装未更改。'
[ ! -L "$stage/manifest.json" ] && [ -f "$stage/manifest.json" ] || fail '新包的 manifest.json 无效。'
grep -Eq '"name"[[:space:]]*:[[:space:]]*"有问题找kaola"' "$stage/manifest.json" || fail '新包不是「有问题找kaola」扩展。'
new_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$stage/manifest.json" | head -n 1)
[ -n "$new_version" ] || fail '无法读取新扩展版本。'
[ -z "$release_version" ] || [ "$new_version" = "$release_version" ] || fail 'ZIP 中的版本与指定版本不一致。'
awk -F. -v old="$old_version" -v new="$new_version" 'BEGIN {
    split(old, a, "."); split(new, b, ".");
    for (i = 1; i <= 3; i++) {
        if (b[i] + 0 > a[i] + 0) exit 0;
        if (b[i] + 0 < a[i] + 0) exit 1;
    }
    exit 1;
}' || fail "新包版本 $new_version 不高于已安装的 $old_version。"
printf '已校验：%s → %s\n安装目录：%s\n' "$old_version" "$new_version" "$install_dir"
if [ "$dry_run" -eq 1 ]; then
    printf '预检完成；未修改原安装。\n'
    exit 0
fi

chmod -R go-rwx "$stage"
mv "$install_dir" "$backup_dir" || fail '无法备份原安装，未替换。'
moved=1
mv "$stage" "$install_dir" || fail '无法放入新文件，将尝试恢复原安装。'
moved=2
rm -f "$archive" "$work/expected-files" "$work/archive-files"
printf '更新文件完成。旧文件备份：%s\n' "$backup_dir"
printf '请在 chrome://extensions 对原扩展点击「重新加载」；本次重载会清除各标签页的会话绑定，但本地规则保留。\n'
