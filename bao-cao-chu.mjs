import fs from "node:fs";
// Báo cáo sáng / tối gửi chủ qua kênh đã nối (baoChu). Ghép từ dữ liệu sẵn có, không gọi AI nên không tốn credit.
const NS = "revidapi-nhansu", VH = "revidapi-vanhanh";
const ngay = (t = Date.now()) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const vn = (d) => d.split("-").reverse().slice(0, 2).join("/");

export function taoBaoCao(erp, buoi, luc = Date.now()) {
  const hn = ngay(luc), mai = ngay(luc + 864e5), dauNgay = new Date(hn + "T00:00:00").getTime();
  const nv = new Map(erp.docHet(NS, "nhanVien").map((n) => [n.id, n.ten]));
  const ten = (id) => nv.get(id) || "chưa giao";
  const cv = erp.docHet(VH, "congViec"), mo = cv.filter((v) => v.tt !== "xong");
  const qua = mo.filter((v) => v.han && v.han < hn), hanNay = mo.filter((v) => v.han === hn), hanMai = mo.filter((v) => v.han === mai);
  const cho = cv.filter((v) => v.tt === "cho-duyet"), chuaGiao = mo.filter((v) => !v.nguoiId && v.tuViec);
  const don = erp.docHet(VH, "donDuyet").filter((d) => d.tt === "cho");
  const hop = erp.docHet(VH, "lichHop").filter((h) => h.ngay === (buoi === "sang" ? hn : mai)).sort((a, b) => (a.gio || "").localeCompare(b.gio || ""));
  const xongHn = cv.filter((v) => v.tt === "xong" && (v.xong || 0) >= dauNgay);
  const ds = (a, n = 5) => a.slice(0, n).map((v) => `• ${v.ten} — ${ten(v.nguoiId)}${v.han ? " (hạn " + vn(v.han) + ")" : ""}`).join("\n") + (a.length > n ? `\n• …và ${a.length - n} việc nữa` : "");
  const p = [buoi === "sang" ? `☀️ Báo cáo sáng ${vn(hn)}` : `🌙 Tổng kết ngày ${vn(hn)}`];
  if (buoi === "toi") p.push(`Hôm nay xong ${xongHn.length} việc.` + (xongHn.length ? "\n" + ds(xongHn) : ""));
  if (qua.length) p.push(`⚠ ${qua.length} việc quá hạn:\n${ds(qua)}`);
  const sap = buoi === "sang" ? hanNay : hanMai;
  if (sap.length) p.push(`${buoi === "sang" ? "Hạn hôm nay" : "Hạn ngày mai"} (${sap.length}):\n${ds(sap)}`);
  if (hop.length) p.push(`${buoi === "sang" ? "Họp hôm nay" : "Họp ngày mai"}:\n` + hop.map((h) => `• ${h.gio || ""} ${h.ten}`).join("\n"));
  const can = [cho.length && `${cho.length} việc chờ anh/chị duyệt`, don.length && `${don.length} đơn chờ duyệt`, chuaGiao.length && `${chuaGiao.length} đề xuất của AI chưa có người nhận`].filter(Boolean);
  if (can.length) p.push("Cần anh/chị xử lý: " + can.join(", ") + ".");
  if (p.length === 1) p.push("Không có việc tồn, không có hạn gấp.");
  return p.join("\n\n");
}

