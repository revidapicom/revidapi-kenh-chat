// Ảnh và link trong tin nhắn — chạy trên máy khách, không qua máy chủ RevidAPI.
// - Link khách gửi: tải trang ngay ở đây, lấy tiêu đề, mô tả, giá (nếu có) và ~800 chữ đầu,
//   ghép vào tin để AI trả lời được ("cái này còn không shop" + link Shopee).
// - Ảnh khách gửi: tải về thành data URI (≤ 1,5 MB) để AI nhìn được; link Telegram chứa token
//   bot nên luôn tải ở đây chứ không đưa link đi.
// - Ảnh bot gửi: link ảnh (.jpg/.png/.webp) mà AI chép từ tài liệu được tách ra gửi thành ảnh.
import dns from "node:dns/promises";
import net from "node:net";

const LINK = /https?:\/\/[^\s<>"')\]]+/gi;
const DUOI_ANH = /\.(?:jpe?g|png|webp|gif)(?:\?[^\s]*)?$/i;
const ANH_TOI_DA = 1_500_000;

// Không cho khách dùng bot để gọi vào mạng nội bộ của máy/VPS (127.0.0.1, 192.168.x, 10.x…).
function ipNoiBo(ip) {
  if (net.isIPv6(ip)) return /^(::1?|fc|fd|fe80|::ffff:(127|10|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

async function anToan(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const ds = await dns.lookup(u.hostname, { all: true });
    return ds.length > 0 && !ds.some((d) => ipNoiBo(d.address));
  } catch { return false; }
}

// Tải tối đa `tran` byte; quá thì cắt (trang HTML) hoặc bỏ (ảnh).
async function tai(url, { tran, hanMs = 8000, headers = {} } = {}) {
  let dich = url;
  for (let i = 0; i < 4; i++) {   // tự theo chuyển hướng để kiểm từng chặng
    if (!(await anToan(dich))) throw new Error("địa chỉ không hợp lệ");
    const r = await fetch(dich, {
      redirect: "manual", signal: AbortSignal.timeout(hanMs),
      headers: { "User-Agent": "Mozilla/5.0 (KenhChat; +https://revidapi.com)", "Accept-Language": "vi,en;q=0.8", ...headers },
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { dich = new URL(r.headers.get("location"), dich).href; continue; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const doc = r.body.getReader();
    const phan = []; let n = 0;
    for (;;) {
      const { done, value } = await doc.read();
      if (done) break;
      phan.push(value); n += value.length;
      if (n > tran) { await doc.cancel().catch(() => {}); return { buf: Buffer.concat(phan), loai: r.headers.get("content-type") || "", cat: true, url: dich }; }
    }
    return { buf: Buffer.concat(phan), loai: r.headers.get("content-type") || "", cat: false, url: dich };
  }
  throw new Error("chuyển hướng quá nhiều");
}

const giaiMa = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const meta = (html, ten) => {
  const m = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${ten}["'][^>]*>`, "i").exec(html);
  return m ? giaiMa(/content=["']([^"']*)["']/i.exec(m[0])?.[1] || "").trim() : "";
};

/** Đọc một link: trả đoạn chữ ngắn mô tả trang, hoặc null nếu không đọc được. */
export async function docLink(url) {
  try {
    const r = await tai(url, { tran: 600_000 });
    if (/^image\//.test(r.loai)) return { url, laAnh: true };
    if (!/html|text/.test(r.loai)) return { url, chu: `(tệp ${r.loai.split(";")[0] || "không rõ loại"})` };
    const html = r.buf.toString("utf8");
    const tieuDe = meta(html, "og:title") || giaiMa(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").trim();
    const moTa = meta(html, "og:description") || meta(html, "description");
    const gia = meta(html, "product:price:amount") || meta(html, "og:price:amount") || meta(html, "price");
    const than = giaiMa(html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ").trim().slice(0, 800);
    const dong = [tieuDe && "Tiêu đề: " + tieuDe, moTa && "Mô tả: " + moTa.slice(0, 400), gia && "Giá trên trang: " + gia,
                  than && "Nội dung đầu trang: " + than].filter(Boolean);
    return dong.length ? { url: r.url, chu: dong.join("\n") } : null;
  } catch { return null; }
}

/** Thêm nội dung các link (tối đa 2) vào tin của khách. Link là ảnh thì trả về để AI nhìn. */
export async function moRongLink(chu) {
  const ds = [...new Set(String(chu || "").match(LINK) || [])].slice(0, 2);
  const them = []; const anh = [];
  for (const d of await Promise.all(ds.map(docLink))) {
    if (!d) continue;
    if (d.laAnh) { anh.push(d.url); continue; }
    them.push(`[Nội dung link ${d.url}]\n${d.chu}`);
  }
  for (const u of ds) if (!them.some((t) => t.includes(u)) && !anh.includes(u))
    them.push(`[Nội dung link ${u}]\n(Không mở được trang này — có thể trang chặn đọc tự động. Hỏi khách tên sản phẩm.)`);
  return { chu: them.length ? chu + "\n\n" + them.join("\n\n") : chu, anh };
}

/**
 * Tải ảnh thành data URI cho AI. Quá lớn: trả link gốc nếu `giuLink` (CDN công khai của
 * Zalo/Fanpage), còn không thì null. Link có bí mật (Telegram) thì đừng bật `giuLink`.
 */
export async function anhDataUri(url, { headers, giuLink = false } = {}) {
  try {
    const r = await tai(url, { tran: ANH_TOI_DA, hanMs: 15000, headers });
    if (r.cat) return giuLink && /^https:/.test(url) ? url : null;
    let loai = r.loai.split(";")[0].trim();
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(loai)) {
      const b = r.buf;   // CDN Zalo/FB hay trả application/octet-stream — nhận theo chữ ký tệp
      loai = b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x89 && b[1] === 0x50 ? "image/png"
        : b.slice(8, 12).toString() === "WEBP" ? "image/webp" : b.slice(0, 3).toString() === "GIF" ? "image/gif" : "";
      if (!loai) return null;
    }
    return `data:${loai};base64,${r.buf.toString("base64")}`;
  } catch { return null; }
}

/** Tách link ảnh trong câu trả lời của bot: { chu (bỏ các dòng chỉ là link ảnh), anh: [url] }. */
export function tachAnh(chu) {
  const anh = [];
  for (const u of String(chu || "").match(LINK) || []) if (DUOI_ANH.test(u) && !anh.includes(u)) anh.push(u);
  if (!anh.length) return { chu, anh };
  // Bỏ link ảnh khỏi chữ; dòng chỉ còn "Ảnh:" / "-" sau khi bỏ thì bỏ cả dòng.
  const gon = String(chu).split("\n").flatMap((d) => {
    let x = d; for (const u of anh) x = x.split(u).join("");
    return x !== d && /^[\s:\-•*]*(?:ảnh|hình)?[\s:\-•*]*$/iu.test(x) ? [] : [x.trimEnd()];
  }).join("\n").trim();
  return { chu: gon, anh: anh.slice(0, 4) };
}

/** Tải ảnh để bot gửi đi (≤ 5 MB): { buf, loai, ten } hoặc null. */
export async function taiAnh(url) {
  try {
    const r = await tai(url, { tran: 5_000_000, hanMs: 15000 });
    if (r.cat || !r.buf.length) return null;
    const duoi = (/\.(jpe?g|png|webp|gif)/i.exec(new URL(r.url).pathname)?.[1] || "jpg").toLowerCase();
    return { buf: r.buf, loai: r.loai.split(";")[0] || "image/" + duoi, ten: "anh." + duoi };
  } catch { return null; }
}
