// RevidAPI Kênh Chat — chatbot cho Zalo cá nhân, Zalo OA, Fanpage, Telegram.
// Chạy trên VPS của khách: node server.mjs. Trang quản trị ở cổng CONG (mặc định 8790).
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KhoTaiLieu, moKho } from "./kho-tai-lieu.mjs";
import { HopThu } from "./hop-thu.mjs";
import { BoNao } from "./tra-loi.mjs";
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
  const r = await fetch("https://revidapi.com/tai-app/kenh-chat.tgz", { signal: AbortSignal.timeout(120000) });
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
  model: "deepseek-v4-flash",
  modelDuPhong: "kimi-k3",   // nguồn chính trễ quá hanGiay thì thử model này
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
if (process.env.MAT_KHAU) CH.matKhau = process.env.MAT_KHAU;
if (!CH.matKhau) CH.matKhau = crypto.randomBytes(9).toString("base64url");
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
const zalo = new ZaloCaNhan({ fileDangNhap: path.join(DATA, "zalo-phien.json"), boNao, hopThu, layCauHinh, bao });
const zaloOA = new ZaloOA({ boNao, hopThu, layCauHinh, ghiCauHinh, bao });
const guiGanDay = new Map();   // "khoa\nchu" → lúc gửi tay, chặn gửi trùng
const fanpage = new Fanpage({ boNao, hopThu, layCauHinh, bao });
const telegram = new Telegram({ boNao, hopThu, layCauHinh, bao });
const web = new Web({ boNao, hopThu, bao });
const KENH = { zalo, "zalo-oa": zaloOA, fb: fanpage, telegram, web };
boNao.guiQua = (kenh, ma, chu, loai) => {
  if (!KENH[kenh]) return Promise.reject(new Error("kênh " + kenh + " không gửi được"));
  return KENH[kenh].gui(ma, chu, loai);
};
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
zalo.moLai();
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

