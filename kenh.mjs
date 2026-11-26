// Bốn kênh: Zalo cá nhân (quét QR), Zalo OA, Facebook Fanpage, Telegram.
// Mỗi kênh làm ba việc: nhận tin → bộ não → gửi trả lời; `gui()` để nhân viên trả lời từ
// hộp thư; nhận ra khi nhân viên trả lời thẳng trên điện thoại (Zalo, Messenger) để bot
// tự im cho cuộc đó. Token của kênh nằm trong cau-hinh.json trên máy khách, không gửi AI.
import crypto from "node:crypto";
import fs from "node:fs";
import { anhDataUri, tachAnh, taiAnh } from "./noi-dung.mjs";
import { boDau } from "./kho-tai-lieu.mjs";

// Tin do chính chương trình gửi đi (bot hoặc hộp thư) — để phân biệt với tin nhân viên
// gõ trên điện thoại, vì Zalo/Messenger đều báo lại cả hai là "tin của mình".
class DaGui {
  constructor() { this.ds = new Map(); }
  khoa(ma, chu) { return ma + "|" + crypto.createHash("sha1").update(String(chu).trim()).digest("hex"); }
  them(ma, chu) { this.ds.set(this.khoa(ma, chu), Date.now()); this.don(); }
  laCuaMinh(ma, chu) { return this.ds.delete(this.khoa(ma, chu)); }
  don() { const moc = Date.now() - 5 * 60e3; for (const [k, t] of this.ds) if (t < moc) this.ds.delete(k); }
}

function nhanVienTraLoi(hopThu, kenh, ma, chu) {
  const khoa = hopThu.ghi(kenh, ma, { vai: "nhan_vien", chu });
  hopThu.tiepQuan(khoa);
}

// Bot đã soạn xong nhưng nền tảng từ chối: ghi vào hộp thư để chủ thấy khách CHƯA nhận được,
// thay vì để câu trả lời nằm đó như đã gửi.
function guiThatBai(hopThu, bao, kenh, ma, lyDo) {
  hopThu.ghi(kenh, ma, { vai: "loi", chu: "Chưa gửi được tới khách: " + lyDo });
  bao(kenh, lyDo);
}

// Lỗi Zalo OA hay gặp, dịch ra việc chủ cần làm.
const LOI_OA = {
  "-213": "người này chưa quan tâm (follow) OA.",
  "-230": "người này không nhắn OA trong 7 ngày qua — Zalo chỉ cho trả lời trong 7 ngày.",
  "-224": "OA chưa mua gói dịch vụ nên Zalo không cho gửi tin tư vấn qua API. Mua gói ở zalo.cloud/oa/pricing (thường là gói Nâng cao trở lên); trong lúc chờ, trả lời tay ở oa.zalo.me — tin khách vẫn về Hộp thư.",
};
// Các lỗi này đúng cho cả OA, không riêng một khách → tạm ngừng gọi AI để đỡ tốn token.
const LOI_OA_CA_KENH = new Set([-224]);
const LOI_TOKEN_OA = {
  "Invalid secret key": "Secret key sai. Lấy ở developers.zalo.me → ứng dụng → Thiết lập chung → Khóa bí mật của ứng dụng (không phải \"OA Secret Key\" ở trang Webhook).",
  "Invalid refresh token.": "Refresh token sai hoặc đã dùng rồi (mỗi refresh token chỉ dùng được một lần). Tạo mới ở API Explorer: chọn đúng ứng dụng, loại OA Access Token.",
};

// ---------------- Zalo cá nhân (zca-js, không chính thức) ----------------
export class ZaloCaNhan {
  constructor({ fileDangNhap, boNao, hopThu, layCauHinh, bao, kenh = this.kenh }) {
    // kenh: this.kenh, "zalo2", "zalo3" — mỗi tài khoản một kênh riêng, trả lời đúng tài khoản nhận tin.
    Object.assign(this, { fileDangNhap, boNao, hopThu, layCauHinh, bao, kenh });
    this.trangThai = "chưa nối";
    this.qr = null;
    this.api = null;
    this.daGui = new DaGui();
    this.botGuiLuc = new Map();   // threadId -> lúc bot vừa gửi (để nhận ra ảnh do chính bot gửi)
  }

  async _zalo() {
    const m = await import("zca-js");
    return { Zalo: m.Zalo, ThreadType: m.ThreadType, Su: m.LoginQRCallbackEventType };
  }

  // Khởi động lại sau khi máy/VPS bật lại: dùng phiên đã lưu, không cần quét lại.
  async moLai() {
    if (!fs.existsSync(this.fileDangNhap)) return;
    try {
      const { Zalo } = await this._zalo();
      const cred = JSON.parse(fs.readFileSync(this.fileDangNhap, "utf8"));
      this._gan(await new Zalo({ selfListen: true }).login(cred));
    } catch (e) {
      this.trangThai = "mất phiên — quét QR lại";
      this.bao(this.kenh, "Không mở lại được phiên: " + (e?.message || e));
    }
  }

