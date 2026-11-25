#!/usr/bin/env bash
# Cài RevidAPI Kênh Chat lên VPS Ubuntu/Debian bằng một lệnh:
#   curl -fsSL https://revidapi.com/tai-app/kenh-chat.sh | sudo bash -s -- sk_khoa_cua_ban
# Dùng tên miền riêng thay cho đường hầm Cloudflare (bản ghi A của tên miền trỏ về IP VPS này):
#   curl -fsSL https://revidapi.com/tai-app/kenh-chat.sh | sudo bash -s -- sk_khoa_cua_ban chat.tenmien.vn
# Chạy lại lệnh này để cập nhật — dữ liệu (cấu hình, phiên Zalo, tài liệu) và tên miền đã đặt được giữ nguyên.
# Quay về đường hầm Cloudflare: truyền "bo" thay cho tên miền.
set -euo pipefail

KHOA="${1:-${REVIDAPI_KEY:-}}"
TEN_MIEN="${2:-${TEN_MIEN:-}}"
DV=/etc/systemd/system/kenh-chat.service
# Chạy lại không truyền tên miền thì giữ tên miền đang dùng (đặt lúc cài hoặc trên trang quản trị).
if [ -z "$TEN_MIEN" ] && [ -f "$DV" ]; then
  TEN_MIEN=$(grep -o 'WEBHOOK_GOC=https://[^ ]*' "$DV" 2>/dev/null | cut -d/ -f3 || true)
fi
if [ -z "$TEN_MIEN" ] && [ -f /opt/kenh-chat/data/cau-hinh.json ]; then
  TEN_MIEN=$(grep -o '"tenMien": *"[^"]*"' /opt/kenh-chat/data/cau-hinh.json | cut -d'"' -f4 || true)
fi
[ "$TEN_MIEN" = bo ] && TEN_MIEN=""
TEN_MIEN=$(printf '%s' "$TEN_MIEN" | tr 'A-Z' 'a-z' | sed -E -e 's#^https?://##' -e 's#/.*$##')
THU_MUC=/opt/kenh-chat
CONG="${CONG:-8790}"
NGUON="${KENH_CHAT_TGZ:-https://revidapi.com/tai-app/kenh-chat.tgz}"

[ "$(id -u)" = 0 ] || { echo "Chạy bằng root (thêm sudo)."; exit 1; }
[ -n "$KHOA" ] || { echo "Thiếu API key: ... | sudo bash -s -- sk_khoa_cua_ban"; exit 1; }

# Kiểm khoá trước khi cài, để không cài xong mới biết khoá sai.
MA=$(curl -s -o /dev/null -w '%{http_code}' https://revidapi.com/v1/account -H "Authorization: Bearer $KHOA")
[ "$MA" = 200 ] || { echo "API key không dùng được (HTTP $MA). Lấy lại khoá ở revidapi.com/dashboard."; exit 1; }

IP=$(curl -s -4 --max-time 8 https://ifconfig.me || hostname -I | awk '{print $1}')
if [ -n "$TEN_MIEN" ]; then
  printf '%s' "$TEN_MIEN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' \
    || { echo "Tên miền không hợp lệ: $TEN_MIEN (ví dụ đúng: chat.tenmien.vn)"; exit 1; }
  # Chứng chỉ HTTPS chỉ cấp được khi tên miền đã trỏ về đúng máy này — kiểm trước cho khỏi cài dở.
  DNS=$(getent ahostsv4 "$TEN_MIEN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
  if ! printf ' %s ' "$DNS" | grep -q " $IP "; then
    echo "Tên miền $TEN_MIEN đang trỏ về: ${DNS:-(chưa có bản ghi)} — VPS này là $IP."
    echo "Vào nơi quản lý tên miền, thêm bản ghi A: ${TEN_MIEN%%.*} → $IP (nếu dùng Cloudflare thì tắt đám mây cam),"
    echo "chờ vài phút rồi chạy lại lệnh. Bỏ qua bước kiểm này: thêm KIEM_DNS=0 trước bash."
    [ "${KIEM_DNS:-1}" = 0 ] || exit 1
  fi
fi

# Node.js 22 RIÊNG cho Kênh Chat (cần node:sqlite). Không nâng Node của hệ thống — VPS
# khách có thể đang chạy ứng dụng khác cần đúng bản Node cũ.
NODE_DIR=/opt/kenh-chat-node
NODE="$NODE_DIR/bin/node"
if [ ! -x "$NODE" ]; then
  echo "• Tải Node.js 22 (riêng cho Kênh Chat)…"
  case "$(uname -m)" in aarch64|arm64) KIEN=arm64 ;; *) KIEN=x64 ;; esac
  TEN=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '{print $2}' | grep "linux-$KIEN.tar.xz$" || true)
  [ -n "$TEN" ] || { echo "Không tìm được bản Node.js cho máy này."; exit 1; }
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$TEN" -o /tmp/node22.tar.xz
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar xJf /tmp/node22.tar.xz -C "$NODE_DIR" --strip-components 1 && rm -f /tmp/node22.tar.xz
fi

