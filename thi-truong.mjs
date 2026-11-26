// Nghiên cứu thị trường: gom dữ liệu thật từ mạng xã hội qua API RevidAPI (5 credit/lượt), rút gọn thành chữ,
// giao AI Marketing phân tích. Báo cáo luôn chờ chủ duyệt; duyệt xong thì AI Điều hành chia việc cho các phòng.
// Không tự đăng bình luận: AI chỉ soạn câu trả lời mẫu, người thật đăng sau khi chủ duyệt.
const VH = "revidapi-vanhanh";
export const TEN_BAO_CAO = "Nghiên cứu thị trường";

const TU_KHOA = (process.env.THI_TRUONG_TU_KHOA || "bánh kem sinh nhật hà nội|bánh kem ít ngọt|tiệm bánh mới mở hà nội").split("|");

const DOI_THU = (process.env.THI_TRUONG_DOI_THU || "thuhuongbakery98|coco.homebaked").split("|").filter(Boolean);
// Bình luận đang hỏi mua: đánh dấu để Bán hàng lọc ra khách tiềm năng.
const HOI_MUA = /giá|bao nhiêu|bn\b|địa chỉ|ở đâu|chỗ nào|ship|giao|inbox|\bib\b|đặt|order|còn không|có quán|bên .* k/i;
const dong = (t, thich) => `- ${HOI_MUA.test(t) ? "[HỎI MUA] " : ""}[${thich ?? 0} thích] ${(t || "").replace(/\s+/g, " ").slice(0, 140)}`;

async function goi(khoa, duong, than) {
  const r = await fetch("https://revidapi.com" + duong, { method: "POST", headers: { authorization: "Bearer " + khoa, "content-type": "application/json" }, body: JSON.stringify(than), signal: AbortSignal.timeout(60e3) });
  if (!r.ok) throw new Error(`${duong} HTTP ${r.status}`);
  const j = await r.json();
  return j.data || j;
}

/** Một đợt gom: ~3 lượt tìm TikTok + bình luận 4 video nhiều tương tác + hashtag đang lên + TikTok Shop ≈ 9 lượt. */
export async function gomThiTruong(khoa) {
  const phan = [], dem = { luot: 0 };
  const g = async (d, t) => { dem.luot++; return goi(khoa, d, t); };
  const video = [];
  for (const k of TU_KHOA) {
    try {
      const d = await g("/v1/tiktok/search", { keyword: k });
      const ds = (d.search_item_list || []).map((x) => x.aweme_info).filter(Boolean);
      phan.push(`## TikTok tìm "${k}" (${ds.length} video)\n` + ds.slice(0, 8).map((a) => `- @${a.author?.unique_id} | ${a.statistics?.play_count} xem | ${a.statistics?.comment_count} bình luận | ${(a.desc || "").replace(/\s+/g, " ").slice(0, 110)}`).join("\n"));
      video.push(...ds);
    } catch (e) { phan.push(`## TikTok "${k}": lỗi ${e.message}`); }
  }
  const top = [...new Map(video.map((a) => [a.aweme_id, a])).values()].sort((a, b) => (b.statistics?.comment_count || 0) - (a.statistics?.comment_count || 0)).slice(0, 4);
  for (const a of top) {
    try {
      const d = await g("/v1/tiktok/comments", { aweme_id: a.aweme_id });
      phan.push(`## Bình luận video @${a.author?.unique_id} (${a.statistics?.play_count} xem): ${(a.desc || "").slice(0, 60)}\n` + (d.comments || []).slice(0, 20).map((c) => dong(c.text, c.digg_count)).join("\n"));
    } catch (e) { phan.push(`## Bình luận ${a.aweme_id}: lỗi ${e.message}`); }
  }
  // Theo dõi kênh đối thủ: 2 bài mới nhất mỗi kênh + bình luận khách để lại.
  for (const u of DOI_THU) {
    try {
      const k = await g("/v1/tiktok/channel", { username: u });
      const bai = (k.items || []).slice(0, 2);
      phan.push(`## Kênh đối thủ @${u} (${k.count ?? bai.length} bài gần đây)\n` + (k.items || []).slice(0, 6).map((b) => `- ${(b.title || "").replace(/\s+/g, " ").slice(0, 110)}`).join("\n"));
      for (const b of bai) {
        const id = (b.url || "").match(/\/(?:video|photo)\/(\d+)/)?.[1]; if (!id) continue;
        const d = await g("/v1/tiktok/comments", { aweme_id: id });
        phan.push(`## Bình luận bài @${u}: ${(b.title || "").slice(0, 60)}\n` + (d.comments || []).slice(0, 15).map((c) => dong(c.text, c.digg_count)).join("\n"));
      }
    } catch (e) { phan.push(`## Đối thủ @${u}: lỗi ${e.message}`); }
  }
  try {
    const d = await g("/v1/instagram/search", { keyword: "bánh kem hà nội" });
    const ds = (d.data?.items || []).sort((a, b) => (b.comment_count || 0) - (a.comment_count || 0));
    phan.push(`## Instagram "bánh kem hà nội" (${ds.length} bài)\n` + ds.slice(0, 8).map((a) => `- @${a.user?.username} | ${a.comment_count ?? 0} bình luận | ${(a.caption?.text || "").replace(/\s+/g, " ").slice(0, 100)}`).join("\n"));
    for (const a of ds.slice(0, 2)) {
      const c = await g("/v1/instagram/comments", { code: a.code });
      phan.push(`## Bình luận Instagram @${a.user?.username}\n` + (c.data?.items || []).filter((x) => !x.is_created_by_media_owner).slice(0, 15).map((x) => dong(x.text, x.comment_like_count)).join("\n"));
    }
  } catch (e) { phan.push(`## Instagram: lỗi ${e.message}`); }
  try {
    const d = await g("/v1/tiktok/ads/hashtags", { period: 7 });
    phan.push("## Hashtag đang lên ở Việt Nam 7 ngày (toàn TikTok, không riêng ngành bánh — chỉ dùng nếu bắt trend được)\n" + (d.items || []).slice(0, 15).map((h) => `- #${h.hashtagName} | ${h.publishCnt} bài`).join("\n"));
  } catch (e) { phan.push(`## Hashtag: lỗi ${e.message}`); }
  try {
    const d = await g("/v1/tiktokshop/search", { keyword: "bánh ngọt" });
    const ds = d.data?.products || d.products || [];
    phan.push("## TikTok Shop \"bánh ngọt\"\n" + ds.slice(0, 10).map((p) => `- ${(p.title || "").slice(0, 80)} | giá ${p.product_price_info?.sale_price_format || "?"}đ | đã bán ${p.sold_info?.sold_count ?? "?"} | ${p.seller_info?.shop_name || ""}`).join("\n"));
  } catch (e) { phan.push(`## TikTok Shop: lỗi ${e.message}`); }
  return { chu: phan.join("\n\n"), luot: dem.luot };
}