  async quetQR() {
    const { Zalo, Su } = await this._zalo();
    this.qr = null;
    this.trangThai = "đang chờ quét QR";
    // selfListen: nghe cả tin chính tài khoản này gửi → biết nhân viên trả lời trên điện thoại.
    new Zalo({ selfListen: true }).loginQR({}, (ev) => {
      if (ev.type === Su.QRCodeGenerated) {
        const img = ev.data.image || "";
        this.qr = img.startsWith("data:") ? img : "data:image/png;base64," + img;
      } else if (ev.type === Su.QRCodeScanned) {
        this.trangThai = "đã quét, chờ xác nhận trên điện thoại";
      } else if (ev.type === Su.QRCodeExpired) {
        this.trangThai = "mã QR hết hạn — bấm hiện lại"; this.qr = null;
      } else if (ev.type === Su.QRCodeDeclined) {
        this.trangThai = "bị từ chối trên điện thoại"; this.qr = null;
      } else if (ev.type === Su.GotLoginInfo) {
        fs.writeFileSync(this.fileDangNhap, JSON.stringify(ev.data), { mode: 0o600 });
      }
    }).then((api) => this._gan(api)).catch((e) => {
      this.trangThai = "lỗi đăng nhập: " + (e?.message || e); this.qr = null;
    });
  }

  async gui(ma, chu, loai) {
    if (!this.api) throw new Error("Zalo chưa kết nối.");
    const { ThreadType } = await this._zalo();
    await this._guiCa(ma, chu, loai === "nhom" ? ThreadType.Group : ThreadType.User);
  }

  // Gửi chữ, rồi từng ảnh mà câu trả lời có link (.jpg/.png…) — Zalo nhận ảnh dạng tệp đính kèm.
  async _guiCa(ma, chu, kieu, quote) {
    const { chu: chuGon, anh } = tachAnh(chu);
    if (chuGon) { this.daGui.them(ma, chuGon); await this.api.sendMessage({ msg: chuGon, quote }, ma, kieu); }
    for (const u of anh) {
      const a = await taiAnh(u);
      if (!a) { this.bao(this.kenh, "Không tải được ảnh để gửi: " + u); continue; }
      await this.api.sendMessage({ msg: "", attachments: [{ data: a.buf, filename: a.ten, metadata: { totalSize: a.buf.length } }] }, ma, kieu);
    }
  }

