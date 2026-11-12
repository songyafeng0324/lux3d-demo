#!/usr/bin/env bash
# Build on this Mac, sync the runtime files to the Hong Kong server, migrate and restart.
# Usage: bash scripts/deploy-hk.sh   (needs the `aholo-hk` entry in ~/.ssh/config, see docs/部署说明.md)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${DEPLOY_HOST:-aholo-hk}"

npm run build

# Only what the server runs: package manifests, compiled dist, migrations, ops scripts, official furniture.
rsync -rlptz --delete --no-owner --no-group \
  --include='/package.json' --include='/package-lock.json' \
  --include='/apps/' --include='/apps/*/' --include='/apps/*/package.json' --include='/apps/*/dist/***' \
  --include='/packages/' --include='/packages/*/' --include='/packages/*/package.json' --include='/packages/*/dist/***' \
  --include='/migrations/***' \
  --include='/scripts/' --include='/scripts/migrate.mjs' --include='/scripts/seed-admin.mjs' --include='/scripts/seed-furniture.mjs' \
  --include='/scripts/backup.mjs' --include='/scripts/restore-check.mjs' --include='/scripts/generation-diagnose.mjs' --include='/scripts/process-group.mjs' \
  --include='/assets/' --include='/assets/furniture/' --include='/assets/furniture/manifest.json' --include='/assets/furniture/*.glb' \
  --exclude='/node_modules/' --exclude='*' \
  ./ "$HOST":/opt/aholo/app/

ssh "$HOST" 'bash -s' <<'EOF'
set -euo pipefail
cd /opt/aholo/app
npm ci --omit=dev --no-audit --no-fund --loglevel=error
# macOS openrsync ignores --chmod and some local files are 0600: make the code readable by the aholo user.
chown -R root:root /opt/aholo/app && chmod -R u+rwX,go+rX,go-w /opt/aholo/app
sudo -u aholo env ENV_FILE=/etc/aholo/aholo.env HOME=/var/lib/aholo node scripts/migrate.mjs
systemctl restart aholo-api aholo-worker
for i in $(seq 1 20); do
  if curl -fs http://127.0.0.1:3001/api/v1/health/ready | grep -q '"generationReady":true'; then echo "deploy ok: ready"; exit 0; fi
  sleep 2
done
echo "deploy finished but health is not ready:"; curl -s http://127.0.0.1:3001/api/v1/health/ready; exit 1
EOF
