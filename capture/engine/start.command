#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' 2>/dev/null; then
  echo 'Node.js 22 이상이 필요합니다. 열린 공식 페이지에서 LTS 버전을 설치하고 이 파일을 다시 실행해 주세요.'
  open 'https://nodejs.org/en/download/'
  read -r -p 'Enter를 누르면 종료합니다. ' _capture_reply
  exit 1
fi
cd engine
if [ ! -d node_modules/playwright ]; then
  echo '첫 실행 준비: 캡처 엔진을 설치합니다.'
  npm install --no-audit --no-fund
fi
node node_modules/playwright/cli.js install chromium
node server.cjs
read -r -p 'Enter를 누르면 종료합니다. ' _capture_reply