  async _gan(api) {
    const { ThreadType } = await this._zalo();
    this.api = api;
    this.qr = null;
    this.trangThai = "đang chạy";
    try {
      const ctx = api.getContext?.();
      if (ctx?.cookie && !fs.existsSync(this.fileDangNhap)) {
        fs.writeFileSync(this.fileDangNhap, JSON.stringify({ cookie: ctx.cookie, imei: ctx.imei, userAgent: ctx.userAgent }), { mode: 0o600 });
      }
    } catch { /* phiên vẫn chạy, chỉ là không lưu được để mở lại */ }

    api.listener.on("message", async (msg) => {
      try {
        // Chữ thường là string; ảnh (chat.photo) và link (chat.recommended) là object — trước đây
        // bị bỏ qua im lặng nên khách gửi ảnh/link không bao giờ được trả lời.
        const c = msg.data?.content;
        let chu = "", anh = [];
        if (typeof c === "string") chu = c;
        else if (c && typeof c === "object" && (c.href || c.thumb)) {
          const kieuTin = String(msg.data.msgType || "");
          if (/photo|image/i.test(kieuTin)) {
            chu = [c.title, c.description].find((x) => x && typeof x === "string" && !/^https?:/.test(x)) || "";
            if (!msg.isSelf) { const d = await anhDataUri(c.href || c.thumb, { giuLink: true }); if (d) anh = [d]; }
          } else if (c.href) chu = [c.title, c.href].filter((x) => x && typeof x === "string").join(" ");
        }
        if (!chu && !anh.length && !(msg.isSelf && c && typeof c === "object")) return;
        const nhom = msg.type === ThreadType.Group;
        const loai = nhom ? "nhom" : "rieng";
        if (msg.isSelf) {
          // Tin "của mình" mà không phải do chương trình gửi → nhân viên trả lời trên điện thoại.
          // Ảnh/tệp nhân viên gửi từ điện thoại cũng là nhân viên đang trả lời (ảnh bot gửi đi
          // không có chữ — bỏ qua tin không chữ đến trong 20 giây sau lượt bot).
          if (typeof c === "string") { if (!this.daGui.laCuaMinh(msg.threadId, chu)) nhanVienTraLoi(this.hopThu, this.kenh, msg.threadId, chu); }
          else if (Date.now() - (this.botGuiLuc.get(msg.threadId) || 0) > 20000) nhanVienTraLoi(this.hopThu, this.kenh, msg.threadId, chu || "[ảnh/tệp]");
          return;
        }
        const ch = this.layCauHinh().zalo || {};
        if (nhom && !ch.traLoiNhom) {
          this.hopThu.ghi(this.kenh, msg.threadId, { vai: "khach", chu: `${msg.data.dName}: ${chu}`, loai });
          return;
        }
        // Trong nhóm chỉ trả lời khi được gọi tên, tránh "spam" cả nhóm và tốn tiền.
        const goiTen = !nhom || !ch.tenGoi || chu.toLowerCase().includes(ch.tenGoi.toLowerCase());
        if (!goiTen) {
          this.hopThu.ghi(this.kenh, msg.threadId, { vai: "khach", chu: `${msg.data.dName}: ${chu}`, loai });
          return;
        }
        const ra = await this.boNao.traLoi(this.kenh, msg.threadId, chu, {
          maTin: this.kenh + ":" + msg.data.msgId, tenNguoi: nhom ? msg.data.dName : null,
          tenCuoc: nhom ? null : msg.data.dName, loai, maNguoi: nhom ? msg.data.uidFrom : null, anh });
        if (ra) {
          this.botGuiLuc.set(msg.threadId, Date.now());
          await this._guiCa(msg.threadId, ra, msg.type, nhom ? msg.data : undefined)
            .catch((e) => guiThatBai(this.hopThu, this.bao, this.kenh, msg.threadId, "Zalo: " + (e?.message || e)));
        }
      } catch (e) { this.bao(this.kenh, "Lỗi xử lý tin: " + (e?.message || e)); }
    });
    api.listener.on("closed", () => {
      this.trangThai = "mất kết nối (có thể do mở Zalo Web) — đang nối lại";
      setTimeout(() => this.moLai(), 30000);
    });
    api.listener.on("error", (e) => this.bao(this.kenh, "Listener lỗi: " + (e?.message || e)));
    api.listener.start();
  }

  ngat() {
    try { this.api?.listener?.stop(); } catch { /* đã dừng */ }
    this.api = null;
    if (fs.existsSync(this.fileDangNhap)) fs.unlinkSync(this.fileDangNhap);
    this.trangThai = "chưa nối";
  }
}

// ---------------- Zalo OA (API chính thức) ----------------
// Webhook: Zalo gửi POST tới /webhook/zalo-oa. Token truy cập sống ~25 giờ, refresh
// token ~3 tháng và ĐỔI mỗi lần làm mới → phải lưu lại ngay.
export class ZaloOA {
  constructor({ boNao, hopThu, layCauHinh, ghiCauHinh, bao }) {
    Object.assign(this, { boNao, hopThu, layCauHinh, ghiCauHinh, bao });
    this.daGui = new DaGui();
    this.ten = new Map();   // user_id -> tên khách
    this.biChan = null;     // { loi, luc } khi Zalo chặn gửi cả OA (vd -224 chưa mua gói)
    setInterval(() => this.lamMoi().catch(() => {}), 20 * 3600e3).unref();
  }

  // Zalo ký webhook: X-ZEvent-Signature = "mac=" + sha256(appId + thân gốc + timestamp + OA Secret Key).
  // Khoá này ở trang Webhook của ứng dụng, khác "Khóa bí mật của ứng dụng".
  chuKyDung(than, chuKy) {
    const oa = this.layCauHinh().zaloOA || {};
    if (!oa.oaSecretKey) return true;   // chưa nhập thì không kiểm được — trang quản trị có cảnh báo
    let ts = "";
    try { ts = String(JSON.parse(than.toString() || "{}").timestamp ?? ""); } catch { return false; }
    const dung = "mac=" + crypto.createHash("sha256").update(String(oa.appId || "") + than.toString() + ts + oa.oaSecretKey).digest("hex");
    return !!chuKy && chuKy.length === dung.length && crypto.timingSafeEqual(Buffer.from(chuKy), Buffer.from(dung));
  }

  get trangThai() {
    const oa = this.layCauHinh().zaloOA || {};
    if (oa.accessToken) return this.dangBiChan() ? "lỗi: Zalo chặn gửi" : "đang chạy";
    return this.loiToken ? "lỗi token" : "chưa nối";
  }

  // Bị chặn cả OA thì 6 giờ thử gửi lại một lần (chủ có thể vừa mua gói).
  dangBiChan() { return this.biChan && Date.now() - this.biChan.luc < 6 * 3600e3; }
  get loi() { return this.loiToken || (this.dangBiChan() ? this.biChan.loi : ""); }

