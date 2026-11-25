# Kênh Chat RevidAPI trên MÁY WINDOWS của bạn (không cần VPS). Mở PowerShell, dán:
#   $env:REVIDAPI_KEY="sk_khoa_cua_ban"; irm https://revidapi.com/tai-app/kenh-chat-windows.ps1 | iex
#
# Mọi thứ nằm trong %LOCALAPPDATA%\RevidAPI\kenh-chat: token Zalo/Fanpage/Telegram, tài
# liệu, phiên đăng nhập — không gửi đi đâu. Trang quản trị chỉ mở được trên chính máy này.
# Bot trả lời khi máy bật; tự chạy khi đăng nhập Windows.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # thanh tiến trình làm Invoke-WebRequest chậm gấp nhiều lần
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Khoa = $env:REVIDAPI_KEY
if (-not $Khoa) { Write-Host "Thiếu API key. Chạy: `$env:REVIDAPI_KEY=`"sk_...`"; rồi dán lại lệnh."; return }
$Cong = if ($env:CONG) { $env:CONG } else { "8790" }
$Nguon = if ($env:KENH_CHAT_TGZ) { $env:KENH_CHAT_TGZ } else { "https://revidapi.com/tai-app/kenh-chat.tgz" }
$Goc = Join-Path $env:LOCALAPPDATA "RevidAPI"
$ThuMuc = Join-Path $Goc "kenh-chat"
$Data = Join-Path $ThuMuc "data"

try {
  Invoke-RestMethod -Uri "https://revidapi.com/v1/account" -Headers @{ Authorization = "Bearer $Khoa" } | Out-Null
} catch { Write-Host "API key không dùng được. Lấy lại khoá ở revidapi.com/dashboard."; return }

New-Item -ItemType Directory -Force -Path $Data, (Join-Path $Goc "bin") | Out-Null

# Node.js 22 riêng (cần node:sqlite) — không đụng Node khách đang dùng.
$NodeDir = Join-Path $Goc "node"
$Node = Join-Path $NodeDir "node.exe"
if (-not (Test-Path $Node)) {
  Write-Host "• Tải Node.js…"
  $Ten = ((Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -UseBasicParsing).Content -split "`n" |
    ForEach-Object { ($_ -split "\s+")[1] } | Where-Object { $_ -match "win-x64\.zip$" } | Select-Object -First 1)
  if (-not $Ten) { Write-Host "Không tìm được bản Node.js cho máy này."; return }
  $Zip = Join-Path $env:TEMP "node22.zip"
  Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/$Ten" -OutFile $Zip -UseBasicParsing
  $Tam = Join-Path $env:TEMP "node22"
  if (Test-Path $Tam) { Remove-Item $Tam -Recurse -Force }
  Expand-Archive $Zip -DestinationPath $Tam -Force
  if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
  Move-Item (Get-ChildItem $Tam | Select-Object -First 1).FullName $NodeDir
  Remove-Item $Zip, $Tam -Recurse -Force -ErrorAction SilentlyContinue
}

# cloudflared: chỉ để Facebook/Zalo OA gửi tin tới máy bạn qua HTTPS.
$Cf = Join-Path $Goc "bin\cloudflared.exe"
if (-not (Test-Path $Cf)) {
  Write-Host "• Tải cloudflared (đường HTTPS cho Fanpage/Zalo OA)…"
  Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $Cf -UseBasicParsing
}

Write-Host "• Tải Kênh Chat…"
# Dừng bản đang chạy trước khi chép đè.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*kenh-chat*server.mjs*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$TamKc = Join-Path $env:TEMP "kenh-chat-tai"
if (Test-Path $TamKc) { Remove-Item $TamKc -Recurse -Force }
New-Item -ItemType Directory -Force -Path $TamKc | Out-Null
$Tgz = Join-Path $TamKc "kc.tgz"
if ($Nguon -like "file://*") { Copy-Item ($Nguon -replace "^file:///?", "") $Tgz } else { Invoke-WebRequest $Nguon -OutFile $Tgz -UseBasicParsing }
tar -xzf $Tgz -C $TamKc   # tar.exe có sẵn từ Windows 10 1803
Copy-Item (Join-Path $TamKc "kenh-chat\*.mjs"), (Join-Path $TamKc "kenh-chat\*.html"), (Join-Path $TamKc "kenh-chat\package.json") $ThuMuc -Force
Remove-Item $TamKc -Recurse -Force
Push-Location $ThuMuc
$env:Path = "$NodeDir;$env:Path"
& (Join-Path $NodeDir "npm.cmd") install --omit=dev --silent | Out-Null
Pop-Location

$Moi = -not (Test-Path (Join-Path $Data "cau-hinh.json"))
$Mk = ""
if ($Moi) { $Mk = -join ((1..18) | ForEach-Object { "0123456789abcdef"[(Get-Random -Maximum 16)] }) }

# Tệp chạy: đặt biến môi trường rồi gọi node. Chỉ người dùng này đọc được (chứa API key).
$Cmd = Join-Path $ThuMuc "chay.cmd"
@"
@echo off
set CONG=$Cong
set HOST=127.0.0.1
set CLOUDFLARED=$Cf
set REVIDAPI_KEY=$Khoa
$(if ($Mk) { "set MAT_KHAU=$Mk" })
cd /d "$ThuMuc"
:lap
"$Node" server.mjs >> "$Data\chay.log" 2>&1
timeout /t 5 /nobreak >nul
goto lap
"@ | Set-Content -Path $Cmd -Encoding ASCII
icacls $Cmd /inheritance:r /grant:r "${env:USERNAME}:(F)" | Out-Null

# Chạy ẩn khi đăng nhập Windows (thư mục Startup của riêng người dùng, không cần quyền admin).
$Vbs = Join-Path ([Environment]::GetFolderPath("Startup")) "RevidAPI Kenh Chat.vbs"
"CreateObject(""WScript.Shell"").Run """"""$Cmd"""""", 0, False" | Set-Content -Path $Vbs -Encoding ASCII
Start-Process wscript.exe -ArgumentList "`"$Vbs`""

if ($Moi) {
  for ($i = 0; $i -lt 30 -and -not (Test-Path (Join-Path $Data "cau-hinh.json")); $i++) { Start-Sleep 1 }
  # Mật khẩu đã được ghi vào cau-hinh.json — bỏ khỏi tệp chạy.
  (Get-Content $Cmd) | Where-Object { $_ -notmatch "^set MAT_KHAU=" } | Set-Content -Path $Cmd -Encoding ASCII
}
for ($i = 0; $i -lt 20; $i++) {
  try { Invoke-WebRequest "http://127.0.0.1:$Cong/" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 }
}

Write-Host ""
Write-Host "================ KÊNH CHAT ĐÃ CHẠY TRÊN MÁY NÀY ================"
Write-Host "Trang quản trị : http://localhost:$Cong   (chỉ mở được trên máy này)"
if ($Moi) { Write-Host "Mật khẩu       : $Mk   <- lưu lại, chỉ hiện một lần" }
else { Write-Host "Mật khẩu       : giữ như cũ (trường matKhau trong $Data\cau-hinh.json)" }
Write-Host "Dữ liệu        : $Data — token và tài liệu không rời khỏi máy."
Write-Host "Bot trả lời khi máy bật. Gỡ: xoá '$Vbs' và thư mục $ThuMuc"
Write-Host "================================================================="
Start-Process "http://localhost:$Cong"
