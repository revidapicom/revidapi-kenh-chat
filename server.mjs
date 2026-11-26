// RevidAPI Kênh Chat — chatbot cho Zalo cá nhân, Zalo OA, Fanpage, Telegram.
// Chạy trên VPS của khách: node server.mjs. Trang quản trị ở cổng CONG (mặc định 8790).
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { KhoTaiLieu, moKho } from "./kho-tai-lieu.mjs";
import { HopThu } from "./hop-thu.mjs";
import { Erp, timThuMucDrive } from "./erp.mjs";
import { BO_PHAN, quyenCua, duocDoc, choXem, locGhi } from "./quyen.mjs";
import { BoNao } from "./tra-loi.mjs";
import { NhanVienAi } from "./nhan-vien-ai.mjs";
import { modelDangBan, dsDaBiet, MODEL_LUI } from "./model-ban.mjs";
import { lichBaoCao } from "./bao-cao-chu.mjs";
import { TuVanHanh } from "./tu-van-hanh.mjs";
import { lichDangBai } from "./dang-bai.mjs";
import { Fanpage, Telegram, Web, ZaloCaNhan, ZaloOA } from "./kenh.mjs";

const GOC = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.KENH_DATA || path.join(GOC, "data");
const CONG = Number(process.env.CONG || 8790);
// Qua đường HTTPS công khai (cloudflared) chỉ cho webhook đi vào; trang quản trị
// chỉ mở qua đó khi chủ chạy trên VPS và bật CHO_QUAN_TRI_HTTPS=1.
const QUAN_TRI_HTTPS = process.env.CHO_QUAN_TRI_HTTPS === "1";
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

const FILE_CH = path.join(DATA, "cau-hinh.json");
const FILE_NK = path.join(DATA, "nhat-ky.jsonl");

// Cập nhật: so phiên bản ở package.json với revidapi.com/tai-app/kenh-chat-ban.txt (6 giờ/lần).
// Bấm "Cập nhật" thì tải gói mới, chép đè mã (không đụng data/), rồi khởi động lại.
const BAN = JSON.parse(fs.readFileSync(path.join(GOC, "package.json"), "utf8")).version;
const capNhat = { moi: "", luc: 0, dangChay: false, loi: "" };
const soBan = (v) => String(v).split(".").map(Number).reduce((a, x) => a * 1000 + (x || 0), 0);
async function xemBanMoi() {
  if (Date.now() - capNhat.luc < 6 * 3600e3) return;
  capNhat.luc = Date.now();
  try {
    const v = (await fetch("https://revidapi.com/tai-app/kenh-chat-ban.txt", { signal: AbortSignal.timeout(8000) }).then((r) => r.ok ? r.text() : "")).trim();
    capNhat.moi = /^\d+\.\d+\.\d+$/.test(v) && soBan(v) > soBan(BAN) ? v : "";
  } catch { /* mất mạng: thử lại lần sau */ }
}
async function lamCapNhat() {
  const tam = path.join(DATA, "_cap-nhat");
  fs.rmSync(tam, { recursive: true, force: true }); fs.mkdirSync(tam);
  // Gói chỉ tải được khi kèm API key (nginx auth_request từ 15/11). Trước 1.5.7 không gửi key → mọi lượt bấm Cập nhật đều 401.
  const khoa = String(layCauHinh().khoa || "").trim();
  if (!khoa) throw new Error("Chưa nhập API key RevidAPI — vào Cài đặt nhập key rồi bấm Cập nhật lại.");
  const r = await fetch("https://revidapi.com/tai-app/kenh-chat.tgz", { headers: { Authorization: "Bearer " + khoa }, signal: AbortSignal.timeout(120000) });
  if (r.status === 401 || r.status === 403) throw new Error("API key không hợp lệ nên không tải được gói mới — kiểm lại key trong Cài đặt.");
  if (!r.ok) throw new Error("Không tải được gói mới (HTTP " + r.status + ")");
  fs.writeFileSync(path.join(tam, "goi.tgz"), Buffer.from(await r.arrayBuffer()));
  await new Promise((ok, hong) => execFile("tar", ["-xzf", "goi.tgz"], { cwd: tam }, (e) => e ? hong(new Error("Giải nén lỗi: " + e.message)) : ok()));
  const moi = path.join(tam, "kenh-chat");
  const pkgCu = fs.readFileSync(path.join(GOC, "package.json"), "utf8");
  for (const ten of fs.readdirSync(moi)) {
    if (!/\.(mjs|html|md|sh|ps1|json)$/.test(ten)) continue;
    fs.copyFileSync(path.join(moi, ten), path.join(GOC, ten));
  }
  // Thêm thư viện mới thì cài lại; không đổi thì bỏ qua cho nhanh.
  const pkgMoi = fs.readFileSync(path.join(GOC, "package.json"), "utf8");
  if (JSON.parse(pkgMoi).dependencies && JSON.stringify(JSON.parse(pkgMoi).dependencies) !== JSON.stringify(JSON.parse(pkgCu).dependencies)) {
    const npm = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
    await new Promise((ok, hong) => execFile(fs.existsSync(npm) ? npm : "npm", ["install", "--omit=dev", "--no-audit", "--no-fund"],
      { cwd: GOC, shell: process.platform === "win32" }, (e) => e ? hong(new Error("Cài thư viện lỗi: " + e.message)) : ok()));
  }
  fs.rmSync(tam, { recursive: true, force: true });
}

const MAC_DINH = {
  bat: true,
  coSo: "https://revidapi.com",
  khoa: "",
  model: "deepseek-v4.1-flash",
  modelDuPhong: "claude-haiku-5-5",   // nguồn chính trễ quá hanGiay thì thử model này (kimi-k3 cũ đã ngừng bán)
  hanGiay: 12,
  toiDaRa: 800,   // model có suy nghĩ ăn ~300 token trước khi ra chữ
  vaiTro: "Bạn là nhân viên tư vấn của cửa hàng. Xưng 'em', gọi khách là 'anh/chị'.",
  gio: "",
  ngoaiGio: "",
  khiLoi: "",
  hoiNhanh: [],
  // Thẻ khách [{id, ten, mau}] và câu trả lời mẫu [{tat, chu}] — nhân viên dùng chung, chủ shop sửa.
  the: [
    { id: "t1", ten: "Khách mới", mau: "#1c7ed6" }, { id: "t2", ten: "Đang tư vấn", mau: "#f08c00" },
    { id: "t3", ten: "Đã chốt đơn", mau: "#2f9e44" }, { id: "t4", ten: "Khách sỉ", mau: "#7048e8", tu: "giá sỉ, lấy sỉ, mua sỉ, mua buôn, bán buôn, giá buôn, đại lý, số lượng lớn" },
    { id: "t5", ten: "Khiếu nại", mau: "#e03131", tu: "khiếu nại, hoàn tiền, trả hàng, hàng lỗi, bị hỏng, lừa đảo" },
  ],
  mau: [
    { tat: "chao", chu: "Dạ em chào anh/chị, em có thể hỗ trợ gì cho mình ạ?" },
    { tat: "sdt", chu: "Anh/chị cho em xin số điện thoại và địa chỉ nhận hàng để em lên đơn ạ." },
    { tat: "camon", chu: "Dạ em cảm ơn anh/chị đã ủng hộ shop ạ!" },
  ],
  // Câu bot không trả lời được → hỏi chủ qua Zalo/Telegram cá nhân (baoChu), chủ gõ "#số nội dung" để trả khách.
  chuyenChu: false,
  cauCho: "",
  botImKhiGiao: false,
  boQua: [],
  zalo: { traLoiNhom: false, tenGoi: "" },
  zaloOA: {},
  facebook: { maXacMinh: crypto.randomBytes(12).toString("hex"), trang: [] },
  telegram: { token: "", traLoiNhom: false, tenGoi: "" },
  web: { ten: "Tư vấn", mau: "#2f9e44", chao: "Dạ em chào anh/chị, em có thể giúp gì ạ?" },
  matKhau: "",
};

let CH = { ...MAC_DINH, ...(fs.existsSync(FILE_CH) ? JSON.parse(fs.readFileSync(FILE_CH, "utf8")) : {}) };
if (process.env.REVIDAPI_KEY && !CH.khoa) CH.khoa = process.env.REVIDAPI_KEY;
// Bản mã nguồn mở chỉ chạy với RevidAPI: địa chỉ cố định, không đổi sang nhà cung cấp khác được.
CH.coSo = "https://revidapi.com";
if (process.env.MAT_KHAU) CH.matKhau = process.env.MAT_KHAU;
if (!CH.matKhau) CH.matKhau = crypto.randomBytes(9).toString("base64url");
if (!CH.woocommerce?.biMat) CH.woocommerce = { biMat: crypto.randomBytes(18).toString("base64url") };
if (!CH.sheetBiMat) CH.sheetBiMat = crypto.randomBytes(18).toString("base64url");
if (!CH.maChu) CH.maChu = "CHU-" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
// Bản cũ đặt tên miền bằng WEBHOOK_GOC trong service — chuyển vào cấu hình để trang quản trị sửa được.
if (CH.tenMien === undefined) CH.tenMien = /^https:\/\/([^/]+)/.exec(process.env.WEBHOOK_GOC || "")?.[1] || "";
ghiCauHinh({});
// Máy tính cá nhân: chỉ nghe 127.0.0.1 — trang quản trị không ai ngoài máy này mở được.
// VPS dùng tên miền riêng: cũng chỉ 127.0.0.1, từ ngoài vào phải qua HTTPS của tên miền.
// VPS dùng đường hầm: 0.0.0.0 để chủ VPS mở từ xa (có mật khẩu).
const hostCan = () => process.env.HOST || (CH.tenMien ? "127.0.0.1" : "0.0.0.0");
const HOST = hostCan();

function ghiCauHinh(them) {
  CH = { ...CH, ...them };
  const tam = FILE_CH + ".tmp";
  fs.writeFileSync(tam, JSON.stringify(CH, null, 2), { mode: 0o600 });
  fs.renameSync(tam, FILE_CH);
}
const layCauHinh = () => CH;
// Model chủ chọn mà cổng đã ngừng bán: báo ngay trên panel, không đợi khách nhắn rồi bot mới lỗi.
function canhBaoModel() {
  const ban = dsDaBiet(); if (!ban) return "";
  const co = new Set(ban.map((x) => x.id));
  const bo = [...new Set([CH.model, CH.modelDuPhong, CH.lichTuDong?.model].filter((m) => m && !co.has(m)))];
  return bo.length ? `Model ${bo.join(", ")} đã ngừng bán — vào Cách trả lời chọn lại Model AI rồi bấm Lưu (trong lúc chờ, bot tự dùng model khác còn bán).` : "";
}
setTimeout(() => modelDangBan(CH.coSo, CH.khoa), 5e3).unref();

function ghiNhatKy(o) {
  const dong = JSON.stringify({ luc: new Date().toISOString(), ...o, vao: String(o.vao || "").slice(0, 300),
                                ra: o.ra ? String(o.ra).slice(0, 300) : undefined }) + "\n";
  fs.appendFileSync(FILE_NK, dong, { mode: 0o600 });
  // Giữ file gọn: quá 2 MB thì chỉ giữ nửa sau.
  try {
    if (fs.statSync(FILE_NK).size > 2e6) {
      const t = fs.readFileSync(FILE_NK, "utf8");
      fs.writeFileSync(FILE_NK, t.slice(t.indexOf("\n", t.length / 2) + 1));
    }
  } catch { /* nhật ký hỏng không được làm hỏng bot */ }
}
const bao = (kenh, loi) => { console.error(`[${kenh}] ${loi}`); ghiNhatKy({ kenh, loi }); };