  async tenKhach(ma) {
    if (this.ten.has(ma)) return this.ten.get(ma);
    let ten = null;
    try {
      const r = await fetch("https://openapi.zalo.me/v3.0/oa/user/detail?data=" + encodeURIComponent(JSON.stringify({ user_id: ma })), {
        headers: { access_token: this.layCauHinh().zaloOA?.accessToken || "" }, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      ten = j?.data?.display_name || null;
    } catch { /* không có tên thì panel hiện mã */ }
    this.ten.set(ma, ten);
    return ten;
  }

  async lamMoi() {
    const oa = this.layCauHinh().zaloOA || {};
    if (!oa.appId || !oa.secretKey || !oa.refreshToken) {
      if (oa.refreshToken) this.loiToken = "Thiếu " + (!oa.appId ? "App ID" : "Secret key") + " — điền ở Kết nối kênh → Zalo OA.";
      return;
    }
    const r = await fetch("https://oauth.zaloapp.com/v4/oa/access_token", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { secret_key: oa.secretKey, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ app_id: oa.appId, grant_type: "refresh_token", refresh_token: oa.refreshToken }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) {
      const goc = String(j.error_description || j.error_name || "HTTP " + r.status);
      this.loiToken = LOI_TOKEN_OA[goc] || "Zalo từ chối làm mới token: " + goc;
      this.bao("zalo-oa", "Làm mới token thất bại: " + goc);
      return;
    }
    this.loiToken = "";
    this.ghiCauHinh({ zaloOA: { ...oa, accessToken: j.access_token, refreshToken: j.refresh_token || oa.refreshToken, lamMoiLuc: Date.now() } });
  }

  async gui(ma, chuDu) {
    const { chu, anh } = tachAnh(chuDu);
    if (chu) await this._gui(ma, { text: chu.slice(0, 2000) }, chu);
    // Ảnh: tin dạng template media, Zalo tự tải từ link công khai.
    for (const url of anh) await this._gui(ma, { attachment: { type: "template", payload: { template_type: "media", elements: [{ media_type: "image", url }] } } });
  }

  async _gui(ma, message, chu) {
    const oa = this.layCauHinh().zaloOA || {};
    if (chu) this.daGui.them(ma, chu);
    const goi = () => fetch("https://openapi.zalo.me/v3.0/oa/message/cs", {
      method: "POST",
      headers: { access_token: this.layCauHinh().zaloOA?.accessToken || oa.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { user_id: ma }, message }),
    }).then((r) => r.json()).catch(() => ({ error: -1, message: "mất mạng" }));
    if (!this.layCauHinh().zaloOA?.accessToken) await this.lamMoi();
    if (!this.layCauHinh().zaloOA?.accessToken) throw new Error(this.loiToken || "Chưa có access token — dán Refresh token ở Kết nối kênh → Zalo OA.");
    let j = await goi();
    if (j.error === -216 || j.error === -124) {   // token hết hạn
      await this.lamMoi();
      if (this.loiToken) throw new Error(this.loiToken);
      j = await goi();
    }
    if (LOI_OA_CA_KENH.has(j.error)) this.biChan = { loi: LOI_OA[j.error], luc: Date.now() };
    else if (!j.error) this.biChan = null;
    if (j.error) throw new Error(LOI_OA[j.error] ? `Zalo OA (${j.error}): ${LOI_OA[j.error]}` : `Zalo OA (${j.error}): ${j.message || "lỗi không rõ"}`);
  }

  async nhan(body) {
    const chu = body?.message?.text;
    if (body?.event_name === "oa_send_text") {
      // OA gửi đi: do chương trình, hoặc nhân viên trả lời trong trang quản lý OA.
      const ma = body.recipient?.id;
      if (ma && chu && !this.daGui.laCuaMinh(ma, chu)) nhanVienTraLoi(this.hopThu, "zalo-oa", ma, chu);
      return;
    }
    // Ảnh và link khách gửi tới OA là sự kiện riêng — trước đây chỉ nhận user_send_text.
    let anh = [], chuVao = chu || "";
    const dk = body?.message?.attachments || [];
    if (body?.event_name === "user_send_image") {
      for (const a of dk.slice(0, 2)) { const d = a?.payload?.url && await anhDataUri(a.payload.url, { giuLink: true }); if (d) anh.push(d); }
    } else if (body?.event_name === "user_send_link") {
      chuVao = [chuVao, ...dk.map((a) => a?.payload?.url)].filter(Boolean).join(" ");
    } else if (body?.event_name !== "user_send_text") return;
    if (!chuVao && !anh.length) return;
    const ma = body.sender?.id;
    const tenCuoc = await this.tenKhach(ma);
    if (this.dangBiChan()) {
      // Gửi không được thì gọi AI chỉ tốn tiền — vẫn lưu tin để nhân viên trả lời tay.
      this.hopThu.ghi("zalo-oa", ma, { vai: "khach", chu: (anh.length ? "[ảnh] " : "") + chuVao, ten: tenCuoc });
      return;
    }
    const ra = await this.boNao.traLoi("zalo-oa", ma, chuVao, { maTin: "oa:" + body.message?.msg_id, tenCuoc, anh });
    if (ra) await this.gui(ma, ra).catch((e) => guiThatBai(this.hopThu, this.bao, "zalo-oa", ma, e.message));
  }
}

// ---------------- Facebook Fanpage (Messenger) ----------------
export class Fanpage {
  constructor({ boNao, hopThu, layCauHinh, bao }) {
    Object.assign(this, { boNao, hopThu, layCauHinh, bao });
    this.ten = new Map();   // psid -> tên khách (đỡ gọi Graph nhiều lần)
    this.daBl = new Map();  // comment_id / người+bài -> lúc đã trả lời (chống trả trùng, chống spam)
  }

