# AluSight — Production Ready

**AI-Powered Aluminum Defect Inspection** — ตรวจจับรูพรุน/รอยบกพร่องในอะลูมิเนียมหล่อ ด้วยกล้องจุลทรรศน์ (OM) + Eddy Current Array (ECA) + Root Cause Analysis

ผลงานเข้าร่วม **Higher Education Innovation Awards 2027** · **Live:** https://alusight.vercel.app

---

## 1. ความพร้อมใช้งานจริง

| เรื่อง | สถานะ | รายละเอียด |
|---|---|---|
| ประมวลผลภาพ | พร้อม | client-side pipeline: grayscale → blur → percentile threshold → morphology → connected components ผลลัพธ์: จำนวนรูพรุน/อนุภาค, ⌀, ตำแหน่ง, % porosity |
| ปรับเทียบสเกล | พร้อม | คลิก 2 จุดบนมาตราอ้างอิง กรอกความยาวจริง (µm) → คำนวณ µm/px แทนการเดาจาก slider |
| วัด ECA หลายบริเวณ | พร้อม | เพิ่ม/ลบบริเวณ, กรอก V/I, คำนวณ R = V/I, ระบุ ปกติ/ดีเฟค |
| เชื่อมเครื่องจริง | พร้อม (Chrome/Edge) | **WebSerial** อ่านบรรทัด `V:5.12,I:0.43` หรือ `5.12,0.43` ที่ 9600 baud → เติมโซนแรกอัตโนมัติ |
| กราฟความสัมพันธ์ | พร้อม | % porosity ↔ R พร้อม regression, correlation r |
| แผนที่ FEA | พร้อม | heatmap 10×6 + Risk Score + hotspot |
| RCA | พร้อม | ตาราง record อุณหภูมิ/แรงดัน/cooling/ความเร็วฉีด/Label ดี-เสีย |
| บันทึกข้อมูล | พร้อม | auto-save ลง localStorage, กู้คืนตอนเปิดใหม่, นำเข้า/ส่งออก JSON |
| วิเคราะห์ชุดภาพ | พร้อม | เลือกหลายไฟล์ → ตารางผลแต่ละภาพ รวม error case |
| รายงาน | พร้อม | ปุ่มพิมพ์รายงาน (print CSS ตัด UI ออก) + CSV สำหรับ zone และ RCA |
| Offline / PWA | พร้อม | manifest + service worker (cache-first สำหรับ asset, network-first สำหรับหน้าเว็บ) |
| Accessibility | ผ่าน gate 12/12 | WCAG-focused: focus ring, reduced-motion, contrast, ไม่มี emoji, semantic h1/h2, 4pt grid |

## 2. รันในเครื่อง

```bash
cd C:\Users\azzin\AluSight
python -m http.server 8899
# เปิด http://127.0.0.1:8899
```

> ใช้เซิร์ฟเวอร์เสมอสำหรับ WebSerial และ service worker (file:// ไม่รองรับ)

## 3. Workflow ที่แนะนำ

1. กรอกข้อมูลชิ้นงาน (Batch / เกรด / ขนาด) — บันทึกอัตโนมัติ
2. โหลดภาพ OM → กด **ปรับเทียบสเกลจากภาพ** → คลิก 2 จุดของมาตราอ้างอิง → ใส่ µm จริง
3. กด **วิเคราะห์ภาพ** → ได้รูพรุน/อนุภาค + % porosity
4. ที่ **พื้นที่วัด ECA**: กดเพิ่มบริเวณ หรือ **เติมจากผลตรวจจับ** → เสียบเครื่องแล้วกด **เชื่อมเครื่อง ECA**
5. ดูกราฟความสัมพันธ์และแผนที่ FEA → บันทึก record ลง RCA
6. **พิมพ์รายงาน** หรือส่งออก JSON/CSV เก็บผล

## 4. รูปแบบข้อมูลที่รองรับ

- ภาพ: JPG / PNG / BMP / TIFF (ลดขนาดเหลือ max 1024 px สำหรับ performance)
- Serial: `V:5.12,I:0.43` · `V=5.12 I=0.43` · `5.12,0.43` · `5.12;0.43` ที่ 9600 baud
- นำเข้า JSON: โครงสร้างเดียวกับที่ส่งออก (`general`, `params`, `zones`, `rca`, `batch`)

## 5. ข้อจำกัดที่ต้องรู้ ( honesty notes )

- โปรแกรมนี้ใช้ **image analysis แบบดั้งเดิม (threshold + morphology)** ไม่ใช่โมเดล deep learning ที่เทรนแล้ว — ค่า porosity เป็นค่าประมาณ ต้องเทียบกับผล OM จริงก่อนใช้ตัดสินใจ
- WebSerial ต้องใช้ **Chrome/Edge** และผู้ใช้ต้องกดปุ่มด้วยตนเอง (browser permission) — การเรียก `.click()` จากสคริปต์จะถูกปฏิเสธ
- ภาพในแชท LINE เก็บเป็น `.eimg` ที่เข้ารหัส ต้องกด Save ในแชทเพื่อได้ไฟล์ต้นฉบับ
- ลิงก์ Kaggle ในแชทถูกตัดเป็น `kaggle.com/d…` จึงไม่ได้เดา URL เต็ม
- LocalStorage อยู่ใน browser profile ของผู้ใช้เท่านั้น — ส่งออก JSON หากต้องย้ายเครื่อง

## 6. โครงสร้างไฟล์

```
index.html            6 sections + session bar + references
styles.css            tokens light/dark, focus, reduced-motion, print CSS
app.js                image pipeline, zones, chart, FEA, RCA, persistence,
                      calibration, batch, WebSerial, import/export, SW register
samples.js            ภาพตัวอย่าง base64
sw.js                 service worker (cache alusight-console-r2)
manifest.webmanifest  PWA manifest
dashboard.html        dashboard เดิม
README.md             ไฟล์นี้
```

## 7. Deploy

```bash
git add -A && git commit -m "..." && git push origin master:main
vercel deploy --prod --yes
# ตรวจสอบ: curl -s https://alusight.vercel.app | grep 'AluSight'
```