const db = moKho(DATA);
const kho = new KhoTaiLieu(db, path.join(DATA, "tai-lieu"));
const hopThu = new HopThu(db);
const boNao = new BoNao({ layCauHinh, ghiCauHinh, kho, hopThu, ghiNhatKy, fileVe: path.join(DATA, "ve-chu.json") });
// Dữ liệu công ty chung với bảng quản lý: bot đọc Kho/Tài liệu, tin khách đổ về Hộp chat + CRM.
const erp = new Erp(db, { kho, ghiNhatKy: (loai, chu) => ghiNhatKy({ kenh: "erp", vao: chu, loi: loai === "loi" ? chu : undefined }) });
boNao.erp = erp;
hopThu.sauGhi = (kenh, ma, o) => erp.ghiTin(kenh, ma, o);
// Thư mục Google Drive trên máy: quét 5 phút một lần, tệp mới/sửa vào Tài liệu nội bộ.
// Google Sheet đã nhập: kéo lại cùng vòng 5 phút, sửa trên Sheet thì app tự theo.
setInterval(() => {
  if (CH.driveThuMuc) try { erp.quetThuMuc(CH.driveThuMuc); } catch { /* ổ Drive chưa mở */ }
  for (const sh of CH.sheets || []) erp.nhapSheet(sh.link, sh.loai).then(() => { sh.loi = ""; }, (e) => { sh.loi = e.message; });
}, 5 * 60e3).unref();
// Nhân viên AI nhận việc được giao ở trang Công việc, quét 15 giây một lần.
const nvAi = new NhanVienAi({ erp, layCauHinh, ghiNhatKy, bao: (...a) => bao(...a) });
nvAi.damBao();
// Có việc mới/đổi người làm là AI nhận ngay, không chờ vòng quét; vòng 15 giây chỉ để nhặt việc còn sót sau khi khởi động lại.
{ const ghi = erp.ghiNhieu.bind(erp); erp.ghiNhieu = (doi, nguon) => { const kq = ghi(doi, nguon); if (doi.some((d) => d.kho === "congViec")) setImmediate(() => nvAi.vong()); return kq; }; }
nvAi.vong();
setInterval(() => nvAi.vong(), 15e3).unref();
if (process.env.TU_VAN_HANH === "1") new TuVanHanh({ erp, bao: (...a) => bao(...a) }).chay();
// Bảng quản lý chạy ở cổng khác trên máy này → cho phép gọi /api có kèm phiên.
const NGUON_BANG = new Set((process.env.KENH_BANG || "http://localhost:3011,http://127.0.0.1:3011,http://localhost:5173").split(",").map((s) => s.trim()));
// Bảng do chính máy này phát ở /bang/ cũng là nguồn tin cậy.
// Bản quyền: key phải còn dùng được thì mới mở bảng. Mỗi máy hỏi cổng 12 giờ một lần (nhẹ cho VPS);
// chỉ khoá khi cổng trả 401/403 hai lượt liền, mạng lỗi thì vẫn cho dùng tiếp.
const BAN_QUYEN = { hong: 0, luc: 0, ok: false };
// Hỏi cổng xem một key có dùng được không: true / false (401, 403) / null (mạng lỗi, chưa biết).
async function hoiKhoa(khoa) {
  try {
    const r = await fetch("https://revidapi.com/v1/account", { headers: { Authorization: "Bearer " + khoa }, signal: AbortSignal.timeout(15e3) });
    return r.ok ? true : r.status === 401 || r.status === 403 ? false : null;
  } catch { return null; }
}
async function kiemBanQuyen() {
  if (!CH.khoa) { BAN_QUYEN.ok = false; return; }
  BAN_QUYEN.luc = Date.now();
  const kq = await hoiKhoa(CH.khoa);
  if (kq === true) { BAN_QUYEN.hong = 0; BAN_QUYEN.ok = true; }
  else if (kq === false) { BAN_QUYEN.hong++; BAN_QUYEN.ok = false; }
}
if (!CH.khoa) console.log("[kenh-chat] Chưa có API key RevidAPI — bot chưa trả lời khách. Lấy key ở https://revidapi.com/dashboard/settings rồi dán vào trang quản trị.");
setTimeout(kiemBanQuyen, 10e3).unref();
setInterval(kiemBanQuyen, 12 * 3600e3).unref();
if (process.env.KENH_BANG_DIR) for (const h of ["127.0.0.1", "localhost"]) NGUON_BANG.add(`http://${h}:${CONG}`);
// Nhiều Zalo cá nhân chung một hộp thư: zalo (tài khoản 1, giữ tên tệp cũ), zalo2, zalo3.
// Ô chưa quét QR không có tệp phiên nên không chạy gì.
const ZALO_TK = ["zalo", "zalo2", "zalo3"];
const ZALO = Object.fromEntries(ZALO_TK.map((k) => [k, new ZaloCaNhan({ kenh: k, fileDangNhap: path.join(DATA, k + "-phien.json"), boNao, hopThu, layCauHinh, bao })]));
const zalo = ZALO.zalo;
const zaloOA = new ZaloOA({ boNao, hopThu, layCauHinh, ghiCauHinh, bao });
const guiGanDay = new Map();   // "khoa\nchu" → lúc gửi tay, chặn gửi trùng
const fanpage = new Fanpage({ boNao, hopThu, layCauHinh, bao });
const telegram = new Telegram({ boNao, hopThu, layCauHinh, bao });
const web = new Web({ boNao, hopThu, bao });
const KENH = { ...ZALO, "zalo-oa": zaloOA, fb: fanpage, telegram, web };
// ---- Lọc khách + gửi loạt ----
function locKhachHang(tim, the, coSdt) {
  const t = boDau(String(tim || "")).trim(), loc = String(the || "");
  return hopThu.khachHang().filter((k) => (!loc || k.the.includes(loc)) && (!coSdt || k.nho["SĐT"])
    && (!t || boDau([k.ten, k.ma, ...Object.values(k.nho)].join(" ")).includes(t)));
}
// {ten} = tên gọi (chữ cuối), {ten_day_du} = cả họ tên; chưa biết tên thì "bạn".
const thayTen = (chu, ten) => { const d = String(ten || "").trim(); return chu.replace(/\{ten_day_du\}/g, d || "bạn").replace(/\{ten\}/g, d.split(/\s+/).pop() || "bạn"); };
// Tin cuối của khách: Messenger chỉ cho nhắn trong 24 giờ (ngoài đó là tin quảng cáo, Facebook khoá Trang),
// Zalo OA cho tin tư vấn trong 7 ngày. Website: khách đóng trang là mất, không gửi.
const HAN_KENH = { fb: [24 * 3600e3, "Fanpage: khách nhắn quá 24 giờ (Facebook cấm nhắn quảng cáo)"], "zalo-oa": [7 * 86400e3, "Zalo OA: khách nhắn quá 7 ngày"] };
function chiaGuiLoat(ds) {
  const gui = [], bo = {}, them = (l) => { bo[l] = (bo[l] || 0) + 1; };
  const tinCuoi = db.prepare("SELECT max(luc) AS luc FROM tin WHERE khoa = ? AND vai = 'khach'");
  for (const k of ds) {
    if (!k.coChat) { them("chưa có cuộc chat riêng (chỉ gặp trong nhóm)"); continue; }
    if (k.loai === "nhom") { them("nhóm chat"); continue; }
    if (k.kenh === "web" || !KENH[k.kenh]) { them("Website / kênh không gửi chủ động được"); continue; }
    const han = HAN_KENH[k.kenh];
    if (han && Date.now() - (tinCuoi.get(k.khoa)?.luc || 0) > han[0]) { them(han[1]); continue; }
    gui.push(k);
  }
  return { gui, bo };
}
const GUI_LOAT = { chay: false, dung: false, tong: 0, xong: 0, loi: 0, batDau: 0, ketThuc: 0, chiTiet: [] };
async function chayGuiLoat(ds, chu, cach) {
  Object.assign(GUI_LOAT, { chay: true, dung: false, tong: ds.length, xong: 0, loi: 0, batDau: Date.now(), ketThuc: 0, chiTiet: [] });
  for (const [i, k] of ds.entries()) {
    if (GUI_LOAT.dung) break;
    const noiDung = thayTen(chu, k.ten);
    try {
      await KENH[k.kenh].gui(k.ma, noiDung, k.loai);
      hopThu.ghi(k.kenh, k.ma, { vai: "bot", chu: noiDung, nguon: "Gửi loạt" });
      GUI_LOAT.xong++;
    } catch (e) {
      GUI_LOAT.loi++;
      GUI_LOAT.chiTiet.push({ ten: k.ten || k.ma, kenh: k.kenh, loi: String(e.message || e).slice(0, 200) });
    }
    // Giãn cách ±30% để không đều như máy (Zalo cá nhân dễ bị khoá khi gửi dồn).
    if (i < ds.length - 1 && !GUI_LOAT.dung) await new Promise((r) => setTimeout(r, cach * 1000 * (0.7 + Math.random() * 0.6)));
  }
  Object.assign(GUI_LOAT, { chay: false, ketThuc: Date.now() });
  bao("gui-loat", `Gửi loạt xong: ${GUI_LOAT.xong}/${GUI_LOAT.tong} thành công, ${GUI_LOAT.loi} lỗi${GUI_LOAT.dung ? " (đã dừng tay)" : ""}.`);
}
// ---- Chăm sóc tự động: khách im lặng N giờ sau tin cuối của họ → bot nhắn lại (mỗi bước một lần cho mỗi lần khách nhắn).
// `moc` = lúc tin cuối của khách: khách nhắn lại thì chuỗi bắt đầu lại từ đầu.
db.exec("CREATE TABLE IF NOT EXISTS cham_soc (khoa TEXT NOT NULL, buoc TEXT NOT NULL, moc INTEGER NOT NULL, luc INTEGER NOT NULL, loi TEXT, PRIMARY KEY (khoa, buoc, moc))");
const TRE_TOI_DA = 48 * 3600e3;   // quá hạn bước quá 2 ngày thì bỏ, để bật tính năng không nhắn dồn cho khách cũ
let dangChamSoc = false;
async function quetChamSoc() {
  const cs = CH.chamSoc;
  if (dangChamSoc || !cs?.bat || !cs.buoc?.length) return;
  dangChamSoc = true;
  try {
    const bay = Date.now(), xaNhat = Math.max(...cs.buoc.map((b) => b.sauGio)) * 3600e3 + TRE_TOI_DA;
    const ds = db.prepare(`SELECT c.khoa, c.kenh, c.ma, c.ten, c.loai, c.the, c.xong, c.tiep_quan_den,
        (SELECT max(luc) FROM tin t WHERE t.khoa = c.khoa AND t.vai = 'khach') AS moc
      FROM cuoc c WHERE c.kenh NOT IN ('web', 'thu') AND coalesce(c.loai, '') != 'nhom' AND c.luc > ?`).all(bay - xaNhat);
    const daGui = db.prepare("SELECT 1 FROM cham_soc WHERE khoa = ? AND buoc = ? AND moc = ?");
    const ghi = db.prepare("INSERT OR IGNORE INTO cham_soc (khoa, buoc, moc, luc, loi) VALUES (?, ?, ?, ?, ?)");
    let soLuot = 0;
    for (const c of ds) {
      if (!c.moc || c.xong || c.tiep_quan_den > bay || !KENH[c.kenh]) continue;
      let the = []; try { the = JSON.parse(c.the || "[]"); } catch {}
      const im = bay - c.moc, han = HAN_KENH[c.kenh];
      // Bước muộn nhất đã tới hạn mà chưa gửi (gửi một bước mỗi lượt quét).
      const b = [...cs.buoc].sort((x, y) => y.sauGio - x.sauGio)
        .find((b) => im >= b.sauGio * 3600e3 && im < b.sauGio * 3600e3 + TRE_TOI_DA && (!b.the || the.includes(b.the)));
      if (!b || daGui.get(c.khoa, b.id, c.moc)) continue;
      if (han && im > han[0]) { ghi.run(c.khoa, b.id, c.moc, bay, "quá hạn kênh"); continue; }
      const noiDung = thayTen(b.chu, hopThu.docNho?.(c.khoa)?.["Tên"] || c.ten);
      try {
        await KENH[c.kenh].gui(c.ma, noiDung, c.loai);
        hopThu.ghi(c.kenh, c.ma, { vai: "bot", chu: noiDung, nguon: "Chăm sóc" });
        ghi.run(c.khoa, b.id, c.moc, bay, null);
      } catch (e) {
        ghi.run(c.khoa, b.id, c.moc, bay, String(e.message || e).slice(0, 200));
        bao("cham-soc", `${c.ten || c.khoa}: ${e.message}`);
      }
      if (++soLuot >= 50) break;   // mỗi lượt quét tối đa 50 tin, phần còn lại lượt sau
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 3000));
    }
  } finally { dangChamSoc = false; }
}
setTimeout(() => quetChamSoc().catch((e) => bao("cham-soc", e.message)), 60e3).unref?.();
setInterval(() => quetChamSoc().catch((e) => bao("cham-soc", e.message)), 10 * 60e3).unref?.();
boNao.guiQua = (kenh, ma, chu, loai) => {
  if (!KENH[kenh]) return Promise.reject(new Error("kênh " + kenh + " không gửi được"));
  return KENH[kenh].gui(ma, chu, loai);
};
lichBaoCao({ erp, layCauHinh, guiQua: boNao.guiQua, bao, fileNhac: path.join(DATA, "da-nhac.json") });
lichDangBai({ erp, layCauHinh, ghiCauHinh, bao, dsKenh: () => dsKenhDang() });
const NHIP_WEB = new Map();   // ip → số tin trong phút này
// Chia cuộc mới cho nhân viên ít việc nhất (24 giờ qua). Tắt chia tự động thì cuộc nằm ở "Chưa giao".
// Từ khoá so không dấu, không phân biệt hoa thường: "si" khớp "sỉ", "SỈ".
const boDau = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
hopThu.theTuDong = (chu) => {
  const c = " " + boDau(chu).replace(/[^a-z0-9]+/g, " ") + " ";
  return (CH.the || []).filter((t) => (t.tu || "").split(",").map((x) => boDau(x).replace(/[^a-z0-9]+/g, " ").trim()).filter(Boolean)
    .some((x) => c.includes(" " + x + " "))).map((t) => t.id);
};
hopThu.chonNguoi = (tai) => {
  const ds = CH.chiaTuDong ? (CH.nhanVien || []) : [];
  return ds.length ? ds.reduce((a, b) => ((tai[b.id] || 0) < (tai[a.id] || 0) ? b : a)).id : null;
};
for (const z of Object.values(ZALO)) z.moLai();
telegram.chay();

