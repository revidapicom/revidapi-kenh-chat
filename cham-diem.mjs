// Chấm điểm tìm tài liệu — chạy lại mỗi khi sửa tài liệu hoặc nâng cấp bot:
//   node cham-diem.mjs
// Đọc data/cau-mau.txt, mỗi dòng: câu khách hay hỏi | chữ phải có trong đoạn tìm được
//   ví dụ:  ship ra Hà Nội mất mấy ngày | 2-3 ngày
// Chưa có tệp thì tự tạo từ các câu nhân viên đã trả lời tay (bảng học). Không tốn credit:
// chỉ chấm bước tìm trên máy, không gọi AI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KhoTaiLieu, moKho, boDau } from "./kho-tai-lieu.mjs";

const GOC = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.KENH_DATA || path.join(GOC, "data");
const TEP = path.join(DATA, "cau-mau.txt");
const db = moKho(DATA);
const kho = new KhoTaiLieu(db);

if (!fs.existsSync(TEP)) {
  const hoc = db.prepare("SELECT hoi, tra FROM hoc WHERE tra != '' ORDER BY luc DESC LIMIT 30").all();
  fs.writeFileSync(TEP, "# câu khách hỏi | chữ phải có trong tài liệu tìm được\n"
    + hoc.map((h) => `${h.hoi.replace(/\|/g, " ")} | ${h.tra.replace(/\|/g, " ").slice(0, 30)}`).join("\n") + "\n");
  console.log(`Đã tạo ${TEP} (${hoc.length} câu). Sửa cột phải cho đúng rồi chạy lại.`);
  if (!hoc.length) process.exit(0);
}

const chuan = (s) => boDau(String(s).toLowerCase()).replace(/\s+/g, " ");
let dat = 0, tong = 0;
for (const dong of fs.readFileSync(TEP, "utf8").split("\n")) {
  if (!dong.trim() || dong.startsWith("#")) continue;
  const [hoi, can = ""] = dong.split("|").map((x) => x.trim());
  const doan = kho.tim(hoi);
  const ok = can ? doan.some((d) => chuan(d.chu).includes(chuan(can))) : doan.length > 0;
  tong++; if (ok) dat++;
  console.log(`${ok ? "✓" : "✗"} ${hoi}${ok ? "" : `  → ${doan.length ? "tìm ra đoạn khác: " + doan[0].chu.slice(0, 60) : "không tìm ra đoạn nào"}`}`);
}
console.log(`\nĐúng ${dat}/${tong}${tong ? ` (${Math.round(dat / tong * 100)}%)` : ""}. Câu ✗: thêm vào tài liệu đúng cách khách hay gọi, hoặc thêm câu "hỏi nhanh".`);
