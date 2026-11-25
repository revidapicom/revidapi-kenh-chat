#!/usr/bin/env bash
# Đặt HTTPS cho tên miền riêng của Kênh Chat trên VPS Ubuntu/Debian (chạy bằng root):
#   bash dat-ten-mien.sh chat.tenmien.vn 8790
# Bộ cài và trang quản trị (ô "Dùng tên miền riêng") đều gọi script này.
# Máy đã có nginx thì thêm một site nginx + certbot; cổng 80/443 còn trống (hoặc đã là Caddy)
# thì dùng Caddy, tự xin và gia hạn chứng chỉ. Có web server khác (Apache, bảng điều khiển
# hosting…) thì không đụng vào. Dòng cuối luôn là "PROXY=nginx|caddy|tay".
set -uo pipefail

TEN_MIEN="${1:-}"
CONG="${2:-8790}"
PROXY=tay
trap 'echo "PROXY=$PROXY"' EXIT

printf '%s' "$TEN_MIEN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' \
  || { echo "! Tên miền không hợp lệ: $TEN_MIEN"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "! Cần quyền root."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

command -v ufw >/dev/null && ufw status | grep -q active && { ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; }

CHU80=$(ss -ltnpH 'sport = :80' 2>/dev/null | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2 || true)
if systemctl is-active --quiet nginx && [ ! -d /etc/nginx ]; then
  # nginx của aaPanel/các bảng điều khiển nằm chỗ khác, tự thêm site sẽ không có tác dụng.
  echo "! nginx đang chạy nhưng không dùng /etc/nginx (bảng điều khiển hosting?) — thêm site bằng tay."
elif systemctl is-active --quiet nginx; then
  CF=/etc/nginx/sites-available/kenh-chat-$TEN_MIEN
  if grep -rlsw "server_name.*$TEN_MIEN" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -vq "kenh-chat-$TEN_MIEN"; then
    echo "! nginx đã có site khác cho $TEN_MIEN — không ghi đè. Dùng một tên miền con riêng (vd chat.$TEN_MIEN)."
    exit 1
  fi
  echo "• Thêm site nginx cho $TEN_MIEN…"
  [ -d /etc/nginx/sites-available ] || CF=/etc/nginx/conf.d/kenh-chat-$TEN_MIEN.conf
  # Chạy lại thì giữ phần SSL certbot đã thêm, chỉ ghi mới lần đầu.
  if [ ! -f "$CF" ]; then
    cat > "$CF" <<NGINX
server {
    listen 80;
    server_name $TEN_MIEN;
    client_max_body_size 30m;
    location / {
        proxy_pass http://127.0.0.1:$CONG;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
NGINX
    [ -d /etc/nginx/sites-enabled ] && ln -sf "$CF" /etc/nginx/sites-enabled/
  fi
  nginx -t >/dev/null 2>&1 || { echo "! Cấu hình nginx lỗi — xem: nginx -t"; exit 1; }
  systemctl reload nginx
  PROXY=nginx
  if ! command -v certbot >/dev/null; then
    echo "• Cài certbot…"
    apt-get update -qq >/dev/null && apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  fi
  certbot --nginx -d "$TEN_MIEN" --non-interactive --agree-tos --register-unsafely-without-email \
    --redirect --keep-until-expiring >/dev/null 2>&1 \
    || echo "! certbot chưa cấp được chứng chỉ — xem: certbot --nginx -d $TEN_MIEN"
elif [ -z "$CHU80" ] || [ "$CHU80" = caddy ]; then
  if ! command -v caddy >/dev/null; then
    echo "• Cài Caddy (tự lo chứng chỉ HTTPS)…"
    apt-get update -qq >/dev/null
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq >/dev/null && apt-get install -y -qq caddy >/dev/null
    command -v caddy >/dev/null || { echo "! Cài Caddy không được."; exit 1; }
    # Caddyfile mặc định có khối ":80" trang chào — bỏ để không giành cổng 80 với tên miền.
    printf 'import /etc/caddy/sites/*.caddy\n' > /etc/caddy/Caddyfile
  fi
  mkdir -p /etc/caddy/sites
  grep -q 'import /etc/caddy/sites/' /etc/caddy/Caddyfile || printf '\nimport /etc/caddy/sites/*.caddy\n' >> /etc/caddy/Caddyfile
  cat > "/etc/caddy/sites/kenh-chat-$TEN_MIEN.caddy" <<CADDY
$TEN_MIEN {
    request_body {
        max_size 30MB
    }
    reverse_proxy 127.0.0.1:$CONG {
        header_up X-Real-IP {remote_host}
    }
}
CADDY
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { echo "! Caddyfile lỗi — xem: caddy validate --config /etc/caddy/Caddyfile"; exit 1; }
  systemctl enable caddy >/dev/null 2>&1
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  PROXY=caddy
else
  echo "! Cổng 80 đang do \"$CHU80\" giữ — không tự sửa web server có sẵn."
fi