  get trangThai() { return (this.layCauHinh().facebook?.trang || []).length ? "đang chạy" : "chưa nối"; }

  xacMinh(q) {
    const fb = this.layCauHinh().facebook || {};
    return q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === fb.maXacMinh ? q.get("hub.challenge") : null;
  }

  chuKyDung(than, chuKy) {
    const bm = this.layCauHinh().facebook?.appSecret;
    if (!bm) return true;   // chưa nhập App Secret thì không kiểm được
    const dung = "sha256=" + crypto.createHmac("sha256", bm).update(than).digest("hex");
    return chuKy && chuKy.length === dung.length && crypto.timingSafeEqual(Buffer.from(chuKy), Buffer.from(dung));
  }

  trang(pageId) { return (this.layCauHinh().facebook?.trang || []).find((t) => String(t.id) === String(pageId)); }

  // Kiểm token đúng Trang và đăng ký Trang vào webhook của app (subscribed_apps). Thiếu bước
  // đăng ký này Facebook không gửi tin nào về dù Callback URL đã xác minh — lỗi hay gặp nhất.
  async kiemTrang(t) {
    const G = "https://graph.facebook.com/v21.0/";
    try {
      const me = await (await fetch(`${G}me?fields=id,name&access_token=${encodeURIComponent(t.token)}`)).json();
      if (me.error) return `Trang ${t.ten || t.id}: token không dùng được — ${me.error.message}`;
      if (String(me.id) !== String(t.id)) return `Trang ${t.ten || t.id}: token này là của "${me.name}" (ID ${me.id}), không phải Page ID đã nhập. Cần Page Access Token, không phải User token.`;
      const dk = await (await fetch(`${G}${t.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes&access_token=${encodeURIComponent(t.token)}`, { method: "POST" })).json();
      if (!dk.success) return `Trang ${me.name}: chưa đăng ký nhận tin được — ${dk.error?.message || "không rõ"}. Token cần quyền pages_messaging và pages_manage_metadata.`;
      // Bình luận → nhắn riêng cần thêm trường "feed". Thiếu quyền thì chỉ cảnh báo, Messenger vẫn chạy.
      if (this.layCauHinh().facebook?.binhLuan?.bat) {
        const f = await (await fetch(`${G}${t.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes,feed&access_token=${encodeURIComponent(t.token)}`, { method: "POST" })).json();
        if (!f.success) return `Trang ${me.name}: Messenger đã nối, nhưng chưa nhận được bình luận — ${f.error?.message || "không rõ"}. Token cần thêm quyền pages_manage_engagement, pages_read_engagement.`;
      }
      return null;
    } catch (e) { return `Trang ${t.ten || t.id}: không gọi được Facebook — ${e.message}`; }
  }

