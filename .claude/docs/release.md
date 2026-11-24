# 릴리즈 절차

0. `sync.js` 를 고쳤으면 `node test/sync.test.js` 가 전부 통과하는지 확인 (가짜 저장소로 두 기기 동기화 시나리오 검증)

1. `manifest.json` 의 `version` 올리고 커밋·push (커밋 제목 끝에 버전, 예: `…, 1.1.0`)
2. zip 생성 — 확장 파일만, 설치 스크립트 제외

   ```bash
   v=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json)
   git archive --format=zip -o "/tmp/watch-box-$v.zip" HEAD app.css app.html app.js sync.js background.js manifest.json icons logos
   ```

3. 릴리즈 — zip 과 설치 스크립트(`install.sh` mac·Linux, `install.ps1` Windows) 첨부

   ```bash
   gh release create "v$v" "/tmp/watch-box-$v.zip" install.sh install.ps1 --target main --title "Watch Box $v" --notes "<변경 요약>"
   ```

받는 기기: zip 과 설치 스크립트를 같은 폴더에 받아 실행 → 크롬에서 새로고침 (zip 탐색: 스크립트 폴더 → 현재 폴더 → 다운로드, 설치 폴더는 물어봄).

- mac: `bash install.sh` — 기본 `~/Applications/watch-box`
- Windows: `powershell -ExecutionPolicy Bypass -File install.ps1` — 기본 `%LOCALAPPDATA%\watch-box`. mac 에서는 실행 검증 불가 — 수정 시 Windows 에서 확인 필요
- `install.ps1` 은 UTF-8 BOM 유지 (없으면 Windows PowerShell 5.1 에서 한글 깨짐)