echo "• Tải Kênh Chat…"
mkdir -p "$THU_MUC/data"
TAM=$(mktemp -d)
curl -fsSL "$NGUON" -o "$TAM/kc.tgz"
tar xzf "$TAM/kc.tgz" -C "$TAM"
# Chép mã mới, KHÔNG đụng thư mục data (cấu hình, phiên Zalo, tài liệu của khách).
cp -f "$TAM"/kenh-chat/*.mjs "$TAM"/kenh-chat/*.html "$TAM"/kenh-chat/package.json "$TAM"/kenh-chat/dat-ten-mien.sh "$THU_MUC/"
rm -rf "$TAM"
chmod 700 "$THU_MUC/data"
(cd "$THU_MUC" && PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install --omit=dev --silent >/dev/null)

MOI=0
if [ ! -f "$THU_MUC/data/cau-hinh.json" ]; then
  MOI=1
  # Không dùng `head -c` sau ống: pipefail làm script dừng vì SIGPIPE.
  MK=$(od -An -N9 -tx1 /dev/urandom | tr -d ' \n')
fi

# Địa chỉ HTTPS cho webhook Fanpage/Zalo OA (Facebook bắt buộc HTTPS): không có tên miền thì
# server tự mở đường hầm Cloudflare miễn phí bằng cloudflared; có tên miền thì dùng Caddy/nginx bên dưới.
# Cài cả khi dùng tên miền: bỏ tên miền trên trang quản trị thì bot quay lại đường hầm ngay.
if ! command -v cloudflared >/dev/null; then
  echo "• Cài cloudflared (để có địa chỉ HTTPS cho webhook)…"
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"
  dpkg -i /tmp/cloudflared.deb >/dev/null && rm -f /tmp/cloudflared.deb
fi
# Bản cũ chạy đường hầm thành service riêng — nay server tự lo, gỡ để không chạy hai đường.
if [ -f /etc/systemd/system/kenh-chat-https.service ]; then
  systemctl disable --now kenh-chat-https >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/kenh-chat-https.service
fi

# Đặt HTTPS cho tên miền: dat-ten-mien.sh (cùng script mà ô "Dùng tên miền riêng" trên trang
# quản trị gọi) — nginx + certbot nếu máy đã có nginx, không thì Caddy; web server khác thì để tay.
PROXY=""
dung_proxy() {
  PROXY=$(bash "$THU_MUC/dat-ten-mien.sh" "$TEN_MIEN" "$CONG" | tee /dev/stderr | sed -n 's/^PROXY=//p' | tail -1 || true)
  PROXY=${PROXY:-tay}
}

cat > "$DV" <<EOF
[Unit]
Description=RevidAPI Kenh Chat
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$THU_MUC
Environment=CONG=$CONG
Environment=REVIDAPI_KEY=$KHOA
Environment=CLOUDFLARED=$(command -v cloudflared)
Environment=CHO_QUAN_TRI_HTTPS=1
${MK:+Environment=MAT_KHAU=$MK}
ExecStart=$NODE server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
chmod 600 /etc/systemd/system/kenh-chat.service
# Tên miền nằm trong cấu hình (trang quản trị đọc/sửa được); có tên miền thì server tự chỉ nghe
# 127.0.0.1 — từ ngoài vào phải đi qua HTTPS của tên miền.
if [ -f "$THU_MUC/data/cau-hinh.json" ]; then
  "$NODE" -e 'const fs=require("fs"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f,"utf8"));c.tenMien=process.argv[2];fs.writeFileSync(f,JSON.stringify(c,null,2),{mode:0o600})' "$THU_MUC/data/cau-hinh.json" "$TEN_MIEN"
else
  mkdir -p "$THU_MUC/data" && printf '{"tenMien":"%s"}\n' "$TEN_MIEN" > "$THU_MUC/data/cau-hinh.json" && chmod 600 "$THU_MUC/data/cau-hinh.json"
fi
systemctl daemon-reload
systemctl enable kenh-chat >/dev/null 2>&1
MOC=$(date '+%Y-%m-%d %H:%M:%S')   # chỉ đọc địa chỉ của lần chạy này, không lấy địa chỉ cũ
systemctl restart kenh-chat
# Mật khẩu chỉ cần ở lần chạy đầu (server ghi vào data/cau-hinh.json); bỏ khỏi service.
if [ "$MOI" = 1 ]; then
  for _ in $(seq 1 20); do grep -q '"matKhau"' "$THU_MUC/data/cau-hinh.json" 2>/dev/null && break; sleep 1; done
  sed -i '/MAT_KHAU=/d' /etc/systemd/system/kenh-chat.service
  systemctl daemon-reload
fi
if [ -z "$TEN_MIEN" ]; then
  command -v ufw >/dev/null && ufw status | grep -q active && ufw allow "$CONG"/tcp >/dev/null || true
else
  dung_proxy
fi

HTTPS=""
if [ -n "$TEN_MIEN" ]; then
  # Chứng chỉ có thể mất vài chục giây mới cấp xong.
  for _ in $(seq 1 20); do
    curl -fs -o /dev/null --max-time 5 "https://$TEN_MIEN/" && { HTTPS="https://$TEN_MIEN"; break; }
    sleep 3
  done
else
  for _ in $(seq 1 20); do
    HTTPS=$(journalctl -u kenh-chat --since "$MOC" --no-pager 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)
    [ -n "$HTTPS" ] && break; sleep 2
  done
fi

echo
echo "================ KÊNH CHAT ĐÃ CHẠY ================"
if [ -n "$TEN_MIEN" ]; then
  echo "Trang quản trị : https://$TEN_MIEN"
  echo "Webhook Zalo OA: https://$TEN_MIEN/webhook/zalo-oa   (cố định, không đổi khi khởi động lại)"
  echo "Webhook Fanpage: https://$TEN_MIEN/webhook/facebook"
  if [ "$PROXY" = tay ]; then
    echo
    echo "Chưa tự đặt được HTTPS. Thêm vào web server của bạn một site cho $TEN_MIEN chuyển tiếp về"
    echo "http://127.0.0.1:$CONG và gửi kèm header X-Real-IP (IP khách). Ví dụ nginx:"
    echo "    location / { proxy_pass http://127.0.0.1:$CONG; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; }"
  elif [ -z "$HTTPS" ]; then
    echo
    echo "! https://$TEN_MIEN chưa trả lời. Kiểm: tường lửa nhà cung cấp VPS đã mở cổng 80 và 443 chưa,"
    echo "  rồi xem log: journalctl -u $PROXY -n 50"
  fi
  echo "Vào tạm khi HTTPS chưa chạy: ssh -L $CONG:127.0.0.1:$CONG root@$IP rồi mở http://localhost:$CONG"
else
  echo "Trang quản trị : ${HTTPS:-http://$IP:$CONG}"
  [ -n "$HTTPS" ] && echo "                  (hoặc http://$IP:$CONG)"
fi
if [ "$MOI" = 1 ]; then
  echo "Mật khẩu       : $MK   ← lưu lại, chỉ hiện một lần"
else
  echo "Mật khẩu       : giữ như cũ (xem trường matKhau trong $THU_MUC/data/cau-hinh.json)"
fi
echo "Vào trang quản trị → Kết nối kênh: quét QR Zalo, dán token Telegram/Fanpage/Zalo OA."
[ -z "$TEN_MIEN" ] && [ -n "$HTTPS" ] && echo "Lưu ý: địa chỉ trycloudflare đổi khi VPS khởi động lại — dùng tên miền riêng để cố định: trang quản trị → Kết nối kênh → tích \"Dùng tên miền riêng\"."
echo "==================================================="
