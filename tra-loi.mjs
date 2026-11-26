// Bộ não chung cho mọi kênh: nhận (kênh, cuộc, chữ) → trả lời bằng RevidAPI.
//
// Giữ token thấp, vì mỗi tin nhắn của khách hàng là một lượt tính tiền:
// - Lịch sử chỉ lấy LICH_SU_TOI_DA tin gần nhất trong hộp thư, mỗi tin cắt CHU_MOI_TIN ký tự.
// - Tài liệu chỉ gửi vài đoạn khớp nhất (kho-tai-lieu.mjs), không gửi cả file.
// - Tìm không ra đoạn nào thì mới nhờ model viết thêm từ khoá đồng nghĩa (~60 token)
//   rồi tìm lại: "ship ra Hà Nội" vẫn tìm thấy "giao hàng các tỉnh".
// - Trả lời giới hạn max_tokens; chỉ dẫn hệ thống ngắn và cố định để cổng cache được.
import { lenhViec } from "./bao-cao-chu.mjs";
import fs from "node:fs";
import { boDau } from "./kho-tai-lieu.mjs";
import { moRongLink, anhDataUri } from "./noi-dung.mjs";
import { thuTuModel, laKhongBan, ghiKhongBan, vuaKhongBan, cauLui } from "./model-ban.mjs";

const LICH_SU_TOI_DA = 6;
const CHU_MOI_TIN = 500;
const CHU_TIN_VAO_TOI_DA = 1500;   // phần dùng để tìm tài liệu
const CHU_GUI_AI_TOI_DA = 3800;    // tin + nội dung link đã đọc

export class BoNao {
  constructor({ layCauHinh, ghiCauHinh, kho, hopThu, ghiNhatKy, fileVe }) {
    Object.assign(this, { layCauHinh, ghiCauHinh, kho, hopThu, ghiNhatKy, fileVe });
    this.guiQua = null;          // (kenh, ma, chu, loai) => Promise — server.mjs gắn, để gửi tin cho chủ/khách
    try { this.ve = JSON.parse(fs.readFileSync(fileVe, "utf8")); } catch { this.ve = { so: 1000, ds: {} }; }
    this.daThay = new Map();     // chống xử lý trùng một tin (webhook gửi lại)
    this.lanCuoi = new Map();    // chống spam: một cuộc tối đa 1 lượt / 3 giây
    this.anhGanDay = new Map();
    this.dangCho = new Map();
    this.boDem = new Map();    // câu hỏi chung (giá, ship, giờ mở cửa…) → câu trả lời, 6 giờ  // khoá cuộc -> { anh, luc }: ảnh vừa gửi, gắn vào câu hỏi ngay sau
  }

  trung(maTin) {
    if (!maTin) return false;
    const bay = Date.now();
    for (const [k, t] of this.daThay) if (bay - t > 600000) this.daThay.delete(k);
    if (this.daThay.has(maTin)) return true;
    this.daThay.set(maTin, bay);
    return false;
  }

