#!/usr/bin/env bash
# Site numbers for https://yafeng.fun : business counts from PostgreSQL plus a GoAccess traffic report
# built from the Nginx access logs (unique visitors = same IP + browser per day). Opens the report in the browser.
# Usage: bash scripts/stats-hk.sh
set -euo pipefail
HOST="${DEPLOY_HOST:-aholo-hk}"
OUT="${TMPDIR:-/tmp}/aholo-stats.html"

echo "== 业务数据（北京时间） =="
ssh "$HOST" "sudo -u postgres psql -d aholo_lux3d -qAt -F ' ' " <<'SQL'
SET TIME ZONE 'Asia/Shanghai';
SELECT '注册用户总数', count(*) FROM users WHERE username_key NOT LIKE '\_%';
SELECT '今天新注册', count(*) FROM users WHERE created_at >= date_trunc('day', now()) AND username_key NOT LIKE '\_%';
SELECT '今天登录过的用户', count(DISTINCT user_id) FROM sessions WHERE created_at >= date_trunc('day', now());
SELECT '生成任务总数', count(*) FROM generation_tasks;
SELECT '今天生成任务', count(*) FROM generation_tasks WHERE created_at >= date_trunc('day', now());
SELECT '今天生成成功', count(*) FROM generation_tasks WHERE created_at >= date_trunc('day', now()) AND status = 'succeeded';
SELECT '今天生成失败', count(*) FROM generation_tasks WHERE created_at >= date_trunc('day', now()) AND status = 'failed';
SELECT '开启分享的小屋', count(*) FROM rooms WHERE share_enabled;
SELECT '小屋点赞总数', count(*) FROM room_likes;
SQL

echo
echo "== 访问统计（Nginx 日志，生成网页报告） =="
ssh "$HOST" 'set -o pipefail; { zcat -f /var/log/nginx/access.log.*.gz 2>/dev/null; cat /var/log/nginx/access.log.1 2>/dev/null; cat /var/log/nginx/access.log; } \
  | goaccess - --log-format=COMBINED --ignore-crawlers --ignore-panel=REMOTE_USER --ignore-panel=GEO_LOCATION \
      --ignore-status=301 --html-report-title="yafeng.fun 访问统计" -o html 2>/dev/null' > "$OUT"
echo "报告：$OUT"
command -v open >/dev/null && open "$OUT" || true
