// Dữ liệu công ty dùng chung (Kho, Đơn hàng, CRM, Nhân sự, Vận hành) — cùng file SQLite với hộp thư.
//
// Bảng quản lý (dashboard) vẫn giữ IndexedDB làm bản trên máy, rồi đồng bộ hai chiều qua
// /api/erp/*: mỗi bản ghi một dòng `erp`, `seq` tăng dần để máy nào cũng chỉ kéo phần đổi.
// Nhờ đó bot đọc được giá/tồn thật, Tài liệu nội bộ, và tin khách tự đổ về Hộp chat + CRM.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { boDau, tachTu } from "./kho-tai-lieu.mjs";

const DB_HOP_LE = new Set(["revidapi-erp", "revidapi-crm", "revidapi-nhansu", "revidapi-vanhanh"]);
const TEN_KENH = { zalo: "zalo", zalo2: "zalo", zalo3: "zalo", "zalo-oa": "zalo", fb: "facebook", telegram: "telegram", web: "web" };
const taoId = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const homNay = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const tien = (n) => Number(n || 0).toLocaleString("vi-VN") + "đ";

export class Erp {
  constructor(db, { kho, ghiNhatKy } = {}) {
    this.db = db; this.kho = kho; this.ghiNhatKy = ghiNhatKy || (() => {});
    db.exec(`
      CREATE TABLE IF NOT EXISTS erp (db TEXT NOT NULL, kho TEXT NOT NULL, id TEXT NOT NULL, v TEXT,
        seq INTEGER NOT NULL, nguon TEXT, PRIMARY KEY (db, kho, id));
      CREATE INDEX IF NOT EXISTS erp_seq ON erp (seq);
      CREATE TABLE IF NOT EXISTS erp_dem (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
    `);
    this.hangCache = null;
  }

  seqMoi() {
    this.db.prepare("INSERT INTO erp_dem (k, n) VALUES ('seq', 1) ON CONFLICT(k) DO UPDATE SET n = n + 1").run();
    return this.db.prepare("SELECT n FROM erp_dem WHERE k = 'seq'").get().n;
  }
  seq() { return this.db.prepare("SELECT n FROM erp_dem WHERE k = 'seq'").get()?.n || 0; }

  docHet(db, kho) {
    return this.db.prepare("SELECT v FROM erp WHERE db = ? AND kho = ? AND v IS NOT NULL").all(db, kho).map((r) => JSON.parse(r.v));
  }
  doc(db, kho, id) {
    const r = this.db.prepare("SELECT v FROM erp WHERE db = ? AND kho = ? AND id = ?").get(db, kho, id);
    return r?.v ? JSON.parse(r.v) : null;
  }

