# Watch Box — 설치 / 업데이트 스크립트 (Windows PowerShell). 네트워크 사용 없음.
#
#   릴리즈 페이지에서 watch-box-X.Y.Z.zip 과 이 파일을 같은 폴더(예: 다운로드)에 받은 뒤:
#     powershell -ExecutionPolicy Bypass -File install.ps1                      # 설치 폴더를 물어봄 (기본 %LOCALAPPDATA%\watch-box)
#     powershell -ExecutionPolicy Bypass -File install.ps1 -Target <폴더> [-Zip <zip>]
#
#   대상 폴더에 manifest.json 이 있으면 업데이트(덮어쓰기), 없으면 새로 설치.
param([string]$Target = "", [string]$Zip = "")
$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "[watch-box] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[watch-box] 오류: $m" -ForegroundColor Red; exit 1 }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DefaultTarget = Join-Path $env:LOCALAPPDATA "watch-box"
# 브라우저가 같은 파일을 다시 받을 때 붙이는 " (1)" 꼬리표도 허용한다
$ZipRe = '^watch-box-([0-9.]+)( \(\d+\))?\.zip$'

# ---- zip 찾기: 인자 → 스크립트 폴더 → 현재 폴더 → 다운로드 (버전이 가장 높은 것) ----
if (-not $Zip) {
  foreach ($d in @($ScriptDir, (Get-Location).Path, (Join-Path $env:USERPROFILE "Downloads"))) {
    $c = Get-ChildItem -Path $d -Filter "watch-box-*.zip" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match $ZipRe } |
      Sort-Object { [version]($_.Name -replace $ZipRe, '$1') } | Select-Object -Last 1
    if ($c) { $Zip = $c.FullName; break }
  }
}
if (-not $Zip -or -not (Test-Path $Zip)) { Die "watch-box-X.Y.Z.zip 을 찾지 못했습니다. 릴리즈에서 zip 을 받아 이 스크립트와 같은 폴더에 두세요." }
if ((Split-Path -Leaf $Zip) -notmatch $ZipRe) { Die "zip 이름이 watch-box-X.Y.Z.zip 형식이 아닙니다: $(Split-Path -Leaf $Zip)" }
$NewVer = $Matches[1]

# ---- 대상 폴더 ----
if (-not $Target) {
  if (Test-Path (Join-Path $ScriptDir "manifest.json")) { $Target = $ScriptDir }
  elseif (Test-Path (Join-Path (Get-Location) "manifest.json")) { $Target = (Get-Location).Path }
  else {
    $hint = if (Test-Path (Join-Path $DefaultTarget "manifest.json")) { " (기존 설치 발견 → 업데이트)" } else { "" }
    $answer = Read-Host "설치/업데이트할 폴더 [$DefaultTarget]$hint"
    $Target = if ($answer) { $answer } else { $DefaultTarget }
  }
}
$Mode = "install"; $CurVer = ""
if (Test-Path (Join-Path $Target "manifest.json")) {
  $Mode = "update"; $CurVer = (Get-Content (Join-Path $Target "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ($CurVer -eq $NewVer) { Say "같은 버전($NewVer)이지만 파일을 다시 덮어씁니다." }
}
Say ($(if ($Mode -eq "update") { "업데이트 $CurVer → $NewVer" } else { "새로 설치 $NewVer" }) + " → $Target")

# ---- 풀기 & 덮어쓰기 ----
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("watch-box-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
  $Src = Get-ChildItem -Path $Tmp -Recurse -Filter manifest.json | Select-Object -First 1 | ForEach-Object { $_.DirectoryName }
  if (-not $Src) { Die "zip 안에서 manifest.json 을 찾지 못했습니다." }
  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  foreach ($d in @("icons", "_locales")) { $p = Join-Path $Target $d; if (Test-Path $p) { Remove-Item $p -Recurse -Force } }  # 통째로 교체. _locales 는 1.1.0 에만 있던 폴더 — 남으면 로드 오류
  Copy-Item -Path (Join-Path $Src "*") -Destination $Target -Recurse -Force
  Say "완료: $Target (버전 $NewVer)"
} finally { Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue }

# ---- 안내 ----
if ($Mode -eq "update") {
  Say "Chrome 에서 chrome://extensions 를 열고 'Watch Box' 카드의 새로고침(↻)을 누르세요. 저장 데이터는 유지됩니다."
} else {
  Say "Chrome 에서 chrome://extensions → 개발자 모드 켜기 → '압축해제된 확장 프로그램을 로드합니다' → 이 폴더 선택:"
  Say "  $Target"
}
