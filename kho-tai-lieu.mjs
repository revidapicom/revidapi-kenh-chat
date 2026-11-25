// Kho tài liệu (RAG) + hộp thư, chung một file SQLite `data/kho.db` (node:sqlite có sẵn
// trong Node ≥ 22 — không cần Postgres/Redis, không chạy server riêng).
//
// Tiết kiệm token: tài liệu cắt đoạn ~700 ký tự, tìm bằng FTS5/BM25 ngay trên máy (miễn
// phí). Mỗi câu hỏi chỉ gửi tối đa DOAN_TOI_DA đoạn khớp nhất, tổng ≤ CHU_TOI_DA ký tự —
// tài liệu 500 trang cũng chỉ tốn chừng ấy. Không khớp gì thì không gửi đoạn nào.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAI_DOAN = 700;
const CHONG_LAP = 120;
export const DOAN_TOI_DA = 3;
export const CHU_TOI_DA = 2400;

// Bỏ dấu để "giá" khớp "gia" — khách nhắn không dấu rất nhiều.
export function boDau(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

const TU_BO = new Set(("la cua va co cho voi nhung cac mot nay do thi ma de duoc khong "
  + "toi ban anh chi em minh oi a nhe nha the nao gi sao ko k vay ha shop ad admin").split(" "));

export function tachTu(s) {
  return boDau(String(s || "").toLowerCase()).split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !TU_BO.has(t));
}

function catDoan(chu) {
  const sach = chu.replace(/\r/g, "").replace(/[ \t]{3,}/g, "  ").replace(/\n{3,}/g, "\n\n").trim();
  const ra = [];
  for (let i = 0; i < sach.length; i += DAI_DOAN - CHONG_LAP) {
    let doan = sach.slice(i, i + DAI_DOAN);
    // Cắt ở cuối câu gần nhất để đoạn không đứt giữa chữ.
    const cuoi = Math.max(doan.lastIndexOf(". "), doan.lastIndexOf("\n"));
    if (i + DAI_DOAN < sach.length && cuoi > DAI_DOAN * 0.6) doan = doan.slice(0, cuoi + 1);
    if (doan.trim()) ra.push(doan.trim());
    if (i + DAI_DOAN >= sach.length) break;
  }
  return ra;
}