  async tenKhach(trang, psid) {
    if (this.ten.has(psid)) return this.ten.get(psid);
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${psid}?fields=name&access_token=${encodeURIComponent(trang.token)}`);
      const j = await r.json();
      if (j.name) { this.ten.set(psid, j.name); return j.name; }
    } catch { /* không có quyền đọc tên thì để trống */ }
    return null;
  }

  async gui(ma, chuDu) {
    const { chu, anh } = tachAnh(chuDu);
    if (chu) await this._gui(ma, { text: chu.slice(0, 2000) });
    for (const url of anh) await this._gui(ma, { attachment: { type: "image", payload: { url, is_reusable: false } } });
  }

  async _gui(ma, message) {
    const [pageId, psid] = String(ma).split(":");
    const trang = this.trang(pageId);
    if (!trang) throw new Error("Không còn Trang " + pageId + " trong cấu hình.");
    const goi = (them) => fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(trang.token)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: psid }, message, ...them }),
    }).then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }));
    // Trong 24 giờ kể từ tin cuối của khách: gửi thường. Quá 24 giờ Meta chỉ cho gửi kèm thẻ
    // HUMAN_AGENT (7 ngày) — thẻ này cần app được duyệt quyền, nên chỉ dùng khi thường bị từ chối.
    let r = await goi({ messaging_type: "RESPONSE" });
    if (!r.ok && [10, 551, 2018278].includes(r.j?.error?.code ?? r.j?.error?.error_subcode)) {
      r = await goi({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
    }
    if (!r.ok) {
      const loi = r.j?.error?.message || "lỗi không rõ";
      throw new Error(/24|window|outside/i.test(loi)
        ? "Fanpage: đã quá 24 giờ từ tin cuối của khách — Meta chỉ cho trả lời tiếp khi app có quyền Human Agent. Trả lời trong Meta Business Suite."
        : "Fanpage: " + loi);
    }
  }

  // ---- Bình luận trên bài viết → trả lời công khai + nhắn riêng (private reply) ----
  // Meta cho đúng MỘT tin nhắn riêng / bình luận, trong 7 ngày. Khách trả lời tin đó thì
  // cuộc chat mở ra như tin Messenger bình thường (bot trả lời tiếp, vào Hộp thư).
  async graph(trang, duong, than) {
    const r = await fetch(`https://graph.facebook.com/v21.0/${duong}${duong.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(trang.token)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: than ? JSON.stringify(than) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error?.message || `HTTP ${r.status}`);
    return j;
  }

  khopBinhLuan(bl, chu, postId) {
    if (bl.baiViet && String(bl.baiViet).trim()) {
      const ds = String(bl.baiViet).split(/[\s,]+/).filter(Boolean);
      if (!ds.some((x) => String(postId).endsWith(x.replace(/^.*[/_]/, "")))) return false;
    }
    const tu = String(bl.tuKhoa || "").split(/[,\n]/).map((x) => boDau(x.toLowerCase()).trim()).filter(Boolean);
    if (!tu.length) return true;
    const c = " " + boDau(chu.toLowerCase()).replace(/[^a-z0-9]+/g, " ") + " ";
    return tu.some((t) => c.includes(" " + t.replace(/[^a-z0-9]+/g, " ").trim() + " "));
  }

  async binhLuan(e, v) {
    const bl = this.layCauHinh().facebook?.binhLuan || {};
    if (!bl.bat || v.item !== "comment" || v.verb !== "add") return;
    const trang = this.trang(e.id);
    const nguoi = v.from?.id, cid = v.comment_id, chu = String(v.message || "").trim();
    if (!trang || !cid || !nguoi || String(nguoi) === String(e.id)) return;   // Trang tự bình luận
    if (v.parent_id && v.parent_id !== v.post_id && !bl.caTraLoiCon) return;   // trả lời trong luồng bình luận
    const bay = Date.now();
    for (const [k, t] of this.daBl) if (bay - t > 86400e3) this.daBl.delete(k);
    const moiBai = `${nguoi}|${v.post_id}`;
    if (this.daBl.has(cid) || this.daBl.has(moiBai)) return;   // mỗi người một lần / bài / 24 giờ
    if (!this.khopBinhLuan(bl, chu, v.post_id)) return;
    this.daBl.set(cid, bay); this.daBl.set(moiBai, bay);
    const ten = v.from?.name || "";
    const dien = (m) => String(m || "").replaceAll("{ten}", ten.split(" ").pop() || "bạn").replaceAll("{ten_day_du}", ten || "bạn").trim();
    const tenTrang = trang.ten || "Fanpage";

    // Nội dung nhắn riêng: câu mẫu chủ soạn, hoặc để AI trả lời theo tài liệu.
    let rieng = dien(bl.nhanRieng), token = 0, nguon = "bình luận";
    if (!rieng && chu) {
      try {
        const ch = this.layCauHinh();
        const { doan, token: t1 } = await this.boNao.timTaiLieu(ch, chu);
        const r = await this.boNao.goiKenh(ch, "tra-loi", {
          cau: `[Khách bình luận dưới bài viết của Trang, mình nhắn riêng để trả lời] ${chu}`.slice(0, 2000),
          doan: doan.map((d) => d.chu), co_tai_lieu: this.boNao.kho.danhSach().length > 0, vai_tro: ch.vaiTro, lich_su: [],
          ten_nguoi: ten || undefined, kenh: "fb", model: ch.model, max_tokens: Math.max(ch.toiDaRa || 800, 600),
        }, 30000);
        rieng = r.chu.replace(/\[\[NHO:[\s\S]*?(?:\]\]|$)/g, "").trim(); token = r.token + t1;
        nguon = [...new Set(doan.map((d) => d.nguon))].join(", ") || "bình luận";
      } catch (x) { this.bao?.("fb", `Bình luận ${tenTrang}: AI không trả lời được — ${x.message}`); }
    }
    if (!rieng) rieng = dien(bl.duPhong) || `Chào ${ten || "bạn"}, mình đã nhận được bình luận của bạn. Bạn cần tư vấn gì cứ nhắn ở đây nhé!`;

    let psid = null;
    try {
      const r = await this.graph(trang, "me/messages", { recipient: { comment_id: cid }, message: { text: rieng.slice(0, 2000) } });
      psid = r.recipient_id;
    } catch (x) { guiThatBai(this.hopThu, this.bao, "fb", `${e.id}:bl_${nguoi}`, `${tenTrang} — không nhắn riêng được cho bình luận: ${x.message}`); }
    if (bl.traLoiCong) {
      // Nhiều câu (mỗi dòng một câu) thì chọn ngẫu nhiên — Facebook dễ coi là spam khi mọi bình luận nhận đúng một câu.
      const ds = String(bl.traLoiCong).split("\n").map((x) => x.trim()).filter(Boolean);
      const cong = dien(ds[Math.floor(Math.random() * ds.length)]);
      if (cong) await this.graph(trang, `${cid}/comments`, { message: cong.slice(0, 1500) }).catch((x) => this.bao?.("fb", `Bình luận ${tenTrang}: không trả lời công khai được — ${x.message}`));
    }
    if (bl.an) await this.graph(trang, `${cid}?is_hidden=true`).catch(() => {});
    if (psid) {
      const ma = `${e.id}:${psid}`;
      const tenCuoc = ten ? `${ten} · ${tenTrang}` : null;
      this.hopThu.ghi("fb", ma, { vai: "khach", chu: `[Bình luận] ${chu || "(ảnh/nhãn dán)"}`, ten: tenCuoc });
      this.hopThu.ghi("fb", ma, { vai: "bot", chu: rieng, token, nguon });
      if (ten) this.ten.set(psid, ten);
    }
  }

