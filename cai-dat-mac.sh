#!/usr/bin/env bash
# Kênh Chat RevidAPI trên MÁY MAC của bạn (không cần VPS). Một lệnh:
#   curl -fsSL https://revidapi.com/tai-app/kenh-chat-mac.sh | bash -s -- sk_khoa_cua_ban
#
# Mọi thứ nằm trong ~/.revidapi/kenh-chat: token Zalo/Fanpage/Telegram, tài liệu,
# phiên đăng nhập — không gửi đi đâu. Trang quản trị chỉ mở được trên chính máy này.
# Bot trả lời khi máy bật; tự chạy lại sau khi khởi động máy.
set -euo pipefail

KHOA="${1:-${REVIDAPI_KEY:-}}"
GOC="$HOME/.revidapi"
THU_MUC="$GOC/kenh-chat"
CONG="${CONG:-8790}"
NGUON="${KENH_CHAT_TGZ:-https://revidapi.com/tai-app/kenh-chat.tgz}"
NHAN=com.revidapi.kenhchat
PLIST="$HOME/Library/LaunchAgents/$NHAN.plist"

[ -n "$KHOA" ] || { echo "Thiếu API key: ... | bash -s -- sk_khoa_cua_ban"; exit 1; }
MA=$(curl -s -o /dev/null -w '%{http_code}' https://revidapi.com/v1/account -H "Authorization: Bearer $KHOA")
[ "$MA" = 200 ] || { echo "API key không dùng được (HTTP $MA). Lấy lại khoá ở revidapi.com/dashboard."; exit 1; }

case "$(uname -m)" in arm64) KIEN=arm64 ;; *) KIEN=x64 ;; esac
mkdir -p "$THU_MUC/data" "$GOC/bin"
chmod 700 "$THU_MUC/data"

# Node.js riêng cho Kênh Chat — không đụng Node khách đang dùng (nếu có).
NODE="$GOC/node/bin/node"
if [ ! -x "$NODE" ]; then
  echo "• Tải Node.js…"
  TEN=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '{print $2}' | grep "darwin-$KIEN.tar.gz$" || true)
  [ -n "$TEN" ] || { echo "Không tìm được bản Node.js cho máy này."; exit 1; }
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$TEN" -o "$GOC/node.tgz"
  rm -rf "$GOC/node" && mkdir -p "$GOC/node"
  tar xzf "$GOC/node.tgz" -C "$GOC/node" --strip-components 1 && rm -f "$GOC/node.tgz"
fi

# cloudflared: chỉ để Facebook/Zalo OA gửi tin tới máy bạn qua HTTPS. Telegram và Zalo
# cá nhân không cần.
CF="$GOC/bin/cloudflared"
if [ ! -x "$CF" ]; then
  echo "• Tải cloudflared (đường HTTPS cho Fanpage/Zalo OA)…"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$([ $KIEN = arm64 ] && echo arm64 || echo amd64).tgz" -o "$GOC/cf.tgz"
  tar xzf "$GOC/cf.tgz" -C "$GOC/bin" && rm -f "$GOC/cf.tgz" && chmod +x "$CF"
fi

echo "• Tải Kênh Chat…"
TAM=$(mktemp -d)
curl -fsSL "$NGUON" -o "$TAM/kc.tgz"
tar xzf "$TAM/kc.tgz" -C "$TAM"
cp -f "$TAM"/kenh-chat/*.mjs "$TAM"/kenh-chat/*.html "$TAM"/kenh-chat/package.json "$THU_MUC/"
rm -rf "$TAM"
(cd "$THU_MUC" && PATH="$GOC/node/bin:$PATH" "$GOC/node/bin/npm" install --omit=dev --silent >/dev/null)

MOI=0; MK=""
if [ ! -f "$THU_MUC/data/cau-hinh.json" ]; then
  MOI=1
  MK=$(od -An -N9 -tx1 /dev/urandom | tr -d ' \n')
fi

# LaunchAgent: chạy khi đăng nhập máy, tự bật lại nếu tắt ngang. Chỉ người dùng này đọc được.
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$NHAN</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$THU_MUC/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$THU_MUC</string>
  <key>EnvironmentVariables</key><dict>
    <key>CONG</key><string>$CONG</string>
    <key>HOST</key><string>127.0.0.1</string>
    <key>CLOUDFLARED</key><string>$CF</string>
    <key>REVIDAPI_KEY</key><string>$KHOA</string>
    ${MK:+<key>MAT_KHAU</key><string>$MK</string>}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$THU_MUC/data/loi.log</string>
</dict></plist>
EOF
chmod 600 "$PLIST"
# bootout chạy bất đồng bộ: bootstrap ngay sau đó (lúc dịch vụ cũ chưa gỡ xong) báo "5: Input/output error".
MIEN="gui/$(id -u)"
launchctl bootout "$MIEN/$NHAN" 2>/dev/null || true
for _ in $(seq 1 15); do launchctl print "$MIEN/$NHAN" >/dev/null 2>&1 || break; sleep 1; done
DA_NAP=0
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "$MIEN" "$PLIST" 2>/dev/null; then DA_NAP=1; break; fi
  sleep 2
done
if [ "$DA_NAP" = 0 ]; then
  # Vẫn còn nạp bản cũ thì khởi động lại nó; không thì báo rõ cách chạy tay.
  if ! launchctl kickstart -k "$MIEN/$NHAN" 2>/dev/null; then
    echo "Không nạp được dịch vụ nền. Chạy tay: launchctl bootstrap $MIEN $PLIST" >&2
    echo "Nếu vẫn lỗi, đăng xuất rồi đăng nhập lại macOS và chạy lại lệnh cài." >&2
    exit 1
  fi
fi

# Mật khẩu chỉ cần ở lần chạy đầu (server ghi vào data/cau-hinh.json); xoá khỏi plist.
if [ "$MOI" = 1 ]; then
  for _ in $(seq 1 20); do [ -f "$THU_MUC/data/cau-hinh.json" ] && break; sleep 1; done
  /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:MAT_KHAU" "$PLIST" 2>/dev/null || true
fi

for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$CONG/" && break; sleep 1; done
echo
echo "================ KÊNH CHAT ĐÃ CHẠY TRÊN MÁY NÀY ================"
echo "Trang quản trị : http://localhost:$CONG   (chỉ mở được trên máy này)"
if [ "$MOI" = 1 ]; then
  echo "Mật khẩu       : $MK   ← lưu lại, chỉ hiện một lần"
else
  echo "Mật khẩu       : giữ như cũ (trường matKhau trong $THU_MUC/data/cau-hinh.json)"
fi
echo "Dữ liệu        : $THU_MUC/data — token và tài liệu không rời khỏi máy."
echo "Bot trả lời khi máy bật."
echo "Gỡ hẳn: launchctl bootout gui/\$(id -u)/$NHAN; rm -f $PLIST; rm -rf $THU_MUC $GOC/node $GOC/bin/cloudflared"
echo "================================================================="
open "http://localhost:$CONG" 2>/dev/null || true