export function moKho(thuMucData) {
  fs.mkdirSync(thuMucData, { recursive: true });
  const db = new DatabaseSync(path.join(thuMucData, "kho.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tai_lieu (ten TEXT PRIMARY KEY, chu TEXT NOT NULL, luc INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS doan USING fts5(chu, ten UNINDEXED,
      tokenize = "unicode61 remove_diacritics 2");
    CREATE TABLE IF NOT EXISTS cuoc (
      khoa TEXT PRIMARY KEY, kenh TEXT NOT NULL, ma TEXT NOT NULL, ten TEXT, loai TEXT,
      tiep_quan_den INTEGER NOT NULL DEFAULT 0, chua_doc INTEGER NOT NULL DEFAULT 0,
      tin_cuoi TEXT, luc INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tin (
      id INTEGER PRIMARY KEY, khoa TEXT NOT NULL, vai TEXT NOT NULL, chu TEXT NOT NULL,
      luc INTEGER NOT NULL, token INTEGER, nguon TEXT);
    CREATE INDEX IF NOT EXISTS tin_khoa ON tin (khoa, id);
    CREATE INDEX IF NOT EXISTS cuoc_luc ON cuoc (luc);
  `);
  // Bộ nhớ riêng từng khách (theo mã cuộc chat): thêm cột cho kho tạo từ bản cũ.
  try { db.exec("ALTER TABLE cuoc ADD COLUMN ghi_nho TEXT NOT NULL DEFAULT '{}'"); } catch { /* đã có */ }
  // Nhân viên phụ trách cuộc (id trong cấu hình nhanVien); NULL = chưa giao ai.
  try { db.exec("ALTER TABLE cuoc ADD COLUMN giao TEXT"); } catch { /* đã có */ }
  // Thẻ khách (mảng id thẻ trong cấu hình `the`) và trạng thái "đã xong" (khách nhắn lại thì mở lại).
  try { db.exec("ALTER TABLE cuoc ADD COLUMN the TEXT NOT NULL DEFAULT '[]'"); } catch { /* đã có */ }
  try { db.exec("ALTER TABLE cuoc ADD COLUMN xong INTEGER NOT NULL DEFAULT 0"); } catch { /* đã có */ }
  // Bộ nhớ theo NGƯỜI (kênh:mã người gửi — psid Fanpage, uid Zalo, id Telegram), tách khỏi cuộc
  // chat: trong nhóm mỗi người một hồ sơ; không bị dọn theo hạn 90 ngày của tin nhắn.
  // Bảng `hoc`: hỏi–đáp bot học được (nhân viên trả lời tay, câu tài liệu chưa có).
  db.exec(`
    CREATE TABLE IF NOT EXISTS nho_khach (nguoi TEXT PRIMARY KEY, ghi_nho TEXT NOT NULL DEFAULT '{}', luc INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hoc (id INTEGER PRIMARY KEY, hoi TEXT NOT NULL, tra TEXT NOT NULL DEFAULT '',
      trang TEXT NOT NULL, khoa TEXT, luc INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS hoc_trang ON hoc (trang, luc);
  `);
  return db;
}

export class KhoTaiLieu {
  constructor(db, thuMucCu) {
    this.db = db;
    // Bản trước lưu tài liệu thành tệp .txt trong data/tai-lieu — chuyển một lần vào SQLite.
    if (thuMucCu && fs.existsSync(thuMucCu)) {
      for (const ten of fs.readdirSync(thuMucCu)) {
        if (!/\.(txt|md|csv)$/i.test(ten)) continue;
        if (!db.prepare("SELECT 1 FROM tai_lieu WHERE ten = ?").get(ten)) {
          this.luu(ten, fs.readFileSync(path.join(thuMucCu, ten), "utf8"));
        }
      }
    }
  }

  danhSach() {
    return this.db.prepare(`SELECT t.ten, length(t.chu) AS kyTu, t.luc,
        (SELECT count(*) FROM doan d WHERE d.ten = t.ten) AS doan FROM tai_lieu t ORDER BY t.luc DESC`).all()
      .map((x) => ({ ten: x.ten, doan: x.doan, kb: Math.ceil(x.kyTu / 1024), kyTu: x.kyTu }));
  }

  luu(ten, chu) {
    const an = path.basename(String(ten || "tai-lieu")).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 80);
    const day = /\.(txt|md|csv)$/i.test(an) ? an : an + ".txt";
    const doan = catDoan(String(chu || ""));
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM doan WHERE ten = ?").run(day);
      this.db.prepare("INSERT OR REPLACE INTO tai_lieu (ten, chu, luc) VALUES (?, ?, ?)").run(day, String(chu), Date.now());
      const them = this.db.prepare("INSERT INTO doan (chu, ten) VALUES (?, ?)");
      for (const d of doan) them.run(d, day);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return day;
  }

  xoa(ten) {
    this.db.prepare("DELETE FROM doan WHERE ten = ?").run(ten);
    this.db.prepare("DELETE FROM tai_lieu WHERE ten = ?").run(ten);
  }

  // BM25 của FTS5. `them` là các từ khoá bổ sung (đồng nghĩa) — cộng vào cùng truy vấn.
  tim(cauHoi, them = []) {
    const tu = [...new Set([...tachTu(cauHoi), ...them.flatMap(tachTu)])].slice(0, 40);
    if (!tu.length) return [];
    const q = tu.map((t) => `"${t}"`).join(" OR ");
    let hang;
    try {
      hang = this.db.prepare(`SELECT chu, ten, bm25(doan) AS s FROM doan WHERE doan MATCH ? ORDER BY s LIMIT ?`)
        .all(q, DOAN_TOI_DA * 3);
    } catch { return []; }
    // bm25() trả số ÂM, càng âm càng khớp — nhưng kho ít đoạn thì điểm gần 0 cho mọi
    // đoạn (IDF ≈ 0), nên KHÔNG dùng ngưỡng điểm. Lọc theo độ phủ: đoạn phải chứa ≥ 2 từ
    // của câu hỏi, hoặc 1 từ dài (≥ 5 ký tự, ít khi là từ đệm).
    const tot = hang.filter((h) => {
      const co = new Set(tachTu(h.chu));
      const khop = tu.filter((x) => co.has(x));
      return khop.length >= Math.min(2, tu.length) || khop.some((x) => x.length >= 5);
    }).slice(0, DOAN_TOI_DA);
    const ra = [];
    let con = CHU_TOI_DA;
    for (const h of tot) {
      if (con <= 100) break;
      ra.push({ nguon: h.ten, chu: h.chu.slice(0, con) });
      con -= h.chu.length;
    }
    return ra;
  }
}
