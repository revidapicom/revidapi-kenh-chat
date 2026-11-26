// Đăng bài đã duyệt ở trang "Lịch đăng bài" lên Fanpage / kênh Telegram / web WordPress đúng giờ hẹn.
// Bài nằm trong taiLieu (thư mục "Lịch đăng bài"), noiDung là JSON. Chỉ đăng bài tt="duyet" và luc đã tới.
import { thuTuModel, laKhongBan, ghiKhongBan } from "./model-ban.mjs";
const VH = "revidapi-vanhanh", THU_MUC = "Lịch đăng bài", FB = "https://graph.facebook.com/v21.0/";

const GIONG = { facebook: "Fanpage: 60-120 chữ, thân thiện, câu đầu gây chú ý, kết bằng câu hỏi, 3 hashtag.", instagram: "Instagram: 40-90 chữ, xuống dòng thoáng, 5-8 hashtag cuối bài.",
  threads: "Threads: dưới 450 ký tự, như trò chuyện, tối đa 1 hashtag.", telegram: "Telegram: 40-80 chữ, gạch đầu dòng, không hashtag.", wordpress: "Blog SEO 400-700 chữ, dòng đầu là tiêu đề." };

export function lichDangBai({ erp, layCauHinh, ghiCauHinh, bao, dsKenh }) {
  let dang = false, lanGiaHan = 0, lanLap = 0, dangLap = false;
  const ngu = (ms) => new Promise((r) => setTimeout(r, ms));
  async function goi(url, form) {
    const r = await fetch(url, { method: "POST", body: new URLSearchParams(form), signal: AbortSignal.timeout(60e3) });
    return r.json().catch(() => ({ error: { message: "HTTP " + r.status } }));
  }
  // Instagram/Threads: tạo container rồi publish; container ảnh có khi chưa sẵn, thử lại vài lần.
  async function haiBuoc(tao, xuat, token) {
    try {
      const c = await goi(tao.url, { ...tao.form, access_token: token });
      if (!c.id) return { loi: c.error?.message || "Không tạo được bài" };
      for (let i = 0; i < 6; i++) {
        await ngu(i ? 5e3 : 2e3);
        const d = await goi(xuat, { creation_id: c.id, access_token: token });
        if (d.id) return { id: d.id };
        if (i === 5 || !/not ready|9007|chưa sẵn/i.test(JSON.stringify(d.error || {}))) return { loi: d.error?.message || "Không xuất bản được" };
      }
    } catch (e) { return { loi: e.message }; }
  }
  const dangInstagram = (t, b) => !b.anh ? Promise.resolve({ loi: "Instagram bắt buộc có ảnh — dán link ảnh cho bài này" })
    : haiBuoc({ url: FB + t.ig + "/media", form: { image_url: b.anh, caption: b.noiDung.slice(0, 2200) } }, FB + t.ig + "/media_publish", t.token);
  const TH = "https://graph.threads.net/v1.0/";
  const dangThreads = (k, b) => haiBuoc({ url: TH + "me/threads", form: b.anh ? { media_type: "IMAGE", image_url: b.anh, text: b.noiDung.slice(0, 500) } : { media_type: "TEXT", text: b.noiDung.slice(0, 500) } },
    TH + "me/threads_publish", k.token);
  // Token Threads dài hạn sống 60 ngày: còn dưới 20 ngày thì tự gia hạn, mỗi 6 giờ xem một lần.
  async function giaHanThreads() {
    if (Date.now() - lanGiaHan < 6 * 3600e3) return;
    lanGiaHan = Date.now();
    const db = layCauHinh().dangBai || {}, ds = db.threads || [];
    let doi = false;
    const moi = await Promise.all(ds.map(async (k) => {
      if ((k.het || 0) - Date.now() > 20 * 864e5) return k;
      const d = await fetch(`https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(k.token)}`, { signal: AbortSignal.timeout(20e3) }).then((x) => x.json()).catch((e) => ({ error: { message: e.message } }));
      if (!d.access_token) { bao?.("dang-bai", `Gia hạn token Threads ${k.ten} lỗi: ${d.error?.message || "?"}`); return k; }
      doi = true; return { ...k, token: d.access_token, het: Date.now() + (d.expires_in || 5184000) * 1e3 };
    }));
    if (doi) ghiCauHinh?.({ dangBai: { ...db, threads: moi } });
  }
  async function dangLen(trang, b) {
    const form = new URLSearchParams({ access_token: trang.token });
    if (b.anh) { form.set("url", b.anh); form.set("caption", b.noiDung); } else form.set("message", b.noiDung);
    try {
      const r = await fetch(FB + trang.id + (b.anh ? "/photos" : "/feed"), { method: "POST", body: form, signal: AbortSignal.timeout(60e3) });
      const d = await r.json().catch(() => ({}));
      return d.id ? { id: d.post_id || d.id } : { loi: d.error?.message || "HTTP " + r.status };
    } catch (e) { return { loi: e.message }; }
  }
  async function dangTelegram(k, b) {
    const chu = b.noiDung.slice(0, b.anh ? 1024 : 4096);
    try {
      const r = await fetch(`https://api.telegram.org/bot${k.token}/${b.anh ? "sendPhoto" : "sendMessage"}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(b.anh ? { chat_id: k.chat, photo: b.anh, caption: chu } : { chat_id: k.chat, text: chu }), signal: AbortSignal.timeout(60e3) });
      const d = await r.json().catch(() => ({}));
      return d.ok ? { id: String(d.result.message_id) } : { loi: d.description || "HTTP " + r.status };
    } catch (e) { return { loi: e.message }; }
  }
  async function dangWordpress(k, b) {
    const [dau, ...than] = b.noiDung.trim().split("\n");
    const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const html = (b.anh ? `<p><img src="${esc(b.anh)}" alt="" /></p>` : "") + than.join("\n").split(/\n{2,}/).filter((x) => x.trim()).map((x) => `<p>${esc(x).replace(/\n/g, "<br/>")}</p>`).join("");
    try {
      const r = await fetch(k.url + "/wp-json/wp/v2/posts", { method: "POST", signal: AbortSignal.timeout(60e3),
        headers: { "content-type": "application/json", Authorization: "Basic " + Buffer.from(k.user + ":" + k.mk).toString("base64") },
        body: JSON.stringify({ title: dau.slice(0, 200), content: html || esc(dau), status: "publish" }) });
      const d = await r.json().catch(() => ({}));
      return d.id ? { id: String(d.id), link: d.link } : { loi: d.message || "HTTP " + r.status };
    } catch (e) { return { loi: e.message }; }
  }
  function timKenh(ma) {
    const c = layCauHinh(), [loai, id] = ma.split(/:(.*)/s);
    if (loai === "fb") { const t = (c.facebook?.trang || []).find((x) => x.id === id); return t && { ten: t.ten || id, dang: (b) => dangLen(t, b) }; }
    if (loai === "tg") { const t = (c.dangBai?.telegram || []).find((x) => x.id === id); return t && { ten: t.ten, dang: (b) => dangTelegram(t, b) }; }
    if (loai === "ig") { const t = (c.facebook?.trang || []).find((x) => x.ig === id); return t && { ten: "Instagram " + (t.igTen || id), dang: (b) => dangInstagram(t, b) }; }
    if (loai === "th") { const t = (c.dangBai?.threads || []).find((x) => x.id === id); return t && { ten: "Threads " + t.ten, dang: (b) => dangThreads(t, b) }; }
    if (loai === "wp") { const t = (c.dangBai?.wordpress || []).find((x) => x.id === id); return t && { ten: t.ten, dang: (b) => dangWordpress(t, b) }; }
  }
  async function nhip() {
    if (dang) return;
    await giaHanThreads().catch((e) => bao?.("dang-bai", e.message));
    const ds = layCauHinh().facebook?.trang || [];
    const toi = erp.docHet(VH, "taiLieu").filter((t) => t.thuMuc === THU_MUC).flatMap((t) => {
      try { const b = JSON.parse(t.noiDung); return b.tt === "duyet" && b.luc <= Date.now() ? [{ t, b }] : []; } catch { return []; }
    });
    if (!toi.length) return;
    dang = true;
    try {
      for (const { t, b } of toi) {
        // Kênh khách tick trong bảng; bài cũ chưa chọn kênh thì đăng Trang đầu tiên.
        const chon = b.kenh?.length ? b.kenh : ds[0] ? ["fb:" + ds[0].id] : [];
        if (!chon.length) continue;   // chưa chọn kênh nào: giữ nguyên chờ, không báo lỗi
        const ketQua = { ...(b.ketQua || {}) };
        for (const ma of chon) {
          if (ketQua[ma]?.id) continue;   // đã lên Trang này rồi, thử lại chỉ đăng chỗ lỗi
          const k = timKenh(ma);
          ketQua[ma] = k ? await k.dang({ ...b, noiDung: b.banRieng?.[ma]?.trim() || b.noiDung }) : { loi: "Kênh chưa nối hoặc đã gỡ" };
        }
        const loi = Object.entries(ketQua).filter(([, v]) => v.loi).map(([k, v]) => `${timKenh(k)?.ten || k}: ${v.loi}`).join("; ");
        const kq = { ...b, ketQua, tt: loi ? "loi" : "da-dang", loi, fbId: Object.values(ketQua).find((v) => v.id)?.id || "" };
        erp.ghiNhieu([{ db: VH, kho: "taiLieu", id: t.id, v: { ...t, noiDung: JSON.stringify(kq), sua: Date.now() } }], "dang-bai");
        bao?.("dang-bai", `${loi ? "Lỗi đăng" : "Đã đăng"} "${t.ten}" lên ${chon.length} kênh${loi ? ": " + loi : ""}`);
      }
    } finally { dang = false; }
  }
  // AI tự lên lịch (bật ở trang Lịch đăng bài, giống bot tự trả lời): ngày nào trong N ngày tới còn thiếu bài thì AI viết bù,
  // nguồn là hàng hoá + tài liệu Thị trường mới nhất + chủ đề chủ đặt; tránh lặp ý các bài gần đây. Không tự duyệt thì giao việc "Duyệt bài" cho chủ.
  async function lapLich(ep = false) {
    const ch = layCauHinh(), cf = ch.lichTuDong || {};
    if ((!cf.bat && !ep) || dangLap || (!ep && Date.now() - lanLap < 6 * 3600e3)) return 0;
    if (!ch.khoa) throw new Error("Chưa nhập khoá API RevidAPI trong Kênh Chat.");
    dangLap = true; lanLap = Date.now();
    try {
      const tl = erp.docHet(VH, "taiLieu"), bai = tl.filter((t) => t.thuMuc === THU_MUC).flatMap((t) => { try { return [JSON.parse(t.noiDung)]; } catch { return []; } });
      const soNgay = Math.min(30, Math.max(1, +cf.soNgay || 7)), moiNgay = Math.min(3, Math.max(1, +cf.moiNgay || 1));
      const [hh, mm] = String(cf.gio || "19:00").split(":").map(Number), homNay = new Date(); homNay.setHours(0, 0, 0, 0);
      const trong = [];
      for (let i = 1; i <= soNgay; i++) {
        const d = new Date(homNay.getTime() + i * 864e5), co = bai.filter((b) => new Date(b.luc).toDateString() === d.toDateString()).length;
        for (let j = co; j < moiNgay; j++) trong.push(new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh || 19, mm || 0).getTime() + j * 3 * 3600e3);
      }
      if (!trong.length) return 0;
      const kenh = (dsKenh?.() || []).filter((k) => !cf.kenh?.length || cf.kenh.includes(k.ma));
      if (!kenh.length) throw new Error("Chưa có kênh đăng nào để AI lên lịch.");
      const sp = erp.docHet("revidapi-erp", "sanPham").filter((x) => x.giaBan).slice(0, 30).map((x) => `${x.ten} – ${x.giaBan}đ`).join("\n");
      const tt = tl.filter((t) => t.thuMuc === "Thị trường").sort((a, b) => b.sua - a.sua)[0];
      const cu = bai.sort((a, b) => b.luc - a.luc).slice(0, 12).map((b) => "- " + String(b.yTuong || b.noiDung).split("\n")[0].slice(0, 80)).join("\n");
      // Model ngừng bán (404 "Không bán model") thì lùi sang model còn bán thay vì báo lỗi cả lượt lên lịch.
      let r, j;
      for (const model of thuTuModel(cf.model || ch.model, ch.modelDuPhong)) {
      r = await fetch(ch.coSo + "/v1/chat/completions", { method: "POST", signal: AbortSignal.timeout(300e3),
        headers: { "content-type": "application/json", authorization: "Bearer " + ch.khoa },
        body: JSON.stringify({ model, response_format: { type: "json_object" }, messages: [
          { role: "system", content: `Bạn là người lên lịch nội dung cho cửa hàng nhỏ. Viết ${trong.length} bài khác chủ đề nhau (sản phẩm, mẹo, câu chuyện cửa hàng, cảm ơn khách, dịp lễ trong tuần). Chỉ dùng sản phẩm và giá có trong danh sách, không bịa ưu đãi.
Mỗi bài viết riêng một bản cho từng kênh theo giọng của kênh đó. Trả DUY NHẤT JSON {"bai":[{"yTuong":"...","moTaAnh":"một câu tiếng Anh mô tả ảnh, không chữ trong ảnh","ban":{"<mã kênh>":"bài viết"}}]}` },
          { role: "user", content: `Kênh:\n${kenh.map((k) => `${k.ma} (${k.loai}): ${k.prompt || GIONG[k.loai] || ""}`).join("\n")}\n\nChủ đề chủ đặt: ${cf.chuDe || "tuỳ bạn"}\n\nSản phẩm:\n${sp || "(chưa có)"}\n\n${tt ? "Thị trường gần nhất:\n" + tt.noiDung.slice(0, 1500) + "\n\n" : ""}Bài gần đây (đừng lặp ý):\n${cu || "(chưa có)"}` }] }) });
      j = await r.json().catch(() => ({}));
      if (r.ok || !laKhongBan({ ma: r.status, message: j.error?.message || j.detail })) break;
      ghiKhongBan(model);
      }
      if (!r.ok) throw new Error(j.error?.message || j.detail || "HTTP " + r.status);
      const chu = j.choices?.[0]?.message?.content || "", ds = JSON.parse(chu.slice(chu.indexOf("{"), chu.lastIndexOf("}") + 1)).bai || [];
      const doi = [], tao = Date.now();
      ds.slice(0, trong.length).forEach((x, i) => {
        const ban = Object.fromEntries(Object.entries(x.ban || {}).filter(([ma, v]) => kenh.some((k) => k.ma === ma) && String(v).trim()).map(([ma, v]) => [ma, String(v).trim()]));
        const ma = Object.keys(ban); if (!ma.length) return;
        const noiDung = ban[ma[0]], id = `ai-bai-${tao.toString(36)}-${i}`;
        doi.push({ db: VH, kho: "taiLieu", id, v: { id, thuMuc: THU_MUC, ten: noiDung.split("\n")[0].slice(0, 60), sua: tao, noiDung: JSON.stringify({
          luc: trong[i], yTuong: String(x.yTuong || ""), noiDung, banRieng: Object.fromEntries(ma.slice(1).map((m) => [m, ban[m]])), moTaAnh: String(x.moTaAnh || ""),
          kenh: ma, tt: cf.tuDuyet ? "duyet" : "nhap", ai: true, tao }) } });
      });
      if (doi.length && !cf.tuDuyet) {
        const id = `ai-viec-lich-${tao.toString(36)}`, d = (t) => new Date(t).toLocaleDateString("vi-VN");
        doi.push({ db: VH, kho: "congViec", id, v: { id, ten: `Duyệt ${doi.length} bài AI lên lịch (${d(trong[0])}–${d(trong[doi.length - 1])})`, moTa: "Mở Lịch đăng bài, xem lại nội dung và ảnh, bấm Duyệt. Bài chưa duyệt sẽ không đăng.",
          nguoiId: "", uuTien: "vua", han: new Date(trong[0] - 864e5 / 2).toISOString().slice(0, 10), tt: "can-lam", tao } });
      }
      if (doi.length) erp.ghiNhieu(doi, "lich-tu-dong");
      const so = doi.filter((x) => x.kho === "taiLieu").length;
      bao?.("dang-bai", `AI lên lịch ${so} bài${cf.tuDuyet ? " (tự duyệt)" : ", chờ chủ duyệt"}`);
      return so;
    } finally { dangLap = false; }
  }
  nhip();
  setInterval(() => lapLich().catch((e) => bao?.("dang-bai", "AI lên lịch lỗi: " + e.message)), 3600e3).unref();
  setTimeout(() => lapLich().catch(() => {}), 30e3).unref();
  lichDangBai.lapNgay = () => lapLich(true);
  return setInterval(() => nhip().catch((e) => bao?.("dang-bai", e.message)), 60e3).unref();
}
