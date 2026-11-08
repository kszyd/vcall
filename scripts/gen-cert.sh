#!/usr/bin/env bash
# 生成 VCall 自签 HTTPS 证书（浏览器使用摄像头/麦克风需要 HTTPS）
# 用法：
#   ./scripts/gen-cert.sh 192.168.199.100
# 产物：
#   certs/server.crt  certs/server.key
set -euo pipefail

IP="${1:-192.168.199.100}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"

mkdir -p "$DIR"

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$DIR/server.key" -out "$DIR/server.crt" \
  -subj "/C=CN/ST=Local/L=Local/O=VCall/CN=${IP}" \
  -addext "subjectAltName=IP:${IP},DNS:vcall.local,DNS:localhost,IP:127.0.0.1"

chmod 600 "$DIR/server.key" 2>/dev/null || true

echo "已生成："
echo "  $DIR/server.crt"
echo "  $DIR/server.key"
echo ""
echo "把 docker-compose.yaml 中改为："
echo '  VCALL_TLS_CERT: "/certs/server.crt"'
echo '  VCALL_TLS_KEY: "/certs/server.key"'
echo "然后重启容器，浏览器访问 https://${IP}:9443/call"
