// Công ty tự chạy: chủ vắng mặt, vẫn có việc mới, có người nhận, có người duyệt.
// Bật bằng TU_VAN_HANH=1. Trần: TU_VAN_HANH_GIO (giờ chạy) và TU_VAN_HANH_TRAN (tổng lượt gọi AI).
// Chỉ tự duyệt việc rủi ro thấp; việc dính tiền/khách/hợp đồng/lương vẫn chờ chủ.
import { NHAN_VIEN_AI } from "./nhan-vien-ai.mjs";
import { gieoSoLieu, nhipBanHang } from "./so-lieu.mjs";
import { nhipThiTruong } from "./thi-truong.mjs";
import fs from "node:fs";
import path from "node:path";

const NS = "revidapi-nhansu", VH = "revidapi-vanhanh";
const RUI_RO = /tiền|chi phí|chi tiêu|thanh toán|chuyển khoản|lương|thưởng|phạt|hợp đồng|gửi khách|nhắn khách|gọi khách|giá bán|giảm giá|khuyến mãi|xoá|xóa|sa thải|tuyển|đặt hàng nhà cung cấp|mua /i;
const ngay = (t) => new Date(t).toISOString().slice(0, 10);

// Công ty mẫu: tiệm bánh nhỏ, 4 người thật + 6 AI (AI do nhan-vien-ai.mjs tự thêm).
const NGUOI = [
  ["nv-chu", "NV01", "Trần Minh Châu", "Chủ tiệm", "Ban giám đốc"],
  ["nv-tho", "NV02", "Lê Thu Hà", "Thợ bánh chính", "Sản xuất"],
  ["nv-ban", "NV03", "Ngô Gia Bảo", "Bán hàng", "Bán hàng"],
  ["nv-giao", "NV04", "Đỗ Quang Huy", "Giao hàng", "Bán hàng"],
];
// Phòng nào xong việc thì nghỉ; chỉ Marketing và Bán hàng (tìm khách) được giao mục tiêu mới liên tục.
const MUC_TIEU = [
  ["ai-marketing", "Lên lịch nội dung Facebook/TikTok 7 ngày: ưu tiên bánh ít ngọt, mẫu đẹp, giá ghi rõ; dựa trên số bán 30 ngày và báo cáo thị trường mới nhất."],
  ["ai-ban-hang", "Lập danh sách khách tiềm năng từ báo cáo thị trường mới nhất (bình luận hỏi giá/địa chỉ/ship), soạn câu trả lời mẫu cho từng người. Người thật gửi sau khi chủ duyệt."],
  ["ai-marketing", "So giá và mẫu bánh của tiệm với đối thủ trong tài liệu thư mục Thị trường; đề xuất 3 combo/mẫu mới kèm giá vốn và giá đề xuất."],
  ["ai-ban-hang", "Rà khách cũ 60 ngày: ai lâu không mua, ai mua sinh nhật năm ngoái; soạn kịch bản chăm sóc lại. Chỉ là bản nháp chờ chủ."],
];

export class TuVanHanh {
  constructor({ erp, bao }) {
    Object.assign(this, { erp, bao });
    this.batDau = Date.now();
    this.gio = Number(process.env.TU_VAN_HANH_GIO) || 2;
    this.tran = Number(process.env.TU_VAN_HANH_TRAN) || 150;
    this.lan = {};
  }

  dungAi() { return this.erp.docHet(VH, "congViec").reduce((s, v) => s + (v.aiDung || 0), 0); }

  khoiTao() {
    gieoSoLieu(this.erp, this.bao);
    if (this.erp.docHet(NS, "nhanVien").some((n) => n.id === "nv-chu")) return;
    this.erp.ghiNhieu(NGUOI.map(([id, ma, ten, chucVu, phongBan]) => ({ db: NS, kho: "nhanVien", id, v: {
      id, ma, ten, sdt: "", chucVu, phongBan, ngayVao: ngay(Date.now()), kieuLuong: "thang", luong: 0, phuCap: 0, baoHiem: 0, nghi: false, ghiChu: "Công ty mẫu tự chạy", tao: Date.now() } })), "tu-van-hanh");
    this.bao?.("tu-van-hanh", "Đã dựng công ty mẫu: Tiệm bánh Mây");
  }

