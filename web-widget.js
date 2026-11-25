// Khung chat RevidAPI Kênh Chat — gắn vào website bằng một thẻ <script>. Máy chủ chèn
// window.__KC (tên, màu, câu chào) ở đầu tệp này khi phục vụ /web/widget.js.
(function () {
  if (window.__kcDaGan) return; window.__kcDaGan = 1;
  var C = window.__KC || {}, the = document.currentScript;
  var GOC = the ? new URL(the.src).origin : "";
  var MAU = /^#[0-9a-f]{3,8}$/i.test(C.mau || "") ? C.mau : "#2f9e44";
  var ma; try { ma = localStorage.getItem("kc_ma"); } catch (e) {}
  if (!/^[a-z0-9]{16,40}$/.test(ma || "")) {
    ma = Array.from(crypto.getRandomValues(new Uint8Array(12)), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    try { localStorage.setItem("kc_ma", ma); } catch (e) {}
  }
  var sau = 0, mo = false, hen = null, daChat = false;
  try { daChat = !!localStorage.getItem("kc_da"); } catch (e) {}

  var goc = document.createElement("div"); goc.id = "kc-goc";
  var bong = goc.attachShadow({ mode: "open" });
  bong.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.nut{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;background:' + MAU + ';color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:2147483646;display:grid;place-items:center}' +
    '.nut svg{width:26px;height:26px}.nut:focus-visible,button:focus-visible{outline:3px solid #222;outline-offset:2px}' +
    '.khung{position:fixed;right:20px;bottom:88px;width:360px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 110px);background:#fff;color:#1f2328;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647}' +
    '.khung[hidden]{display:none}.dau{background:' + MAU + ';color:#fff;padding:12px 14px;display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px}' +
    '.dau span{flex:1}.dong{background:none;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1}' +
    '.ds{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f6f7f8}' +
    '.tin{max-width:82%;padding:8px 11px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}' +
    '.tin.ban{align-self:flex-end;background:' + MAU + ';color:#fff;border-bottom-right-radius:4px}' +
    '.tin.shop{align-self:flex-start;background:#fff;border:1px solid #e3e5e8;border-bottom-left-radius:4px}' +
    '.tin img{max-width:100%;border-radius:8px;display:block;margin-top:4px}.go{font-size:12px;color:#6b7280;align-self:flex-start}' +
    'form{display:flex;gap:6px;padding:10px;border-top:1px solid #e3e5e8;background:#fff}' +
    'textarea{flex:1;resize:none;border:1px solid #d0d4d9;border-radius:10px;padding:8px 10px;font-size:14px;height:40px;max-height:100px;color:#1f2328;background:#fff}' +
    'form button{border:0;border-radius:10px;background:' + MAU + ';color:#fff;padding:0 14px;font-weight:600;cursor:pointer}' +
    '@media (max-width:480px){.khung{right:12px;bottom:80px}}' +
    '</style>' +
    '<button class="nut" aria-label="Mở khung chat"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg></button>' +
    '<div class="khung" role="dialog" aria-label="Chat" hidden><div class="dau"><span></span><button class="dong" aria-label="Đóng">×</button></div>' +
    '<div class="ds" aria-live="polite"></div><form><textarea rows="1" placeholder="Nhập tin nhắn…" aria-label="Tin nhắn" maxlength="1000"></textarea><button>Gửi</button></form></div>';
  var $ = function (s) { return bong.querySelector(s); };
  $(".dau span").textContent = C.ten || "Tư vấn";
  var ds = $(".ds"), o = $("textarea"), go = null;

  function them(vai, chu, anh) {
    var d = document.createElement("div"); d.className = "tin " + vai;
    if (chu) d.textContent = chu;
    (anh || []).forEach(function (a) { if (/^(https:|data:image\/)/.test(a)) { var i = document.createElement("img"); i.src = a; i.alt = ""; d.appendChild(i); } });
    ds.insertBefore(d, go && go.parentNode ? go : null); ds.scrollTop = ds.scrollHeight;
  }
  function dangGo(co) {
    if (co && !go) { go = document.createElement("div"); go.className = "go"; go.textContent = "Đang trả lời…"; ds.appendChild(go); ds.scrollTop = ds.scrollHeight; }
    if (!co && go) { go.remove(); go = null; }
  }
  function hoi() {
    clearTimeout(hen);
    fetch(GOC + "/web/tin?ma=" + ma + "&sau=" + sau).then(function (r) { return r.json(); }).then(function (j) {
      (j.tin || []).forEach(function (t) { sau = Math.max(sau, t.id); dangGo(false); them("shop", t.chu, t.anh); });
    }).catch(function () {}).finally(function () { if (mo || daChat) hen = setTimeout(hoi, mo ? (go ? 1500 : 4000) : 20000); });
  }
  function batTat() {
    mo = !mo; $(".khung").hidden = !mo;
    if (mo) { if (!ds.children.length && C.chao) them("shop", C.chao); o.focus(); hoi(); }
  }
  $(".nut").onclick = batTat; $(".dong").onclick = batTat;
  o.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); } });
  $("form").onsubmit = function (e) {
    e.preventDefault();
    var chu = o.value.trim(); if (!chu) return;
    o.value = ""; them("ban", chu); daChat = true; try { localStorage.setItem("kc_da", "1"); } catch (e) {} dangGo(true);
    fetch(GOC + "/web/tin", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ ma: ma, chu: chu, trang: location.href }) })
      .then(function (r) { if (!r.ok) return r.json().then(function (j) { throw new Error(j.loi || "Lỗi"); }); hoi(); })
      .catch(function (x) { dangGo(false); them("shop", x.message || "Chưa gửi được, thử lại sau ít phút."); });
  };
  (document.body || document.documentElement).appendChild(goc);
  // Đã từng chat: lấy tin nhân viên trả lời trong lúc khách rời trang (hộp giữ 2 giờ).
  if (daChat) hoi();
})();
