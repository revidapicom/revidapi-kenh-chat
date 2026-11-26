/**
 * Nhân viên AI: mỗi bộ phận có một "người" trong Nhân sự (id ai-<bộ phận>). Chủ giao việc cho họ ở trang Công việc
 * như giao cho người thật; máy chủ nhận việc "Cần làm", gọi API RevidAPI của chủ với ĐÚNG dữ liệu bộ phận đó được đọc,
 * rồi ghi kết quả qua cùng bộ lọc quyền của nhân viên thường (locGhi). Việc xong chuyển sang "Chờ duyệt" để chủ xem.
 */
import { BO_PHAN, duocDoc, choXem, locGhi } from "./quyen.mjs";
import { thuTuModel, laKhongBan, ghiKhongBan } from "./model-ban.mjs";

const NS = "revidapi-nhansu", VH = "revidapi-vanhanh", ERP = "revidapi-erp";
export const NHAN_VIEN_AI = [
  { id: "ai-kho", ma: "AI-KHO", ten: "AI Kho", boPhan: "kho", chucVu: "Thủ kho (AI)" },
  { id: "ai-ban-hang", ma: "AI-BH", ten: "AI Bán hàng", boPhan: "banHang", chucVu: "Nhân viên bán hàng (AI)" },
  { id: "ai-ke-toan", ma: "AI-KT", ten: "AI Kế toán", boPhan: "keToan", chucVu: "Kế toán (AI)" },
  { id: "ai-marketing", ma: "AI-MKT", ten: "AI Marketing", boPhan: "marketing", chucVu: "Marketing (AI)" },
  { id: "ai-nhan-su", ma: "AI-NS", ten: "AI Nhân sự", boPhan: "nhanSu", chucVu: "Nhân sự (AI)" },
  // Điều hành: đọc số tổng của mọi phòng, chỉ được chia việc cho các AI khác và viết tài liệu, không đụng tiền/kho.
  { id: "ai-dieu-hanh", ma: "AI-DH", ten: "AI Điều hành", boPhan: "dieuHanh", chucVu: "Trợ lý điều hành (AI)",
    quyen: { ten: "Điều hành", an: [], doc: ["erp/*", "crm/*", "nhansu/*", "vanhanh/*"], ghi: ["vanhanh/congViec", "vanhanh/taiLieu"] } },
];
const quyenAi = (ai) => ai.quyen || BO_PHAN[ai.boPhan];
const ngay = (t) => new Date(t).toISOString().slice(0, 10);
// Giám sát: không giới hạn số bậc, nhưng mỗi mục tiêu gốc có ngân sách lượt gọi AI (kể cả lượt duyệt); hết thì cả chuỗi dừng, phần còn lại thành đề xuất chờ chủ giao.
const NGAN_SACH = Number(process.env.AI_NGAN_SACH) || 40;
// Kết quả của các phòng được AI Điều hành duyệt; sai thì trả về làm lại tối đa từng này lần.
const LAM_LAI = 1;
const tu = (x) => new Set(String(x || "").toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
const giong = (a, b) => { const A = tu(a), B = tu(b); let c = 0; for (const w of A) if (B.has(w)) c++; return c / Math.max(1, Math.min(A.size, B.size)); };

// Ngữ cảnh theo bộ phận: số liệu đã gom sẵn, không đổ 36.000 phiếu kho cho model.
const NGU_CANH = {
  kho(doc, homNay) {
    const tu = ngay(Date.parse(homNay) - 30 * 864e5);
    const ban = {};
    for (const p of doc(ERP, "phieuKho")) if (p.loai === "ban" && p.ngay >= tu) ban[p.spId] = (ban[p.spId] || 0) - p.sl;
    const sp = doc(ERP, "sanPham"), duoi = sp.filter((s) => s.ton < (s.tonMin ?? 0));
    return `Tổng: ${sp.length} mã, ${sp.reduce((a, s) => a + (s.ton || 0), 0)} cái tồn; dưới tồn tối thiểu: ${duoi.map((s) => `${s.ma} ${s.ton}/${s.tonMin}`).join(", ") || "không"}.\n`
      + "Hàng hoá (mã | tên | tồn | tồn tối thiểu | giá vốn | đã bán 30 ngày):\n" + sp
      .map((s) => `${s.ma} | ${s.ten} | ${s.ton} | ${s.tonMin ?? 0} | ${s.giaVon ?? "?"} | ${ban[s.id] || 0}`).join("\n");
  },
  banHang(doc) {
    const cho = doc(ERP, "donHang").filter((d) => d.trangThai === "cho");
    const hang = doc(ERP, "sanPham");
    const ht = doc(VH, "hoiThoai").filter((h) => h.tt !== "xong").sort((a, b) => b.sua - a.sua);
    return `Đơn chờ duyệt từ chatbot (${cho.length}):\n` + cho.map((d) => `${d.so} | ${d.ngay} | ${d.tenKhach} ${d.sdt || ""} | `
        + d.dong.map((x) => { const sp = hang.find((s) => s.id === x.spId); return `${x.ten} x${x.sl} giá ${x.gia} (tồn ${sp?.ton ?? "?"})`; }).join(", ")
        + ` | ship ${d.phiShip || 0} | ${d.ghiChu || ""}`).join("\n")
      + `\n\nHội thoại khách chưa xong (${ht.length}):\n` + ht.map((h) => `[${h.kenh}] ${h.ten}: ` + h.tin.map((t) => `${t.tu}: ${t.chu}`).join(" / ")).join("\n")
      + "\n\nHàng hoá (mã | tên | giá bán | tồn):\n" + hang.map((s) => `${s.ma} | ${s.ten} | ${s.giaBan} | ${s.ton}`).join("\n");
  },
  keToan(doc, homNay) {
    const tu = ngay(Date.parse(homNay) - 30 * 864e5), nhom = {};
    for (const t of doc(ERP, "thuChi")) if (t.ngay >= tu) { const k = `${t.loai} · ${t.hangMuc}`; nhom[k] = (nhom[k] || 0) + t.soTien; }
    const tong = (d) => d.dong.reduce((a, x) => a + x.sl * x.gia, 0) - (d.giam || 0) + (d.phiShip || 0);
    const no = {};
    for (const d of doc(ERP, "donHang")) if (d.trangThai === "xong" && tong(d) > (d.daThu || 0)) {
      const k = d.tenKhach || d.lienHeId; no[k] = no[k] || { tien: 0, don: 0, cu: d.ngay }; no[k].tien += tong(d) - (d.daThu || 0); no[k].don++; if (d.ngay < no[k].cu) no[k].cu = d.ngay;
    }
    const dsNo = Object.entries(no).sort((a, b) => b[1].tien - a[1].tien);
    return `Thu chi 30 ngày (từ ${tu}) theo hạng mục:\n` + Object.entries(nhom).map(([k, v]) => `${k}: ${v}`).join("\n")
      + `\n\nCông nợ khách (${dsNo.length} khách, tổng ${dsNo.reduce((a, [, v]) => a + v.tien, 0)}). Từng khách (khách | còn nợ | số đơn | đơn nợ cũ nhất):\n`
      + dsNo.map(([k, v]) => `${k} | ${v.tien} | ${v.don} | ${v.cu}`).join("\n");
  },
  marketing(doc) {
    const ht = doc(VH, "hoiThoai").sort((a, b) => b.sua - a.sua);
    return "Hàng hoá (mã | tên | nhóm | giá bán | tồn):\n" + doc(ERP, "sanPham").map((s) => `${s.ma} | ${s.ten} | ${s.nhom} | ${s.giaBan} | ${s.ton}`).join("\n")
      + `\n\nKhách nhắn gần đây:\n` + ht.map((h) => `${h.ten}: ` + h.tin.filter((t) => t.tu === "khach").map((t) => t.chu).join(" / ")).join("\n")
      + `\n\nSố khách trong CRM: ${doc("revidapi-crm", "lienHe").length}`;
  },
  dieuHanh(doc, homNay, ...k) {
    // Mỗi phòng cắt bớt cho vừa ngữ cảnh; dòng "Tổng" đứng đầu nên không mất, và ghi rõ đã cắt để AI không lấy phần thấy được làm tổng.
    const nv = doc(NS, "nhanVien").filter((n) => !n.nghi && !n.id.startsWith("ai-")).map((n) => `${n.id} | ${n.ten} | ${n.phongBan} | ${n.chucVu || ""}`).join("\n");
    return ["kho", "banHang", "keToan", "marketing", "nhanSu"].map((b) => `### ${BO_PHAN[b].ten}\n` + NGU_CANH[b](doc, homNay, ...k)).join("\n\n")
      + `\n\n### Nhân viên người (id | tên | phòng | chức vụ)\n${nv}`;
  },
  nhanSu(doc, homNay) {
    const thang = homNay.slice(0, 7), cong = {};
    for (const c of doc(NS, "chamCong")) if (c.ngay.startsWith(thang)) {
      const o = cong[c.nvId] = cong[c.nvId] || { di: 0, nua: 0, phep: 0, vang: 0, muon: 0, tangCa: 0 }; o[c.tt]++; o.tangCa += c.tangCa || 0;
    }
    const ds = doc(NS, "nhanVien").filter((n) => !n.nghi && !n.id.startsWith("ai-")), t = { vang: 0, muon: 0, tangCa: 0 };
    for (const n of ds) { const o = cong[n.id] || {}; t.vang += o.vang || 0; t.muon += o.muon || 0; t.tangCa += o.tangCa || 0; }
    return `Tổng tháng ${thang}: ${ds.length} người, ${t.vang} ngày vắng, ${t.muon} lượt muộn, ${t.tangCa} giờ tăng ca.\n`
      + `Chấm công tháng ${thang} (mã | tên | phòng | đi | nửa ngày | phép | vắng | muộn | giờ tăng ca):\n` + doc(NS, "nhanVien").filter((n) => !n.nghi && !n.id.startsWith("ai-"))
      .map((n) => { const o = cong[n.id] || {}; return `${n.ma} | ${n.ten} | ${n.phongBan} | ${o.di || 0} | ${o.nua || 0} | ${o.phep || 0} | ${o.vang || 0} | ${o.muon || 0} | ${o.tangCa || 0}`; }).join("\n");
  },
};

const HUONG_DAN = `Bạn là nhân viên AI của một công ty bán lẻ, làm đúng việc chủ giao, chỉ dùng số liệu được cung cấp, không bịa.
Trả về DUY NHẤT một JSON:
{"baoCao": "báo cáo ngắn gọn bằng tiếng Việt cho chủ, có số cụ thể",
 "taoMoi": [ mỗi phần tử là MỘT trong:
   {"kho":"congViec","ten":"...","moTa":"...","uuTien":"thap|vua|cao","han":"YYYY-MM-DD"},
   {"kho":"donDuyet","loai":"de-nghi-chi|khac","soTien":0,"lyDo":"..."},
   {"kho":"taiLieu","thuMuc":"...","ten":"...","noiDung":"..."} ]}
Việc cần phòng khác làm tiếp thì tạo congViec kèm "giaoCho": id AI phòng đó (ai-kho, ai-ban-hang, ai-ke-toan, ai-marketing, ai-nhan-su) và ghi rõ số liệu cần trong moTa; AI đó sẽ tự nhận làm.
Nếu chủ yêu cầu giao cho nhân viên (người) thì "giaoCho" là id nhân viên trong danh sách "Nhân viên người", chọn đúng phòng ban; việc đó chờ người làm, AI không tự làm.
Tài liệu (taiLieu): "thuMuc" chọn đúng MỘT trong: Báo cáo, Kho, Bán hàng, Kế toán, Khách hàng, Nhân sự, Thị trường, Quy trình. "ten" tiếng Việt có dấu, ngắn, không lặp ngày nếu không cần. "noiDung" viết markdown: tiêu đề ## từng phần, số liệu dạng bảng | cột |, gạch đầu dòng, xuống dòng bằng \n — không dồn thành một đoạn. Cùng tên với tài liệu cũ thì bản mới thay bản cũ.
Chỉ tạo mục trong taoMoi khi việc được giao yêu cầu. Đề nghị chi tiền phải có số tiền tính từ số liệu.`;

export class NhanVienAi {
  constructor({ erp, layCauHinh, ghiNhatKy, bao }) {
    Object.assign(this, { erp, layCauHinh, ghiNhatKy, bao });
    this.dang = new Set();
  }

  /** Thêm các nhân viên AI vào danh sách Nhân sự (một lần) để chủ chọn được ở ô "Người làm". */
  damBao() {
    const thieu = NHAN_VIEN_AI.filter((a) => !this.erp.doc(NS, "nhanVien", a.id));
    if (!thieu.length) return;
    this.erp.ghiNhieu(thieu.map((a) => ({ db: NS, kho: "nhanVien", id: a.id, v: {
      id: a.id, ma: a.ma, ten: a.ten, sdt: "", chucVu: a.chucVu, phongBan: "Nhân viên AI", ngayVao: ngay(Date.now()),
      kieuLuong: "thang", luong: 0, phuCap: 0, baoHiem: 0, nghi: false, ghiChu: "Chạy bằng API RevidAPI của chủ", tao: Date.now() } })), "ai");
  }

  vong() {
    for (const v of this.erp.docHet(VH, "congViec")) {
      const ai = NHAN_VIEN_AI.find((a) => a.id === v.nguoiId);
      if (!ai || this.dang.has(v.id)) continue;
      if (v.tt === "can-lam") this.lam(ai, v).catch(() => {});
      // Treo: "Đang làm" mà không có tiến trình nào giữ (máy chủ khởi động lại, lỗi giữa chừng). Việc đang chạy thật có hạn 180 giây ở goi().
      else if (v.tt === "dang-lam") {
        const lan = (v.treo || 0) + 1, ghi = { ...v, treo: lan };
        if (lan > 1) Object.assign(ghi, { tt: "can-lam", nguoiId: "", moTa: `${v.moTa || ""}\n\n⚠ ${ai.ten} treo ${lan} lần — đã bỏ người làm, chờ chủ giao lại.` });
        else Object.assign(ghi, { tt: "can-lam" });
        this.erp.ghiNhieu([{ db: VH, kho: "congViec", id: v.id, v: ghi }], "ai:giam-sat");
        if (lan > 1) this.bao?.("ai", `Việc "${v.ten}" treo ${lan} lần, chờ chủ giao lại`);
      }
    }
  }

  /** Trừ một lượt vào ngân sách của mục tiêu gốc; false nếu đã hết. */
  tieu(viec) {
    const id = viec.goc || viec.id, goc = this.erp.doc(VH, "congViec", id);
    if (!goc) return false;   // việc gốc đã bị xoá: dừng chuỗi, không chạy không trần ngân sách
    const dung = goc.aiDung || 0;
    if (dung >= (goc.aiNganSach || NGAN_SACH)) return false;
    this.erp.ghiNhieu([{ db: VH, kho: "congViec", id, v: { ...goc, aiDung: dung + 1 } }], "ai:giam-sat");
    return true;
  }

  async lam(ai, viec) {
    this.dang.add(viec.id);
    const q = quyenAi(ai), nguon = "ai:" + ai.id;
    const ghiViec = (sua) => { const v = { ...this.erp.doc(VH, "congViec", viec.id), ...sua }; this.erp.ghiNhieu([{ db: VH, kho: "congViec", id: viec.id, v }], nguon); return v; };
    const luc = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    try {
      if (!this.tieu(viec)) {
        ghiViec({ tt: "can-lam", nguoiId: "", moTa: `${viec.moTa || ""}\n\n⚠ Mục tiêu đã dùng hết ngân sách ${this.erp.doc(VH, "congViec", viec.goc || viec.id)?.aiNganSach || NGAN_SACH} lượt AI — dừng chuỗi, chờ chủ giao hoặc nâng ngân sách.` });
        this.bao?.("ai", `Hết ngân sách AI cho "${viec.ten}"`);
        return;
      }
      ghiViec({ tt: "dang-lam", batDau: Date.now() });
      const doc = (db, kho) => (duocDoc(q, db, kho) ? this.erp.docHet(db, kho).map((x) => choXem(q, x)) : []);
      const homNay = ngay(Date.now());
      const duocTao = ["congViec", "donDuyet", "taiLieu"].filter((k) => q.ghi.includes("vanhanh/" + k));
      const nguCanh = `Hôm nay ${homNay}. Bạn là ${ai.ten}, bộ phận ${q.ten}. Bộ phận bạn CHỈ được tạo: ${duocTao.join(", ")}.`
        + ` Việc cần loại khác thì nói rõ trong baoCao là bạn không có quyền, đừng nói đã làm.\n\n` + (NGU_CANH[ai.boPhan]?.(doc, homNay) || "");
      const kq = await this.goi(nguCanh, `Việc được giao: ${viec.ten}\n${viec.moTa || ""}`, false, ai);
      // Mọi thứ AI tạo đi qua đúng bộ lọc quyền của bộ phận đó.
      const nguoi = new Set(this.erp.docHet(NS, "nhanVien").filter((n) => !n.nghi && !n.id.startsWith("ai-")).map((n) => n.id));
      // Tổ tiên trong chuỗi: dùng để chặn vòng (A nhờ B, B nhờ lại A cùng một việc).
      const toTien = []; for (let x = viec; x; x = x.tuViec && this.erp.doc(VH, "congViec", x.tuViec)) { toTien.push(x); if (toTien.length > 500) break; }
      const doi = (Array.isArray(kq.taoMoi) ? kq.taoMoi : []).map((m, i) => banGhi(m, ai, viec, i, nguoi, toTien, this.erp.docHet(VH, "taiLieu"))).filter(Boolean);
      const { duoc, bo } = locGhi(q, doi, (db, kho, id) => this.erp.doc(db, kho, id));
      if (duoc.length) this.erp.ghiNhieu(duoc, nguon);
      const duyet = await this.duyet(ai, viec, kq, nguCanh);
      if (duyet && !duyet.dat && (viec.lamLai || 0) < LAM_LAI) {
        ghiViec({ tt: "can-lam", lamLai: (viec.lamLai || 0) + 1, moTa: `${viec.moTa || ""}\n\n— AI Điều hành trả về làm lại · ${luc}\n${duyet.lyDo}` });
        this.bao?.("ai", `AI Điều hành trả "${viec.ten}" về ${ai.ten} làm lại`);
        return;
      }
      const tenAi = (id) => NHAN_VIEN_AI.find((a) => a.id === id)?.ten || (id && this.erp.doc(NS, "nhanVien", id)?.ten);
      const tao = duoc.map((d) => `${{ congViec: "việc", donDuyet: "đơn duyệt", taiLieu: "tài liệu" }[d.kho]} "${d.v.ten || d.v.lyDo}"` + (tenAi(d.v.nguoiId) ? ` → ${tenAi(d.v.nguoiId)}` : ""));
      ghiViec({ tt: "cho-duyet", moTa: `${viec.moTa ? viec.moTa + "\n\n" : ""}— ${ai.ten} · ${luc}\n${String(kq.baoCao || "").trim()}`
        + (tao.length ? `\n\nĐã tạo: ${tao.join("; ")}` : "") + (duyet ? `\n\n${duyet.dat ? "✓ AI Điều hành đã duyệt" : "⚠ AI Điều hành chưa đạt sau khi làm lại"}: ${duyet.lyDo}` : "") + (bo ? `\n⚠ ${bo} mục ngoài quyền bộ phận ${q.ten} đã bị chặn, KHÔNG được lưu.` : "") });
      this.bao?.("ai", `${ai.ten} xong "${viec.ten}"`);
    } catch (e) {
      ghiViec({ tt: "cho-duyet", moTa: `${viec.moTa ? viec.moTa + "\n\n" : ""}— ${ai.ten} · ${luc}\nKhông làm được: ${e.message}` });
      this.ghiNhatKy?.({ kenh: "ai", vao: viec.ten, loi: e.message });
    } finally { this.dang.delete(viec.id); setImmediate(() => this.vong()); }
  }

  /** AI Điều hành kiểm kết quả của phòng khác dựa trên đúng dữ liệu phòng đó đã thấy. Không duyệt việc của chính nó. */
  async duyet(ai, viec, kq, nguCanh) {
    if (ai.id === "ai-dieu-hanh" || !this.tieu(viec)) return null;
    try {
      const j = await this.goi(nguCanh, `Bạn là AI Điều hành, đang DUYỆT kết quả của ${ai.ten} cho việc "${viec.ten}".\n${viec.moTa || ""}\n\nKết quả nộp:\n${JSON.stringify(kq)}\n\n`
        + `Đối chiếu từng con số với dữ liệu ở trên. Trả JSON {"dat": true/false, "lyDo": "một-hai câu: đúng ở đâu hoặc sai số nào, đúng phải là bao nhiêu"}. Chỉ đánh false khi sai số liệu, bịa, hoặc không làm đúng việc được giao; đừng bắt bẻ văn phong. Không cần taoMoi.`, true);
      return { dat: j.dat !== false, lyDo: String(j.lyDo || "").trim() };
    } catch { return null; }
  }

  async goi(nguCanh, viec, khongHuongDan, ai) {
    const ch = this.layCauHinh(), rieng = ai ? this.erp.doc(NS, "nhanVien", ai.id) || {} : {};   // model + nhiệm vụ riêng chủ đặt ở Văn phòng 3D
    const heThong = khongHuongDan ? "Bạn là người duyệt kết quả, chỉ trả JSON." : HUONG_DAN + (rieng.aiNhiemVu ? `\n\nNHIỆM VỤ RIÊNG chủ giao cho ${rieng.ten || ai.ten}:\n${rieng.aiNhiemVu}` : "");
    if (!ch.khoa) throw new Error("Chưa nhập khoá API RevidAPI trong Kênh Chat.");
    let loi;
    for (const model of thuTuModel(rieng.aiModel, ch.model, ch.modelDuPhong)) {   // model ngừng bán thì lùi sang model còn bán
      try {
        const r = await fetch(ch.coSo + "/v1/chat/completions", {
          method: "POST", signal: AbortSignal.timeout(180e3),
          headers: { "content-type": "application/json", authorization: "Bearer " + ch.khoa },
          body: JSON.stringify({ model, response_format: { type: "json_object" }, messages: [
            { role: "system", content: heThong }, { role: "user", content: nguCanh + "\n\n" + viec }] }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { const e = new Error(j.error?.message || j.detail || "HTTP " + r.status); e.ma = r.status; throw e; }
        const chu = j.choices?.[0]?.message?.content || "";
        return JSON.parse(chu.slice(chu.indexOf("{"), chu.lastIndexOf("}") + 1));
      } catch (e) {
        loi = e;
        if (laKhongBan(e)) ghiKhongBan(model);
        else if ([401, 402, 403].includes(e.ma)) throw e;   // khoá sai/hết credit: đổi model cũng vậy
      }
    }
    throw loi;
  }
}

const THU_MUC_TL = ["Báo cáo", "Kho", "Bán hàng", "Kế toán", "Khách hàng", "Nhân sự", "Thị trường", "Quy trình"];
const khoa = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "");
/** AI hay đặt thư mục kiểu "BaoCaoThiTruong", "Kho/Kiểm kê": quy về danh sách cố định, không khớp thì "Báo cáo". */
const TU_KHOA_TL = [["Kho", /kho|kiemke|nguyenlieu|tonkho/], ["Kế toán", /ketoan|congno|doichieu|thuchi|chiphi/], ["Khách hàng", /khach|crm/], ["Bán hàng", /banhang|donhang|giaban|sanpham/],
  ["Nhân sự", /nhansu|chamcong|luong/], ["Thị trường", /thitruong|doithu|mangxahoi|binhluan/], ["Quy trình", /quytrinh|sop|chinhsach/]];
const thuMucTl = (x) => { const k = khoa(x); return THU_MUC_TL.find((t) => k === khoa(t)) || TU_KHOA_TL.find(([, r]) => r.test(k))?.[0] || "Báo cáo"; };

function banGhi(m, ai, viec, i, nguoi = new Set(), toTien = [], taiLieu = []) {
  const id = `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${i}`, tao = Date.now(), s = (x) => String(x ?? "");
  if (m?.kho === "congViec") {
    const chuoi = (viec.chuoi || 0) + 1, nhan = NHAN_VIEN_AI.find((a) => a.id === m.giaoCho && a.id !== ai.id && a.id !== "ai-dieu-hanh");
    const vong = nhan && toTien.some((x) => x.nguoiId === nhan.id && giong(x.ten, m.ten) >= 0.5);
    const tuDong = !!nhan && !vong, choNguoi = nguoi.has(m.giaoCho);
    return { db: VH, kho: "congViec", id, v: { id, duAnId: viec.duAnId, ten: s(m.ten), chuoi, tuViec: viec.id,
    goc: viec.goc || viec.id,
    moTa: s(m.moTa) + `\n(${ai.ten} ${tuDong || choNguoi ? "giao" : "đề xuất"} từ việc "${s(viec.ten)}")` + (vong ? `\n⚠ Chặn vòng: ${nhan.ten} đã làm việc gần giống ở bậc trước — chờ chủ quyết.` : ""),
    nguoiId: tuDong ? nhan.id : choNguoi ? m.giaoCho : "", han: /^\d{4}-\d\d-\d\d$/.test(m.han) ? m.han : "", uuTien: ["thap", "vua", "cao"].includes(m.uuTien) ? m.uuTien : "vua", tt: "can-lam", tao } };
  }
  if (m?.kho === "donDuyet") return { db: VH, kho: "donDuyet", id, v: { id, loai: m.loai === "de-nghi-chi" ? "de-nghi-chi" : "khac", nguoiId: ai.id,
    tu: ngay(tao), den: ngay(tao), soTien: Math.max(0, Math.round(Number(m.soTien) || 0)), gio: 0, lyDo: s(m.lyDo), tt: "cho", yKien: "", tao } };
  if (m?.kho === "taiLieu") {
    const thuMuc = thuMucTl(m.thuMuc), ten = s(m.ten).trim();
    const cu = taiLieu.find((t) => t.thuMuc === thuMuc && khoa(t.ten) === khoa(ten)); // trùng tên thì ghi đè, không đẻ bản thứ hai
    const idTl = cu?.id || id;
    return { db: VH, kho: "taiLieu", id: idTl, v: { id: idTl, thuMuc, ten, noiDung: s(m.noiDung).replace(/\\n/g, "\n"), sua: tao } };
  }
  return null;
}
