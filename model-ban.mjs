// Model AI mà RevidAPI đang bán. Trước 1.5.7 tên model ghi cứng trong app (kimi-k3, gemini-3.8-flash):
// model ngừng bán thì cổng trả 404 "Không bán model" và bot im trên Zalo/Fanpage. Nay:
// - panel lấy danh sách từ GET /v1/chat/models, không ghi cứng;
// - gặp model ngừng bán thì tự lùi sang model khác còn bán và báo trên panel để chủ chọn lại.

// Lùi về theo thứ tự này khi model chủ chọn đã ngừng bán. Không dùng model "dùng thử" (hết lượt là lỗi).
export const MODEL_LUI = ["deepseek-v4.1-flash", "claude-haiku-5-5", "deepseek-v4-pro"];

const NHO_MS = 30 * 60e3;
const khongBan = new Map();   // model → lúc cổng báo ngừng bán; bỏ qua 30 phút cho đỡ một lượt 404 mỗi tin
let ds = { luc: 0, model: null };

/** Lỗi do cổng không bán model này (404/400 "Không bán model ..."), khác với hết credit/khoá sai/quá hạn. */
export const laKhongBan = (e) => (e?.ma === 404 || e?.ma === 400) && /không bán model|model_not_found|\/v1\/chat\/models/i.test(String(e?.message || ""));

export function ghiKhongBan(model) { if (model) khongBan.set(model, Date.now()); }
export const vuaKhongBan = (m) => { const t = khongBan.get(m); return t && Date.now() - t < NHO_MS; };

/** Thứ tự thử: các model chủ chọn (bỏ model vừa bị báo ngừng bán) rồi tới MODEL_LUI. */
export function thuTuModel(...chon) {
  const dau = [...new Set(chon.filter(Boolean).map(String))];
  const con = dau.filter((m) => !vuaKhongBan(m));
  const ds = [...new Set([...con, ...MODEL_LUI.filter((m) => !vuaKhongBan(m))])];
  return ds.length ? ds : [...MODEL_LUI];   // mọi model đều vừa bị báo: vẫn thử lại, cổng có thể đã bán lại
}

/** Danh sách model cổng đang bán (không gồm model dùng thử), nhớ 30 phút. Lỗi mạng thì trả bản cũ hoặc null. */
export async function modelDangBan(coSo, khoa) {
  if (ds.model && Date.now() - ds.luc < NHO_MS) return ds.model;
  try {
    const r = await fetch(String(coSo || "https://revidapi.com").replace(/\/$/, "") + "/v1/chat/models", {
      headers: khoa ? { Authorization: "Bearer " + khoa } : {}, signal: AbortSignal.timeout(10e3) });
    if (!r.ok) return ds.model;
    const j = await r.json();
    const m = (j.data || []).filter((x) => x?.id && !x.free)
      .sort((a, b) => (a.credits_out_per_m || 0) - (b.credits_out_per_m || 0))
      .map((x) => ({ id: String(x.id), ten: String(x.label || x.id), dat: (x.credits_out_per_m || 0) > 1000 }));
    if (m.length) {
      ds = { luc: Date.now(), model: m };
      for (const x of m) khongBan.delete(x.id);   // cổng bán lại thì thôi né
    }
    return ds.model;
  } catch { return ds.model; }
}

/** Bản đã tải gần nhất (không gọi mạng), null khi chưa tải được lần nào. */
export const dsDaBiet = () => ds.model;

/** Câu báo cho panel khi phải lùi model. */
export const cauLui = (bo, dung) =>
  `Model ${bo.join(", ")} đã ngừng bán — bot đang tạm trả lời bằng ${dung}. Vào Cách trả lời → chọn lại Model AI rồi bấm Lưu.`;
