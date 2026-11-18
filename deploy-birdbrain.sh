#!/usr/bin/env bash
# Birdbrain's query meter, on Birdbrain's own box (ADR 0076). Copies the engine,
# the Birdbrain config, the graph-only corpus (adapters/birdbrain-graph.ts) and the
# buyer kit to /opt/query-meter, runs it as systemd `query-meter` (user query-meter,
# loopback :8794, claims and request log in /var/lib/query-meter). nginx sends
# /query and /query/* to it (infra/services/birdbrain-edge/nginx/birdbrain.conf).
# Open to anyone, dUSD only, settling to Birdbrain's operator account. Holds no keys.
set -euo pipefail
BOX="${BOX:-root@birdbrain.wtf}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/out/birdbrain-graph.db" ] || { echo "build the corpus first: bun run adapters/birdbrain-graph.ts"; exit 1; }
ssh -o BatchMode=yes "$BOX" 'id query-meter >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin query-meter
  mkdir -p /opt/query-meter/engine /opt/query-meter/collectives /opt/query-meter/out /opt/query-meter/kit /var/lib/query-meter
  chown query-meter:query-meter /var/lib/query-meter && chmod 700 /var/lib/query-meter'
scp -q "$HERE/engine/server.ts" "$HERE/engine/sql-runner.ts" "$BOX:/opt/query-meter/engine/"
scp -q "$HERE/collectives/birdbrain.json" "$BOX:/opt/query-meter/collectives/"
scp -q "$HERE/out/birdbrain-graph.db" "$HERE/out/birdbrain-graph-sample.db" "$BOX:/opt/query-meter/out/"
scp -q "$HERE/kit/buy.ts" "$HERE/kit/README.md" "$BOX:/opt/query-meter/kit/"
scp -q "$HERE/package.json" "$BOX:/opt/query-meter/"
ssh -o BatchMode=yes "$BOX" 'cd /opt/query-meter && rm -f bun.lock && /usr/local/bin/bun install --production >/dev/null && chown -R root:root /opt/query-meter && chmod 444 out/*.db
cat > /etc/systemd/system/query-meter.service <<UNIT
[Unit]
Description=Birdbrain: pay-per-query over its world model, dUSD on Asset Hub (lab/query-meter)
After=network-online.target

[Service]
User=query-meter
WorkingDirectory=/opt/query-meter
Environment=COLLECTIVE=birdbrain
Environment=PORT=8794
Environment=HOME=/tmp
Environment=QM_STATE=/var/lib/query-meter
Environment=QM_KEYS=/var/lib/query-meter/buyers.json
ExecStart=/usr/local/bin/bun engine/server.ts
Restart=always
RestartSec=3
MemoryMax=768M
CPUQuota=150%
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/query-meter
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now query-meter && systemctl restart query-meter && sleep 8 && systemctl is-active query-meter && curl -s 127.0.0.1:8794/health'
echo
for p in /query /query/manifest.json /query/buy.ts /query/README.md /query/sample.db; do
  code="$(curl -s -m 60 -o /dev/null -w '%{http_code}' "https://birdbrain.wtf$p")"
  echo "https://birdbrain.wtf$p $code"
  [ "$code" = 200 ] || exit 1
done
