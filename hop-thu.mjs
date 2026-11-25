// Hộp thư chung: mọi cuộc chat của Zalo, Zalo OA, Fanpage, Telegram ở một chỗ (SQLite).
//
// "Tiếp quản": nhân viên trả lời tay thì bot im cho cuộc đó trong TIEP_QUAN_PHUT phút
// (mặc định 120), tự trả lại cho bot khi hết hạn. Nhân viên trả lời ngay trên điện
// thoại (Zalo, Messenger) cũng được nhận ra và tính là tiếp quản.

export const TIEP_QUAN_PHUT = 120;
const GIU_NGAY = 90;

const docThe = (s) => { try { return JSON.parse(s || "[]"); } catch { return []; } };

export class HopThu {
  constructor(db) {
    this.db = db;
    this.don();
    setInterval(() => this.don(), 24 * 3600e3).unref();
  }

  don() {
    const moc = Date.now() - GIU_NGAY * 86400e3;
    this.db.prepare("DELETE FROM tin WHERE luc < ?").run(moc);
    // Cuộc đã gắn thẻ giữ lại (không còn tin) để danh sách khách cho remarketing không mất nhóm.
    this.db.prepare("DELETE FROM cuoc WHERE luc < ? AND the = '[]'").run(moc);
  }

  /** vai: khach | bot | nhan_vien | loi (ghi chú cho chủ: tin không gửi tới khách được). Trả khoá cuộc. */
  ghi(kenh, ma, { vai, chu, ten, loai, token, nguon }) {
    const khoa = `${kenh}:${ma}`;
    const bay = Date.now();
    if (vai === "nhan_vien" && String(chu).trim().length >= 15) {
      // Nhân viên trả lời tay câu khách vừa hỏi (≤ 30 phút) → cặp hỏi–đáp chờ chủ duyệt cho bot học.
      // Thường bot đã trả lời trước (sai/thiếu) rồi nhân viên mới vào → lấy tin khách gần nhất trong 4 tin cuối.
      const hoi = this.db.prepare("SELECT vai, chu, luc FROM tin WHERE khoa = ? ORDER BY id DESC LIMIT 4").all(khoa).find((x) => x.vai === "khach");
      if (hoi && bay - hoi.luc < 30 * 60e3) this.ghiHoc(hoi.chu.replace(/^[^:\n]{1,40}: /, ""), chu, "cho", khoa);
    }
    this.db.prepare(`INSERT INTO cuoc (khoa, kenh, ma, ten, loai, chua_doc, tin_cuoi, luc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(khoa) DO UPDATE SET ten = coalesce(excluded.ten, ten), loai = coalesce(excluded.loai, loai),
        chua_doc = CASE WHEN ? = 'khach' THEN chua_doc + 1 ELSE chua_doc END,
        xong = CASE WHEN ? = 'khach' THEN 0 ELSE xong END,
        tin_cuoi = excluded.tin_cuoi, luc = excluded.luc`)
      .run(khoa, kenh, String(ma), ten ?? null, loai ?? null, vai === "khach" ? 1 : 0, String(chu).slice(0, 120), bay, vai, vai);
    // Tự gắn thẻ: tin khách chứa từ khoá của thẻ nào thì thêm thẻ đó (không bao giờ tự gỡ).
    if (vai === "khach" && kenh !== "thu" && this.theTuDong) {
      const them = this.theTuDong(String(chu));
      if (them.length) {
        const cu = docThe(this.cuoc(khoa)?.the);
        if (them.some((id) => !cu.includes(id))) this.datThe(khoa, [...new Set([...cu, ...them])]);
      }
    }
    // Chia tự động: khách nhắn vào cuộc chưa ai phụ trách → giao cho nhân viên đang ít cuộc nhất.
    if (vai === "khach" && kenh !== "thu" && this.chonNguoi && !this.cuoc(khoa)?.giao) {
      const id = this.chonNguoi(this.taiNhanVien());
      if (id) this.giao(khoa, id);
    }
    this.db.prepare("INSERT INTO tin (khoa, vai, chu, luc, token, nguon) VALUES (?, ?, ?, ?, ?, ?)")
      .run(khoa, vai, String(chu), bay, token ?? null, nguon ?? null);
    return khoa;
  }

  /** n tin gần nhất (cũ → mới) để làm ngữ cảnh cho AI. */
  ganNhat(khoa, n) {
    return this.db.prepare("SELECT vai, chu FROM tin WHERE khoa = ? AND vai NOT IN ('loi', 'ghi_chu') ORDER BY id DESC LIMIT ?").all(khoa, n).reverse();
  }

  cuoc(khoa) { return this.db.prepare("SELECT * FROM cuoc WHERE khoa = ?").get(khoa); }

