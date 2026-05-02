#!/bin/sh
# Deploy music-toys to the NAS via tar-over-ssh (no git on the NAS).
set -e

NAS="${NAS:-mattwinwood@winwoodnas.local}"
NAS_PATH="${NAS_PATH:-~/git/music-toys}"

cd "$(dirname "$0")"

echo "→ Syncing files to $NAS:$NAS_PATH"
ssh "$NAS" "mkdir -p $NAS_PATH"
tar -czf - --exclude=.git --exclude=node_modules --exclude=.env --exclude=deploy.sh . \
  | ssh "$NAS" "cd $NAS_PATH && tar -xzf - && find . -name '._*' -delete"

echo "→ Rebuilding container"
ssh "$NAS" "cd $NAS_PATH && docker compose up -d --build music-toys"

echo "→ Health check"
ssh "$NAS" "sleep 2 && curl -sS -o /dev/null -w 'local=%{http_code}\n' http://localhost:3220/"

echo "✓ Done"