const YEU_CAU = `Phân tích dữ liệu thị trường bên dưới (lấy thật từ mạng xã hội hôm nay) cho tiệm bánh Mây, đối chiếu với số bán của tiệm. Báo cáo gồm:
1. Nhu cầu khách: khách khen gì, chê gì, hỏi gì nhiều nhất (dẫn đúng bình luận).
2. Xu hướng và đối thủ: tiệm nào đang hút tương tác, vì sao, giá họ đang bán.
3. Khách tiềm năng: mọi bình luận gắn [HỎI MUA] và câu tương tự (ghi nền tảng + kênh + câu bình luận), kể cả khách đang hỏi ở kênh đối thủ.
4. 5 bình luận mẫu tiệm có thể đăng dưới video liên quan — lịch sự, không chê đối thủ, không spam. Chỉ là bản nháp chờ chủ duyệt.
5. Đề xuất việc cụ thể cho từng phòng (bán hàng, kho/sản xuất, marketing, kế toán) kèm con số.
Chỉ dùng dữ liệu có ở đây, không bịa. Không tạo congViec trong lượt này — chủ duyệt báo cáo xong mới chia việc.`;

/** Nhịp nghiên cứu: gom dữ liệu → việc cho AI Marketing. Báo cáo đã được chủ duyệt → việc cho AI Điều hành chia phòng. */
export async function nhipThiTruong({ erp, khoa, bao, phut }) {
  const cv = erp.docHet(VH, "congViec"), luc = Date.now(), doi = [];
  for (const v of cv) if (v.thiTruong && v.tt === "xong" && !v.daChia) {
    doi.push({ ...v, daChia: luc });
    doi.push({ id: `tt-chia-${luc.toString(36)}`, duAnId: "", ten: "Chia việc theo báo cáo thị trường chủ đã duyệt", nguoiId: "ai-dieu-hanh", tt: "can-lam", uuTien: "cao", tao: luc, aiNganSach: 10,
      han: new Date(luc + 2 * 864e5).toISOString().slice(0, 10),
      moTa: `Chủ đã duyệt báo cáo dưới đây. Chia thành việc cụ thể cho từng phòng AI (giaoCho), mỗi việc có con số và hạn. Bình luận mẫu thì giao Bán hàng chuẩn bị, người thật đăng.\n\n${v.moTa}` });
  }
  const cuoi = Math.max(0, ...cv.filter((v) => v.thiTruong).map((v) => v.tao || 0));
  if (luc - cuoi >= phut * 60e3 && khoa) {
    const { chu, luot } = await gomThiTruong(khoa);
    const tu = new Date(luc - 30 * 864e5).toISOString().slice(0, 10), ban = {};
    for (const d of erp.docHet("revidapi-erp", "donHang")) if (d.trangThai === "xong" && d.ngay >= tu) for (const x of d.dong) { const o = ban[x.spId] = ban[x.spId] || { sl: 0, tien: 0 }; o.sl += x.sl; o.tien += x.sl * x.gia; }
    const cuaTiem = "## Số bán của tiệm 30 ngày (mã | tên | giá bán | đã bán | doanh thu)\n" + erp.docHet("revidapi-erp", "sanPham").filter((s) => s.giaBan)
      .map((s) => `${s.ma} | ${s.ten} | ${s.giaBan} | ${ban[s.id]?.sl || 0} | ${ban[s.id]?.tien || 0}`).join("\n");
    const id = `tt-${luc.toString(36)}`, gio = new Date(luc).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    erp.ghiNhieu([{ db: VH, kho: "taiLieu", id: `tl-${id}`, v: { id: `tl-${id}`, thuMuc: "Thị trường", ten: `Dữ liệu mạng xã hội ${gio}`, noiDung: chu, sua: luc } }], "thi-truong");
    doi.push({ id, duAnId: "", ten: `${TEN_BAO_CAO} ${gio}`, nguoiId: "ai-marketing", tt: "can-lam", uuTien: "cao", tao: luc, aiNganSach: 4, thiTruong: true, luotThiTruong: luot,
      han: new Date(luc + 864e5).toISOString().slice(0, 10), moTa: `${YEU_CAU}\n\n---\n${cuaTiem}\n\n${chu}` });
    bao?.("thi-truong", `Đã gom dữ liệu thị trường: ${luot} lượt API`);
  }
  if (doi.length) erp.ghiNhieu(doi.map((v) => ({ db: VH, kho: "congViec", id: v.id, v })), "thi-truong");
}