  // Mọi lượt AI đi qua /v1/kenh-chat/* của RevidAPI: cách dựng prompt, chống bịa, mở rộng
  // từ khoá nằm trên máy chủ RevidAPI. Máy này chỉ gửi tin nhắn + vài đoạn tài liệu đã tìm sẵn.
  async goiKenh(ch, duong, than, hanMs) {
    if (!ch.khoa) throw new Error("Chưa có API key RevidAPI — dán key ở trang quản trị.");
    const r = await fetch(ch.coSo.replace(/\/$/, "") + "/v1/kenh-chat/" + duong, {
      method: "POST",
      headers: { Authorization: "Bearer " + ch.khoa, "Content-Type": "application/json" },
      body: JSON.stringify(than),
      signal: AbortSignal.timeout(hanMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j?.error?.message || `HTTP ${r.status}`); e.ma = r.status; throw e; }
    return {
      chu: boSuyNghi(j?.choices?.[0]?.message?.content),
      token: Number(j?.usage?.prompt_tokens || 0) + Number(j?.usage?.completion_tokens || 0),
    };
  }

  // Tìm đoạn tài liệu; ít kết quả thì nhờ máy chủ viết thêm từ khoá đồng nghĩa rồi tìm lại.
  async timTaiLieu(ch, cau) {
    let doan = this.kho.tim(cau);
    let token = 0;
    if (!doan.length && this.kho.danhSach().length) {   // đã có đoạn khớp thì khỏi gọi thêm (nhanh hơn ~3–5 giây)
      try {
        const r = await this.goiKenh(ch, "tu-khoa", { cau: cau.slice(0, 300) }, 12000);
        token = r.token;
        const them = r.chu.split(/[,\n;]/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
        const moi = this.kho.tim(cau, them);
        if (moi.length > doan.length) doan = moi;
      } catch { /* mở rộng hỏng/chậm thì dùng kết quả cũ — không bắt khách chờ */ }
    }
    // Giá/tồn thật từ bảng Kho của bảng quản lý — đứng đầu, vì khách hỏi giá nhiều nhất.
    const hang = this.erp?.timHang(cau);
    if (hang) doan = [{ nguon: hang.nguon, chu: hang.chu }, ...doan].slice(0, 4);
    return { doan, token };
  }

  /**
   * Ghi tin của khách vào hộp thư, rồi trả câu trả lời (hoặc null khi không nên trả lời).
   * `ma` là mã cuộc trong kênh (threadId Zalo, chat_id Telegram, "page:psid" Fanpage…).
   */
  async traLoi(kenh, ma, chu, { maTin, tenNguoi, tenCuoc, loai, maNguoi, anh = [] } = {}) {
    const ch = this.layCauHinh();
    chu = String(chu || "").trim();
    anh = (anh || []).filter(Boolean).slice(0, 2);   // data URI hoặc link https của ảnh khách gửi
    if ((!chu && !anh.length) || this.trung(maTin)) return null;
    const traChu = this.tinCuaChu(kenh, ma, chu, tenCuoc || tenNguoi);
    if (traChu !== undefined) return traChu;
    const ghiLai = [anh.length ? `[${anh.length} ảnh]` : "", chu].filter(Boolean).join(" ");
    const khoa = this.hopThu.ghi(kenh, ma, { vai: "khach", chu: (tenNguoi ? `${tenNguoi}: ` : "") + ghiLai, ten: tenCuoc, loai });

    if (!ch.bat) return null;
    if (this.hopThu.dangTiepQuan(khoa)) return null;           // nhân viên đang trả lời tay
    if (ch.botImKhiGiao && this.hopThu.cuoc(khoa)?.giao) return null;   // cuộc đã có người phụ trách
    if ((ch.boQua || []).includes(khoa)) return null;
    if (!dangTrongGio(ch.gio)) return this.ghiBot(khoa, ch.ngoaiGio);

    // Khách hay gửi ảnh rồi gõ ngay "cái này giá sao": tin thứ hai trước đây bị bỏ vì chống spam.
    // Nay chờ cho đủ 3 giây rồi vẫn trả lời; chỉ bỏ khi dồn quá nhiều tin.
    const cho = 3000 - (Date.now() - (this.lanCuoi.get(khoa) || 0));
    if (cho > 0) {
      if ((this.dangCho.get(khoa) || 0) >= 2) return null;
      this.dangCho.set(khoa, (this.dangCho.get(khoa) || 0) + 1);
      await new Promise((r) => setTimeout(r, cho));
      this.dangCho.set(khoa, this.dangCho.get(khoa) - 1);
    }
    this.lanCuoi.set(khoa, Date.now());
    if (anh.length) this.anhGanDay.set(khoa, { anh, luc: Date.now() });
    else if (this.anhGanDay.get(khoa)?.luc > Date.now() - 120000) { anh = this.anhGanDay.get(khoa).anh; this.anhGanDay.delete(khoa); }

    // Câu hỏi giống câu "hỏi nhanh" đã soạn sẵn → trả ngay, 0 token.
    const nhanh = anh.length ? null : timHoiNhanh(ch.hoiNhanh, chu);
    if (nhanh) return this.ghiBot(khoa, nhanh, { token: 0, nguon: "hỏi nhanh" });

    // Link trong tin: đọc trang ngay trên máy này rồi ghép vào tin gửi AI (trước đây AI chỉ thấy chữ URL).
    const lk = await moRongLink(chu).catch(() => ({ chu, anh: [] }));
    for (const u of lk.anh) if (anh.length < 2) { const d = await anhDataUri(u, { giuLink: true }); if (d) anh.push(d); }
    const tinVao = chu.replace(/https?:\/\/\S+/g, " ").trim().slice(0, CHU_TIN_VAO_TOI_DA) || chu.slice(0, CHU_TIN_VAO_TOI_DA);
    // Câu cụt ("cái này còn ko", "size M thì sao") không đủ từ để tìm: ghép tin khách vừa nhắn trước đó.
    const truoc = this.hopThu.ganNhat(khoa, 4).slice(0, -1).reverse().find((t) => t.vai === "khach")?.chu || "";
    const tinTim = laCauCut(tinVao) && truoc ? `${truoc.replace(/https?:\/\/\S+|\[\d ảnh\]/g, " ").slice(0, 300)} ${tinVao}` : tinVao;
    // Câu hỏi chung, không ảnh/link, không phụ thuộc câu trước → dùng lại câu trả lời cũ, 0 token.
    const khoaDem = !anh.length && !lk.anh.length && lk.chu === chu && !laCauCut(tinVao) ? boDau(tinVao.toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim() + "|" + this.kho.danhSach().map((d) => d.ten + d.kyTu).join(",") + "|" + (this.erp?.phienBan() || 0) : null;
    const daDem = khoaDem && this.boDem.get(khoaDem);
    if (daDem && Date.now() - daDem.luc < 6 * 3600e3) return this.ghiBot(khoa, daDem.chu, { token: 0, nguon: "nhớ đệm" });
    const { doan, token: tokenTim } = tinTim ? await this.timTaiLieu(ch, tinTim, kenh) : { doan: [], token: 0 };
    const coKho = this.kho.danhSach().length > 0 || (this.erp?.hang().length || 0) > 0;
    const laCauHoi = /\?|(?<!\p{L})(?:không|ko|k|chưa|gì|nào|sao|bao nhiêu|bao lâu|mấy|đâu|có .+ ko)(?!\p{L})/iu.test(tinVao);
    if (coKho && !doan.length && laCauHoi) {
      this.hopThu.ghiHoc(tinVao, "", "thieu", khoa);   // chủ bổ sung → bot học
      // Tài liệu không có gì: đừng để AI đoán. Hỏi chủ, báo khách chờ.
      if (await this.hoiChu(khoa, tinVao, tenCuoc || tenNguoi, loai)) return this.ghiBot(khoa, ch.cauCho || CAU_CHO);
    }
    // Bộ nhớ theo NGƯỜI: Fanpage psid / Zalo uid / Telegram id. Nhóm: người gửi; 1-1: chính cuộc chat.
    const nguoi = maNguoi ? `${kenh}:${maNguoi}` : khoa;
    // Bộ nhớ khách: tự ghi SĐT, email, tên tự xưng khi khách nhắn; nhân viên sửa thêm trong hộp thư.
    const bat = {};
    const sdt = /(?:\+?84|0)(?:[\s.-]?\d){9}\b/.exec(chu); if (sdt) bat["SĐT"] = sdt[0].replace(/[\s.-]/g, "");
    const mail = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(chu); if (mail) bat["Email"] = mail[0];
    const ten = /(?:tên (?:em|anh|chị|mình|tôi) là|(?:em|anh|chị|mình|tôi) tên(?: là)?)\s+([\p{L} ]{2,30}?)(?=[,.!?\n]|$)/iu.exec(chu);
    if (ten) bat["Tên"] = ten[1].trim();
    const dc = /(?:địa chỉ(?: (?:em|anh|chị|mình|của \S+))?(?: là)?|giao (?:về|tới|đến|cho \S+ ở)|ship (?:về|tới|đến)|nhà (?:em|anh|chị|mình) ở)[:\s]+([^\n]{6,160})/i.exec(chu);
    if (dc) {
      const s = dc[1].replace(/[\s,.!]*(?:nhé|nha|nhá|ạ|nhe|đó|nhen|với|giúp (?:em|mình)|luôn)?[\s.!?]*$/iu, "").trim();
      // Chỉ nhận khi giống địa chỉ thật (có số nhà hoặc đơn vị hành chính) và không phải câu hỏi
      // ("giao về đâu em nhớ không") — nếu không sẽ ghi đè địa chỉ đúng đã lưu.
      const laHoi = /\?|(?<!\p{L})(?:đâu|gì|nào|không|ko|chưa|nhớ)(?!\p{L})/iu.test(s);
      const giongDiaChi = /\d|(?<!\p{L})(?:đường|phố|phường|xã|quận|huyện|tp|thành phố|tỉnh|thôn|ấp|ngõ|hẻm|kiệt)(?!\p{L})/iu.test(s);
      if (s.length >= 6 && !laHoi && giongDiaChi) bat["Địa chỉ"] = s;
    }
    const cu = this.hopThu.docNho(nguoi);
    const tenHienThi = loai === "nhom" ? tenNguoi : tenCuoc;
    if (!bat["Tên"] && !cu["Tên"] && tenHienThi) bat["Tên"] = String(tenHienThi).replace(/ · .*$/, "");
    const nho = Object.keys(bat).length ? this.hopThu.ghiNho(nguoi, bat) : cu;
    // Lịch sử từ hộp thư, bỏ tin vừa ghi.
    const ls = this.hopThu.ganNhat(khoa, LICH_SU_TOI_DA + 1).slice(0, -1).map((t) => ({
      role: t.vai === "khach" ? "user" : "assistant", content: t.chu.slice(0, CHU_MOI_TIN),
    }));
    const than = (model) => ({
      cau: lk.chu.slice(0, CHU_GUI_AI_TOI_DA), anh: anh.length ? anh : undefined, doan: doan.map((d) => d.chu), co_tai_lieu: coKho, vai_tro: ch.vaiTro, lich_su: ls,
      ten_nguoi: tenNguoi || undefined, ghi_nho: nho, kenh, model, max_tokens: Math.max(ch.toiDaRa || 800, 600),
    });

    try {
      // Khách chờ tối đa ~12 giây: nguồn đôi khi trễ 30 giây+. Quá hạn thì thử một lần bằng
      // model dự phòng do chủ bot chọn (Cách trả lời → Nâng cao).
      // Model ngừng bán (cổng trả 404 "Không bán model") thì lùi sang model kế tiếp còn bán, không để bot im.
      let r, dung;
      const dsModel = thuTuModel(ch.model, ch.modelDuPhong);
      let conLuotCham = ch.modelDuPhong && ch.modelDuPhong !== ch.model ? 1 : 0;
      for (const [i, m] of dsModel.entries()) {
        try {
          r = await this.goiKenh(ch, "tra-loi", than(m), i === 0 ? (ch.hanGiay || 12) * 1000 : 30000); dung = m; break;
        } catch (e) {
          if (laKhongBan(e)) { ghiKhongBan(m); if (i < dsModel.length - 1) continue; }
          // quá hạn/mạng lỗi/nguồn quá tải (429, 5xx): thử thêm đúng một model (như trước)
          else if ((!e.ma || e.ma === 429 || e.ma >= 500) && conLuotCham-- > 0) continue;
          throw e;
        }
      }
      // Máy chủ cho model ghi thêm điều mới biết về khách vào dòng [[NHO: Khoá=giá trị; ...]] — tách ra, không gửi khách.
      const m = /\[\[NHO:([\s\S]*?)\]\]/.exec(r.chu);
      r.chu = r.chu.replace(/\[\[NHO:[\s\S]*?(?:\]\]|$)/g, "").trim();
      if (m) {
        const them = {};
        for (const cap of m[1].split(";")) {
          const [k, ...v] = cap.split("="); const kk = k?.trim(), vv = v.join("=").trim();
          if (kk && vv && kk.length <= 30 && !/^(?:không|chưa|n\/a|null|-)$/i.test(vv)) them[kk] = vv;
        }
        if (Object.keys(them).length) this.hopThu.ghiNho(nguoi, them);
      }
      const bo = [ch.model, ch.modelDuPhong].filter((m) => m && m !== dung && vuaKhongBan(m));
      this.loiGoi = bo.length ? cauLui([...new Set(bo)], dung) : "";
      if (!r.chu) return null;
      if (coKho && doan.length && /chưa có thông tin|không có thông tin|chưa rõ|để em (?:kiểm tra|báo)/iu.test(r.chu))
      { this.hopThu.ghiHoc(tinVao, "", "thieu", khoa);   // tìm thấy đoạn nhưng không đúng ý → vẫn là chỗ tài liệu thiếu
        await this.hoiChu(khoa, tinVao, tenCuoc || tenNguoi, loai); }
      // Chỉ đệm câu không nhắc tên/thông tin riêng của khách.
      if (khoaDem && doan.length && !Object.values(nho || {}).some((v) => v && r.chu.includes(String(v)))) {
        if (this.boDem.size > 300) this.boDem.delete(this.boDem.keys().next().value);
        this.boDem.set(khoaDem, { chu: r.chu, luc: Date.now() });
      }
      return this.ghiBot(khoa, r.chu, { token: r.token + tokenTim, nguon: [...new Set(doan.map((d) => d.nguon))].join(", ") });
    } catch (e) {
      this.ghiNhatKy({ kenh, cuoc: ma, vao: chu, loi: e.message });
      this.loiCuoi = e.message;   // trang "Thử bot" đọc để báo lý do thay vì im lặng
      if (e.ma === 403) { this.loiGoi = e.message; return null; }
      if (laKhongBan(e)) this.loiGoi = "Không model nào trong Cách trả lời còn bán: " + e.message;   // key không thuộc gói Pro: bot im, panel báo
      return e.ma === 402 ? null : this.ghiBot(khoa, ch.khiLoi);
    }
  }

  luuVe() {
    const moc = Date.now() - 3 * 86400e3;   // vé quá 3 ngày thì bỏ, giữ tối đa 200 vé
    const ds = Object.entries(this.ve.ds).filter(([, v]) => v.luc > moc).slice(-200);
    this.ve.ds = Object.fromEntries(ds);
    if (!this.fileVe) return;
    try { fs.writeFileSync(this.fileVe + ".tmp", JSON.stringify(this.ve), { mode: 0o600 }); fs.renameSync(this.fileVe + ".tmp", this.fileVe); }
    catch (e) { this.ghiNhatKy({ kenh: "chu", loi: "Không lưu được vé: " + e.message }); }
  }

  // Bot không trả lời được → gửi câu hỏi cho chủ qua Zalo/Telegram cá nhân, kèm số vé #NNNN.
  // Trả true khi đã báo được chủ.
  async hoiChu(khoa, hoi, ten, loai) {
    const ch = this.layCauHinh(), bc = ch.baoChu;
    if (!ch.chuyenChu || !bc?.kenh || !this.guiQua || loai === "nhom") return false;
    // Khách hỏi dồn nhiều câu: một vé đang mở cho cuộc này trong 10 phút thì gộp vào, không báo chủ liên tục.
    const mo = Object.entries(this.ve.ds).find(([, v]) => v.khoa === khoa && !v.xong && Date.now() - v.luc < 600e3);
    const so = mo ? mo[0] : String(++this.ve.so);
    this.ve.ds[so] = mo ? { ...mo[1], hoi: mo[1].hoi + "\n" + hoi } : { khoa, hoi, ten: ten || "", luc: Date.now() };
    this.luuVe();
    const [kenh] = khoa.split(":");
    const tenKenh = { zalo: "Zalo", zalo2: "Zalo 2", zalo3: "Zalo 3", "zalo-oa": "Zalo OA", fb: "Fanpage", telegram: "Telegram", web: "Web" }[kenh] || kenh;
    try {
      await this.guiQua(bc.kenh, bc.ma, `#${so} · ${ten || "Khách"} (${tenKenh}) hỏi:\n${hoi.slice(0, 600)}\n\nTrả lời khách: gõ #${so} rồi nội dung.`);
      return true;
    } catch (e) {
      this.ghiNhatKy({ kenh: "chu", loi: "Không báo được chủ: " + e.message });
      return false;
    }
  }

  // Tin đến từ cuộc chat của chủ (hoặc mã nối chủ). Trả undefined khi KHÔNG phải tin của chủ.
  tinCuaChu(kenh, ma, chu, ten) {
    const ch = this.layCauHinh();
    if (ch.maChu && chu.trim().toUpperCase() === ch.maChu && this.ghiCauHinh) {
      this.ghiCauHinh({ baoChu: { kenh, ma: String(ma), ten: ten || "", luc: Date.now() } });
      return "Đã nối. Từ giờ câu khách hỏi mà bot chưa trả lời được sẽ gửi về đây kèm số #. Trả lời khách bằng cách gõ: #số nội dung";
    }
    const bc = ch.baoChu, laChu = bc && bc.kenh === kenh && bc.ma === String(ma);
    // Nhân viên tự nối: "#toi NV01" (mã nhân viên trên bảng Nhân sự). Sau đó dùng #ds, #xong cho việc của mình.
    const toi = this.erp && /^#\s?t[oôố]i\s+(\S+)$/i.exec(chu.trim());
    if (toi && !laChu) {
      const nv = this.erp.docHet("revidapi-nhansu", "nhanVien").find((n) => String(n.ma || "").toUpperCase() === toi[1].toUpperCase());
      if (!nv) return `Không thấy nhân viên mã ${toi[1]}. Hỏi chủ mã của mình trên bảng Nhân sự.`;
      this.ghiCauHinh({ nvKenh: { ...(ch.nvKenh || {}), [nv.id]: { kenh, ma: String(ma), luc: Date.now() } } });
      return `Chào ${nv.ten}. Từ giờ việc chủ giao và nhắc hạn sẽ gửi về đây. Gõ #ds xem việc của mình, #xong <mã> khi xong.`;
    }
    const nvId = !laChu && Object.entries(ch.nvKenh || {}).find(([, k]) => k.kenh === kenh && k.ma === String(ma))?.[0];
    if (!laChu && !nvId) return undefined;
    const kq = this.erp ? lenhViec(this.erp, chu, Date.now(), nvId || null) : null;
    if (kq) return this.baoViec(kq, nvId, ch);
    if (!laChu) return /^#/.test(chu.trim()) ? "Gõ #ds xem việc của mình, #xong <mã> khi xong." : undefined;
    const m = /^#\s?(\d{3,6})\s+([\s\S]+)$/.exec(chu.trim());
    if (!m) return /^#/.test(chu.trim()) ? "Gõ đúng dạng: #số nội dung (ví dụ: #1001 Dạ bên em có ship COD ạ)" : null;
    const v = this.ve.ds[m[1]];
    if (!v) return `Không thấy vé #${m[1]} (vé chỉ giữ 3 ngày).`;
    const traLoi = m[2].trim();
    const [kenhKhach, ...maKhach] = v.khoa.split(":");
    const c = this.hopThu.cuoc(v.khoa);
    return this.guiQua(kenhKhach, maKhach.join(":"), traLoi, c?.loai).then(() => {
      this.hopThu.ghi(kenhKhach, maKhach.join(":"), { vai: "nhan_vien", chu: traLoi, nguon: "Chủ shop" });
      // Hộp thư tự ghép hỏi–đáp cho bot học khi trả lời trong 30 phút; quá thì ghép theo vé.
      if (Date.now() - v.luc >= 30 * 60e3) this.hopThu.ghiHoc(v.hoi, traLoi, "cho", v.khoa);
      v.xong = true; this.luuVe();
      return `Đã gửi cho ${v.ten || "khách"} (#${m[1]}). Câu này đã vào mục chờ duyệt để bot học.`;
    }).catch((e) => `Chưa gửi được cho khách #${m[1]}: ${e.message}`);
  }

  // Sau lệnh việc: báo người được giao (chủ giao) hoặc báo chủ (nhân viên đóng việc). Lỗi gửi không chặn câu trả lời.
  baoViec(kq, nvId, ch) {
    if (typeof kq === "string") return kq;
    const v = kq.viec, k = !nvId && v.nguoiId && (ch.nvKenh || {})[v.nguoiId], bc = ch.baoChu;
    if (k && /^Đã tạo/.test(kq.tra)) this.guiQua?.(k.kenh, k.ma, `📌 Việc mới từ chủ: ${v.ten}${v.han ? " (hạn " + v.han.split("-").reverse().slice(0, 2).join("/") + ")" : ""}. Xong gõ: #xong ${String(v.id).slice(-4)}`).catch(() => {});
    if (nvId && bc?.kenh) this.guiQua?.(bc.kenh, bc.ma, `✅ ${this.erp.docHet("revidapi-nhansu", "nhanVien").find((n) => n.id === nvId)?.ten || "Nhân viên"} báo xong: ${v.ten}`).catch(() => {});
    return kq.tra + (k ? " Đã báo cho người nhận." : !nvId && v.nguoiId && /^Đã tạo/.test(kq.tra) ? " (Người này chưa nối chat nên chưa được báo.)" : "");
  }

  ghiBot(khoa, chu, them = {}) {
    if (!chu) return null;
    const [kenh, ...ma] = khoa.split(":");
    this.hopThu.ghi(kenh, ma.join(":"), { vai: "bot", chu, ...them });
    return chu;
  }
}

const CAU_CHO = "Dạ câu này em xin phép kiểm tra lại rồi báo anh/chị ngay ạ.";

function timHoiNhanh(ds, chu) {
  const c = boDau(chu.toLowerCase()).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  for (const h of ds || []) {
    const tu = String(h.khi || "").split("|").map((x) => boDau(x.toLowerCase()).trim()).filter(Boolean);
    if (tu.some((t) => c === t || c.includes(t))) return h.tra;
  }
  return null;
}

// "08:00-22:00" theo giờ Việt Nam; trống = cả ngày.
function dangTrongGio(gio) {
  const m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(String(gio || "").trim());
  if (!m) return true;
  const vn = new Date(Date.now() + 7 * 3600e3);
  const phut = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return a <= b ? phut >= a && phut < b : phut >= a || phut < b;
}

// Câu ngắn hoặc chỉ trỏ ("cái này", "mẫu đó", "còn ko") — nghĩa nằm ở tin trước.
export function laCauCut(c) {
  const t = String(c || "").trim();
  return t.length < 18 || /(?<!\p{L})(?:cái (?:này|đó|kia)|mẫu (?:này|đó|kia)|nó|loại (?:này|đó)|sp này)(?!\p{L})/iu.test(t);
}

// Một số model ghi lời tự nghĩ vào câu trả lời ("Người dùng hỏi phí ship - tôi sẽ trả lời ngắn gọn",
// "I'll keep it brief"). Bỏ các đoạn đầu kiểu đó, không bao giờ gửi cho khách.
export function boSuyNghi(chu) {
  let s = String(chu || "").replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
  const NGHI = /^(?:(?:người dùng|khách(?: hàng)?|user|the user)\s+(?:hỏi|muốn|đang|vừa|is|wants|asked|asks)|(?:tôi|mình|em) (?:sẽ|cần|nên) (?:trả lời|viết|giữ|kiểm tra)|i(?:'ll| will| should| need to| must)\b|let me\b|okay[,.]|ok[,.] |so the user\b|i'm going to\b)/iu;
  for (let i = 0; i < 3; i++) {
    const [dau, ...con] = s.split(/\n+/);
    if (!con.length || !NGHI.test(dau.trim())) break;
    s = con.join("\n").trim();
  }
  // Câu tự nghĩ dính liền đầu đoạn: "I'll keep it brief. Dạ, ..." → cắt tới câu đầu tiên.
  s = s.replace(/^(?:(?:[Nn]gười dùng|[Tt]he user|[Uu]ser)[^.\n]{0,160}?[.\n]\s*|[Ii](?:'ll| will| should)[^.\n]{0,120}[.]\s*)+(?=\p{Lu})/u, "");
  // Zalo/FB hiện chữ thường: bỏ dấu markdown model hay chèn (**đậm**, # tiêu đề, `mã`).
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/`([^`]+)`/g, "$1");
  return s.trim();
}
