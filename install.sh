#!/usr/bin/env bash
# Watch Box — 설치 / 업데이트 스크립트 (macOS, Linux). 네트워크 사용 없음.
#
#   릴리즈 페이지에서 watch-box-X.Y.Z.zip 과 이 파일을 같은 폴더(예: 다운로드)에 받은 뒤:
#     bash install.sh                      # 설치 폴더를 물어봄 (기본 ~/Applications/watch-box)
#     bash install.sh <설치 폴더> [zip 경로]  # 묻지 않고 진행
#
#   대상 폴더에 manifest.json 이 있으면 업데이트(덮어쓰기), 없으면 새로 설치.
set -euo pipefail

say() { printf '\033[1;33m[watch-box]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[watch-box] 오류:\033[0m %s\n' "$*" >&2; exit 1; }
command -v unzip >/dev/null || die "unzip 이 필요합니다."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_TARGET="$HOME/Applications/watch-box"

# ---- zip 찾기: 인자 → 스크립트 폴더 → 현재 폴더 → ~/Downloads (버전이 가장 높은 것) ----
# 브라우저가 같은 파일을 다시 받을 때 붙이는 " (1)" 꼬리표도 허용한다
ZIP_RE='watch-box-([0-9.]+)( \([0-9]+\))?\.zip$'
ZIP="${2:-}"
if [[ -z "$ZIP" ]]; then
  for d in "$SCRIPT_DIR" "$PWD" "$HOME/Downloads"; do
    cand="$(ls "$d"/watch-box-*.zip 2>/dev/null | grep -E "/$ZIP_RE" | sort -V | tail -1 || true)"
    [[ -n "$cand" ]] && { ZIP="$cand"; break; }
  done
fi
[[ -n "$ZIP" && -f "$ZIP" ]] || die "watch-box-X.Y.Z.zip 을 찾지 못했습니다. 릴리즈에서 zip 을 받아 이 스크립트와 같은 폴더에 두세요."
NEW_VER="$(basename "$ZIP" | sed -nE "s/^$ZIP_RE/\1/p")"
[[ -n "$NEW_VER" ]] || die "zip 이름이 watch-box-X.Y.Z.zip 형식이 아닙니다: $(basename "$ZIP")"

# ---- 대상 폴더: 인자 → 스크립트 폴더/현재 폴더에 manifest 있으면 그곳 → 질문(기본값) ----
if [[ $# -ge 1 ]]; then TARGET="$1"
elif [[ -f "$SCRIPT_DIR/manifest.json" ]]; then TARGET="$SCRIPT_DIR"
elif [[ -f "$PWD/manifest.json" ]]; then TARGET="$PWD"
elif [[ -t 0 ]]; then
  hint="$([[ -f "$DEFAULT_TARGET/manifest.json" ]] && echo " (기존 설치 발견 → 업데이트)" || echo "")"
  read -r -p "설치/업데이트할 폴더 [$DEFAULT_TARGET]$hint: " input || true
  TARGET="${input:-$DEFAULT_TARGET}"
else TARGET="$DEFAULT_TARGET"; fi
TARGET="${TARGET/#\~/$HOME}"

MODE="install"; CUR_VER=""
if [[ -f "$TARGET/manifest.json" ]]; then
  MODE="update"; CUR_VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TARGET/manifest.json" | head -1)"
  [[ "$CUR_VER" == "$NEW_VER" ]] && say "같은 버전($NEW_VER)이지만 파일을 다시 덮어씁니다."
fi
say "$([[ $MODE == update ]] && echo "업데이트 $CUR_VER → $NEW_VER" || echo "새로 설치 $NEW_VER") → $TARGET"

# ---- 풀기 & 덮어쓰기 ----
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
unzip -q "$ZIP" -d "$TMP"
SRC="$(find "$TMP" -maxdepth 2 -name manifest.json -exec dirname {} \; | head -1)"
[[ -n "$SRC" ]] || die "zip 안에서 manifest.json 을 찾지 못했습니다."
mkdir -p "$TARGET"
for d in icons _locales; do rm -rf "${TARGET:?}/$d"; done   # 통째로 교체. _locales 는 1.1.0 에만 있던 폴더 — 남으면 로드 오류
cp -R "$SRC"/. "$TARGET"/
say "완료: $TARGET (버전 $NEW_VER)"

# ---- 안내 ----
if [[ $MODE == update ]]; then
  say "Chrome 에서 chrome://extensions 를 열고 'Watch Box' 카드의 새로고침(↻)을 누르세요. 저장 데이터는 유지됩니다."
else
  say "Chrome 에서 chrome://extensions → 개발자 모드 켜기 → '압축해제된 확장 프로그램을 로드합니다' → 이 폴더 선택:"
  say "  $TARGET"
fi
if [[ "$(uname)" == "Darwin" && -t 0 ]]; then
  read -r -p "지금 chrome://extensions 를 열까요? [y/N] " yn || true
  [[ "${yn:-}" =~ ^[Yy]$ ]] && open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
fi
