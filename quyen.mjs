/**
 * Phân quyền theo bộ phận cho dữ liệu công ty (bảng quản lý đồng bộ qua /api/erp/*).
 * Kiểm ở máy chủ: nhân viên chỉ KÉO VỀ được kho mình được đọc, chỉ GHI được kho mình được ghi,
 * trường bị ẩn (giá vốn) bị xoá trước khi gửi và được giữ nguyên bản cũ khi họ ghi lại.
 * Bảng y hệt nằm ở dashboard/src/lib/quyen.ts để ẩn menu — sửa thì sửa cả hai.
 */
const CHUNG_DOC = ["vanhanh/taiLieu", "vanhanh/congViec", "vanhanh/lichHop", "vanhanh/duAn", "vanhanh/donDuyet"];
const CHUNG_GHI = ["vanhanh/congViec", "vanhanh/donDuyet"];

export const BO_PHAN = {
  banHang: { ten: "Bán hàng", an: ["giaVon"],
    doc: ["erp/sanPham", "erp/donHang", "crm/*", "vanhanh/hoiThoai", ...CHUNG_DOC],
    // Duyệt đơn chat phải trừ tồn: được sửa đúng cột ton của hàng hoá, không sửa giá.
    ghi: ["erp/donHang", "erp/phieuKho", "erp/sanPham:ton,sua", "crm/*", "vanhanh/hoiThoai", ...CHUNG_GHI] },
  kho: { ten: "Kho", an: [],
    doc: ["erp/sanPham", "erp/phieuKho", "erp/donHang", ...CHUNG_DOC],
    ghi: ["erp/sanPham", "erp/phieuKho", "erp/donHang", ...CHUNG_GHI] },
  keToan: { ten: "Kế toán", an: [],
    doc: ["erp/*", "crm/lienHe", "nhansu/*", ...CHUNG_DOC],
    ghi: ["erp/thuChi", "erp/donHang", "nhansu/bangLuong", ...CHUNG_GHI] },
  marketing: { ten: "Marketing", an: ["giaVon"],
    doc: ["erp/sanPham", "crm/*", "vanhanh/hoiThoai", ...CHUNG_DOC],
    ghi: ["crm/*", "vanhanh/taiLieu", ...CHUNG_GHI] },
  nhanSu: { ten: "Nhân sự", an: [],
    doc: ["nhansu/*", ...CHUNG_DOC],
    ghi: ["nhansu/*", "vanhanh/lichHop", "vanhanh/duAn", ...CHUNG_GHI] },
};

const ngan = (db) => String(db).replace(/^revidapi-/, "");
const khop = (ds, db, kho) => {
  const k = ngan(db) + "/" + kho;
  return ds.find((x) => { const [duong] = x.split(":"); return duong === k || duong === ngan(db) + "/*"; });
};

/** null = toàn quyền (chủ). */
export const quyenCua = (toi) => (toi?.vai === "nv" ? BO_PHAN[toi.boPhan] || { ten: "Chưa phân bộ phận", an: [], doc: CHUNG_DOC, ghi: CHUNG_GHI } : null);
export const duocDoc = (q, db, kho) => !q || !!khop(q.doc, db, kho);

function xoaTruong(v, an) {
  if (Array.isArray(v)) return v.map((x) => xoaTruong(x, an));
  if (!v || typeof v !== "object") return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) if (!an.includes(k)) o[k] = xoaTruong(x, an);
  return o;
}
/** Bản ghi gửi cho người này xem. */
export const choXem = (q, v) => (!q || !q.an.length || v == null ? v : xoaTruong(v, q.an));

/**
 * Lọc một lô thay đổi nhân viên gửi lên. Trả { duoc, bo } — `bo` là số bản ghi ngoài quyền bị bỏ.
 * doc(db, kho, id) đọc bản đang có để giữ lại trường bị ẩn / cột không được sửa.
 */
export function locGhi(q, doi, doc) {
  if (!q) return { duoc: doi, bo: 0 };
  const duoc = []; let bo = 0;
  for (const d of doi) {
    const luat = khop(q.ghi, d.db, d.kho);
    if (!luat) { bo++; continue; }
    const cu = doc(d.db, d.kho, d.id);
    const cot = luat.split(":")[1]?.split(",");
    if (cot) {   // chỉ được sửa vài cột của bản đã có: không tạo mới, không xoá
      if (!cu || d.v == null) { bo++; continue; }
      const v = { ...cu }; for (const c of cot) if (c in d.v) v[c] = d.v[c];
      duoc.push({ ...d, v }); continue;
    }
    duoc.push({ ...d, v: d.v == null || !q.an.length ? d.v : giuAn(d.v, cu, q.an) });
  }
  return { duoc, bo };
}

// Nhân viên không thấy giá vốn nên gửi lên thiếu: lấy lại từ bản cũ, dòng đơn mới thì để máy chủ điền theo hàng hoá.
function giuAn(v, cu, an) {
  if (Array.isArray(v)) return v.map((x, i) => giuAn(x, Array.isArray(cu) ? cu.find((c) => c?.spId && c.spId === x?.spId) ?? cu[i] : undefined, an));
  if (!v || typeof v !== "object") return v;
  const o = { ...v };
  for (const k of an) if (!(k in o) && cu && typeof cu === "object" && k in cu) o[k] = cu[k];
  for (const [k, x] of Object.entries(o)) if (x && typeof x === "object") o[k] = giuAn(x, cu?.[k], an);
  return o;
}