// ---------------- HTTP ----------------
const PHIEN = new Map();   // mã phiên -> { vai: "chu" | "nv", id }
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
  const m = /(?:^|;\s*)phien=([a-zA-Z0-9_-]+)/.exec(req.headers.cookie || "");
  const ph = m && PHIEN.get(m[1]);
  if (!ph) return null;
  if (ph.vai === "chu") return ph;
  const nv = (CH.nhanVien || []).find((x) => x.id === ph.id);
  if (!nv) { PHIEN.delete(m[1]); return null; }
  return { vai: "nv", id: nv.id, ten: nv.ten };
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
function che(s) { return s ? "••••" + String(s).slice(-4) : ""; }
function cauHinhCongKhai() {
  return {
    ...CH, matKhau: undefined, khoa: che(CH.khoa), nhanVien: (CH.nhanVien || []).map(({ id, ten }) => ({ id, ten })),
    zaloOA: { ...CH.zaloOA, secretKey: che(CH.zaloOA?.secretKey), oaSecretKey: che(CH.zaloOA?.oaSecretKey), accessToken: che(CH.zaloOA?.accessToken), refreshToken: che(CH.zaloOA?.refreshToken) },
    facebook: { ...CH.facebook, appSecret: che(CH.facebook?.appSecret), trang: (CH.facebook?.trang || []).map((t) => ({ ...t, token: che(t.token) })) },
    telegram: { ...CH.telegram, token: che(CH.telegram?.token) },
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
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const meta = metaXacThucZalo();
      const trang = fs.readFileSync(path.join(GOC, "quan-tri.html"), "utf8");
      return res.end(meta ? trang.replace(/<head>/i, "<head>" + meta) : trang);
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
      return res.end("{}");
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
    if (nvId && !(p === "/api/trang-thai" || p.startsWith("/api/hop-thu"))) return json(res, 403, { loi: "Tài khoản nhân viên chỉ dùng Hộp thư." });
    if (nvId && p === "/api/trang-thai") {
      return json(res, 200, { toi, chuaDoc: hopThu.tongChuaDoc(nvId), nhanVien: (CH.nhanVien || []).map(({ id, ten }) => ({ id, ten })), the: CH.the, mau: CH.mau,
        kenh: { zalo: zalo.trangThai, zaloOA: zaloOA.trangThai, facebook: fanpage.trangThai, telegram: telegram.trangThai } });
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
    if (p === "/api/trang-thai") {
      xemBanMoi();
      return json(res, 200, {
        cauHinh: cauHinhCongKhai(),
        kenh: { zalo: zalo.trangThai, zaloOA: zaloOA.trangThai, facebook: fanpage.trangThai, telegram: telegram.trangThai },
        loiOA: zaloOA.loi || "", loiGoi: boNao.loiGoi || "",
        qr: zalo.qr, taiLieu: kho.danhSach(), chuaDoc: hopThu.tongChuaDoc(),
        webhook: { goc: duongHam.goc, facebook: "/webhook/facebook", zaloOA: "/webhook/zalo-oa" },
        tenMien: { dangChay: viecTenMien.dangChay, ten: CH.tenMien || "", tuDat: tuDatDuoc(), cong: CONG },
        ban: BAN, banMoi: capNhat.moi, loiCapNhat: capNhat.loi,
        toi, diaChiNhanVien: diaChiNhanVien(),
      });
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
    if (p === "/api/cau-hinh" && req.method === "POST") {
      const m = JSON.parse((await docThan(req, 2e5)).toString() || "{}");
      const oaCu = { ...CH.zaloOA };
      ghiCauHinh({
        bat: !!m.bat, model: String(m.model || CH.model), modelDuPhong: String(m.modelDuPhong ?? CH.modelDuPhong ?? ""), hanGiay: Math.min(90, Math.max(8, Number(m.hanGiay) || 12)), toiDaRa: Math.min(2000, Math.max(300, Number(m.toiDaRa) || 800)),
        vaiTro: String(m.vaiTro || "").slice(0, 3000), gio: String(m.gio || ""), ngoaiGio: String(m.ngoaiGio || "").slice(0, 500),
        khiLoi: String(m.khiLoi || "").slice(0, 500), khoa: giu(m.khoa, CH.khoa) || CH.khoa,
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
        facebook: { maXacMinh: CH.facebook.maXacMinh, appSecret: giu(m.facebook?.appSecret, CH.facebook.appSecret) || "",
                    trang: (m.facebook?.trang || []).map((t) => ({ id: String(t.id || "").trim(), ten: String(t.ten || ""),
                      token: giu(t.token, (CH.facebook.trang.find((c) => c.id === t.id) || {}).token) || "" })).filter((t) => t.id) },
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
    if (p === "/api/zalo/qr" && req.method === "POST") { await zalo.quetQR(); return json(res, 200, {}); }
    if (p === "/api/zalo/ngat" && req.method === "POST") { zalo.ngat(); return json(res, 200, {}); }
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
      const ra = await boNao.traLoi("thu", ma, chu, { tenCuoc: "Thử bot" });
      const cuoi = hopThu.db.prepare("SELECT vai, nguon FROM tin WHERE khoa = ? ORDER BY id DESC LIMIT 1").get("thu:" + ma);
      hopThu.db.prepare("DELETE FROM tin WHERE khoa = ?").run("thu:" + ma);
      hopThu.db.prepare("DELETE FROM cuoc WHERE khoa = ?").run("thu:" + ma);
      return json(res, 200, { ra, doan: cuoi?.vai === "bot" ? String(cuoi.nguon || "").split(", ").filter(Boolean) : [] });
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
        ghiCauHinh({ nhanVien: [...ds, { id, ten, mk: bamMk(mk) }] });
        return json(res, 200, { id, ten, matKhau: mk });
      }
      const i = ds.findIndex((x) => x.id === m.id);
      if (m.viec === "chia") { ghiCauHinh({ chiaTuDong: !!m.bat }); return json(res, 200, {}); }
      if (m.viec === "bot-im") { ghiCauHinh({ botImKhiGiao: !!m.bat }); return json(res, 200, {}); }
      if (i < 0) return json(res, 404, { loi: "Không có nhân viên này." });
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
    // Khách hàng (chủ shop): lọc theo chữ / thẻ / có SĐT; ?csv=1 tải về để remarketing (Zalo ZNS, SMS, quảng cáo theo SĐT/email).
    if (p === "/api/khach-hang") {
      const tim = boDau(url.searchParams.get("tim") || "").trim(), loc = String(url.searchParams.get("the") || ""), coSdt = url.searchParams.get("sdt") === "1";
      const ds = hopThu.khachHang().filter((k) => (!loc || k.the.includes(loc)) && (!coSdt || k.nho["SĐT"])
        && (!tim || boDau([k.ten, k.ma, ...Object.values(k.nho)].join(" ")).includes(tim)));
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
  const p = spawn(process.env.CLOUDFLARED || "cloudflared",
    ["tunnel", "--config", cfg, "--protocol", "http2", "--url", `http://127.0.0.1:${CONG}`],
    { stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.on("data", (b) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(b.toString());
    if (m && m[0] !== duongHam.goc && duongHam.p === p) { duongHam.goc = m[0]; console.log("Địa chỉ webhook HTTPS: " + m[0]); }
  });
  const xong = () => {
    if (duongHam.p !== p) return;   // đã tắt có chủ ý (chuyển sang tên miền)
    duongHam.p = null; duongHam.goc = "";
    setTimeout(moDuongHam, 15000);
  };
  p.on("error", xong);   // chưa cài cloudflared
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