  async nhan(body) {
    for (const e of body?.entry || []) {
      const trang = this.trang(e.id);
      if (!trang) continue;
      for (const c of e.changes || []) {
        if (c.field === "feed") await this.binhLuan(e, c.value || {}).catch((x) => this.bao?.("fb", `Bình luận: ${x.message}`));
      }
      for (const m of e.messaging || []) {
        // Ảnh: attachments type=image; link chia sẻ: type=fallback có payload.url.
        // Khách bấm "Bắt đầu" / nút menu: coi tiêu đề nút là tin nhắn.
        if (m.postback && !m.message) m.message = { text: m.postback.title || m.postback.payload, mid: "pb:" + m.timestamp + ":" + m.sender?.id };
        const dk = m.message?.attachments || [];
        const chu = [m.message?.text, ...dk.filter((a) => a.type === "fallback").map((a) => a.payload?.url)]
          .filter(Boolean).join(" ");
        const coAnh = dk.some((a) => a.type === "image" && a.payload?.url && !a.payload?.sticker_id);
        if (!chu && !coAnh) continue;
        if (m.message.is_echo) {
          // Tin Trang gửi đi. Không có app_id = nhân viên trả lời trong Meta Business Suite.
          if (!m.message.app_id) nhanVienTraLoi(this.hopThu, "fb", `${e.id}:${m.recipient.id}`, chu || "[ảnh]");
          continue;
        }
        const ma = `${e.id}:${m.sender.id}`;
        const ten = await this.tenKhach(trang, m.sender.id);
        const anh = [];
        for (const a of dk.filter((x) => x.type === "image" && x.payload?.url && !x.payload?.sticker_id).slice(0, 2)) {
          const d = await anhDataUri(a.payload.url, { giuLink: true }); if (d) anh.push(d);
        }
        const ra = await this.boNao.traLoi("fb", ma, chu, { maTin: "fb:" + m.message.mid, tenCuoc: ten ? `${ten} · ${trang.ten || "Fanpage"}` : null, anh });
        if (!ra) continue;
        await this.gui(ma, ra).catch((x) => guiThatBai(this.hopThu, this.bao, "fb", ma, `${trang.ten || e.id} — ${x.message}`));
      }
    }
  }
}

// ---------------- Telegram (long polling, không cần tên miền) ----------------
export class Telegram {
  constructor({ boNao, hopThu, layCauHinh, bao }) {
    Object.assign(this, { boNao, hopThu, layCauHinh, bao });
    this.offset = 0;
    this.dangChay = false;
    this.trangThai = "chưa nối";
  }