// Mỗi phút xem giờ máy; tới giờ thì gửi, mỗi buổi chỉ một lần một ngày. Giờ đổi bằng BAO_SANG / BAO_TOI ("07:30", "21:00", "tat").
export function lichBaoCao({ erp, layCauHinh, guiQua, bao, fileNhac }) {
  const gio = { sang: process.env.BAO_SANG || "07:30", toi: process.env.BAO_TOI || "21:00" };
  const daGui = new Set();
  let daNhac = new Set(), daNhacNv = new Set();
  try { const j = JSON.parse(fs.readFileSync(fileNhac, "utf8")); daNhac = new Set(j.chu); daNhacNv = new Set(j.nv); } catch {}
  const luuNhac = () => { try { fs.writeFileSync(fileNhac, JSON.stringify({ chu: [...daNhac].slice(-2000), nv: [...daNhacNv].slice(-2000) })); } catch {} };
  const xem = async () => {
    const d = new Date(), bay = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    for (const buoi of ["sang", "toi"]) {
      const khoa = buoi + ngay();
      if (gio[buoi] !== bay || daGui.has(khoa)) continue;
      const bc = layCauHinh().baoChu;
      if (!bc?.kenh) continue;
      daGui.add(khoa);
      try { await guiQua(bc.kenh, bc.ma, taoBaoCao(erp, buoi)); } catch (e) { bao("bao-cao", "Không gửi được báo cáo " + buoi + ": " + e.message); }
    }
    // Nhắc hạn: từ giờ NHAC_HAN (mặc định 09:00) trở đi, việc nào hạn ngày mai mà chưa nhắc thì gom gửi.
    const bc = layCauHinh().baoChu, gioNhac = process.env.NHAC_HAN || "09:00";
    if (bc?.kenh && gioNhac !== "tat" && bay >= gioNhac) {
      const tin = nhacTruocHan(erp, Date.now(), daNhac);
      if (tin) try { await guiQua(bc.kenh, bc.ma, tin); } catch (e) { bao("bao-cao", "Không gửi được nhắc hạn: " + e.message); }
    }
    // Nhân viên đã nối kênh (#toi <mã NV>) nhận nhắc riêng việc của mình.
    if (gioNhac !== "tat" && bay >= gioNhac) for (const [nvId, k] of Object.entries(layCauHinh().nvKenh || {})) {
      const tin = nhacTruocHan(erp, Date.now(), daNhacNv, nvId);
      if (tin) try { await guiQua(k.kenh, k.ma, tin + "\n\nXong gõ: #xong <mã>"); } catch (e) { bao("bao-cao", "Không gửi được nhắc cho nhân viên: " + e.message); }
    }
    luuNhac();
  };
  setInterval(() => void xem(), 20e3).unref();
}

