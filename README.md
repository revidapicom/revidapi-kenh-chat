# RevidAPI Kênh Chat — chatbot AI đa kênh

Chatbot AI tự trả lời khách trên **Zalo cá nhân, Zalo OA, Facebook Fanpage, Telegram** và **widget website**, dựa trên tài liệu của bạn (PDF, DOCX, TXT, link web). Chạy trên máy bạn hoặc VPS, AI đi qua [RevidAPI](https://revidapi.com).

## Tính năng
- Hộp thư gộp mọi kênh, admin nhảy vào trả lời tay bất cứ lúc nào
- Kho tài liệu: tải file / link, bot trả lời theo đúng nội dung shop
- Chấm điểm khách tiềm năng, tự đăng bài Fanpage
- Trang quản trị web (`quan-tri.html`), widget nhúng website (`web-widget.js`)

## Cài nhanh
Cần Node.js ≥ 22.5 và một [API key RevidAPI](https://revidapi.com).

```bash
npm install
npm start          # mở http://localhost:<cổng in ra> để quản trị
```
Hoặc dùng script: `cai-dat.sh` (Linux/VPS), `cai-dat-mac.sh`, `cai-dat-windows.ps1`. Chi tiết xem [HUONG-DAN.md](HUONG-DAN.md).

> ⚠️ **Zalo cá nhân** dùng thư viện không chính thức `zca-js`. Zalo có thể khoá tài khoản dùng tự động — hãy dùng số phụ, đừng spam. Zalo OA / Facebook / Telegram dùng API chính thức.

## Giấy phép
MIT — xem [LICENSE](LICENSE).
