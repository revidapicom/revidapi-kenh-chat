# Kênh Chat RevidAPI — chatbot AI cho Zalo, Fanpage, Telegram

Một lệnh cài lên VPS, vào trang quản trị bấm kết nối là bot tự trả lời khách 24/7 bằng tài liệu của bạn
(bảng giá, chính sách, FAQ). Tiền tính theo credit RevidAPI, chỉ cho phần chữ thật dùng.

## 1. Cài đặt (5 phút) — chọn nơi chạy

Token Zalo/Fanpage/Telegram, tài liệu và lịch sử chat **chỉ nằm trên máy bạn chọn**, không gửi về RevidAPI.
Lấy API key ở revidapi.com/dashboard.

| Chạy ở đâu | Lệnh | Ghi chú |
|---|---|---|
| **VPS** Ubuntu/Debian (bot chạy 24/7) | `curl -fsSL https://revidapi.com/tai-app/kenh-chat.sh \| sudo bash -s -- sk_khoa` | 1 GB RAM là đủ (đo: ~75 MB) |
| **Máy Mac** | `curl -fsSL https://revidapi.com/tai-app/kenh-chat-mac.sh \| bash -s -- sk_khoa` | Bot trả lời khi máy bật |
| **Máy Windows** (PowerShell) | `$env:REVIDAPI_KEY="sk_khoa"; irm https://revidapi.com/tai-app/kenh-chat-windows.ps1 \| iex` | Bot trả lời khi máy bật |

Có tên miền riêng, không muốn dùng địa chỉ Cloudflare → xem mục **Dùng tên miền riêng** ngay dưới.

Cuối lệnh in ra **địa chỉ trang quản trị** và **mật khẩu** (chỉ hiện một lần — lưu lại).
Trên máy tính, trang quản trị là `http://localhost:8790` — người khác không mở được.
Chạy lại đúng lệnh để cập nhật; cấu hình, phiên Zalo, tài liệu, hộp thư được giữ nguyên.

## Dùng tên miền riêng (không qua Cloudflare)

Mặc định bot tự mở một địa chỉ HTTPS miễn phí `xxx.trycloudflare.com` cho webhook. Địa chỉ này **đổi mỗi
lần khởi động lại**, nên với Zalo OA/Fanpage phải xác thực và dán webhook lại. Có tên miền riêng thì dùng
nó cho cố định.

1. Nơi quản lý tên miền (Tenten, Mắt Bão, PA, GoDaddy…) → thêm bản ghi **A**: tên `chat` → **IP của VPS**
   (dùng Cloudflare DNS thì tắt đám mây cam). Nên dùng tên miền con riêng (`chat.tenmien.vn`) để không đụng
   website đang chạy. Chờ 5–15 phút.