  /** Một nhịp: hết hạn/hết trần thì dừng; duyệt việc an toàn; giao việc trôi nổi; thiếu việc thì giao mục tiêu mới cho AI Điều hành. */
  nhip() {
    const daChay = (Date.now() - this.batDau) / 3600e3, dung = this.dungAi();
    if (daChay > this.gio || dung >= this.tran) {
      if (!this.dung) { this.dung = true; this.bao?.("tu-van-hanh", `Dừng: chạy ${daChay.toFixed(2)} giờ, ${dung} lượt AI (trần ${this.gio} giờ / ${this.tran} lượt)`); }
      return;
    }
    nhipBanHang(this.erp);
    // Báo cáo thị trường không bao giờ tự duyệt: chủ đọc rồi mới chia việc.
    if (!this.dangTim) {
      let khoa = ""; try { khoa = JSON.parse(fs.readFileSync(path.join(process.env.KENH_DATA || "", "cau-hinh.json"))).khoa; } catch {}
      this.dangTim = nhipThiTruong({ erp: this.erp, khoa, bao: this.bao, phut: Number(process.env.THI_TRUONG_PHUT) || 60 })
        .catch((e) => this.bao?.("thi-truong", e.message)).finally(() => { this.dangTim = null; });
    }
    const cv = this.erp.docHet(VH, "congViec"), doi = [], luc = Date.now();
    const laAi = (id) => NHAN_VIEN_AI.some((a) => a.id === id);
    for (const v of cv) {
      if (v.tt === "cho-duyet" && laAi(v.nguoiId)) {
        // Xét tên việc, không xét bài báo cáo (báo cáo nào cũng nhắc tiền); việc đã sinh đơn đề nghị chi luôn chờ chủ.
        if (v.thiTruong || RUI_RO.test(v.ten) || /đơn duyệt|Không làm được|chưa đạt/.test(v.moTa || "")) continue;
        doi.push({ ...v, tt: "xong", xong: luc, moTa: `${v.moTa || ""}\n\n✓ Tự duyệt (rủi ro thấp) · ${new Date(luc).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}` });
      } else if (v.tt === "can-lam" && !v.nguoiId && !RUI_RO.test(v.ten) && !/hết ngân sách/.test(v.moTa || "")) {
        doi.push({ ...v, nguoiId: "ai-dieu-hanh", moTa: `${v.moTa || ""}\n(Tự giao cho AI Điều hành chia lại)` });
      }
    }
    for (const [nguoiId, ten] of MUC_TIEU) {
      if (cv.some((v) => v.nguoiId === nguoiId && (v.tt === "can-lam" || v.tt === "dang-lam")) || doi.some((v) => v.nguoiId === nguoiId && v.tt === "can-lam")) continue;
      const mt = MUC_TIEU.filter((m) => m[0] === nguoiId), lan = (this.lan[nguoiId] = (this.lan[nguoiId] || 0) + 1);
      const chon = mt[(lan - 1) % mt.length][1], id = `tvh-${nguoiId}-${luc.toString(36)}`;
      doi.push({ id, duAnId: "", ten: chon.split(":")[0].slice(0, 80), moTa: chon + "\n(Mục tiêu tự sinh: marketing và tìm khách là ưu tiên)", nguoiId,
        han: ngay(luc + 864e5), uuTien: "cao", tt: "can-lam", tao: luc, aiNganSach: 15 });
    }
    if (doi.length) this.erp.ghiNhieu(doi.map((v) => ({ db: VH, kho: "congViec", id: v.id, v })), "tu-van-hanh");
  }

  chay() {
    this.khoiTao();
    this.nhip();
    return setInterval(() => { try { this.nhip(); } catch (e) { this.bao?.("tu-van-hanh", e.message); } }, 60e3);
  }
}