// Chủ giao việc ngay trong chat: "#viec Tên việc @Lan 30/10", "#xong 3f2a", "#ds". Trả câu trả lời, hoặc null nếu không phải lệnh.
const boDau = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
const ma4 = (id) => String(id).slice(-4);
export function lenhViec(erp, chu, luc = Date.now(), chi = null) {
  const t = chu.trim(), m = /^#(viec|việc|xong|ds)\b\s*([\s\S]*)$/i.exec(t);
  if (!m) return null;
  const lenh = boDau(m[1]), con = m[2].trim();
  const nvs = erp.docHet(NS, "nhanVien"), ten = (id) => nvs.find((n) => n.id === id)?.ten || "chưa giao";
  const mo = erp.docHet(VH, "congViec").filter((v) => v.tt !== "xong" && (!chi || v.nguoiId === chi));
  if (chi && lenh === "viec") return "Chỉ chủ mới giao việc qua chat. Anh/chị dùng #ds và #xong <mã>.";
  if (lenh === "ds") {
    if (!mo.length) return "Không có việc nào đang mở.";
    const xep = [...mo].sort((a, b) => (a.han || "9").localeCompare(b.han || "9"));
    return `Việc đang mở (${mo.length}):\n` + xep.slice(0, 15).map((v) => `• [${ma4(v.id)}] ${v.ten} — ${ten(v.nguoiId)}${v.han ? " (hạn " + vn(v.han) + ")" : ""}`).join("\n")
      + (mo.length > 15 ? `\n…và ${mo.length - 15} việc nữa` : "") + "\n\nXong việc nào gõ: #xong <mã>";
  }
  if (lenh === "xong") {
    const tim = mo.filter((v) => con && ma4(v.id) === con.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(-4));
    if (tim.length !== 1) return tim.length ? `Mã ${con} trùng ${tim.length} việc, gõ #ds để xem lại.` : `Không thấy việc đang mở mã "${con}". Gõ #ds để xem mã.`;
    const v = tim[0];
    erp.ghiNhieu([{ db: VH, kho: "congViec", id: v.id, v: { ...v, tt: "xong", xong: luc } }], "kenh-chat");
    return { tra: `Đã đánh dấu xong: ${v.ten}.`, viec: v };
  }
  // #viec
  let ten_ = con, han = "", nguoi = null;
  const h = /\s(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*$/.exec(" " + ten_);
  if (h) {
    const nam = h[3] || String(new Date(luc).getFullYear());
    han = `${nam}-${h[2].padStart(2, "0")}-${h[1].padStart(2, "0")}`;
    if (!h[3] && han < ngay(luc)) han = `${+nam + 1}${han.slice(4)}`;
    ten_ = (" " + ten_).slice(0, h.index).trim();
  }
  const a = /@(\S+(?:\s\S+){0,3})/.exec(ten_);
  if (a) {
    const tu = a[1].split(" ");
    for (const thu of tu.map((_, i) => tu.slice(0, tu.length - i).join(" "))) {
      const k = boDau(thu), khop = nvs.filter((n) => boDau(n.ten) === k || boDau(n.ten).split(" ").pop() === k || boDau(n.ten).endsWith(" " + k) || boDau(n.ten.replace(/^AI\s+/, "")) === k);
      if (khop.length === 1) { nguoi = khop[0]; ten_ = ten_.replace("@" + thu, "").replace(/\s+/g, " ").trim(); break; }
      if (khop.length > 1) return `Có ${khop.length} người tên "${thu}": ${khop.map((n) => n.ten).join(", ")}. Gõ rõ hơn, ví dụ @${khop[0].ten}.`;
    }
    if (!nguoi) return `Không thấy nhân viên "${a[1]}". Việc chưa được tạo.`;
  }
  if (!ten_) return "Gõ đúng dạng: #viec Tên việc @tên người 30/10 (người và hạn có thể bỏ).";
  const id = "chat-cv-" + luc.toString(36) + Math.random().toString(36).slice(2, 5);
  erp.ghiNhieu([{ db: VH, kho: "congViec", id, v: { id, duAnId: "", ten: ten_, moTa: "Chủ giao qua chat", nguoiId: nguoi?.id || "", han, uuTien: "vua", tt: "can-lam", tao: luc } }], "kenh-chat");
  return { viec: { id, ten: ten_, han, nguoiId: nguoi?.id || "" }, tra: `Đã tạo việc [${ma4(id)}]: ${ten_}` + (nguoi ? ` — giao ${nguoi.ten}` : " — chưa giao ai") + (han ? `, hạn ${vn(han)}` : "") + "." };
}

// Nhắc việc còn ~24 giờ tới hạn (hạn = cuối ngày ghi trong "han"). Mỗi việc nhắc một lần; gom chung một tin.
export function nhacTruocHan(erp, luc = Date.now(), daNhac = new Set(), chi = null) {
  const mai = ngay(luc + 864e5);
  const nvs = new Map(erp.docHet(NS, "nhanVien").map((n) => [n.id, n.ten]));
  const can = erp.docHet(VH, "congViec").filter((v) => v.tt !== "xong" && v.han === mai && !daNhac.has(v.id + v.han) && (!chi || v.nguoiId === chi));
  if (!can.length) return null;
  can.forEach((v) => daNhac.add(v.id + v.han));
  return `⏰ ${can.length} việc tới hạn ngày mai (${vn(mai)}):\n` + can.slice(0, 10).map((v) => `• [${ma4(v.id)}] ${v.ten} — ${nvs.get(v.nguoiId) || "chưa giao"}`).join("\n")
    + (can.length > 10 ? `\n…và ${can.length - 10} việc nữa` : "");
}