2. Mở **cổng 80 và 443** ở tường lửa của nhà cung cấp VPS (nếu họ có tường lửa riêng ngoài máy).
3. Trang quản trị → **Kết nối kênh** → thẻ *Zalo OA* → bước 3 → mở *Dùng tên miền riêng* → tích **Bật tên miền riêng** → nhập
   `chat.tenmien.vn` → **Kiểm tra & dùng**. Bot tự kiểm tên miền đã trỏ đúng VPS chưa, rồi tự đặt HTTPS
   (Let's Encrypt, tự gia hạn), mất 1–3 phút:
   - VPS đã có **nginx** → thêm một site riêng cho `chat.tenmien.vn` + certbot, không đụng site khác.
   - VPS trống → cài **Caddy**.
   - Có web server khác (Apache, aaPanel/CyberPanel…) → không tự sửa, hiện cấu hình mẫu để bạn tự thêm
     (bên dưới), thêm xong bấm lại *Kiểm tra & dùng*.
4. Xong, trang quản trị tự chuyển sang `https://chat.tenmien.vn` (đăng nhập lại). Webhook cố định là
   `https://chat.tenmien.vn/webhook/zalo-oa` và `/webhook/facebook` — dán lại vào Zalo/Facebook và xác thực
   domain `chat.tenmien.vn` cho Zalo OA bằng thẻ meta như bước 4 phần Zalo OA, **chỉ cần làm một lần**.

Bỏ tích là quay về địa chỉ Cloudflare. Cũng có thể đặt ngay lúc cài: thêm tên miền sau API key
(`... | sudo bash -s -- sk_khoa chat.tenmien.vn`).

**Tự cấu hình web server**: bot nghe ở `127.0.0.1:8790`, site của bạn chỉ cần chuyển tiếp về đó và gửi kèm
IP khách, rồi tích ô ở trang quản trị như bước 3.
```
# nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 30m;
}
# Caddy
chat.tenmien.vn {
    reverse_proxy 127.0.0.1:8790 {
        header_up X-Real-IP {remote_host}
    }
}
```

**Bot chạy trên Mac/Windows ở nhà/văn phòng**: máy không có IP công khai nên tên miền không trỏ thẳng vào được.
Muốn địa chỉ cố định thì cài bot lên VPS (khuyên dùng — chạy 24/7), hoặc tự tạo Cloudflare Tunnel có tên trỏ
`chat.tenmien.vn` → `http://localhost:8790`, rồi tích ô ở trang quản trị như bước 3.
Zalo cá nhân và Telegram **không cần** HTTPS/tên miền — chỉ Zalo OA và Fanpage cần.

## Hộp thư chung

Mọi tin của Zalo, Zalo OA, Fanpage, Telegram về **một hộp thư**: lọc chưa đọc, tìm theo tên/nội dung.
- Bấm **Tôi trả lời** (hoặc gửi một tin từ hộp thư) → bot nghỉ cuộc đó 2 giờ, rồi tự trả lại.
- Nhân viên trả lời thẳng trên điện thoại (Zalo, Meta Business Suite) cũng được nhận ra → bot tự im.
- Lịch sử giữ 90 ngày.

### Chia khách cho nhân viên

Mục **👥 Nhân viên** (chỉ chủ shop thấy): thêm tên → trang hiện mật khẩu riêng **một lần**, chép gửi nhân viên.
- Nhân viên đăng nhập bằng mật khẩu đó, **chỉ thấy Hộp thư**: cuộc giao cho mình + cuộc chưa giao. Không xem được khoá API, tài liệu, cài đặt.
- Bật **Tự chia khách mới** → khách mới vào người ít việc nhất (24 giờ qua); khách cũ nhắn lại vẫn về người cũ.
- Tắt tự chia → cuộc nằm ở **Chưa giao**; nhân viên bấm **Nhận cuộc này** hoặc trả lời là nhận luôn.
- Chủ shop đổi người phụ trách bằng ô chọn trên đầu cuộc chat. Xoá nhân viên → cuộc của họ về Chưa giao, máy họ bị đăng xuất. Cấp mật khẩu mới cũng đăng xuất máy cũ.
- Nhân viên mở ở đâu: mục Nhân viên ghi sẵn địa chỉ (cùng Wi-Fi với máy chạy bot), hoặc tên miền riêng nếu đã gắn.
- Bật **Bot im ở cuộc đã giao** nếu muốn khách đã có người phụ trách chỉ do người đó trả lời; cuộc chưa giao bot vẫn trả lời.
- Mục Nhân viên có **Thống kê** (hôm nay / 7 / 30 ngày): mỗi người gửi bao nhiêu tin, cho bao nhiêu khách, trả lời trung bình sau bao lâu, xong bao nhiêu cuộc được giao.

### Thẻ khách, đã xong, ghi chú, câu mẫu

- **Thẻ khách**: trên đầu cuộc chat bấm thẻ để gắn/bỏ (một khách gắn nhiều thẻ). Danh sách hiện thẻ màu, ô **Mọi thẻ** để lọc. Sửa tên, màu, thêm/xoá thẻ ở mục **🏷️ Thẻ & câu mẫu** (xoá thẻ là gỡ khỏi mọi khách).
- **✓ Xong**: cuộc đã xử lý xong rời khỏi danh sách chính (xem ở lọc **Đã xong**); khách nhắn lại thì tự mở lại.
- **Ghi chú nội bộ**: tích ô **Ghi chú** cạnh ô trả lời → tin lưu vào cuộc chat, nền vàng, **khách không nhận được**. Dùng để dặn nhau ("hẹn 3h gọi lại").
- **Câu mẫu**: gõ `/` trong ô trả lời → chọn câu có sẵn (mũi tên + Enter). Sửa danh sách ở mục Thẻ & câu mẫu; nhân viên dùng chung.
- **Tự gắn thẻ**: mỗi thẻ có cột **Từ khoá** (cách nhau dấu phẩy). Khách nhắn có từ đó (không phân biệt dấu) thì cuộc tự được gắn thẻ — vd "giá sỉ, mua buôn" → Khách sỉ; "hoàn tiền, hàng lỗi" → Khiếu nại. Chỉ thêm thẻ, không tự gỡ.
- **Khách chờ lâu**: khách nhắn mà chưa ai trả lời quá 5 phút → nhãn đỏ "chờ X phút" trong danh sách.
- **🔔 Báo tin**: bật ở đầu Hộp thư → có tin mới thì kêu "bíp" và tab trình duyệt hiện số tin chưa đọc (mỗi máy bật riêng).
- Cuộc chat **có thẻ được giữ mãi**; cuộc không thẻ tự dọn sau 90 ngày.

### Danh sách khách hàng & remarketing (chỉ chủ shop)

Mục **👥 Khách hàng** gom mọi khách từng nhắn (trừ nhóm): tên, SĐT, email, địa chỉ bot tự ghi nhận trong lúc chat, kèm kênh, thẻ, người phụ trách, lần nhắn cuối. Bấm một dòng để mở cuộc chat.

- Lọc theo tên/SĐT (gõ không dấu cũng được), theo thẻ, hoặc tích **Chỉ khách có SĐT**.
- **Xuất CSV** → mở bằng Excel/Google Sheets (đúng tiếng Việt). Dùng để:
  - gửi Zalo ZNS / SMS chăm sóc theo cột SĐT;
  - tải lên **Facebook / Google Ads** làm tệp đối tượng (Custom Audience) theo SĐT hoặc email;
  - gọi lại nhóm "Khách sỉ", "Khiếu nại"… bằng cách lọc thẻ trước khi xuất.
- Chỉ nhắn quảng cáo cho khách đã đồng ý nhận tin. Tệp CSV có số điện thoại khách — đừng gửi lung tung.

## 2. Nạp tài liệu (để bot trả lời đúng giá, đúng chính sách)

Trang quản trị → **Tài liệu** → dán chữ, chọn tệp **PDF** (tới 60 MB) / `.txt/.md/.csv`, hoặc dán link trang web.
PDF được bóc chữ ngay trên VPS (không tốn token). PDF chụp ảnh (scan, không bôi đen được chữ) thì không đọc được — dùng bản xuất từ Word/Excel.

Bot **không đọc cả tài liệu mỗi tin**: nó tìm tối đa 3 đoạn khớp nhất với câu hỏi (≤ 2.400 ký tự)
rồi mới gửi cho AI. Tài liệu 500 trang cũng chỉ tốn chừng ấy. Đo thật: tài liệu 41 KB, một câu hỏi
về phí ship tốn ~1.000 token (đưa nguyên tài liệu sẽ tốn ~15.000).

Mẹo tiết kiệm thêm — **Hỏi nhanh** (tab Cách trả lời): câu hay gặp trả lời ngay, 0 token.
```
dia chi|o dau|shop o dau => Shop ở 45 Nguyễn Trãi Q5, mở cửa 8h-21h.
stk|chuyen khoan => Vietcombank 0123456789 - CONG TY ABC.
```

Bấm **Thử bot** để hỏi thử trước khi bật cho khách thật.

## 3. Kết nối kênh

### Zalo cá nhân (quét QR)
1. Tab **Kết nối kênh** → tick *Tôi hiểu rủi ro* → **Hiện mã QR**.
2. Điện thoại: Zalo → biểu tượng QR → quét → xác nhận đăng nhập.
3. Trạng thái chuyển **đang chạy** là xong. VPS khởi động lại bot tự nối lại, không cần quét.

Lưu ý quan trọng:
- Đây là kết nối **không chính thức** (giả lập Zalo Web). Zalo có thể khoá tài khoản → **dùng số Zalo phụ**.
- Mở Zalo Web trên trình duyệt bằng số đó sẽ làm bot ngắt (Zalo chỉ cho một phiên web).
- Trong nhóm: mặc định không trả lời. Bật *Trả lời trong nhóm* và đặt *tên gọi* để bot chỉ trả lời khi được gọi.

### Zalo OA (chính thức, cho doanh nghiệp/hộ kinh doanh)
1. developers.zalo.me → tạo ứng dụng → liên kết Official Account.
2. Lấy **App ID**, **Secret key**; cấp quyền cho OA để lấy **Refresh token**.
3. Dán 3 giá trị vào trang quản trị → **Lưu**. Bot thử lấy token ngay, sai thì báo đỏ trên thẻ Zalo OA kèm cách sửa. Sau đó bot tự làm mới token (token Zalo hết hạn sau ~25 giờ).
   **Secret key** là *Khóa bí mật của ứng dụng* ở developers.zalo.me → ứng dụng → **Thiết lập chung** — không phải *OA Secret Key* ở trang Webhook (hai mã khác nhau, dán nhầm sẽ báo "Secret key sai").
   Không cần điền ô *Official Account Callback Url* — refresh token lấy ở developers.zalo.me → Công cụ → API Explorer → chọn OA Access Token là được. Mỗi refresh token chỉ dùng một lần: dán vào bot rồi thì đừng bấm Reset hay dùng lại.
4. **Xác thực domain** (Zalo không nhận webhook ở domain chưa xác thực): ứng dụng Zalo → *Xác thực domain* → nhập domain của địa chỉ webhook trong trang quản trị (vd `abc-xyz.trycloudflare.com`, hoặc `chat.tenmien.vn` nếu dùng tên miền riêng) → chọn cách **thẻ meta** → copy thẻ → dán vào ô *Thẻ meta xác thực* ở trang quản trị → Lưu → quay lại Zalo bấm *Xác thực* (Zalo có thể trễ vài phút, bấm lại nếu chưa được).
5. Trong ứng dụng Zalo → **Webhook** → dán địa chỉ webhook hiển thị trong trang quản trị, bật sự kiện *user_send_text* và *oa_send_text*.

Lưu ý: địa chỉ `trycloudflare.com` đổi mỗi lần bot khởi động lại → phải xác thực domain và dán webhook lại. Dùng lâu dài nên dùng tên miền riêng (mục ở trên).
Zalo OA chỉ cho trả lời người đã **quan tâm (follow) OA** và nhắn OA trong **7 ngày** gần nhất.
**OA phải mua gói dịch vụ** (zalo.cloud/oa/pricing) thì Zalo mới cho gửi tin tư vấn qua API — chưa có gói, Zalo trả lỗi `-224`. Khi đó bot ngừng gọi AI cho OA (đỡ tốn token), tin khách vẫn về Hộp thư, bạn trả lời tay ở oa.zalo.me. Mua gói xong, bot tự thử gửi lại sau tối đa 6 giờ (hoặc khởi động lại bot).

### Facebook Fanpage
1. developers.facebook.com → tạo app (loại Business) → thêm sản phẩm **Messenger**.
2. Nối Trang → tạo **Page Access Token**; ghi **Page ID**.
3. Messenger → Webhooks: dán **Callback URL** và **Verify token** từ trang quản trị, đăng ký trường `messages`.
4. Trang quản trị → Fanpage → Thêm Trang → dán Page ID, Token. Nên dán cả **App Secret** để bot kiểm chữ ký.
   Bấm **Lưu**: bot tự kiểm token đúng Trang chưa và tự đăng ký Trang nhận tin (subscribed_apps). Báo lỗi thì đọc dòng cảnh báo — thường là dán nhầm User token thay vì Page token.
5. Muốn trả lời người ngoài (không phải admin app) thì app phải qua duyệt quyền `pages_messaging` của Meta.
6. **Bình luận → nhắn riêng** (khách bình luận dưới bài, bot tự inbox): Fanpage → mục *Bình luận → nhắn riêng* → bật.
   - Webhooks của app bật thêm trường `feed`; token Trang cần thêm quyền `pages_manage_engagement`, `pages_read_engagement`.
   - Lọc theo từ khoá (vd `giá, ib, inbox`) và theo bài; tin riêng để trống thì AI trả lời theo tài liệu, có `{ten}` để gọi tên.
   - Trả lời công khai: mỗi dòng một câu, bot chọn ngẫu nhiên. Có thể tự ẩn bình luận sau khi trả lời.
   - Meta chỉ cho **một** tin riêng / bình luận trong 7 ngày; khách trả lời lại thì cuộc chat vào Hộp thư như Messenger thường.

### Telegram
Nhắn @BotFather → `/newbot` → dán token. Xong.

### Website (khung chat nổi)
Mục Kết nối → thẻ **Website** → chép dòng `<script src="https://<địa chỉ bot>/web/widget.js" async></script>` dán vào trước `</body>` của website (WordPress: plugin "Insert Headers and Footers" hoặc "WPCode"). Góc phải dưới hiện nút chat; khách nhắn là bot trả lời, tin về Hộp thư với nhãn Website, bạn trả lời tay từ Hộp thư thì khách thấy ngay trên trang.
- Đổi tên khung, màu, câu chào ngay ở thẻ đó rồi Lưu (website cập nhật sau tối đa 5 phút).
- Cần địa chỉ HTTPS cố định: dùng tên miền riêng. Đường hầm tạm (trycloudflare) đổi địa chỉ mỗi lần bot khởi động lại, phải dán lại mã.
- Mỗi IP nhắn tối đa 15 tin/phút; tin trả lời giữ 2 giờ để khách quay lại trang vẫn thấy.

## 4. Chi phí

Mỗi tin bot trả lời trừ credit theo model đã chọn (mặc định `deepseek-v4.1-flash`, rẻ nhất).
Mỗi lượt chỉ gửi: vai trò ngắn + 6 tin gần nhất (mỗi tin ≤ 500 ký tự) + tối đa 3 đoạn tài liệu.
Đặt trần chi tiêu theo ngày cho API key ở revidapi.com/dashboard → API key, để bot không bao giờ tiêu quá số bạn muốn.

## 5. Khi bot không trả lời

| Thấy gì | Làm gì |
|---|---|
| Zalo: *mất kết nối* | Có ai mở Zalo Web bằng số đó? Đóng lại; bot tự nối lại sau 30 giây. Vẫn không được → quét QR lại |
| Nhật ký báo hết credit | Nạp thêm, hoặc nâng trần chi tiêu ngày |
| Fanpage im lặng sau khi VPS khởi động lại | Địa chỉ HTTPS miễn phí đã đổi → copy Callback URL mới vào Facebook (hoặc dùng tên miền riêng) |
| Hộp thư có ô đỏ **⚠ Chưa gửi tới khách** | Bot đã soạn câu trả lời nhưng kênh từ chối gửi — ô đỏ ghi rõ lý do. Hay gặp nhất: Zalo OA *lỗi token* |
| Zalo OA: **Zalo chặn gửi** (lỗi -224) | OA chưa mua gói dịch vụ — mua ở zalo.cloud/oa/pricing; trong lúc chờ trả lời tay ở oa.zalo.me |
| Zalo OA: **lỗi token** | Tạo Refresh token mới (API Explorer → đúng ứng dụng → OA Access Token), kiểm Secret key là *Khóa bí mật của ứng dụng* → dán → Lưu → nhắn thử |
| Bot trả lời sai giá | Bổ sung tài liệu, hoặc thêm vào Hỏi nhanh |

Muốn một khách cụ thể không bị bot trả lời (người quen, đang có nhân viên chat tay): copy mã cuộc trong
**Nhật ký** (vd `zalo:123456`) vào ô *Không trả lời các cuộc*.

## 6. Bảo mật

- Token Zalo/Facebook/Telegram và API key chỉ nằm trên VPS của bạn (`/opt/kenh-chat/data`, quyền 600),
  không gửi cho AI và không gửi về RevidAPI.
- Trang quản trị khoá bằng mật khẩu, sai 10 lần bị chặn 15 phút.
- Quên mật khẩu: `sudo grep matKhau /opt/kenh-chat/data/cau-hinh.json`.

## Tắt máy, mở lại có phải làm gì không?

Không. Bot tự chạy lại khi máy/VPS bật (Mac: LaunchAgent, VPS: systemd), tự mở lại phiên Zalo cá nhân đã quét và token OA/Fanpage/Telegram đã lưu. Lịch sử chat và tài liệu nằm trong `data/kho.db`, không mất.
Hai trường hợp cần làm lại: (1) đang dùng đường hầm `trycloudflare.com` — địa chỉ đổi, phải dán webhook Zalo OA/Fanpage lại (dùng tên miền riêng thì không); (2) Zalo cá nhân bị đăng xuất (mở Zalo Web bằng số đó, hoặc Zalo tự đăng xuất) — quét QR lại.

## Chấm điểm bot tìm tài liệu (miễn phí)

```bash
cd ~/.revidapi/kenh-chat && node cham-diem.mjs
```

Lần đầu tự tạo `data/cau-mau.txt` từ các câu nhân viên đã trả lời. Mỗi dòng: `câu khách hỏi | chữ phải có`.
Câu ✗ nghĩa là tài liệu thiếu hoặc gọi tên khác cách khách gọi — sửa tài liệu rồi chạy lại.

## Giao việc qua chat

Chủ (kênh đã nối bằng mã chủ):
- `#viec Tên việc @tên người 30/10` — tạo việc; người và hạn có thể bỏ. Người nhận đã nối chat sẽ được báo ngay.
- `#ds` — việc đang mở, kèm mã 4 ký tự. `#xong <mã>` — đánh dấu xong.

Nhân viên: nhắn bot `#toi <mã nhân viên>` (mã trên bảng Nhân sự) một lần. Sau đó `#ds` chỉ thấy việc của mình, `#xong <mã>` thì chủ được báo.

Nhắc hạn: từ 09:00 mỗi ngày, việc hạn ngày mai được nhắc một lần cho chủ và cho người được giao. Đổi giờ bằng `NHAC_HAN=08:00`, tắt bằng `NHAC_HAN=tat`. Báo cáo sáng/tối: `BAO_SANG` (07:30), `BAO_TOI` (21:00).

## Gửi loạt cho khách cũ

Trang quản trị → *Khách hàng* → lọc theo tên/số điện thoại, thẻ, hoặc "chỉ khách có SĐT" → mở *Gửi loạt*.
- Viết tin, dùng `{ten}` (tên gọi) hoặc `{ten_day_du}`. Bấm **Xem ai sẽ nhận** để thấy số người và tin mẫu trước khi gửi.
- Bấm **Gửi** hai lần mới gửi thật. Mặc định cách nhau ~5 giây/người (3–60) để tài khoản không bị khoá; có nút **Dừng**.
- Tự bỏ qua: khách chỉ gặp trong nhóm, khách Website, khách Fanpage nhắn quá 24 giờ, khách Zalo OA quá 7 ngày (luật của Facebook/Zalo). Lý do bỏ hiện ngay trên trang.

## Chăm sóc tự động

*Khách hàng* → *Chăm sóc tự động*: thêm tối đa 10 bước "sau X giờ khách im lặng thì gửi tin này", có thể chỉ áp cho khách mang một thẻ.
- Mỗi bước chỉ gửi một lần cho mỗi lần khách im lặng; khách nhắn lại thì đếm lại từ đầu.
- Không gửi khi nhân viên đang tiếp quản, cuộc chat đã đánh dấu xong, hoặc đã quá hạn kênh (như Gửi loạt).
- Bảng hiện số tin đã gửi/lỗi 7 ngày qua cho từng bước. Bot quét mỗi 10 phút.
