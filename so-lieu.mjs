// Số liệu như tiệm bánh thật: 60 ngày lịch sử (đơn, phiếu kho, thu chi, khách, chấm công) rồi đơn mới đổ về mỗi phút.
// Sinh bằng hạt cố định nên chạy lại ra đúng bộ số cũ. Chỉ gieo khi kho chưa có sản phẩm.
const ERP = "revidapi-erp", CRM = "revidapi-crm", NS = "revidapi-nhansu", VH = "revidapi-vanhanh";
const ngay = (t) => new Date(t).toISOString().slice(0, 10);

function rng(h) { return () => { h = (h + 0x6d2b79f5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// mã, tên, nhóm, giá vốn, giá bán, bán TB/ngày, tồn min
const SP = [
  ["BM01", "Bánh mì bơ tỏi", "Bánh mì", 9000, 25000, 14, 20],
  ["BM02", "Bánh mì hoa cúc", "Bánh mì", 38000, 95000, 4, 6],
  ["BN01", "Croissant bơ", "Bánh ngọt", 14000, 35000, 10, 15],
  ["BN02", "Bánh su kem (hộp 6)", "Bánh ngọt", 22000, 55000, 6, 8],
  ["BN03", "Tiramisu ly", "Bánh ngọt", 21000, 49000, 7, 10],
  ["BN04", "Bánh bông lan trứng muối", "Bánh ngọt", 48000, 120000, 3, 5],
  ["SN01", "Bánh kem sinh nhật 16cm", "Bánh kem", 160000, 380000, 1.6, 2],
  ["SN02", "Bánh kem sinh nhật 20cm", "Bánh kem", 230000, 520000, 0.9, 2],
  ["KD01", "Bánh không đường yến mạch", "Ăn kiêng", 18000, 45000, 3, 6],
  ["DU01", "Cà phê sữa", "Đồ uống", 9000, 29000, 12, 0],
  ["DU02", "Trà đào", "Đồ uống", 8000, 35000, 8, 0],
  ["NL01", "Bơ lạt Anchor 5kg", "Nguyên liệu", 1150000, 0, 0, 2],
];
const HO = ["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Vũ", "Đặng", "Bùi", "Đỗ", "Phan"];
const TEN = ["Lan", "Hương", "Minh", "Tú", "Ngọc", "Hải", "Thảo", "Dũng", "Linh", "Trang", "Quân", "Vy", "Nam", "Mai", "Khoa"];
const SI = [["Cà phê Góc Phố", 4], ["Văn phòng Sao Mai", 3], ["Trường mầm non Hoa Sen", 2]]; // khách sỉ, trả cuối tháng

export function gieoSoLieu(erp, bao) {
  if (erp.docHet(ERP, "sanPham").length) return false;
  const r = rng(20261024), luc = Date.now(), hom = Date.parse(ngay(luc)), ghi = [];
  const put = (db, kho, v) => ghi.push({ db, kho, id: v.id, v });
  const sp = SP.map(([ma, ten, nhom, giaVon, giaBan, tb, tonMin], i) => ({ id: `sp-${ma}`, ma, ten, dvt: nhom === "Nguyên liệu" ? "thùng" : "cái", nhom, giaVon, giaBan, ton: 0, tonMin, tao: luc, sua: luc, _tb: tb }));
  const kh = [];
  for (let i = 0; i < 48; i++) kh.push({ id: `kh-${i}`, ten: `${HO[i % 10]} ${TEN[(i * 7) % 15]}`, email: "", sdt: `09${String(10000000 + Math.floor(r() * 89999999))}`, congTy: "", nhan: [i < 12 ? "quen" : "le"], ghiChu: "", tao: luc, sua: luc });
  SI.forEach(([t], i) => kh.push({ id: `kh-si-${i}`, ten: t, email: "", sdt: "", congTy: t, nhan: ["si"], ghiChu: "Trả cuối tháng", tao: luc, sua: luc }));
  let soDon = 1, soPk = 1;
  const pk = (d, loai, s, sl, gia, ghiChu) => { s.ton += sl; put(ERP, "phieuKho", { id: `pk-${soPk++}`, ngay: d, loai, spId: s.id, sl, gia, tonSau: s.ton, ghiChu, tao: luc }); };
  const tc = (d, loai, soTien, hangMuc, ghiChu, donId) => put(ERP, "thuChi", { id: `tc-${ghi.length}`, ngay: d, loai, soTien: Math.round(soTien), hangMuc, ghiChu, donId, tao: luc });
  for (const s of sp) if (s._tb) pk(ngay(hom - 61 * 864e5), "nhap", s, Math.ceil(s._tb * 3), s.giaVon, "Tồn đầu kỳ");
  for (let n = 60; n >= 1; n--) {
    const t = hom - n * 864e5, d = ngay(t), thu = new Date(t).getUTCDay(), he = thu === 0 || thu === 6 ? 1.35 : 1;
    const xuHuong = 0.85 + (60 - n) / 60 * 0.25; // tháng này đông hơn tháng trước
    // Sản xuất buổi sáng = nhập kho thành phẩm theo dự kiến bán.
    for (const s of sp) if (s._tb && s.nhom !== "Nguyên liệu") { const can = Math.ceil(s._tb * he * xuHuong * 1.1) - Math.max(0, s.ton - s.tonMin); if (can > 0) pk(d, "nhap", s, can, s.giaVon, "Ra lò sáng"); }
    const soLuot = Math.round((18 + r() * 10) * he * xuHuong);
    for (let k = 0; k < soLuot; k++) {
      const dong = [], m = 1 + Math.floor(r() * 3);
      for (let j = 0; j < m; j++) {
        const s = sp[Math.floor(r() * 11)]; if (r() > s._tb / 14 + 0.15 || s.ton <= 0) continue;
        const sl = Math.min(s.ton, s.nhom === "Bánh kem" ? 1 : 1 + Math.floor(r() * 3)); dong.push({ spId: s.id, ten: s.ten, sl, gia: s.giaBan, giaVon: s.giaVon });
      }
      if (!dong.length) continue;
      const k1 = kh[Math.floor(r() * 48)], online = r() < 0.35, ship = online ? 20000 : 0, giam = r() < 0.08 ? 10000 : 0;
      const tong = dong.reduce((a, x) => a + x.sl * x.gia, 0) - giam + ship;
      const don = { id: `dh-${soDon}`, so: `DH${String(soDon++).padStart(5, "0")}`, ngay: d, lienHeId: k1.id, tenKhach: k1.ten, sdt: k1.sdt, dong, giam, phiShip: ship,
        thanhToan: online || r() < 0.4 ? "chuyen-khoan" : "tien-mat", daThu: tong, trangThai: r() < 0.02 ? "huy" : "xong", ghiChu: online ? "Đơn Facebook" : "", tao: t };
      put(ERP, "donHang", don);
      if (don.trangThai === "xong") { for (const x of dong) pk(d, "ban", sp.find((s) => s.id === x.spId), -x.sl, x.gia, don.so); tc(d, "thu", tong, "Bán hàng", don.so, don.id); }
    }
    // Khách sỉ: giao sáng, ghi nợ.
    SI.forEach(([, sl], i) => { if (thu === 0 || r() < 0.2) return; const s = sp[2], s2 = sp[0];
      const dong = [{ spId: s.id, ten: s.ten, sl: sl * 3, gia: 30000, giaVon: s.giaVon }, { spId: s2.id, ten: s2.ten, sl: sl * 2, gia: 21000, giaVon: s2.giaVon }];
      pk(d, "nhap", s, sl * 3, s.giaVon, "Ra lò đơn sỉ"); pk(d, "nhap", s2, sl * 2, s2.giaVon, "Ra lò đơn sỉ");
      const tong = dong.reduce((a, x) => a + x.sl * x.gia, 0), daTra = n > 30;
      const don = { id: `dh-${soDon}`, so: `DH${String(soDon++).padStart(5, "0")}`, ngay: d, lienHeId: `kh-si-${i}`, tenKhach: SI[i][0], sdt: "", dong, giam: 0, phiShip: 0, thanhToan: "cong-no", daThu: daTra || (i === 0 && n > 12) ? tong : 0, trangThai: "xong", ghiChu: "Giao sỉ buổi sáng", tao: t };
      put(ERP, "donHang", don); for (const x of dong) pk(d, "ban", sp.find((q) => q.id === x.spId), -x.sl, x.gia, don.so);
      if (don.daThu) tc(d, "thu", tong, "Thu công nợ sỉ", don.so, don.id);
    });
    // Bánh thừa cuối ngày huỷ.
    for (const s of sp) if (["Bánh ngọt", "Bánh mì"].includes(s.nhom) && s.ton > s.tonMin * 1.5) pk(d, "xuat-huy", s, -Math.floor((s.ton - s.tonMin) * 0.5), s.giaVon, "Quá hạn trong ngày");
    tc(d, "chi", 1800000 * he * xuHuong * (0.9 + r() * 0.2), "Nguyên liệu", "Bột, trứng, sữa, kem");
    if (thu === 2) tc(d, "chi", 450000 + r() * 250000, "Quảng cáo Facebook", "Chạy bài tuần");
    const dom = new Date(t).getUTCDate();
    if (dom === 1) { tc(d, "chi", 15000000, "Mặt bằng", "Tiền thuê tháng"); tc(d, "chi", 31500000, "Lương", "Lương 4 nhân viên"); }
    if (dom === 5) tc(d, "chi", 2600000 + r() * 600000, "Điện nước", "Hoá đơn tháng");
    if (dom === 10 || dom === 25) { const s = sp[11]; pk(d, "nhap", s, 2, s.giaVon, "Nhập bơ"); tc(d, "chi", 2 * s.giaVon, "Nguyên liệu", "Bơ Anchor 2 thùng"); }
    for (const nv of ["nv-chu", "nv-tho", "nv-ban", "nv-giao"]) { const x = r(); put(NS, "chamCong", { id: `cc-${nv}-${d}`, nvId: nv, ngay: d, tt: x < 0.03 ? "vang" : x < 0.07 ? "muon" : x < 0.1 ? "phep" : "di", gio: x < 0.03 || (x >= 0.07 && x < 0.1) ? 0 : 8, tangCa: thu === 6 && nv === "nv-tho" ? 2 : 0 }); }
  }
  // Bơ Anchor đang dưới mức tối thiểu sau đợt dùng cuối tháng: tiêu 1 thùng mỗi tuần.
  pk(ngay(hom - 864e5), "xuat-huy", sp[11], -Math.max(0, sp[11].ton - 1), sp[11].giaVon, "Xuất dùng sản xuất");
  for (const s of sp) { delete s._tb; put(ERP, "sanPham", s); }
  for (const k of kh) put(CRM, "lienHe", k);
  for (let i = 0; i < ghi.length; i += 500) erp.ghiNhieu(ghi.slice(i, i + 500), "so-lieu");
  bao?.("so-lieu", `Đã gieo số liệu 60 ngày: ${ghi.length} bản ghi`);
  return true;
}

const HOI = ["Bánh kem 20cm còn không shop, mai lấy được không?", "Ship về Cầu Giấy bao lâu ạ?", "Có bánh không đường cho người tiểu đường không?",
  "Đặt 30 croissant cho công ty sáng thứ 6 được không?", "Hôm qua mua su kem bị chảy kem, shop xem lại giúp", "Shop mở cửa đến mấy giờ?", "Tiramisu ly giá bao nhiêu?"];

/** Một phút trong ngày làm việc: có khách mua tại quầy, thỉnh thoảng có đơn Facebook chờ duyệt và khách nhắn hỏi. */
export function nhipBanHang(erp) {
  const r = Math.random, luc = Date.now(), d = ngay(luc), ghi = [];
  const sp = erp.docHet(ERP, "sanPham"), kh = erp.docHet(CRM, "lienHe").filter((k) => !k.id.startsWith("kh-si"));
  if (!sp.length) return;
  const so = erp.docHet(ERP, "donHang").length + 1, pick = (a) => a[Math.floor(r() * a.length)];
  const k1 = pick(kh), s = pick(sp.filter((x) => x.giaBan && x.ton > 0));
  if (s && r() < 0.7) {
    const sl = Math.min(s.ton, 1 + Math.floor(r() * 2)), dong = [{ spId: s.id, ten: s.ten, sl, gia: s.giaBan, giaVon: s.giaVon }], cho = r() < 0.25;
    const tong = sl * s.giaBan + (cho ? 20000 : 0), id = `dh-${luc.toString(36)}`;
    ghi.push({ db: ERP, kho: "donHang", id, v: { id, so: `DH${String(so).padStart(5, "0")}`, ngay: d, lienHeId: k1.id, tenKhach: k1.ten, sdt: k1.sdt, dong, giam: 0, phiShip: cho ? 20000 : 0,
      thanhToan: cho ? "chuyen-khoan" : "tien-mat", daThu: cho ? 0 : tong, trangThai: cho ? "cho" : "xong", ghiChu: cho ? "Đơn chatbot Facebook, chờ xác nhận" : "", tao: luc } });
    if (!cho) {
      const ns = { ...s, ton: s.ton - sl, sua: luc };
      ghi.push({ db: ERP, kho: "sanPham", id: s.id, v: ns });
      ghi.push({ db: ERP, kho: "phieuKho", id: `pk-${id}`, v: { id: `pk-${id}`, ngay: d, loai: "ban", spId: s.id, sl: -sl, gia: s.giaBan, tonSau: ns.ton, ghiChu: id, tao: luc } });
      ghi.push({ db: ERP, kho: "thuChi", id: `tc-${id}`, v: { id: `tc-${id}`, ngay: d, loai: "thu", soTien: tong, hangMuc: "Bán hàng", ghiChu: id, donId: id, tao: luc } });
    }
  }
  if (r() < 0.15) { const id = `ht-${luc.toString(36)}`; ghi.push({ db: VH, kho: "hoiThoai", id, v: { id, kenh: "facebook", ten: k1.ten, tin: [{ tu: "khach", chu: pick(HOI), luc }], tt: "moi", tao: luc, sua: luc } }); }
  if (ghi.length) erp.ghiNhieu(ghi, "ban-hang");
}