  /** Ghi nhiều thay đổi trong MỘT transaction. doi: [{db, kho, id, v}] — v = null là xoá. */
  ghiNhieu(doi, nguon = "bang") {
    const dat = this.db.prepare(`INSERT INTO erp (db, kho, id, v, seq, nguon) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(db, kho, id) DO UPDATE SET v = excluded.v, seq = excluded.seq, nguon = excluded.nguon`);
    this.db.exec("BEGIN");
    try {
      for (const d of doi) {
        if (!DB_HOP_LE.has(d.db) || !/^[A-Za-z]{2,20}$/.test(d.kho) || !d.id) throw new Error("bản ghi sai: " + d.db + "/" + d.kho);
        dat.run(d.db, d.kho, String(d.id), d.v == null ? null : JSON.stringify(d.v), this.seqMoi(), nguon);
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    if (doi.some((d) => d.kho === "sanPham")) this.hangCache = null;
    // Tài liệu nội bộ của bảng quản lý = tài liệu bot đọc. Không phải nạp hai lần.
    for (const d of doi) if (d.db === "revidapi-vanhanh" && d.kho === "taiLieu") this.dongBoTaiLieu(d);
    return this.seq();
  }

  dongBoTaiLieu(d) {
    if (!this.kho) return;
    const ten = (x) => "noi-bo-" + String(x.id).slice(0, 40) + ".md";
    try {
      if (d.v) this.kho.luu(ten(d.v), `# ${d.v.ten}\n(${d.v.thuMuc})\n\n${d.v.noiDung || ""}`);
      else this.kho.xoa(ten({ id: d.id }));
    } catch (e) { this.ghiNhatKy("loi", "Đồng bộ tài liệu: " + e.message); }
  }

  /** Các thay đổi sau `tu` (để bảng quản lý kéo về). Trả tối đa 5.000 dòng mỗi lần. */
  doiTu(tu, gioiHan = 5000) {
    const hang = this.db.prepare("SELECT db, kho, id, v, seq, nguon FROM erp WHERE seq > ? ORDER BY seq LIMIT ?").all(Number(tu) || 0, gioiHan);
    return { seq: hang.length ? hang.at(-1).seq : this.seq(), het: hang.length < gioiHan,
      doi: hang.map((h) => ({ db: h.db, kho: h.kho, id: h.id, v: h.v ? JSON.parse(h.v) : null, nguon: h.nguon })) };
  }

  dem() {
    return Object.fromEntries(this.db.prepare("SELECT db || '/' || kho AS k, count(*) AS n FROM erp WHERE v IS NOT NULL GROUP BY db, kho").all().map((r) => [r.k, r.n]));
  }

  // ---------- Bot đọc hàng thật ----------
  hang() {
    if (!this.hangCache) this.hangCache = this.docHet("revidapi-erp", "sanPham").map((s) => ({ ...s, _tu: new Set(tachTu(`${s.ten} ${s.ma} ${s.nhom}`)) }));
    return this.hangCache;
  }

  /** Dòng giá/tồn của các mã khớp câu khách hỏi — đưa vào ngữ cảnh như một đoạn tài liệu. */
  timHang(cau, toiDa = 6) {
    const tu = tachTu(cau);
    if (!tu.length) return null;
    const diem = this.hang().map((s) => ({ s, d: tu.filter((t) => s._tu.has(t)).length + (tu.includes(boDau(String(s.ma).toLowerCase())) ? 3 : 0) }))
      .filter((x) => x.d >= Math.min(2, tu.length) || x.d >= 3).sort((a, b) => b.d - a.d).slice(0, toiDa);
    if (!diem.length) return null;
    const dong = diem.map(({ s }) => `- ${s.ten} (mã ${s.ma}): giá ${tien(s.giaBan)}/${s.dvt || "cái"}, ${s.ton > 0 ? `còn ${s.ton}` : "HẾT HÀNG"}`);
    return { nguon: "Kho hàng", chu: `Giá bán và tồn kho hiện tại (cập nhật ${new Date().toLocaleString("vi-VN")}):\n` + dong.join("\n"), _sp: diem.map((x) => x.s) };
  }

  phienBan() { return this.db.prepare("SELECT max(seq) AS m FROM erp WHERE kho = 'sanPham'").get()?.m || 0; }

  // ---------- Tin khách → Hộp chat + CRM ----------
  /** Gọi sau mỗi tin hộp thư ghi (khách, bot, nhân viên). */
  ghiTin(kenh, ma, { vai, chu, ten }) {
    if (kenh === "thu" || !["khach", "bot", "nhan_vien"].includes(vai)) return;
    try {
      const khoa = `${kenh}:${ma}`, id = "kc-" + khoa.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
      const cu = this.doc("revidapi-vanhanh", "hoiThoai", id);
      // Kênh web không có tên tài khoản: lấy từ câu "mình là Anh Tuấn", "tên em là Lan".
      const tenCau = vai === "khach" && /(?:[Mm]ình|[Ee]m|[Tt]ôi|[Tt]ui|[Tt]ên)\s+(?:tên\s+)?là\s+((?:[Aa]nh|[Cc]hị|[Ee]m|[Cc]ô|[Cc]hú|[Bb]ác)?\s*\p{Lu}\p{Ll}*(?:\s+\p{Lu}\p{Ll}*){0,3})/u.exec(chu)?.[1].trim();
      const tam = (x) => !x || /^Khách /.test(x);
      const tenKhach = (!tam(ten) && ten) || (!tam(cu?.ten) && cu.ten) || tenCau || ten || cu?.ten || "Khách " + String(ma).slice(-4);
      const doi = [];
      let lienHeId = cu?.lienHeId || "";
      const sdt = vai === "khach" && /(?<![\d\w])(?:\+?84|0)[35789](?:[\s.-]?\d){8}(?![\d\w])/.exec(chu)?.[0].replace(/[\s.-]/g, "");
      if (!lienHeId && vai === "khach") {
        const ds = this.docHet("revidapi-crm", "lienHe");
        const lh = (sdt && ds.find((l) => l.sdt === sdt)) || ds.find((l) => boDau(l.ten).toLowerCase() === boDau(tenKhach).toLowerCase());
        if (lh) lienHeId = lh.id;
        else {
          const t = Date.now(); lienHeId = taoId();
          doi.push({ db: "revidapi-crm", kho: "lienHe", id: lienHeId, v: { id: lienHeId, ten: tenKhach, email: "", sdt: sdt || "", congTy: "", nhan: [TEN_KENH[kenh] || kenh, "Khách mới từ chat"], ghiChu: "Tự tạo từ Kênh Chat", tao: t, sua: t } });
        }
      } else if (sdt && lienHeId) {
        const lh = this.doc("revidapi-crm", "lienHe", lienHeId);
        if (lh && !lh.sdt) doi.push({ db: "revidapi-crm", kho: "lienHe", id: lh.id, v: { ...lh, sdt, sua: Date.now() } });
      }
      if (tenCau && lienHeId && tam(cu?.ten)) {
        const lh = this.doc("revidapi-crm", "lienHe", lienHeId);
        if (lh && tam(lh.ten)) doi.push({ db: "revidapi-crm", kho: "lienHe", id: lh.id, v: { ...lh, ten: tenKhach, sua: Date.now() } });
      }
      const tin = [...(cu?.tin || []), { tu: vai === "khach" ? "khach" : "shop", chu: String(chu), luc: Date.now() }].slice(-200);
      const tt = vai === "khach" ? (cu?.tt === "dang" ? "dang" : "moi") : "dang";
      doi.push({ db: "revidapi-vanhanh", kho: "hoiThoai", id, v: { id, kenh: TEN_KENH[kenh] || "web", ten: tenKhach, lienHeId, nguoiId: cu?.nguoiId || "", tt, tin, sua: Date.now() } });
      this.ghiNhieu(doi, "kenh-chat");
      if (vai === "khach") this.batChot(khoa, id, lienHeId, tenKhach, chu, sdt);
    } catch (e) { this.ghiNhatKy("loi", "Ghi tin vào Hộp chat: " + e.message); }
  }

  /** Khách chốt (có SĐT/“chốt/đặt/lấy” + tên hàng) → đơn CHỜ DUYỆT. Không trừ kho, không ghi thu. */
  batChot(khoa, htId, lienHeId, ten, chu, sdt) {
    if (!/(?<!\p{L})(chốt|chot|đặt|dat hang|lấy|lay|ship cho|gửi cho|mua)(?!\p{L})/iu.test(chu)) return;
    const nho = this.db.prepare("SELECT chu FROM tin WHERE khoa = ? AND vai = 'khach' ORDER BY id DESC LIMIT 6").all(khoa).map((x) => x.chu).join(" ");
    const tim = this.timHang(nho + " " + chu, 3);
    if (!tim) return;
    const sl = Number((/(\d{1,3})\s*(?:cái|chiếc|bộ|cai|chiec|bo|sp)/i.exec(chu) || /(?:chốt|chot|lấy|lay|đặt|dat|mua|sl|x)\s*(\d{1,3})(?!\d)/i.exec(chu))?.[1] || 1);
    const sp = tim._sp[0];
    const da = this.docHet("revidapi-erp", "donHang").find((d) => d.trangThai === "cho" && d.ghiChu?.includes(htId));
    if (da) return;
    const lh = this.doc("revidapi-crm", "lienHe", lienHeId);
    const so = "CHO-" + Date.now().toString().slice(-6);
    const id = taoId();
    const don = { id, so, ngay: homNay(), lienHeId, tenKhach: ten, sdt: sdt || lh?.sdt || "", dong: [{ spId: sp.id, ten: sp.ten, sl, gia: sp.giaBan, giaVon: sp.giaVon }],
      giam: 0, phiShip: 0, thanhToan: "cong-no", daThu: 0, trangThai: "cho", ghiChu: `Bot tạo từ chat (${htId}). Khách: "${String(chu).slice(0, 120)}"`, tao: Date.now() };
    this.ghiNhieu([{ db: "revidapi-erp", kho: "donHang", id, v: don }], "kenh-chat");
    this.ghiNhatKy("don", `Đơn chờ duyệt ${so}: ${ten} — ${sl} × ${sp.ten}`);
  }

  // ---------- Đơn website (WooCommerce webhook) ----------
  /** Đơn Woo → đơn CHỜ DUYỆT (id cố định theo mã Woo nên Woo gửi lại/cập nhật không sinh đơn trùng). Chưa trừ kho. */
  nhanDonWoo(o) {
    if (!o || !o.id || !Array.isArray(o.line_items)) return null;
    const id = "woo-" + o.id, cu = this.doc("revidapi-erp", "donHang", id);
    const huy = /cancelled|refunded|failed|trash/.test(o.status || "");
    if (cu && cu.trangThai === "xong" && !huy) return cu;   // đã duyệt trong app thì giữ nguyên
    const sp = this.docHet("revidapi-erp", "sanPham");
    const b = o.billing || {}, sh = o.shipping || {};
    const ten = [b.first_name, b.last_name].filter(Boolean).join(" ").trim() || [sh.first_name, sh.last_name].filter(Boolean).join(" ").trim() || "Khách website";
    const dong = o.line_items.map((l) => {
      const m = sp.find((x) => l.sku && x.ma === l.sku) || sp.find((x) => x.ten?.toLowerCase() === String(l.name || "").toLowerCase());
      const sl = Number(l.quantity) || 1;
      return { spId: m?.id || "", ten: l.name || m?.ten || "Sản phẩm", sl, gia: Number(l.price) || Math.round((Number(l.total) || 0) / sl), giaVon: m?.giaVon || 0 };
    });
    const daTra = !!o.date_paid || /processing|completed/.test(o.status || "") && o.payment_method !== "cod";
    const diaChi = [sh.address_1 || b.address_1, sh.city || b.city].filter(Boolean).join(", ");
    const don = { id, so: "WEB-" + (o.number || o.id), ngay: String(o.date_created || "").slice(0, 10) || homNay(), lienHeId: cu?.lienHeId || "", tenKhach: ten, sdt: b.phone || sh.phone || "",
      dong, giam: Number(o.discount_total) || 0, phiShip: Number(o.shipping_total) || 0,
      thanhToan: o.payment_method === "cod" ? "cong-no" : "chuyen-khoan", daThu: daTra ? Number(o.total) || 0 : 0,
      trangThai: huy ? "huy" : "cho", ghiChu: `Website #${o.number || o.id} (${o.payment_method_title || o.payment_method || ""}, ${o.status || ""})${diaChi ? " — " + diaChi : ""}${o.customer_note ? " — Khách ghi: " + o.customer_note : ""}`,
      tao: cu?.tao || Date.now() };
    this.ghiNhieu([{ db: "revidapi-erp", kho: "donHang", id, v: don }], "woocommerce");
    this.ghiNhatKy("don", `Đơn website ${don.so}: ${ten} — ${dong.length} món${huy ? " (huỷ)" : ""}`);
    return don;
  }

  // ---------- Google Sheet (link công khai) ----------
  /** Kéo CSV từ Google Sheet đã chia sẻ "Bất kỳ ai có đường liên kết" → bảng sản phẩm hoặc khách hàng. */
  async nhapSheet(link, loai) {
    const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(link || "");
    const gid = /[#&?]gid=(\d+)/.exec(link || "")?.[1] || "0";
    const csvUrl = m ? `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}` : String(link);
    if (!/^https:\/\//.test(csvUrl)) throw new Error("Cần link Google Sheet.");   // không nhận file: — body từ web không được đọc tệp trên máy
    const chu = await fetch(csvUrl, { redirect: "follow", signal: AbortSignal.timeout(20000) }).then(async (r) => {
        if (!r.ok) throw new Error(`Google trả HTTP ${r.status} — sheet đã chia sẻ “Bất kỳ ai có đường liên kết” chưa?`);
        const t = await r.text(); if (/^\s*</.test(t)) throw new Error("Sheet chưa mở công khai (Google trả trang đăng nhập)."); return t;
      });
    return this.nhapCsv(chu, loai, (m ? m[1] : csvUrl) + "#" + gid);
  }

  /** `the`: khoá của Sheet nguồn. Có thì dòng nào trước đây từ Sheet đó mà nay không còn trên Sheet sẽ bị xoá theo. */
  nhapCsv(chu, loai, the = "") {
    // Bảng thật hay bỏ trống dòng/cột đầu, tiêu đề không ở dòng 1, ô nhóm gộp: tự dò dòng tiêu đề và điền xuống.
    const hang0 = docCsv(chu).filter((r) => r.some((x) => x.trim()));
    if (hang0.length < 2) throw new Error("Sheet trống.");
    const chuan = (h) => boDau(String(h).toLowerCase()).replace(/[^a-z0-9]/g, "");
    const BIET = ["ma", "masp", "sku", "mahang", "ten", "tensp", "tensanpham", "tenhang", "giaban", "gia", "price", "ban", "giavon", "von", "cost", "nhap", "gianhap",
      "ton", "tonkho", "soluong", "sl", "dvt", "donvi", "nhom", "danhmuc", "loai", "hoten", "tenkhach", "khachhang", "sdt", "dienthoai", "sodienthoai", "phone", "email", "congty"];
    let iDau = 0, diem = -1;
    hang0.slice(0, 10).forEach((r, i) => { const d = r.filter((h) => BIET.includes(chuan(h))).length; if (d > diem) { diem = d; iDau = i; } });
    const dau = hang0[iDau].map(chuan);
    const hang = [hang0[iDau], ...hang0.slice(iDau + 1)];
    const cot = (...ten) => dau.findIndex((h) => ten.includes(h));
    const laSo = (x) => /^[\d.,\s-]+$/.test(String(x).trim());
    // cột chữ (đa số ô không phải số) — dùng khi bảng không có cột "Tên"
    const cotChu = dau.map((_, j) => j).filter((j) => { const o = hang.slice(1).map((r) => (r[j] || "").trim()).filter(Boolean); return o.length && o.filter((x) => !laSo(x)).length > o.length / 2; });
    const truoc = {};
    for (const r of hang.slice(1)) for (const j of cotChu.slice(0, 1)) { if ((r[j] || "").trim()) truoc[j] = r[j]; else if (r.some((x, k) => k > j && x.trim())) r[j] = truoc[j] || ""; }
    const t = Date.now(), doi = [];
    if (loai === "sanPham") {
      const ds = this.docHet("revidapi-erp", "sanPham");
      const c = { ma: cot("ma", "masp", "sku", "mahang"), ten: cot("ten", "tensp", "tensanpham", "tenhang"), gia: cot("giaban", "gia", "price", "ban", "giabanle"), von: cot("giavon", "von", "cost", "nhap", "gianhap"),
        ton: cot("ton", "tonkho", "soluong", "sl"), dvt: cot("dvt", "donvi", "donvitinh"), nhom: cot("nhom", "danhmuc", "loai") };
      // không có cột Tên: ghép các cột chữ nằm trước cột giá (VD "Kling" + "Standard 826 cre"); cột chữ đầu tiên làm nhóm
      const gioi = Math.min(...[c.gia, c.von].filter((x) => x >= 0), dau.length);
      const ghep = c.ten < 0 ? cotChu.filter((j) => j < gioi && j !== c.ma) : [];
      if (c.ten < 0 && c.ma < 0 && !ghep.length) throw new Error("Không tìm thấy cột tên hàng. Dòng tiêu đề cần có “Tên” hoặc “Mã”.");
      if (c.nhom < 0 && ghep.length > 1) c.nhom = ghep[0];
      for (const r of hang.slice(1)) {
        const ma = (r[c.ma] || "").trim(), ten = (c.ten >= 0 ? r[c.ten] || "" : ghep.map((j) => (r[j] || "").trim()).filter(Boolean).reduce((a, x) => a && boDau(x.toLowerCase()).replace(/\W/g, "").startsWith(boDau(a.toLowerCase()).replace(/\W/g, "")) ? x : (a ? a + " " : "") + x, "")).trim();
        if (c.ten < 0 && ghep.length > 1 && !(r[ghep[ghep.length - 1]] || "").trim()) continue;   // dòng chỉ có tên nhóm / dòng tổng
        if (c.ten < 0 && ![c.gia, c.von].some((i) => i >= 0 && (r[i] || "").trim())) continue;
        if (doi.some((d) => d.v.ten === ten)) continue;
        if (!ma && !ten) continue;
        const cu = ds.find((s) => (ma && s.ma === ma) || (!ma && s.ten === ten));
        const so = (i, mac) => (i >= 0 && r[i]?.trim() ? Math.round(Number(r[i].replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".").replace(/[^\d.-]/g, ""))) || 0 : mac);
        const v = { id: cu?.id || taoId(), ma: ma || cu?.ma || "SP" + (ds.length + doi.length + 1), ten: ten || cu?.ten, dvt: (c.dvt >= 0 && r[c.dvt]) || cu?.dvt || "cái",
          nhom: (c.nhom >= 0 && r[c.nhom]) || cu?.nhom || "Chung", giaVon: so(c.von, cu?.giaVon || 0), giaBan: so(c.gia, cu?.giaBan || 0), ton: so(c.ton, cu?.ton || 0), tonMin: cu?.tonMin ?? 5, tao: cu?.tao || t, sua: t, ...(the ? { nguonSheet: the } : cu?.nguonSheet ? { nguonSheet: cu.nguonSheet } : {}) };
        doi.push({ db: "revidapi-erp", kho: "sanPham", id: v.id, v });
        if (!cu) ds.push(v);   // dòng sau cùng mã trong lần nhập này cập nhật bản vừa tạo, không đẻ mã trùng
      }
    } else if (loai === "lienHe") {
      const ds = this.docHet("revidapi-crm", "lienHe");
      const c = { ten: cot("ten", "hoten", "tenkhach", "khachhang"), sdt: cot("sdt", "dienthoai", "sodienthoai", "phone"), email: cot("email", "mail"), ct: cot("congty", "company", "donvi") };
      if (c.ten < 0) throw new Error("Sheet cần cột “Tên”.");
      for (const r of hang.slice(1)) {
        const ten = (r[c.ten] || "").trim(); if (!ten) continue;
        const sdt = (r[c.sdt] || "").replace(/\D/g, "");
        const cu = ds.find((l) => (sdt && l.sdt === sdt) || l.ten === ten);
        const v = { id: cu?.id || taoId(), ten, sdt: sdt || cu?.sdt || "", email: (r[c.email] || cu?.email || "").trim(), congTy: (r[c.ct] || cu?.congTy || "").trim(),
          nhan: cu?.nhan || ["Từ Google Sheet"], ghiChu: cu?.ghiChu || "", tao: cu?.tao || t, sua: t, ...(the ? { nguonSheet: the } : cu?.nguonSheet ? { nguonSheet: cu.nguonSheet } : {}) };
        doi.push({ db: "revidapi-crm", kho: "lienHe", id: v.id, v });
        if (!cu) ds.push(v);
      }
    } else throw new Error("Loại phải là sanPham hoặc lienHe.");
    let xoa = 0;
    if (the && doi.length) {
      const [db, kho] = loai === "sanPham" ? ["revidapi-erp", "sanPham"] : ["revidapi-crm", "lienHe"];
      const con = new Set(doi.map((d) => d.id));
      for (const x of this.docHet(db, kho)) if (x?.nguonSheet === the && !con.has(x.id)) { doi.push({ db, kho, id: x.id, v: null }); xoa++; }
    }
    if (xoa) this.ghiNhatKy("sheet", `Google Sheet: xoá ${xoa} dòng không còn trên Sheet`);
    for (let i = 0; i < doi.length; i += 2000) this.ghiNhieu(doi.slice(i, i + 2000), "google-sheet");
    return doi.length - xoa;
  }

  /** CSV của một bảng để dán vào Google Sheet / Excel. */
  xuatCsv(db, kho) {
    const ds = this.docHet(db, kho);
    if (!ds.length) return "";
    const cot = [...new Set(ds.flatMap((x) => Object.keys(x)))].filter((k) => k !== "tin");
    const o = (v) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return "\uFEFF" + [cot.join(","), ...ds.map((x) => cot.map((k) => o(x[k])).join(","))].join("\n");
  }

  // ---------- Google Drive (thư mục đồng bộ trên máy) ----------
  /** Đọc mọi .txt/.md/.csv trong thư mục Drive → Tài liệu nội bộ (bot + bảng quản lý cùng thấy). */
  quetThuMuc(thuMuc) {
    if (!thuMuc || !fs.existsSync(thuMuc)) throw new Error("Không thấy thư mục: " + thuMuc);
    const ds = this.docHet("revidapi-vanhanh", "taiLieu");
    const doi = [];
    const di = (d, sau = 0) => {
      for (const ten of fs.readdirSync(d)) {
        if (ten.startsWith(".")) continue;
        const p = path.join(d, ten), st = fs.statSync(p);
        if (st.isDirectory()) { if (sau < 3) di(p, sau + 1); continue; }
        if (!/\.(txt|md|csv)$/i.test(ten) || st.size > 2e6) continue;
        const id = "drive-" + crypto.createHash("sha1").update(path.relative(thuMuc, p)).digest("hex").slice(0, 16);
        const cu = ds.find((x) => x.id === id);
        if (cu && cu.sua >= st.mtimeMs) continue;
        doi.push({ db: "revidapi-vanhanh", kho: "taiLieu", id, v: { id, thuMuc: "Drive/" + (path.relative(thuMuc, d) || "Gốc"), ten: ten.replace(/\.(txt|md|csv)$/i, ""), noiDung: fs.readFileSync(p, "utf8"), sua: Math.round(st.mtimeMs) } });
      }
    };
    di(thuMuc);
    if (doi.length) this.ghiNhieu(doi, "google-drive");
    return doi.length;
  }
}

/** Thư mục Google Drive cho máy tính (Drive for desktop) trên macOS/Windows. */
export function timThuMucDrive() {
  const goc = path.join(process.env.HOME || process.env.USERPROFILE || "", "Library", "CloudStorage");
  try { for (const t of fs.readdirSync(goc)) if (t.startsWith("GoogleDrive-")) return path.join(goc, t, "My Drive"); } catch { /* không có */ }
  for (const o of ["G:\\My Drive", "G:\\Drive của tôi"]) if (fs.existsSync(o)) return o;
  return "";
}

function docCsv(s) {
  const ra = []; let dong = [], o = "", trong = false;
  s = s.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (trong) { if (c === '"') { if (s[i + 1] === '"') { o += '"'; i++; } else trong = false; } else o += c; }
    else if (c === '"') trong = true;
    else if (c === ",") { dong.push(o); o = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; dong.push(o); o = ""; if (dong.some((x) => x !== "")) ra.push(dong); dong = []; }
    else o += c;
  }
  dong.push(o); if (dong.some((x) => x !== "")) ra.push(dong);
  return ra;
}