  // `nv` = id nhân viên đang xem: chỉ thấy cuộc của mình và cuộc chưa giao ai. Chủ truyền null.
  danhSach(tim = "", gioiHan = 100, nv = null) {
    const q = `%${tim}%`;
    return this.db.prepare(`SELECT khoa, kenh, ma, ten, loai, chua_doc, tin_cuoi, luc, tiep_quan_den, giao, the, xong,
          (SELECT vai FROM tin WHERE tin.khoa = cuoc.khoa AND vai NOT IN ('loi', 'ghi_chu') ORDER BY id DESC LIMIT 1) AS vai_cuoi
        FROM cuoc WHERE kenh != 'thu' AND (? = '' OR ten LIKE ? OR tin_cuoi LIKE ? OR ma LIKE ?)
          AND (? IS NULL OR giao IS NULL OR giao = ?) ORDER BY luc DESC LIMIT ?`)
      .all(tim, q, q, q, nv, nv, gioiHan)
      .map((c) => ({ ...c, the: docThe(c.the), tiepQuan: c.tiep_quan_den > Date.now() }));
  }

  tin(khoa, gioiHan = 200) {
    this.db.prepare("UPDATE cuoc SET chua_doc = 0 WHERE khoa = ?").run(khoa);
    return this.db.prepare("SELECT id, vai, chu, luc, token, nguon FROM tin WHERE khoa = ? ORDER BY id DESC LIMIT ?")
      .all(khoa, gioiHan).reverse();
  }

  dangTiepQuan(khoa) {
    const c = this.db.prepare("SELECT tiep_quan_den FROM cuoc WHERE khoa = ?").get(khoa);
    return !!c && c.tiep_quan_den > Date.now();
  }

  tiepQuan(khoa, phut = TIEP_QUAN_PHUT) {
    this.db.prepare("UPDATE cuoc SET tiep_quan_den = ? WHERE khoa = ?").run(Date.now() + phut * 60e3, khoa);
  }

  // `nguoi` = "kênh:mã người". Chat 1-1 thì trùng khoá cuộc. Bản cũ lưu ở cuoc.ghi_nho → đọc dự phòng.
  docNho(nguoi) {
    try {
      const r = this.db.prepare("SELECT ghi_nho FROM nho_khach WHERE nguoi = ?").get(nguoi)
        ?? this.db.prepare("SELECT ghi_nho FROM cuoc WHERE khoa = ?").get(nguoi);
      return JSON.parse(r?.ghi_nho || "{}");
    } catch { return {}; }
  }
  ghiNho(nguoi, them) {
    const moi = { ...this.docNho(nguoi) };
    for (const [k, v] of Object.entries(them || {})) {
      const s = String(v ?? "").trim().slice(0, 300);
      if (s) moi[String(k).slice(0, 40)] = s; else delete moi[k];
    }
    this.db.prepare(`INSERT INTO nho_khach (nguoi, ghi_nho, luc) VALUES (?, ?, ?)
      ON CONFLICT(nguoi) DO UPDATE SET ghi_nho = excluded.ghi_nho, luc = excluded.luc`).run(nguoi, JSON.stringify(moi), Date.now());
    return moi;
  }

  // ---- Bot tự học: trang = 'cho' (chờ chủ duyệt) | 'duyet' (đưa vào tài liệu) | 'thieu' (tài liệu chưa có)
  ghiHoc(hoi, tra, trang, khoa) {
    hoi = String(hoi || "").trim().slice(0, 600); tra = String(tra || "").trim().slice(0, 2000);
    if (hoi.length < 4) return;
    const cu = this.db.prepare("SELECT id FROM hoc WHERE hoi = ? AND trang = ?").get(hoi, trang);
    if (cu) this.db.prepare("UPDATE hoc SET tra = ?, luc = ?, khoa = ? WHERE id = ?").run(tra, Date.now(), khoa ?? null, cu.id);
    else this.db.prepare("INSERT INTO hoc (hoi, tra, trang, khoa, luc) VALUES (?, ?, ?, ?, ?)").run(hoi, tra, trang, khoa ?? null, Date.now());
  }
  dsHoc(trang) { return this.db.prepare("SELECT id, hoi, tra, trang, khoa, luc FROM hoc WHERE trang = ? ORDER BY luc DESC LIMIT 300").all(trang); }
  suaHoc(id, { hoi, tra, trang }) {
    if (trang === "xoa") return this.db.prepare("DELETE FROM hoc WHERE id = ?").run(id);
    this.db.prepare("UPDATE hoc SET hoi = coalesce(?, hoi), tra = coalesce(?, tra), trang = coalesce(?, trang), luc = ? WHERE id = ?")
      .run(hoi ?? null, tra ?? null, trang ?? null, Date.now(), id);
  }