async function bocChuPdf(du) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(du), isEvalSupported: false, useSystemFonts: false }).promise;
  const trang = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    trang.push(tc.items.map((x) => (x.str || "") + (x.hasEOL ? "\n" : " ")).join(""));
  }
  await doc.destroy();
  return trang.join("\n\n").replace(/[ \t]{3,}/g, "  ");
}

// Word (.docx) và Excel (.xlsx) là tệp zip chứa XML: tự mở zip bằng zlib, không cần thư viện.
function moZip(du) {
  let e = du.length - 22;
  while (e >= 0 && du.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("không phải zip");
  const tep = new Map();
  let o = du.readUInt32LE(e + 16);
  for (let i = 0, n = du.readUInt16LE(e + 10); i < n; i++) {
    const kieu = du.readUInt16LE(o + 10), nen = du.readUInt32LE(o + 20), dt = du.readUInt16LE(o + 28),
      ex = du.readUInt16LE(o + 30), cm = du.readUInt16LE(o + 32), dau = du.readUInt32LE(o + 42);
    const ten = du.toString("utf8", o + 46, o + 46 + dt);
    const bd = dau + 30 + du.readUInt16LE(dau + 26) + du.readUInt16LE(dau + 28), raw = du.subarray(bd, bd + nen);
    tep.set(ten, () => (kieu === 8 ? zlib.inflateRawSync(raw) : raw).toString("utf8"));
    o += 46 + dt + ex + cm;
  }
  return tep;
}
const giaiXml = (x) => x.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function bocChuDocx(du) {
  const xml = moZip(du).get("word/document.xml")?.();
  if (!xml) throw new Error("không phải Word");
  const chu = (x) => x.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "");
  const bang = (t) => (t.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []).map((r) => (r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map((c) => chu(c).trim().replace(/\s*\n\s*/g, " ")).join(" | ")).join("\n") + "\n";
  return giaiXml(chu(xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, bang))).replace(/\n{3,}/g, "\n\n").trim();
}

function bocChuXlsx(du) {
  const z = moZip(du), chung = [];
  const ss = z.get("xl/sharedStrings.xml")?.() || "";
  for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) || []) chung.push(giaiXml((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  const tenSheet = [...(z.get("xl/workbook.xml")?.() || "").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => giaiXml(m[1]));
  const ds = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  return ds.map((k, i) => {
    const dong = (z.get(k)().match(/<row[\s\S]*?<\/row>/g) || []).map((r) => (r.match(/<c [\s\S]*?(?:\/>|<\/c>)/g) || []).map((c) => {
      const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? c.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      return /t="s"/.test(c) ? chung[+v] ?? "" : giaiXml(v);
    }).join(" | ")).filter((x) => x.replace(/[ |]/g, ""));
    return `# ${tenSheet[i] || "Sheet " + (i + 1)}\n` + dong.join("\n");
  }).join("\n\n");
}

// ---------------- HTTP ----------------
// mã phiên -> { vai: "chu" | "nv", id }. Ghi ra đĩa để khởi động lại không đá bảng quản lý ra ngoài.
const TEP_PHIEN = path.join(DATA, ".phien.json");
const PHIEN = new (class extends Map {
  luu() { try { fs.writeFileSync(TEP_PHIEN, JSON.stringify([...this]), { mode: 0o600 }); } catch { /* bỏ qua */ } }
  set(k, v) { super.set(k, v); this.luu(); return this; }
  delete(k) { const r = super.delete(k); if (r) this.luu(); return r; }
})((() => { try { return JSON.parse(fs.readFileSync(TEP_PHIEN, "utf8")); } catch { return []; } })());
const SAI = new Map();   // ip -> số lần sai mật khẩu (chặn dò mật khẩu)

function docThan(req, toiDa = 5e6) {
  return new Promise((ok, hong) => {
    const ds = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > toiDa) { hong(new Error("quá lớn")); req.destroy(); } else ds.push(c); });
    req.on("end", () => ok(Buffer.concat(ds)));
    req.on("error", hong);
  });
}
const json = (res, ma, o) => { res.writeHead(ma, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(o)); };