  async gui(ma, chu) {
    const token = this.layCauHinh().telegram?.token;
    if (!token) throw new Error("Telegram chưa kết nối.");
    await this._guiCa(token, ma, chu);
  }

  async _guiCa(token, ma, chuDu, reply) {
    const { chu, anh } = tachAnh(chuDu);
    const goi = async (lenh, than) => {
      const r = await fetch(`https://api.telegram.org/bot${token}/${lenh}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: ma, reply_to_message_id: reply, ...than }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error("Telegram: " + (j.description || r.status));
    };
    if (chu) await goi("sendMessage", { text: chu });
    for (const photo of anh) await goi("sendPhoto", { photo });
  }

  async chay() {
    if (this.dangChay) return;
    this.dangChay = true;
    while (this.dangChay) {
      const token = this.layCauHinh().telegram?.token;
      if (!token) { this.trangThai = "chưa nối"; await ngu(5000); continue; }
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=50&offset=${this.offset}`,
                              { signal: AbortSignal.timeout(60000) });
        const j = await r.json();
        if (!j.ok) { this.trangThai = "token sai"; await ngu(15000); continue; }
        this.trangThai = "đang chạy";
        for (const u of j.result) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m || m.from?.is_bot) continue;
          // Ảnh: m.photo (nhiều cỡ, lấy cỡ vừa ≤ 1280px) + chú thích ở m.caption.
          const chuTin = m.text || m.caption || "";
          if (!chuTin && !m.photo?.length) continue;
          const nhom = m.chat.type !== "private";
          const ten = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ");
          const ch = this.layCauHinh().telegram || {};
          const duocGoi = !nhom || (ch.traLoiNhom && (chuTin.includes("@") || (ch.tenGoi && chuTin.toLowerCase().includes(ch.tenGoi.toLowerCase()))));
          if (!duocGoi) {
            this.hopThu.ghi("telegram", m.chat.id, { vai: "khach", chu: `${ten}: ${m.photo ? "[ảnh] " : ""}${chuTin}`, ten: m.chat.title, loai: "nhom" });
            continue;
          }
          const anh = [];
          if (m.photo?.length) {
            const co = [...m.photo].reverse().find((p) => Math.max(p.width, p.height) <= 1280) || m.photo[0];
            const f = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${co.file_id}`).then((r) => r.json()).catch(() => ({}));
            // Link tệp Telegram chứa token bot → luôn tải về đây, không bao giờ gửi link đi.
            const d = f.ok && await anhDataUri(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`);
            if (d) anh.push(d);
          }
          const ra = await this.boNao.traLoi("telegram", m.chat.id, chuTin, {
            maTin: `tg:${m.chat.id}:${m.message_id}`, tenNguoi: nhom ? ten : null,
            tenCuoc: nhom ? m.chat.title : ten, loai: nhom ? "nhom" : "rieng", maNguoi: nhom ? m.from?.id : null, anh });
          if (ra) await this._guiCa(token, m.chat.id, ra, nhom ? m.message_id : undefined)
            .catch((x) => guiThatBai(this.hopThu, this.bao, "telegram", m.chat.id, x.message));
        }
      } catch {
        this.trangThai = "mất mạng, thử lại";
        await ngu(5000);
      }
    }
  }
}

// Khung chat trên website của khách: tin vào bằng POST /web/tin, tin ra (bot + nhân viên trả lời tay)
// nằm trong hộp chờ để khung chat hỏi lại mỗi vài giây. Hộp chỉ giữ trong bộ nhớ, 2 giờ.
export class Web {
  constructor({ boNao, hopThu, bao }) {
    Object.assign(this, { boNao, hopThu, bao });
    this.hop = new Map();   // ma khách → [{ id, chu, anh, luc }]
    this.so = Date.now();
    this.trangThai = "sẵn sàng";
  }

  async gui(ma, chuDu) {
    const { chu, anh } = tachAnh(chuDu);
    const ds = this.hop.get(ma) || [];
    ds.push({ id: ++this.so, chu, anh, luc: Date.now() });
    this.hop.set(ma, ds.slice(-50));
  }

  layTin(ma, sau) {
    const han = Date.now() - 2 * 3600e3;
    for (const [k, ds] of this.hop) if (!ds.length || ds[ds.length - 1].luc < han) this.hop.delete(k);
    return (this.hop.get(ma) || []).filter((t) => t.id > sau);
  }

  async nhan(ma, chu, ten) {
    const ra = await this.boNao.traLoi("web", ma, chu, {
      maTin: `web:${ma}:${Date.now()}`, tenCuoc: ten || `Khách web ${ma.slice(0, 4)}`, loai: "rieng" });
    if (ra) await this.gui(ma, ra);
  }
}

const ngu = (ms) => new Promise((r) => setTimeout(r, ms));