  // Ghi chú nội bộ: chỉ người trong shop thấy, không gửi khách, không vào ngữ cảnh AI, không đổi tin cuối.
  ghiChu(khoa, chu, nguon) {
    this.db.prepare("INSERT INTO tin (khoa, vai, chu, luc, nguon) VALUES (?, 'ghi_chu', ?, ?, ?)").run(khoa, String(chu).slice(0, 2000), Date.now(), nguon ?? null);
  }
  datThe(khoa, the) { this.db.prepare("UPDATE cuoc SET the = ? WHERE khoa = ?").run(JSON.stringify(the), khoa); }
  // Danh sách khách (trang Khách hàng, xuất CSV): mỗi người một dòng — người có ghi nhớ (kể cả thành viên
  // nhóm Zalo) + cuộc 1-1 chưa có ghi nhớ. Không tính cuộc nhóm, không tính khung Thử bot.
  khachHang() {
    return this.db.prepare(`
      SELECT n.nguoi AS khoa, n.ghi_nho, max(n.luc, coalesce(c.luc, 0)) AS luc, c.ten, c.the, c.giao, c.loai FROM nho_khach n LEFT JOIN cuoc c ON c.khoa = n.nguoi
        WHERE n.nguoi NOT LIKE 'thu:%'
      UNION ALL
      SELECT c.khoa, '{}', c.luc, c.ten, c.the, c.giao, c.loai FROM cuoc c
        WHERE c.kenh != 'thu' AND coalesce(c.loai, '') != 'nhom' AND c.khoa NOT IN (SELECT nguoi FROM nho_khach)
      ORDER BY luc DESC`).all().map((r) => {
      let nho = {}; try { nho = JSON.parse(r.ghi_nho || "{}"); } catch {}
      const i = r.khoa.indexOf(":");
      return { khoa: r.khoa, kenh: r.khoa.slice(0, i), ma: r.khoa.slice(i + 1), ten: nho["Tên"] || r.ten || "", nho,
        the: docThe(r.the), giao: r.giao, luc: r.luc, coChat: r.loai != null };
    });
  }
  datXong(khoa, xong) { this.db.prepare("UPDATE cuoc SET xong = ? WHERE khoa = ?").run(xong ? 1 : 0, khoa); }
  boThe(id) {
    for (const c of this.db.prepare("SELECT khoa, the FROM cuoc WHERE the LIKE ?").all(`%"${id}"%`))
      this.datThe(c.khoa, docThe(c.the).filter((x) => x !== id));
  }

  // Thống kê `ngay` ngày qua: theo người gửi tay (nguon) — số tin, số cuộc, thời gian trả lời trung bình
  // (từ tin khách đầu tiên chưa ai trả lời tới tin nhân viên kế tiếp); theo thẻ — số cuộc.
  thongKe(ngay = 7) {
    const moc = Date.now() - ngay * 86400e3, nguoi = {}, cho = {};
    for (const t of this.db.prepare("SELECT khoa, vai, luc, nguon FROM tin WHERE luc > ? AND vai IN ('khach', 'nhan_vien') AND khoa NOT LIKE 'thu:%' ORDER BY id").all(moc)) {
      if (t.vai === "khach") { cho[t.khoa] ??= t.luc; continue; }
      const n = (nguoi[t.nguon || "Chủ shop"] ??= { tin: 0, cuoc: new Set(), tong: 0, lan: 0 });
      n.tin++; n.cuoc.add(t.khoa);
      if (cho[t.khoa]) { n.tong += t.luc - cho[t.khoa]; n.lan++; delete cho[t.khoa]; }
    }
    const the = {};
    for (const c of this.db.prepare("SELECT the FROM cuoc WHERE luc > ? AND kenh != 'thu'").all(moc)) for (const id of docThe(c.the)) the[id] = (the[id] || 0) + 1;
    const theoNv = Object.fromEntries(this.db.prepare("SELECT giao, count(*) AS n, sum(xong) AS xong FROM cuoc WHERE luc > ? AND giao IS NOT NULL GROUP BY giao").all(moc).map((r) => [r.giao, { cuoc: r.n, xong: r.xong }]));
    return {
      nguoi: Object.entries(nguoi).map(([ten, n]) => ({ ten, tin: n.tin, cuoc: n.cuoc.size, traLoiTb: n.lan ? Math.round(n.tong / n.lan / 1000) : null })),
      the, theoNv, chuaTraLoi: Object.keys(cho).length,
    };
  }

  giao(khoa, nv) { this.db.prepare("UPDATE cuoc SET giao = ? WHERE khoa = ?").run(nv || null, khoa); }

  // Số cuộc mỗi nhân viên phụ trách có tin trong 24 giờ qua — để chia đều.
  taiNhanVien() {
    return Object.fromEntries(this.db.prepare("SELECT giao, count(*) AS n FROM cuoc WHERE giao IS NOT NULL AND luc > ? GROUP BY giao")
      .all(Date.now() - 86400e3).map((r) => [r.giao, r.n]));
  }

  traBot(khoa) { this.db.prepare("UPDATE cuoc SET tiep_quan_den = 0 WHERE khoa = ?").run(khoa); }

  tongChuaDoc(nv = null) {
    return this.db.prepare("SELECT coalesce(sum(chua_doc), 0) AS n FROM cuoc WHERE kenh != 'thu' AND (? IS NULL OR giao IS NULL OR giao = ?)").get(nv, nv).n;
  }
}