// Trả người đang đăng nhập: { vai: "chu" } hoặc { vai: "nv", id, ten }. Nhân viên đã bị xoá thì phiên hết hiệu lực.
function daDangNhap(req) {
  const m = /(?:^|;\s*)phien=([a-zA-Z0-9_-]+)/.exec(req.headers.cookie || "") || /^([a-zA-Z0-9_-]{20,})$/.exec(String(req.headers["x-phien"] || ""));
  const ph = m && PHIEN.get(m[1]);
  if (!ph) return null;
  if (ph.vai === "chu") return ph;
  const nv = (CH.nhanVien || []).find((x) => x.id === ph.id);
  if (!nv) { PHIEN.delete(m[1]); return null; }
  return { vai: "nv", id: nv.id, ten: nv.ten, boPhan: nv.boPhan || "" };
}
const bamMk = (mk, muoi = crypto.randomBytes(12).toString("hex")) => muoi + ":" + crypto.scryptSync(String(mk), muoi, 32).toString("hex");
function dungMkNv(mk, bam) {
  const [muoi, h] = String(bam || "").split(":");
  if (!muoi || !h) return false;
  const a = Buffer.from(bamMk(mk, muoi).split(":")[1], "hex"), b = Buffer.from(h, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Địa chỉ nhân viên mở được trang Hộp thư: mạng nội bộ (khi bot nghe 0.0.0.0) và tên miền riêng.
function diaChiNhanVien() {
  const ds = [];
  if (CH.tenMien && QUAN_TRI_HTTPS) ds.push(`https://${CH.tenMien}`);
  if (HOST === "0.0.0.0") for (const ip of Object.values(os.networkInterfaces()).flat())
    if (ip && ip.family === "IPv4" && !ip.internal) ds.push(`http://${ip.address}:${CONG}`);
  return ds;
}

// Cấu hình gửi ra trang quản trị: che khoá/token, chỉ hiện 4 ký tự cuối.
function dsKenhDang() {
  const c = layCauHinh(), pr = c.dangBai?.prompt || {};
  return [
    ...(c.facebook?.trang || []).map((t) => ({ ma: "fb:" + t.id, ten: t.ten || "Fanpage " + t.id, loai: "facebook" })),
    ...(c.facebook?.trang || []).filter((t) => t.ig).map((t) => ({ ma: "ig:" + t.ig, ten: "@" + (t.igTen || t.ig), loai: "instagram" })),
    ...(c.dangBai?.threads || []).map((t) => ({ ma: "th:" + t.id, ten: "@" + t.ten, loai: "threads", het: t.het })),
    ...(c.dangBai?.telegram || []).map((t) => ({ ma: "tg:" + t.id, ten: t.ten, loai: "telegram" })),
    ...(c.dangBai?.wordpress || []).map((t) => ({ ma: "wp:" + t.id, ten: t.ten, loai: "wordpress" })),
  ].map((k) => ({ ...k, prompt: pr[k.ma] || "" }));
}
function che(s) { return s ? "••••" + String(s).slice(-4) : ""; }
function cauHinhCongKhai() {
  return {
    ...CH, matKhau: undefined, khoa: che(CH.khoa), nhanVien: (CH.nhanVien || []).map(({ id, ten, boPhan }) => ({ id, ten, boPhan })),
    zaloOA: { ...CH.zaloOA, secretKey: che(CH.zaloOA?.secretKey), oaSecretKey: che(CH.zaloOA?.oaSecretKey), accessToken: che(CH.zaloOA?.accessToken), refreshToken: che(CH.zaloOA?.refreshToken) },
    facebook: { ...CH.facebook, appSecret: che(CH.facebook?.appSecret), trang: (CH.facebook?.trang || []).map((t) => ({ ...t, token: che(t.token) })) },
    telegram: { ...CH.telegram, token: che(CH.telegram?.token) },
    dangBai: undefined,   // token kênh đăng chỉ đi qua /api/kenh-dang (đã bỏ bí mật)
    web: { ...MAC_DINH.web, ...CH.web },
  };
}
// Ô nào khách để nguyên "••••xxxx" thì giữ giá trị cũ.
const giu = (moi, cu) => (typeof moi === "string" && moi.startsWith("••••") ? cu : moi);

// Xác thực domain của Zalo: Zalo không nhận webhook ở domain chưa xác thực. Khách dán
// thẻ meta (hoặc chỉ mã) / tệp HTML Zalo đưa; ta trả lại đúng chỗ Zalo sẽ đọc.
function metaXacThucZalo() {
  const s = String(CH.zaloOA?.xacThucNoiDung || "").trim();
  if (/^[A-Za-z0-9_-]{8,200}$/.test(s)) return `<meta name="zalo-platform-site-verification" content="${s}" />`;
  const m = /<meta\s+[^<>]*zalo-platform-site-verification[^<>]*>/i.exec(s);
  const ma = m && /content\s*=\s*["']([A-Za-z0-9_-]{8,200})["']/i.exec(m[0]);
  return ma ? `<meta name="zalo-platform-site-verification" content="${ma[1]}" />` : "";
}
function tepXacThucZalo(p) {
  const ten = String(CH.zaloOA?.xacThucTen || "").trim().replace(/^\/+/, "");
  if (!ten || !/^[A-Za-z0-9_.-]{1,100}\.html?$/.test(ten) || p !== "/" + ten) return null;
  const s = String(CH.zaloOA?.xacThucNoiDung || "").trim();
  return s.includes("<") ? s : `<!doctype html><html><head>${metaXacThucZalo()}</head><body></body></html>`;
}

// Sau proxy chạy cùng máy, socket luôn là 127.0.0.1 → đếm sai mật khẩu theo IP thật, không thì
// một người đoán bừa khoá luôn cả chủ. Chỉ tin header khi kết nối đến từ chính máy này.
function ipThat(req) {
  const ip = req.socket.remoteAddress || "";
  if (!/^(::1|127\.|::ffff:127\.)/.test(ip)) return ip;
  // x-forwarded-for lấy phần CUỐI (do proxy gần nhất thêm vào) — phần đầu là khách tự gửi, giả được.
  const h = req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] || String(req.headers["x-forwarded-for"] || "").split(",").pop();
  return String(h || ip).trim();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  // Request đi qua đường hầm Cloudflare luôn có header cf-connecting-ip; qua Caddy/nginx của
  // tên miền riêng thì có x-forwarded-for. Cả hai đều là truy cập từ Internet, không phải máy này.
  const quaHam = !!(req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] || req.headers["x-forwarded-for"]);
  const p = url.pathname;
  const goc = req.headers.origin;
  if (goc && NGUON_BANG.has(goc) && p.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", goc);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Phien");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }
  try {
    // Mã kiểm tên miền: trang quản trị gọi https://<tên miền>/.well-known/kenh-chat, đúng mã
    // này thì tên miền đã trỏ tới chính bot này.
    if (p === "/.well-known/kenh-chat") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(MA_TEN_MIEN); }
    // Webhook công khai (Facebook / Zalo OA gọi vào).
    if (p === "/webhook/facebook") {
      if (req.method === "GET") {
        const c = fanpage.xacMinh(url.searchParams);
        res.writeHead(c ? 200 : 403); return res.end(c || "sai mã xác minh");
      }
      const than = await docThan(req);
      if (!fanpage.chuKyDung(than, req.headers["x-hub-signature-256"])) { res.writeHead(403); return res.end(); }
      res.writeHead(200); res.end("ok");   // trả 200 ngay, Facebook không chờ AI
      return fanpage.nhan(JSON.parse(than.toString() || "{}")).catch((e) => bao("fb", e.message));
    }
    // Đơn website: WooCommerce → Cài đặt → Nâng cao → Webhooks, chủ đề "Order created"/"Order updated",
    // Secret = mã ở trang quản trị. Woo ký HMAC-SHA256 base64 vào X-WC-Webhook-Signature.
    if (p === "/webhook/woocommerce" && req.method === "POST") {
      const than = await docThan(req);
      const ky = crypto.createHmac("sha256", CH.woocommerce.biMat).update(than).digest("base64");
      const gui = String(req.headers["x-wc-webhook-signature"] || "");
      if (!/^\{/.test(than.toString().trim())) { res.writeHead(200); return res.end("ok"); }   // Woo "ping" lúc tạo webhook (form, không ký JSON)
      if (gui.length !== ky.length || !crypto.timingSafeEqual(Buffer.from(gui), Buffer.from(ky))) { res.writeHead(403); return res.end("sai chu ky"); }
      try { const d = erp.nhanDonWoo(JSON.parse(than.toString())); res.writeHead(200); return res.end(d ? "ok " + d.so : "bo qua"); }
      catch (e) { bao("woocommerce", e.message); res.writeHead(400); return res.end("loi"); }
    }
    // Sheet riêng tư: Apps Script trong chính Sheet (chạy bằng quyền chủ Sheet) gửi CSV về đây khi Sheet đổi.
    if (p === "/webhook/google-sheet" && req.method === "POST") {
      try {
        const { ma, loai, khoa, csv } = JSON.parse((await docThan(req, 2e7)).toString() || "{}");
        const a = Buffer.from(String(ma || "")), b = Buffer.from(CH.sheetBiMat);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 403, { loi: "sai mã" });
        if (!/^[A-Za-z0-9_-]{20,}#\d+$/.test(String(khoa || ""))) return json(res, 400, { loi: "thiếu khoá Sheet" });
        return json(res, 200, { so: erp.nhapCsv(String(csv || ""), loai, khoa) });
      } catch (e) { bao("google-sheet", e.message); return json(res, 400, { loi: e.message }); }
    }
    if (p === "/webhook/zalo-oa") {
      const than = await docThan(req);
      if (!zaloOA.chuKyDung(than, req.headers["x-zevent-signature"])) { res.writeHead(403); return res.end(); }
      res.writeHead(200); res.end("ok");
      return zaloOA.nhan(JSON.parse(than.toString() || "{}")).catch((e) => bao("zalo-oa", e.message));
    }
    // Khung chat website: công khai, mọi tên miền nhúng được (CORS *).
    if (p.startsWith("/web/")) {
      const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      if (p === "/web/widget.js") {
        const w = CH.web || MAC_DINH.web;
        res.writeHead(200, { ...cors, "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "max-age=300" });
        return res.end(`window.__KC=${JSON.stringify({ ten: w.ten, mau: w.mau, chao: w.chao }).replace(/</g, "\\u003c")};\n` + fs.readFileSync(path.join(GOC, "web-widget.js"), "utf8"));
      }
      const tra = (ma, j) => { res.writeHead(ma, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
      const hopLe = (m) => /^[a-z0-9]{16,40}$/.test(String(m || ""));
      if (p === "/web/tin" && req.method === "GET") {
        const ma = url.searchParams.get("ma");
        if (!hopLe(ma)) return tra(400, { loi: "sai mã" });
        return tra(200, { tin: web.layTin(ma, Number(url.searchParams.get("sau")) || 0).map(({ id, chu, anh }) => ({ id, chu, anh })) });
      }
      if (p === "/web/tin" && req.method === "POST") {
        const ip = ipThat(req), n = (NHIP_WEB.get(ip) || 0) + 1;
        if (n > 15) return tra(429, { loi: "Anh/chị nhắn nhanh quá, chờ một chút rồi gửi lại nhé." });
        if (n === 1) setTimeout(() => NHIP_WEB.delete(ip), 60e3).unref();
        NHIP_WEB.set(ip, n);
        const m = JSON.parse((await docThan(req, 8192)).toString() || "{}");
        const chu = String(m.chu || "").trim().slice(0, 1000);
        if (!hopLe(m.ma) || !chu) return tra(400, { loi: "Tin trống." });
        tra(200, { ok: true });
        return web.nhan(m.ma, chu).catch((e) => bao("web", e.message));
      }
      return tra(404, {});
    }
    const tepZalo = tepXacThucZalo(p);
    if (tepZalo) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(tepZalo); }

    if (quaHam && !QUAN_TRI_HTTPS) {
      // Trang chủ qua đường hầm chỉ chứa thẻ meta xác thực của Zalo, không lộ trang quản trị.
      const meta = p === "/" ? metaXacThucZalo() : "";
      if (meta) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(`<!doctype html><html><head>${meta}</head><body></body></html>`); }
      res.writeHead(404); return res.end();
    }
    // Trang web AI làm trong Phòng chat: lưu thành file trên máy này, mở ở /trang/<tên>.html.
    // Chỉ nhận từ chính bảng /bang/ (cùng nguồn), không cho trang lạ ghi file.
    if (p === "/bang-trang" && req.method === "POST") {
      const nguon = String(req.headers.origin || "");
      if (nguon && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(nguon)) { res.writeHead(403); return res.end(); }
      const { ten, html } = JSON.parse((await docThan(req, 5e6)).toString() || "{}");
      if (!html || typeof html !== "string") return json(res, 400, { loi: "trống" });
      const thuMuc = path.join(os.homedir(), ".revidapi", "trang-web");
      fs.mkdirSync(thuMuc, { recursive: true });
      const goc3 = String(ten || "trang").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "trang";
      const tenTep = goc3 + "-" + Date.now().toString(36) + ".html";
      fs.writeFileSync(path.join(thuMuc, tenTep), html);
      return json(res, 200, { url: "/trang/" + tenTep, tep: path.join(thuMuc, tenTep) });
    }
    if (p.startsWith("/trang/") && req.method === "GET") {
      const tenTep = path.basename(decodeURIComponent(p.slice(7)));
      const tep = path.join(os.homedir(), ".revidapi", "trang-web", tenTep);
      if (!/\.html$/.test(tenTep) || !fs.existsSync(tep)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return fs.createReadStream(tep).pipe(res);
    }
    // Bảng quản lý chạy chung cổng: KENH_BANG_DIR trỏ tới thư mục đã build, mở ở /bang/.
    if (process.env.KENH_BANG_DIR && (p === "/bang" || p.startsWith("/bang/"))) {
      if (p === "/bang") { res.writeHead(302, { Location: "/bang/" }); return res.end(); }
      if (BAN_QUYEN.hong >= 2) {
        // Khách vừa đổi key ở /quan-tri thì lần mở sau kiểm lại ngay (tối đa 1 lần/phút).
        if (Date.now() - BAN_QUYEN.luc > 60e3) kiemBanQuyen();
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        return res.end('<!doctype html><meta charset="utf-8"><title>Cần API key</title><body style="font:16px system-ui;max-width:560px;margin:60px auto;padding:0 16px"><h2>API key không còn dùng được</h2><p>Phần mềm cần API key RevidAPI còn hiệu lực. Lấy key ở <b>revidapi.com/dashboard</b>, rồi dán vào trang <a href="/quan-tri">Quản trị Kênh Chat</a> và tải lại trang này.</p></body>');
      }
      const goc2 = path.resolve(process.env.KENH_BANG_DIR);
      const tep = path.resolve(goc2, "." + decodeURIComponent(p.slice(5) || "/index.html").replace(/\/$/, "/index.html"));
      if (!tep.startsWith(goc2 + path.sep) || !fs.existsSync(tep) || !fs.statSync(tep).isFile()) { res.writeHead(404); return res.end(); }
      const LOAI = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".wasm": "application/wasm", ".mp3": "audio/mpeg" };
      res.writeHead(200, { "Content-Type": LOAI[path.extname(tep).toLowerCase()] || "application/octet-stream", "Cache-Control": tep.includes(path.sep + "assets" + path.sep) ? "public, max-age=31536000, immutable" : "no-cache" });
      // Mở trên chính máy này: gắn sẵn API key của Kênh Chat để khách không phải dán lại. Qua đường hầm thì không.
      if (tep.endsWith("index.html") && !quaHam && process.env.REVIDAPI_KEY) {
        const k = JSON.stringify(process.env.REVIDAPI_KEY).replace(/</g, "\\u003c");
        return res.end(fs.readFileSync(tep, "utf8").replace("<head>", `<head><script>try{localStorage.getItem("revidapi-key")||localStorage.setItem("revidapi-key",${k})}catch(e){}</script>`));
      }
      return fs.createReadStream(tep).pipe(res);
    }
    // Một cửa: có bảng quản lý thì trang gốc mở bảng; giao diện chat cũ vẫn ở /quan-tri.
  if (p === "/" && process.env.KENH_BANG_DIR) { res.writeHead(302, { Location: "/bang/" }); return res.end(); }
  if (p === "/" || p === "/index.html" || p === "/quan-tri") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const meta = metaXacThucZalo();
      const trang = fs.readFileSync(path.join(GOC, "quan-tri.html"), "utf8");
      return res.end(meta ? trang.replace(/<head>/i, "<head>" + meta) : trang);
    }
    // Bảng quản lý mở trên CHÍNH máy chạy Kênh Chat: tự nối quyền chủ, không hỏi mật khẩu.
    // Chỉ nhận khi socket là máy này, không qua đường hầm/proxy và trang gọi nằm trong KENH_BANG —
    // trang web lạ trên máy này không có Origin hợp lệ, máy khác trong mạng phải đăng nhập.
    if (p === "/api/tu-noi" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "";
      if (quaHam || !/^(::1|127\.|::ffff:127\.)/.test(ip) || !goc || !NGUON_BANG.has(goc)) return json(res, 403, { loi: "Chỉ tự nối khi mở trên chính máy chạy Kênh Chat." });
      const ma = crypto.randomBytes(24).toString("base64url");
      PHIEN.set(ma, { vai: "chu" });
      return json(res, 200, { phien: ma, vai: "chu", ten: "Chủ" });
    }
    if (p === "/api/dang-nhap" && req.method === "POST") {
      const ip = ipThat(req);
      if ((SAI.get(ip) || 0) >= 10) return json(res, 429, { loi: "Sai quá nhiều lần, chờ 15 phút." });
      const { matKhau } = JSON.parse((await docThan(req, 4096)).toString() || "{}");
      const a = Buffer.from(String(matKhau || "")), b = Buffer.from(CH.matKhau);
      const laChu = a.length === b.length && crypto.timingSafeEqual(a, b);
      const nv = laChu ? null : (CH.nhanVien || []).find((x) => dungMkNv(matKhau, x.mk));
      if (!laChu && !nv) {
        SAI.set(ip, (SAI.get(ip) || 0) + 1);
        setTimeout(() => SAI.delete(ip), 15 * 60e3).unref();
        return json(res, 401, { loi: "Sai mật khẩu." });
      }
      const ma = crypto.randomBytes(24).toString("base64url");
      PHIEN.set(ma, laChu ? { vai: "chu" } : { vai: "nv", id: nv.id });
      res.writeHead(200, { "Set-Cookie": `phien=${ma}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, "Content-Type": "application/json" });
      // Bảng quản lý (khác cổng) không đọc được cookie HttpOnly → nhận mã phiên để gửi qua X-Phien.
      return res.end(goc && NGUON_BANG.has(goc) ? JSON.stringify({ phien: ma, vai: laChu ? "chu" : "nv", ten: laChu ? "Chủ" : nv.ten, boPhan: laChu ? "" : nv.boPhan || "" }) : "{}");
    }
    if (!p.startsWith("/api/")) { res.writeHead(404); return res.end(); }
    const toi = daDangNhap(req);
    if (!toi) return json(res, 401, { loi: "Chưa đăng nhập." });
    if (p === "/api/dang-xuat" && req.method === "POST") {
      const m = /(?:^|;\s*)phien=([a-zA-Z0-9_-]+)/.exec(req.headers.cookie || "");
      if (m) PHIEN.delete(m[1]);
      res.writeHead(200, { "Set-Cookie": "phien=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0", "Content-Type": "application/json" });
      return res.end("{}");
    }
    // Nhân viên chỉ dùng Hộp thư: không xem cấu hình, khoá API, tài liệu, nhật ký.
    const nvId = toi.vai === "nv" ? toi.id : null;
    if (nvId && !(p === "/api/trang-thai" || p.startsWith("/api/hop-thu") || /^\/api\/erp\/(doi|ghi|dem|toi)$/.test(p))) return json(res, 403, { loi: "Tài khoản nhân viên chỉ dùng Hộp thư." });
    if (nvId && p === "/api/trang-thai") {
      return json(res, 200, { toi, chuaDoc: hopThu.tongChuaDoc(nvId), nhanVien: (CH.nhanVien || []).map(({ id, ten }) => ({ id, ten })), the: CH.the, mau: CH.mau,
        kenh: { zalo: zalo.trangThai, zalo2: ZALO.zalo2.trangThai, zalo3: ZALO.zalo3.trangThai, zaloOA: zaloOA.trangThai, facebook: fanpage.trangThai, telegram: telegram.trangThai } });
    }
    // Nhân viên chỉ mở được cuộc của mình hoặc cuộc chưa giao ai.
    const duocXem = (c) => !!c && (!nvId || !c.giao || c.giao === nvId);

    if (p === "/api/cap-nhat" && req.method === "POST") {
      if (capNhat.dangChay) return json(res, 409, { loi: "Đang cập nhật." });
      capNhat.dangChay = true; capNhat.loi = "";
      try { await lamCapNhat(); } catch (e) { capNhat.dangChay = false; capNhat.loi = e.message; return json(res, 500, { loi: e.message }); }
      json(res, 200, { ok: true });
      // Mac (launchd) và VPS (systemd) tự bật lại khi tiến trình thoát; Windows chạy qua .vbs nên tự bật bản mới.
      setTimeout(() => {
        if (process.platform === "win32") spawn(process.execPath, [path.join(GOC, "server.mjs")], { cwd: GOC, detached: true, stdio: "ignore", env: process.env }).unref();
        process.exit(0);
      }, 800);
      return;
    }
    if (p.startsWith("/api/erp/")) {
      // Nhân viên: chỉ kéo/ghi trong quyền bộ phận (quyen.mjs). Nhập Sheet, Drive, xuất CSV chỉ chủ.
      const q = quyenCua(toi);
      if (p === "/api/erp/toi") return json(res, 200, { vai: toi.vai, ten: toi.ten || "Chủ", boPhan: toi.boPhan || "", tenBoPhan: q?.ten || "Chủ" });
      if (p === "/api/erp/doi") {
        const r = erp.doiTu(url.searchParams.get("tu"));
        if (q) r.doi = r.doi.filter((d) => duocDoc(q, d.db, d.kho)).map((d) => ({ ...d, v: choXem(q, d.v) }));
        return json(res, 200, r);
      }
      if (p === "/api/erp/dem") {
        const dem = Object.fromEntries(Object.entries(erp.dem()).filter(([k]) => { const [db, kho] = k.split("/"); return duocDoc(q, db, kho); }));
        return json(res, 200, q ? { seq: erp.seq(), dem, drive: "", driveGoiY: [] } : { seq: erp.seq(), dem, drive: CH.driveThuMuc || "", driveGoiY: timThuMucDrive() });
      }
      if (p === "/api/erp/ghi" && req.method === "POST") {
        const { doi, may } = JSON.parse((await docThan(req, 64e6)).toString() || "{}");
        if (!Array.isArray(doi)) return json(res, 400, { loi: "Thiếu doi." });
        const { duoc, bo } = locGhi(q, doi, (db, kho, id) => erp.doc(db, kho, id));
        // Dòng đơn mới do người không thấy giá vốn tạo: điền giá vốn theo hàng hoá để lãi không sai.
        if (q?.an.includes("giaVon")) for (const d of duoc) if (d.kho === "donHang" && Array.isArray(d.v?.dong))
          d.v.dong = d.v.dong.map((x) => ("giaVon" in x ? x : { ...x, giaVon: erp.doc("revidapi-erp", "sanPham", x.spId)?.giaVon || 0 }));
        if (bo) bao("erp", `${toi.ten} (${q.ten}) gửi ${bo} bản ghi ngoài quyền — đã bỏ`);
        return json(res, 200, { seq: duoc.length ? erp.ghiNhieu(duoc, "bang:" + String(may || "").slice(0, 40)) : erp.seq(), bo });
      }
      if (q) return json(res, 403, { loi: "Chỉ chủ mới nhập Sheet, đọc Drive hay xuất dữ liệu." });
      if (p === "/api/erp/csv") {
        const csv = erp.xuatCsv(url.searchParams.get("db"), url.searchParams.get("kho"));
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${url.searchParams.get("kho")}.csv"` });
        return res.end(csv);
      }
      if (p === "/api/erp/sheet" && req.method === "POST") {
        const { link, loai } = JSON.parse((await docThan(req, 8192)).toString() || "{}");
        try {
          const so = await erp.nhapSheet(link, loai);
          ghiCauHinh({ sheets: [...(CH.sheets || []).filter((x) => !(x.link === link && x.loai === loai)), { link, loai }] });
          return json(res, 200, { so, seq: erp.seq() });
        } catch (e) { return json(res, 400, { loi: e.message }); }
      }
      // Trang Nạp dữ liệu: bảng hàng hoá / khách hàng đọc từ Excel trên trình duyệt gửi lên dạng CSV.
      if (p === "/api/erp/nhap-csv" && req.method === "POST") {
        try { const { csv, loai } = JSON.parse((await docThan(req, 2e7)).toString() || "{}"); return json(res, 200, { so: erp.nhapCsv(String(csv || ""), loai), seq: erp.seq() }); }
        catch (e) { return json(res, 400, { loi: e.message }); }
      }
      if (p === "/api/erp/sheet-script") {
        const loai = url.searchParams.get("loai") === "lienHe" ? "lienHe" : "sanPham";
        if (!duongHam.goc) return json(res, 400, { loi: "Chưa có địa chỉ HTTPS công khai — chờ vài giây sau khi Kênh Chat khởi động rồi bấm lại." });
        return json(res, 200, { tamThoi: !CH.tenMien, script: scriptSheet(duongHam.goc + "/webhook/google-sheet", CH.sheetBiMat, loai) });
      }
      if (p === "/api/erp/drive" && req.method === "POST") {
        const { thuMuc } = JSON.parse((await docThan(req, 8192)).toString() || "{}");
        try { const so = erp.quetThuMuc(thuMuc); ghiCauHinh({ driveThuMuc: thuMuc }); return json(res, 200, { so, seq: erp.seq() }); } catch (e) { return json(res, 400, { loi: e.message }); }
      }
      return json(res, 404, { loi: "Không có." });
    }
    if (p === "/api/model") return json(res, 200, { model: (await modelDangBan(CH.coSo, CH.khoa)) || [], luiVe: MODEL_LUI });
    if (p === "/api/trang-thai") {
      xemBanMoi(); modelDangBan(CH.coSo, CH.khoa);
      return json(res, 200, {
        banQuyen: { coKhoa: !!CH.khoa, hopLe: BAN_QUYEN.ok, daKiem: BAN_QUYEN.luc > 0 },
        cauHinh: cauHinhCongKhai(),
        kenh: { zalo: zalo.trangThai, zalo2: ZALO.zalo2.trangThai, zalo3: ZALO.zalo3.trangThai, zaloOA: zaloOA.trangThai, facebook: fanpage.trangThai, telegram: telegram.trangThai },
        kenhDang: dsKenhDang(),
        loiOA: zaloOA.loi || "", loiGoi: boNao.loiGoi || canhBaoModel(),
        qr: zalo.qr, qrTk: Object.fromEntries(ZALO_TK.map((k) => [k, ZALO[k].qr])), taiLieu: kho.danhSach(), chuaDoc: hopThu.tongChuaDoc(),
        webhook: { goc: duongHam.goc, loi: duongHam.loi || "", facebook: "/webhook/facebook", zaloOA: "/webhook/zalo-oa", woocommerce: "/webhook/woocommerce" },
        tenMien: { dangChay: viecTenMien.dangChay, ten: CH.tenMien || "", tuDat: tuDatDuoc(), cong: CONG },
        ban: BAN, banMoi: capNhat.moi, loiCapNhat: capNhat.loi,
        toi, diaChiNhanVien: diaChiNhanVien(),
      });
    }
    // Kênh đăng bài nối ngay ở trang Lịch đăng bài. Token/mật khẩu chỉ đi vào, không bao giờ trả ra.
    if (p === "/api/kenh-dang" && req.method === "POST") {
      const m = JSON.parse((await docThan(req, 2e4)).toString() || "{}");
      const s = (v, n = 300) => String(v || "").trim().slice(0, n);
      const db = { prompt: CH.dangBai?.prompt || {}, telegram: [...(CH.dangBai?.telegram || [])], wordpress: [...(CH.dangBai?.wordpress || [])], threads: [...(CH.dangBai?.threads || [])] };
      const lay = (u) => fetch(u, { signal: AbortSignal.timeout(20e3) }).then((x) => x.json()).catch((e) => ({ error: { message: e.message } }));
      if (m.lichTuDong) {   // chế độ AI tự lên lịch: bật/tắt, số ngày, bài/ngày, giờ, kênh, tự duyệt
        const l = m.lichTuDong;
        ghiCauHinh({ lichTuDong: { bat: !!l.bat, tuDuyet: !!l.tuDuyet, soNgay: +l.soNgay || 7, moiNgay: +l.moiNgay || 1, gio: s(l.gio, 5) || "19:00", chuDe: s(l.chuDe, 500), model: s(l.model, 100), kenh: Array.isArray(l.kenh) ? l.kenh.map(String) : [] } });
        if (!l.chayNgay) return json(res, 200, { kenhDang: dsKenhDang() });
        try { return json(res, 200, { kenhDang: dsKenhDang(), so: await lichDangBai.lapNgay() }); } catch (e) { return json(res, 400, { loi: e.message }); }
      }
      if (m.prompt !== undefined && m.ma) {   // system prompt AI riêng cho kênh — không phải bí mật nên trả ra được
        ghiCauHinh({ dangBai: { ...db, prompt: { ...(CH.dangBai?.prompt || {}), [String(m.ma)]: String(m.prompt).slice(0, 4000) } } });
        return json(res, 200, { kenhDang: dsKenhDang() });
      }
      if (m.xoa) {
        const [loai, id] = String(m.xoa).split(/:(.*)/s);
        if (loai === "fb") ghiCauHinh({ facebook: { ...CH.facebook, trang: CH.facebook.trang.filter((t) => t.id !== id) } });
        else if (loai === "ig") ghiCauHinh({ facebook: { ...CH.facebook, trang: CH.facebook.trang.map((t) => t.ig === id ? { ...t, ig: undefined, igTen: undefined } : t) } });
        else ghiCauHinh({ dangBai: { ...db, telegram: db.telegram.filter((t) => t.id !== id), wordpress: db.wordpress.filter((t) => t.id !== id), threads: db.threads.filter((t) => t.id !== id) } });
        return json(res, 200, { kenhDang: dsKenhDang() });
      }
      if (m.loai === "facebook" && m.appSecret) {
        // App ID + App Secret + token người dùng ngắn hạn -> token dài hạn -> token Trang không hết hạn (kèm Instagram nối với Trang).
        const appId = s(m.appId, 40), sec = s(m.appSecret, 100), ut = s(m.token, 800), G = "https://graph.facebook.com/v21.0/";
        if (!/^\d{5,}$/.test(appId) || !sec || !ut) return json(res, 400, { loi: "Cần App ID, App Secret và User Access Token." });
        const dai = await lay(`${G}oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${encodeURIComponent(sec)}&fb_exchange_token=${encodeURIComponent(ut)}`);
        if (!dai.access_token) return json(res, 400, { loi: "Facebook không đổi được token: " + (dai.error?.message || "không rõ") });
        const ac = await lay(`${G}me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100&access_token=${encodeURIComponent(dai.access_token)}`);
        if (ac.error) return json(res, 400, { loi: "Facebook từ chối: " + ac.error.message });
        if (!ac.data?.length) return json(res, 400, { loi: "Tài khoản này không quản lý Trang nào, hoặc token thiếu quyền pages_show_list / pages_manage_posts." });
        const cu = CH.facebook?.trang || [], moi = ac.data.map((p) => ({ ...cu.find((x) => x.id === p.id), id: p.id, ten: p.name, token: p.access_token, ig: p.instagram_business_account?.id, igTen: p.instagram_business_account?.username }));
        ghiCauHinh({ facebook: { ...CH.facebook, appId, appSecret: giu(sec, CH.facebook?.appSecret), trang: [...cu.filter((x) => !moi.some((y) => y.id === x.id)), ...moi] } });
      } else if (m.loai === "threads") {
        const sec = s(m.appSecret, 100), ut = s(m.token, 800);
        if (!ut) return json(res, 400, { loi: "Cần Threads Access Token." });
        let tk = ut, het = Date.now() + 3600e3;
        if (sec) {
          const d = await lay(`https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(sec)}&access_token=${encodeURIComponent(ut)}`);
          if (d.access_token) { tk = d.access_token; het = Date.now() + (d.expires_in || 5184000) * 1e3; }
          else if (!/long/i.test(d.error?.message || "")) return json(res, 400, { loi: "Threads không đổi được token: " + (d.error?.message || "không rõ") });
        }
        const me = await lay(`https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(tk)}`);
        if (!me.id) return json(res, 400, { loi: "Threads từ chối token: " + (me.error?.message || "không rõ") });
        if (tk === ut && !sec) het = Date.now() + 50 * 864e5;   // khách dán sẵn token dài hạn
        db.threads = [...db.threads.filter((x) => x.id !== me.id), { id: me.id, ten: me.username, token: tk, het }];
        ghiCauHinh({ dangBai: db });
      } else if (m.loai === "facebook") {
        const t = { id: s(m.id, 40), ten: s(m.ten, 80), token: s(m.token, 600) };
        if (!/^\d{5,}$/.test(t.id) || !t.token) return json(res, 400, { loi: "Cần ID Trang (dãy số) và Page Access Token." });
        // Chỉ kiểm token đúng Trang; đăng bài không cần quyền nhắn tin như kiemTrang đòi.
        const me = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(t.token)}`, { signal: AbortSignal.timeout(15e3) }).then((x) => x.json()).catch((e) => ({ error: e }));
        if (me.error) return json(res, 400, { loi: "Facebook từ chối token: " + me.error.message });
        if (String(me.id) !== t.id) return json(res, 400, { loi: `Token này của "${me.name}" (ID ${me.id}), không phải Trang ${t.id}. Cần Page Access Token.` });
        t.ten ||= me.name;
        ghiCauHinh({ facebook: { ...CH.facebook, trang: [...CH.facebook.trang.filter((x) => x.id !== t.id), t] } });
      } else if (m.loai === "telegram") {
        const token = s(m.token, 100) || CH.telegram?.token || "", chat = s(m.chat, 100);
        if (!token || !chat) return json(res, 400, { loi: "Cần Bot token và @kênh hoặc chat_id." });
        const r = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chat)}`, { signal: AbortSignal.timeout(15e3) }).then((x) => x.json()).catch((e) => ({ description: e.message }));
        if (!r.ok) return json(res, 400, { loi: "Telegram từ chối: " + (r.description || "không rõ") + ". Bot phải là admin của kênh." });
        db.telegram = [...db.telegram.filter((x) => x.chat !== chat), { id: String(r.result.id), ten: s(m.ten, 80) || r.result.title || chat, token, chat }];
        ghiCauHinh({ dangBai: db });
      } else if (m.loai === "wordpress") {
        const url = s(m.url, 200).replace(/\/+$/, ""), user = s(m.user, 80), mk = s(m.mk, 100);
        if (!/^https?:\/\//.test(url) || !user || !mk) return json(res, 400, { loi: "Cần địa chỉ web, tên đăng nhập và Application Password." });
        const r = await fetch(url + "/wp-json/wp/v2/users/me?context=edit", { headers: { Authorization: "Basic " + Buffer.from(user + ":" + mk.replace(/\s+/g, "")).toString("base64") }, signal: AbortSignal.timeout(20e3) })
          .then(async (x) => ({ ok: x.ok, j: await x.json().catch(() => ({})) })).catch((e) => ({ j: { message: e.message } }));
        if (!r.ok) return json(res, 400, { loi: "WordPress từ chối: " + (r.j.message || "sai tài khoản") });
        const id = new URL(url).host;
        db.wordpress = [...db.wordpress.filter((x) => x.id !== id), { id, ten: s(m.ten, 80) || id, url, user, mk: mk.replace(/\s+/g, "") }];
        ghiCauHinh({ dangBai: db });
      } else return json(res, 400, { loi: "Loại kênh không hỗ trợ." });
      return json(res, 200, { kenhDang: dsKenhDang() });
    }
    if (p === "/api/ten-mien" && req.method === "POST") {
      const { tenMien } = JSON.parse((await docThan(req, 4096)).toString() || "{}");
      const ten = chuanTenMien(tenMien);
      if (ten === null) return json(res, 400, { loi: "Tên miền không hợp lệ — ví dụ đúng: chat.tenmien.vn" });
      if (viecTenMien.dangChay) return json(res, 409, { loi: "Đang đặt tên miền, đợi chút." });
      datTenMien(ten);   // chạy nền: tự cài HTTPS có thể mất 1–3 phút, quá hạn chờ của đường hầm
      return json(res, 200, {});
    }
    if (p === "/api/ten-mien") return json(res, 200, { ...viecTenMien, nhatKy: viecTenMien.nhatKy.slice(-4000) });
    // Màn bắt buộc nhập key: kiểm với cổng trước khi lưu, key sai thì không lưu.
    if (p === "/api/khoa" && req.method === "POST") {
      const k = String(JSON.parse((await docThan(req, 2e3)).toString() || "{}").khoa || "").trim();
      if (!/^sk_[A-Za-z0-9_-]{16,}$/.test(k)) return json(res, 400, { loi: "Key RevidAPI có dạng sk_… — copy lại ở revidapi.com/dashboard/settings." });
      const kq = await hoiKhoa(k);
      if (kq === false) return json(res, 400, { loi: "Key không hợp lệ hoặc đã bị thu hồi." });
      if (kq === null) return json(res, 503, { loi: "Không kết nối được revidapi.com để kiểm key. Kiểm mạng rồi thử lại." });
      ghiCauHinh({ khoa: k }); BAN_QUYEN.hong = 0; BAN_QUYEN.ok = true; BAN_QUYEN.luc = Date.now();
      modelDangBan(CH.coSo, CH.khoa);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/cau-hinh" && req.method === "POST") {
      const m = JSON.parse((await docThan(req, 2e5)).toString() || "{}");
      const khoaMoi = String(giu(m.khoa, CH.khoa) || "").trim();
      if (khoaMoi && khoaMoi !== CH.khoa) {
        const kq = await hoiKhoa(khoaMoi);
        if (kq === false) return json(res, 400, { loi: "API key RevidAPI không hợp lệ — chưa lưu. Lấy key ở revidapi.com/dashboard/settings." });
        if (kq === true) { BAN_QUYEN.hong = 0; BAN_QUYEN.ok = true; BAN_QUYEN.luc = Date.now(); }
      }
      const oaCu = { ...CH.zaloOA };
      ghiCauHinh({
        bat: !!m.bat, model: String(m.model || CH.model), modelDuPhong: String(m.modelDuPhong ?? CH.modelDuPhong ?? ""), hanGiay: Math.min(90, Math.max(8, Number(m.hanGiay) || 12)), toiDaRa: Math.min(2000, Math.max(300, Number(m.toiDaRa) || 800)),
        vaiTro: String(m.vaiTro || "").slice(0, 3000), gio: String(m.gio || ""), ngoaiGio: String(m.ngoaiGio || "").slice(0, 500),
        khiLoi: String(m.khiLoi || "").slice(0, 500), khoa: khoaMoi || CH.khoa,
        chuyenChu: !!m.chuyenChu, cauCho: String(m.cauCho ?? CH.cauCho ?? "").slice(0, 500),
        ...(m.boNoiChu ? { baoChu: null } : {}),
        hoiNhanh: (m.hoiNhanh || []).slice(0, 100).map((h) => ({ khi: String(h.khi || ""), tra: String(h.tra || "").slice(0, 2000) })),
        boQua: (m.boQua || []).map(String).slice(0, 500),
        zalo: { traLoiNhom: !!m.zalo?.traLoiNhom, tenGoi: String(m.zalo?.tenGoi || "") },
        telegram: { traLoiNhom: !!m.telegram?.traLoiNhom, tenGoi: String(m.telegram?.tenGoi || ""), token: giu(m.telegram?.token, CH.telegram.token) || "" },
        web: { ten: String(m.web?.ten ?? CH.web?.ten ?? "").slice(0, 60), mau: /^#[0-9a-f]{6}$/i.test(m.web?.mau || "") ? m.web.mau : (CH.web?.mau || "#2f9e44"), chao: String(m.web?.chao ?? CH.web?.chao ?? "").slice(0, 300) },
        zaloOA: { ...CH.zaloOA, appId: String(m.zaloOA?.appId || ""), secretKey: giu(m.zaloOA?.secretKey, CH.zaloOA.secretKey) || "",
                  oaSecretKey: giu(m.zaloOA?.oaSecretKey, CH.zaloOA.oaSecretKey) || "",
                  refreshToken: giu(m.zaloOA?.refreshToken, CH.zaloOA.refreshToken) || "",
                  accessToken: giu(m.zaloOA?.accessToken, CH.zaloOA.accessToken) || "",
                  xacThucTen: String(m.zaloOA?.xacThucTen ?? CH.zaloOA.xacThucTen ?? "").trim().slice(0, 100),
                  xacThucNoiDung: String(m.zaloOA?.xacThucNoiDung ?? CH.zaloOA.xacThucNoiDung ?? "").trim().slice(0, 4000) },
        // Giữ appId và Instagram đã nối ở Lịch đăng bài — form quản trị không biết các trường đó.
        facebook: { maXacMinh: CH.facebook.maXacMinh, appId: CH.facebook.appId, appSecret: giu(m.facebook?.appSecret, CH.facebook.appSecret) || "",
                    binhLuan: m.facebook?.binhLuan ? (({ bat, tuKhoa, baiViet, traLoiCong, nhanRieng, duPhong, an, caTraLoiCon }) => ({
                      bat: !!bat, an: !!an, caTraLoiCon: !!caTraLoiCon, tuKhoa: String(tuKhoa || "").slice(0, 1000), baiViet: String(baiViet || "").slice(0, 2000),
                      traLoiCong: String(traLoiCong || "").slice(0, 3000), nhanRieng: String(nhanRieng || "").slice(0, 2000), duPhong: String(duPhong || "").slice(0, 1000),
                    }))(m.facebook.binhLuan) : CH.facebook.binhLuan,
                    trang: (m.facebook?.trang || []).map((t) => { const cu = CH.facebook.trang.find((c) => c.id === String(t.id || "").trim()) || {};
                      return { ...cu, id: String(t.id || "").trim(), ten: String(t.ten || ""), token: giu(t.token, cu.token) || "" }; }).filter((t) => t.id) },
      });
      // Đổi App ID / Secret key / Refresh token thì lấy token mới ngay, báo lỗi lên panel luôn
      // (trước đây giữ access token cũ, lỗi chỉ lộ ra khi khách nhắn mà bot im).
      const doiOA = ["appId", "secretKey", "refreshToken"].some((k) => (CH.zaloOA[k] || "") !== (oaCu[k] || ""));
      if (CH.zaloOA.refreshToken && (doiOA || !CH.zaloOA.accessToken)) {
        if (doiOA) ghiCauHinh({ zaloOA: { ...CH.zaloOA, accessToken: "" } });
        await zaloOA.lamMoi().catch((e) => { zaloOA.loiToken = "Không gọi được Zalo: " + e.message; });
        if (zaloOA.loiToken) return json(res, 200, { canhBao: "Zalo OA: " + zaloOA.loiToken });
      }
      const fbMoi = CH.facebook.trang.filter((t) => t.token);
      const loiFB = (await Promise.all(fbMoi.map((t) => fanpage.kiemTrang(t)))).filter(Boolean);
      if (loiFB.length) return json(res, 200, { canhBao: "Fanpage: " + loiFB.join(" · ") });
      return json(res, 200, {});
    }
    if (p === "/api/zalo/qr" && req.method === "POST") { await (ZALO[url.searchParams.get("tk")] || zalo).quetQR(); return json(res, 200, {}); }
    if (p === "/api/zalo/ngat" && req.method === "POST") { (ZALO[url.searchParams.get("tk")] || zalo).ngat(); return json(res, 200, {}); }
    // PDF: gửi thẳng tệp nhị phân, bóc chữ NGAY TRÊN MÁY bằng pdf.js (chạy được cả
    // Windows/macOS/Linux, không cần cài thêm gì). AI không bao giờ đọc nguyên PDF.
    if (p === "/api/tai-lieu/pdf" && req.method === "POST") {
      let chu;
      try {
        chu = await bocChuPdf(await docThan(req, 60e6));
      } catch {
        return json(res, 400, { loi: "Tệp không đọc được như PDF (hỏng, có mật khẩu, hoặc không phải PDF)." });
      }
      if (chu.replace(/\s/g, "").length < 50) {
        return json(res, 400, { loi: "PDF này là ảnh chụp (không có lớp chữ). Hãy dùng bản PDF xuất từ Word/Excel." });
      }
      const ten = kho.luu(String(url.searchParams.get("ten") || "tai-lieu").replace(/\.pdf$/i, ""), chu);
      return json(res, 200, { ten, kyTu: chu.length });
    }
    if (p === "/api/tai-lieu/office" && req.method === "POST") {
      const tenGoc = String(url.searchParams.get("ten") || "tai-lieu"), excel = /\.xlsx$/i.test(tenGoc);
      let chu;
      try {
        const du = await docThan(req, 60e6);
        chu = excel ? bocChuXlsx(du) : bocChuDocx(du);
      } catch {
        return json(res, 400, { loi: "Không đọc được tệp. Chỉ nhận .docx/.xlsx — tệp .doc/.xls đời cũ hãy mở bằng Word/Excel rồi Lưu thành .docx/.xlsx." });
      }
      if (chu.replace(/\s/g, "").length < 10) return json(res, 400, { loi: "Tệp không có chữ để đọc." });
      const ten = kho.luu(tenGoc.replace(/\.(docx|xlsx)$/i, ""), chu);
      return json(res, 200, { ten, kyTu: chu.length });
    }
    if (p === "/api/tai-lieu" && req.method === "POST") {
      const m = JSON.parse((await docThan(req)).toString() || "{}");
      let chu = String(m.chu || "");
      // Lấy nội dung trang web qua RevidAPI (bóc sẵn chữ, không cần AI đọc trang).
      if (m.url) {
        const r = await fetch(CH.coSo + "/v1/website/crawl", { method: "POST",
          headers: { Authorization: "Bearer " + CH.khoa, "Content-Type": "application/json" },
          body: JSON.stringify({ url: m.url, mode: "article" }) });   // web chỉ trả links, không có chữ
        const j = await r.json().catch(() => ({}));
        chu = j.markdown || j.content || j.text || j?.data?.markdown || j?.data?.content || "";
        if (!chu) return json(res, 400, { loi: j?.error?.message || "Không đọc được trang này." });
      }
      if (!chu.trim()) return json(res, 400, { loi: "Tài liệu trống." });
      return json(res, 200, { ten: kho.luu(m.ten || (m.url ? new URL(m.url).hostname : "tai-lieu"), chu) });
    }
    if (p === "/api/tai-lieu/xoa" && req.method === "POST") {
      kho.xoa(JSON.parse((await docThan(req, 4096)).toString()).ten); return json(res, 200, {});
    }
    if (p === "/api/thu" && req.method === "POST") {
      const { chu } = JSON.parse((await docThan(req, 2e4)).toString() || "{}");
      const ma = "quan-tri-" + Date.now();   // mỗi lần thử là một cuộc mới, không lẫn lịch sử
      boNao.loiCuoi = "";
    const ra = await boNao.traLoi("thu", ma, chu, { tenCuoc: "Thử bot" });
      const cuoi = hopThu.db.prepare("SELECT vai, nguon FROM tin WHERE khoa = ? ORDER BY id DESC LIMIT 1").get("thu:" + ma);
      hopThu.db.prepare("DELETE FROM tin WHERE khoa = ?").run("thu:" + ma);
      hopThu.db.prepare("DELETE FROM cuoc WHERE khoa = ?").run("thu:" + ma);
      return json(res, 200, { ra, loi: ra ? "" : (boNao.loiCuoi || boNao.loiGoi || ""), doan: cuoi?.vai === "bot" ? String(cuoi.nguon || "").split(", ").filter(Boolean) : [] });
    }
    // ---- Hộp thư chung
    if (p === "/api/hop-thu") {
      return json(res, 200, hopThu.danhSach(String(url.searchParams.get("tim") || "").slice(0, 100), 100, nvId));
    }
    if (p === "/api/hop-thu/tin") {
      const khoa = String(url.searchParams.get("khoa") || "");
      if (!duocXem(hopThu.cuoc(khoa))) return json(res, 403, { loi: "Cuộc này đã giao cho nhân viên khác." });
      return json(res, 200, { cuoc: hopThu.cuoc(khoa), tin: hopThu.tin(khoa), nho: hopThu.docNho(khoa) });
    }
    if (p === "/api/hop-thu/gui" && req.method === "POST") {
      const { khoa, chu } = JSON.parse((await docThan(req, 2e4)).toString() || "{}");
      const c = hopThu.cuoc(String(khoa || ""));
      const noiDung = String(chu || "").trim();
      if (!c || !noiDung) return json(res, 400, { loi: "Thiếu cuộc chat hoặc nội dung." });
      if (!duocXem(c)) return json(res, 403, { loi: "Cuộc này đã giao cho nhân viên khác." });
      const kenh = KENH[c.kenh];
      if (!kenh) return json(res, 400, { loi: "Kênh này không gửi tay được." });
      // Cùng cuộc + cùng chữ trong 8 giây (hoặc đang gửi dở) là bấm/Enter lặp → bỏ, không gửi khách hai lần.
      const dauVet = c.khoa + "\n" + noiDung, truoc = guiGanDay.get(dauVet);
      if (truoc && Date.now() - truoc < 8000) return json(res, 200, { trung: true });
      guiGanDay.set(dauVet, Date.now());
      for (const [k, t] of guiGanDay) if (Date.now() - t > 60000) guiGanDay.delete(k);
      try {
        await kenh.gui(c.ma, noiDung, c.loai);
      } catch (e) {
        guiGanDay.delete(dauVet);
        return json(res, 400, { loi: "Chưa gửi được: " + e.message });
      }
      hopThu.ghi(c.kenh, c.ma, { vai: "nhan_vien", chu: noiDung, nguon: toi.ten || "Chủ shop" });
      if (nvId && !c.giao) hopThu.giao(c.khoa, nvId);   // nhân viên trả lời cuộc chưa giao → nhận luôn
      hopThu.tiepQuan(c.khoa);   // nhân viên đã vào cuộc → bot im trong lúc này
      return json(res, 200, {});
    }
    if (p === "/api/hop-thu/ghi-nho" && req.method === "POST") {
      const { khoa, nho } = JSON.parse((await docThan(req, 2e4)).toString() || "{}");
      if (!hopThu.cuoc(String(khoa || ""))) return json(res, 404, { loi: "Không có cuộc chat này." });
      if (!duocXem(hopThu.cuoc(String(khoa)))) return json(res, 403, { loi: "Cuộc này đã giao cho nhân viên khác." });
      const cu = hopThu.docNho(String(khoa));
      const xoa = Object.fromEntries(Object.keys(cu).filter((k) => !(k in (nho || {}))).map((k) => [k, ""]));
      return json(res, 200, hopThu.ghiNho(String(khoa), { ...xoa, ...(nho || {}) }));
    }
    // ---- Bot tự học: cặp hỏi–đáp chờ duyệt, câu tài liệu chưa có. Duyệt xong ghép vào tài liệu
    // "hoi-dap-da-hoc.txt" để lần sau bot tìm thấy như mọi tài liệu khác.
    if (p === "/api/hoc") {
      return json(res, 200, { cho: hopThu.dsHoc("cho"), thieu: hopThu.dsHoc("thieu"), duyet: hopThu.dsHoc("duyet") });
    }
    if (p === "/api/hoc/sua" && req.method === "POST") {
      const { id, hoi, tra, trang } = JSON.parse((await docThan(req, 2e4)).toString() || "{}");
      if (!["cho", "duyet", "thieu", "xoa", undefined].includes(trang)) return json(res, 400, { loi: "Trạng thái sai." });
      if (trang === "duyet" && !String(tra ?? hopThu.db.prepare("SELECT tra FROM hoc WHERE id = ?").get(id)?.tra ?? "").trim())
        return json(res, 400, { loi: "Cần câu trả lời trước khi duyệt." });
      hopThu.suaHoc(Number(id), { hoi, tra, trang });
      const ds = hopThu.dsHoc("duyet");
      if (ds.length) kho.luu("hoi-dap-da-hoc.txt", ds.map((h) => `Hỏi: ${h.hoi}\nĐáp: ${h.tra}`).join("\n\n"));
      else kho.xoa("hoi-dap-da-hoc.txt");
      return json(res, 200, {});
    }
    if (p === "/api/hop-thu/tiep-quan" && req.method === "POST") {
      const { khoa, bat } = JSON.parse((await docThan(req, 4096)).toString() || "{}");
      if (!duocXem(hopThu.cuoc(String(khoa)))) return json(res, 403, { loi: "Cuộc này đã giao cho nhân viên khác." });
      if (bat) hopThu.tiepQuan(String(khoa)); else hopThu.traBot(String(khoa));
      return json(res, 200, {});
    }
    // Thẻ khách, đã xong, ghi chú nội bộ: ai xem được cuộc thì dùng được.
    if (["/api/hop-thu/the", "/api/hop-thu/xong", "/api/hop-thu/ghi-chu"].includes(p) && req.method === "POST") {
      const m = JSON.parse((await docThan(req, 8000)).toString() || "{}");
      const c = hopThu.cuoc(String(m.khoa || ""));
      if (!c) return json(res, 404, { loi: "Không có cuộc chat này." });
      if (!duocXem(c)) return json(res, 403, { loi: "Cuộc này đã giao cho nhân viên khác." });
      if (p.endsWith("/the")) {
        const ids = [...new Set((m.the || []).map(String))];
        if (ids.some((id) => !CH.the.some((t) => t.id === id))) return json(res, 400, { loi: "Thẻ đã bị xoá — tải lại trang." });
        hopThu.datThe(c.khoa, ids);
      }
      else if (p.endsWith("/xong")) hopThu.datXong(c.khoa, !!m.xong);
      else {
        const chu = String(m.chu || "").trim();
        if (!chu) return json(res, 400, { loi: "Ghi chú trống." });
        hopThu.ghiChu(c.khoa, chu, toi.ten || "Chủ shop");
      }
      return json(res, 200, {});
    }
    // Giao cuộc: chủ giao cho bất kỳ ai / bỏ giao; nhân viên chỉ nhận cuộc chưa giao về mình, hoặc trả lại.
    if (p === "/api/hop-thu/giao" && req.method === "POST") {
      const { khoa, nv } = JSON.parse((await docThan(req, 4096)).toString() || "{}");
      const c = hopThu.cuoc(String(khoa || ""));
      if (!c) return json(res, 404, { loi: "Không có cuộc chat này." });
      const dich = nv ? String(nv) : null;
      if (dich && !(CH.nhanVien || []).some((x) => x.id === dich)) return json(res, 400, { loi: "Không có nhân viên này." });
      if (nvId) {
        const nhan = dich === nvId && !c.giao, tra = !dich && c.giao === nvId;
        if (!nhan && !tra) return json(res, 403, { loi: "Chỉ chủ shop mới chuyển cuộc giữa các nhân viên." });
      }
      hopThu.giao(c.khoa, dich);
      return json(res, 200, {});
    }
    if (p === "/api/nhan-vien" && req.method === "POST") {
      const m = JSON.parse((await docThan(req, 4096)).toString() || "{}");
      const ds = [...(CH.nhanVien || [])];
      const mkMoi = () => crypto.randomBytes(7).toString("base64url");
      if (m.viec === "them") {
        const ten = String(m.ten || "").trim().slice(0, 40);
        if (!ten) return json(res, 400, { loi: "Nhập tên nhân viên." });
        if (ds.length >= 30) return json(res, 400, { loi: "Tối đa 30 nhân viên." });
        const mk = mkMoi(), id = "nv" + crypto.randomBytes(4).toString("hex");
        const boPhan = BO_PHAN[m.boPhan] ? m.boPhan : "";
        ghiCauHinh({ nhanVien: [...ds, { id, ten, boPhan, mk: bamMk(mk) }] });
        return json(res, 200, { id, ten, boPhan, matKhau: mk });
      }
      const i = ds.findIndex((x) => x.id === m.id);
      if (m.viec === "chia") { ghiCauHinh({ chiaTuDong: !!m.bat }); return json(res, 200, {}); }
      if (m.viec === "bot-im") { ghiCauHinh({ botImKhiGiao: !!m.bat }); return json(res, 200, {}); }
      if (i < 0) return json(res, 404, { loi: "Không có nhân viên này." });
      if (m.viec === "bo-phan") {
        if (m.boPhan && !BO_PHAN[m.boPhan]) return json(res, 400, { loi: "Bộ phận không hợp lệ." });
        ds[i] = { ...ds[i], boPhan: m.boPhan || "" }; ghiCauHinh({ nhanVien: ds });
        return json(res, 200, {});
      }
      if (m.viec === "doi-mk") {
        const mk = mkMoi(); ds[i] = { ...ds[i], mk: bamMk(mk) }; ghiCauHinh({ nhanVien: ds });
        for (const [k, v] of PHIEN) if (v.id === m.id) PHIEN.delete(k);   // đăng xuất máy cũ
        return json(res, 200, { matKhau: mk });
      }
      if (m.viec === "xoa") {
        ds.splice(i, 1); ghiCauHinh({ nhanVien: ds });
        hopThu.db.prepare("UPDATE cuoc SET giao = NULL WHERE giao = ?").run(m.id);   // cuộc của người đó về "Chưa giao"
        return json(res, 200, {});
      }
      return json(res, 400, { loi: "Việc không hợp lệ." });
    }
    if (p === "/api/the-mau" && req.method === "POST") {
      const m = JSON.parse((await docThan(req, 1e5)).toString() || "{}");
      const the = (m.the || []).slice(0, 30).map((t, i) => ({
        id: /^t[\w]{1,12}$/.test(t.id) ? t.id : "t" + crypto.randomBytes(3).toString("hex"),
        ten: String(t.ten || "").trim().slice(0, 30), mau: /^#[0-9a-f]{6}$/i.test(t.mau) ? t.mau : "#868e96",
        tu: String(t.tu || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20).join(", ").slice(0, 300) })).filter((t) => t.ten);
      const mau = (m.mau || []).slice(0, 100).map((x) => ({ tat: String(x.tat || "").trim().replace(/\s+/g, "-").slice(0, 20), chu: String(x.chu || "").trim().slice(0, 2000) }))
        .filter((x) => x.tat && x.chu);
      for (const cu of CH.the) if (!the.some((t) => t.id === cu.id)) hopThu.boThe(cu.id);   // thẻ bị xoá → gỡ khỏi các cuộc
      ghiCauHinh({ the, mau });
      return json(res, 200, { the, mau });
    }
    if (p === "/api/cham-soc" && req.method === "GET") {
      const tuan = Date.now() - 7 * 86400e3;
      const dem = db.prepare("SELECT buoc, sum(loi IS NULL) AS gui, sum(loi IS NOT NULL AND loi != 'quá hạn kênh') AS loi FROM cham_soc WHERE luc > ? GROUP BY buoc").all(tuan);
      return json(res, 200, { ...(CH.chamSoc || { bat: false, buoc: [] }), dem });
    }
    if (p === "/api/cham-soc" && req.method === "POST") {
      const m = JSON.parse((await docThan(req, 5e4)).toString() || "{}");
      const buoc = (m.buoc || []).slice(0, 10).map((b) => ({
        id: /^b\w{1,12}$/.test(b.id) ? b.id : "b" + crypto.randomBytes(3).toString("hex"),
        sauGio: Math.min(720, Math.max(1, Number(b.sauGio) || 0)), the: CH.the.some((t) => t.id === b.the) ? b.the : "",
        chu: String(b.chu || "").trim().slice(0, 2000) })).filter((b) => b.chu);
      ghiCauHinh({ chamSoc: { bat: !!m.bat, buoc } });
      quetChamSoc().catch((e) => bao("cham-soc", e.message));
      return json(res, 200, CH.chamSoc);
    }
    // Khách hàng (chủ shop): lọc theo chữ / thẻ / có SĐT; ?csv=1 tải về để remarketing (Zalo ZNS, SMS, quảng cáo theo SĐT/email).
    if (p === "/api/khach-hang") {
      const ds = locKhachHang(url.searchParams.get("tim"), url.searchParams.get("the"), url.searchParams.get("sdt") === "1");
      if (url.searchParams.get("csv") !== "1") return json(res, 200, { tong: ds.length, ds: ds.slice(0, 500) });
      const o = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const tenThe = (id) => CH.the.find((t) => t.id === id)?.ten;
      const CHINH = ["Tên", "SĐT", "Email", "Địa chỉ"];
      const dong = ds.map((k) => [k.ten, k.nho["SĐT"], k.nho["Email"], k.nho["Địa chỉ"],
        Object.entries(k.nho).filter(([x]) => !CHINH.includes(x)).map(([x, v]) => `${x}: ${v}`).join("; "),
        k.kenh, k.ma, k.the.map(tenThe).filter(Boolean).join("; "), (CH.nhanVien || []).find((x) => x.id === k.giao)?.ten || "",
        new Date(k.luc).toLocaleString("vi-VN")].map(o).join(","));
      const csv = "\ufeff" + ["Tên,SĐT,Email,Địa chỉ,Thông tin khác,Kênh,Mã trên kênh,Thẻ,Phụ trách,Nhắn lần cuối", ...dong].join("\r\n");
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="khach-hang-${new Date().toISOString().slice(0, 10)}.csv"` });
      return res.end(csv);
    }
    // Gửi loạt: một tin cho mọi khách đang lọc (thẻ / chữ / có SĐT). Chạy nền, giãn cách, xem tiến độ bằng GET.
    if (p === "/api/gui-loat" && req.method === "GET") return json(res, 200, { ...GUI_LOAT, chiTiet: GUI_LOAT.chiTiet.slice(-30) });
    if (p === "/api/gui-loat/dung" && req.method === "POST") { GUI_LOAT.dung = true; return json(res, 200, {}); }
    if (p === "/api/gui-loat" && req.method === "POST") {
      const m = JSON.parse((await docThan(req, 2e4)).toString() || "{}");
      const chu = String(m.chu || "").trim().slice(0, 2000);
      const { gui, bo } = chiaGuiLoat(locKhachHang(m.tim, m.the, !!m.sdt));
      const tomTat = { gui: gui.length, bo: Object.entries(bo).map(([lyDo, n]) => ({ lyDo, n })), mau: gui.slice(0, 5).map((k) => ({ ten: k.ten, kenh: k.kenh, chu: thayTen(chu, k.ten) })) };
      if (m.thu) return json(res, 200, tomTat);
      if (!chu) return json(res, 400, { loi: "Chưa có nội dung tin." });
      if (!gui.length) return json(res, 400, { loi: "Không có khách nào gửi được trong bộ lọc này." });
      if (GUI_LOAT.chay) return json(res, 409, { loi: "Đang có một lượt gửi loạt chạy dở. Chờ xong hoặc bấm Dừng." });
      chayGuiLoat(gui, chu, Math.min(60, Math.max(3, Number(m.cach) || 5)));
      return json(res, 200, tomTat);
    }
    if (p === "/api/thong-ke") return json(res, 200, hopThu.thongKe(Math.min(90, Math.max(1, Number(url.searchParams.get("ngay")) || 7))));
    if (p === "/api/nhat-ky") {
      const t = fs.existsSync(FILE_NK) ? fs.readFileSync(FILE_NK, "utf8").trim().split("\n").slice(-100).reverse() : [];
      return json(res, 200, t.filter(Boolean).map((d) => JSON.parse(d)));
    }
    json(res, 404, { loi: "Không có đường dẫn này." });
  } catch (e) {
    json(res, 500, { loi: String(e?.message || e) });
  }
});

// ---------------- Đường HTTPS cho webhook (Fanpage, Zalo OA) ----------------
// Facebook/Zalo chỉ gửi webhook tới địa chỉ HTTPS công khai. Có tên miền riêng thì dùng nó;
// không thì tự mở đường hầm Cloudflare miễn phí nếu máy có cloudflared (bộ cài tải sẵn).
// Không có cả hai thì Telegram và Zalo cá nhân vẫn chạy — hai kênh đó không cần webhook.
const duongHam = { goc: CH.tenMien ? "https://" + CH.tenMien : "" };
function moDuongHam() {
  if (CH.tenMien || duongHam.p || process.env.KHONG_DUONG_HAM === "1") return;
  const cfg = path.join(DATA, "cloudflared.yml");
  fs.writeFileSync(cfg, "no-autoupdate: true\n");   // tách khỏi ~/.cloudflared/config.yml của tunnel khác
  const cf = process.env.CLOUDFLARED || [path.join(GOC, "..", "bin", "cloudflared"), path.join(GOC, "bin", "cloudflared")].find((f) => fs.existsSync(f)) || "cloudflared";
  const p = spawn(cf,
    ["tunnel", "--config", cfg, "--protocol", "http2", "--url", `http://127.0.0.1:${CONG}`],
    { stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.on("data", (b) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(b.toString());
    if (m && m[0] !== duongHam.goc && duongHam.p === p) { duongHam.goc = m[0]; duongHam.loi = ""; console.log("Địa chỉ webhook HTTPS: " + m[0]); }
  });
  const xong = () => {
    if (duongHam.p !== p) return;   // đã tắt có chủ ý (chuyển sang tên miền)
    duongHam.p = null; duongHam.goc = "";
    setTimeout(moDuongHam, 15000);
  };
  p.on("error", (e) => { duongHam.loi = e.code === "ENOENT" ? "Máy chưa có cloudflared — chạy lại bộ cài, hoặc dùng tên miền riêng" : e.message; xong(); });   // chưa cài cloudflared
  p.on("exit", xong);
  duongHam.p = p;
}
function tatDuongHam() {
  const p = duongHam.p;
  duongHam.p = null;
  p?.kill();
}
process.on("exit", () => duongHam.p?.kill());
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(0));
moDuongHam();

// ---------------- Tên miền riêng (ô "Dùng tên miền riêng" trên trang quản trị) ----------------
const MA_TEN_MIEN = crypto.randomBytes(16).toString("hex");
const viecTenMien = { dangChay: false, ten: "", ok: null, bao: "", nhatKy: "" };
const DAT_TEN_MIEN = path.join(GOC, "dat-ten-mien.sh");
// Tự cài HTTPS (Caddy / nginx + certbot) chỉ khi là VPS Linux chạy bằng root, như bộ cài VPS.
const tuDatDuoc = () => process.platform === "linux" && process.getuid?.() === 0 && fs.existsSync(DAT_TEN_MIEN);

function chuanTenMien(s) {
  const t = String(s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
  if (!t) return "";
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(t) && t.length <= 253 ? t : null;
}
async function toiDuoc(ten) {
  try {
    const r = await fetch(`https://${ten}/.well-known/kenh-chat`, { signal: AbortSignal.timeout(8000), redirect: "manual" });
    return r.ok && (await r.text()).trim() === MA_TEN_MIEN;
  } catch { return false; }
}
function chayLenh(lenh, thamSo, hanMs) {
  return new Promise((ok) => {
    execFile(lenh, thamSo, { timeout: hanMs, maxBuffer: 1e6, env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } },
      (loi, ra, rl) => ok({ ma: loi ? (loi.code ?? 1) : 0, ra: String(ra) + String(rl) }));
  });
}
async function ipMay() {
  try { return (await (await fetch("https://ifconfig.me/ip", { signal: AbortSignal.timeout(6000) })).text()).trim(); } catch { return ""; }
}
function huongDanTay(ten) {
  return `Thêm vào web server đang chạy trên máy này một site cho ${ten}, chuyển tiếp về http://127.0.0.1:${CONG}\n` +
    `và gửi kèm header X-Real-IP. Ví dụ nginx:\n` +
    `  server {\n    server_name ${ten};\n    location / {\n      proxy_pass http://127.0.0.1:${CONG};\n` +
    `      proxy_set_header Host $host;\n      proxy_set_header X-Real-IP $remote_addr;\n    }\n  }\n` +
    `Bật HTTPS cho site đó (certbot --nginx -d ${ten}) rồi bấm "Kiểm tra & dùng" lại.\n` +
    `Máy tính ở nhà/văn phòng (không có IP công khai): dùng Cloudflare Tunnel có tên của bạn trỏ ${ten} → http://localhost:${CONG}.`;
}
function apDungTenMien(ten) {
  ghiCauHinh({ tenMien: ten });
  if (ten) { duongHam.goc = "https://" + ten; tatDuongHam(); }
  else { duongHam.goc = ""; moDuongHam(); }
  // Có/bỏ tên miền thì đổi chỗ nghe (127.0.0.1 ↔ 0.0.0.0): dưới systemd thoát để nó chạy lại
  // với chỗ nghe mới. Trả lời trang quản trị xong mới thoát.
  if (!process.env.HOST && hostCan() !== HOST && process.env.INVOCATION_ID) setTimeout(() => process.exit(0), 3000);
}

async function datTenMien(ten) {
  Object.assign(viecTenMien, { dangChay: true, ten, ok: null, bao: "", nhatKy: "" });
  const ghi = (s) => { viecTenMien.nhatKy += s.endsWith("\n") ? s : s + "\n"; };
  const xong = (ok, bao) => { Object.assign(viecTenMien, { dangChay: false, ok, bao }); if (!ok) console.error("[ten-mien] " + bao.split("\n")[0]); };
  try {
    if (!ten) {
      apDungTenMien("");
      return xong(true, "Đã bỏ tên miền — quay lại đường hầm Cloudflare, địa chỉ webhook mới hiện sau vài giây.");
    }
    ghi(`• Kiểm https://${ten}…`);
    let toi = await toiDuoc(ten);
    if (!toi && tuDatDuoc()) {
      const [ip, dsIp] = await Promise.all([ipMay(), dns.resolve4(ten).catch(() => [])]);
      if (!dsIp.length || (ip && !dsIp.includes(ip))) {
        return xong(false, `${ten} đang trỏ về: ${dsIp.join(", ") || "(chưa có bản ghi)"}${ip ? ` — máy này là ${ip}` : ""}.\n` +
          `Vào nơi quản lý tên miền, thêm bản ghi A: ${ten.split(".")[0]} → ${ip || "IP của VPS"} (dùng Cloudflare thì tắt đám mây cam),\n` +
          `chờ vài phút rồi bấm "Kiểm tra & dùng" lại.`);
      }
      ghi("• Tên miền trỏ đúng máy này. Đặt HTTPS (Caddy hoặc nginx + certbot)…");
      const r = await chayLenh("bash", [DAT_TEN_MIEN, ten, String(CONG)], 4 * 60e3);
      ghi(r.ra);
      const proxy = /PROXY=(\w+)\s*$/.exec(r.ra)?.[1] || "tay";
      if (r.ma !== 0 || proxy === "tay") {
        return xong(false, `Chưa tự đặt được HTTPS cho ${ten} (xem nhật ký bên dưới).\n\n` + huongDanTay(ten));
      }
      ghi("• Chờ chứng chỉ HTTPS…");
      for (let i = 0; i < 20 && !(toi = await toiDuoc(ten)); i++) await new Promise((ok) => setTimeout(ok, 3000));
      if (!toi) {
        return xong(false, `Đã đặt ${proxy} cho ${ten} nhưng https://${ten} chưa trả lời. Kiểm tường lửa của nhà cung cấp VPS\n` +
          `đã mở cổng 80 và 443 chưa, rồi bấm "Kiểm tra & dùng" lại (xem log: journalctl -u ${proxy} -n 50).`);
      }
    }
    if (!toi) return xong(false, `https://${ten}/.well-known/kenh-chat chưa tới được bot này.\n\n` + huongDanTay(ten));
    apDungTenMien(ten);
    xong(true, `Đã dùng https://${ten}. Dán lại địa chỉ webhook mới vào Zalo OA / Facebook (xác thực domain lại với tên miền này).`);
  } catch (e) {
    xong(false, String(e?.message || e));
  }
}

server.listen(CONG, HOST, () => {
  console.log(`Kênh Chat chạy ở cổng ${CONG}`);
  if (!process.env.MAT_KHAU) console.log(`Mật khẩu trang quản trị nằm trong ${FILE_CH} (trường matKhau).`);
});

// Mã Apps Script khách dán vào Sheet riêng tư (Tiện ích mở rộng → Apps Script), chạy hàm caiDat một lần.
function scriptSheet(dich, ma, loai) {
  return `const DICH = ${JSON.stringify(dich)}, MA = ${JSON.stringify(ma)}, LOAI = ${JSON.stringify(loai)};
const TAB = ""; // để trống = tab đầu tiên; muốn tab khác thì ghi đúng tên tab

function guiRevid() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = TAB ? ss.getSheetByName(TAB) : ss.getSheets()[0];
  const csv = sh.getDataRange().getDisplayValues().map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\\n");
  const r = UrlFetchApp.fetch(DICH, { method: "post", contentType: "application/json", muteHttpExceptions: true,
    payload: JSON.stringify({ ma: MA, loai: LOAI, khoa: ss.getId() + "#" + sh.getSheetId(), csv }) });
  console.log(r.getResponseCode() + " " + r.getContentText());
}

function caiDat() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("guiRevid").forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger("guiRevid").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("guiRevid").timeBased().everyMinutes(5).create();
  guiRevid();
}
`;
}
