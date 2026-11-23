# AluSight v2

**AI-Powered Aluminum Defect Inspection** — ตรวจจับรูพรุน/รอยบกพร่องในอะลูมิเนียมหล่อ ด้วยกล้องจุลทรรศน์ (OM) + Eddy Current Array (ECA) + Root Cause Analysis

ผลงานเข้าร่วมประกวด **นวัตกรรมสายอุดมศึกษา ประจำปี 2570 (Higher Education Innovation Awards 2027)** ด้านวิศวกรรมศาสตร์ เทคโนโลยีปัญญาประดิษฐ์ และอุปกรณ์อัจฉริยะ

> **Live:** https://alusight.vercel.app

## สิ่งที่เพิ่มใน v2 (อ้างอิงสเปกจากแชททีม 22 พ.ย. 2026)

| ฟีเจอร์ | รายละเอียด |
|---|---|
| ข้อมูลชิ้นงาน | รหัส Batch, เกรด, ความยาว/กว้าง/หนา, Process — กรอกครั้งเดียว |
| ตรวจจับอัตโนมัติ | OM image → grayscale → blur → percentile threshold → morphology → connected components → รูพรุน/อนุภาค พร้อม ⌀, ตำแหน่ง, พื้นที่ |
| พื้นที่วัด ECA หลายบริเวณ | กดเพิ่มบริเวณได้ · กรอก Voltage/Current · คำนวณ **R = V/I** · ระบุสภาพ ปกติ/ดีเฟค |
| เติมจากผลตรวจจับ | แบ่งภาพเป็น 6 โซน แล้วกรอก % porosity ให้อัตโนมัติจากตำแหน่งที่พบรูพรุน |
| กราฟความสัมพันธ์ | % porosity ↔ ความต้านทานไฟฟ้า พร้อมแนวโน้ม regression และค่า r |
| แผนที่ FEA | Heatmap ความหนาแน่นข้อบกพร่อง + Risk Score (0–100) + บริเวณเสี่ยงสูงสุด |
| Root Cause Analysis | ตาราง record: อุณหภูมิ / แรงดัน / เวลา cooling / ความเร็วฉีด / Label ดี-เสีย |
| ส่งออกข้อมูล | JSON (session ทั้งหมด) และ CSV (ตารางโซนวัด) |
| Theme | สลับโหมดมืด/สว่าง พร้อม redraw กราฟและแผนที่ |
| แหล่งข้อมูลอ้างอิง | รวม 7 แหล่งจากแชท (Kaggle, Zenodo, Mendeley, MDPI, PMC, Casting Defects, Materials Defect Analysis) |

## โครงสร้างไฟล์

```
index.html      หน้าเว็บหลัก — workbench / zones / chart / FEA / RCA / references
styles.css      design tokens (light + dark), 4pt grid, focus ring, reduced-motion
app.js          image pipeline + zone/state + chart + heatmap + RCA + export
samples.js      ภาพตัวอย่างแบบ base64 (om_raw, om_overlay)
dashboard.html  dashboard วิเคราะห์ข้อมูลเดิม
README.md       ไฟล์นี้
```

## รันในเครื่อง

```bash
python -m http.server 8899
# เปิด http://127.0.0.1:8899
```

หรือเปิด `index.html` โดยตรง (บางเบราว์เซอร์บล็อก canvas สำหรับ file:// แนะนำใช้เซิร์ฟเวอร์)

## หมายเหตุ

- ประมวลผลทั้งหมดในเบราว์เซอร์ — ไม่มีการอัปโหลดภาพหรือข้อมูลไปเซิร์ฟเวอร์
- ค่า % porosity มาจากการประมาณจากภาพ ควรเทียบกับผลทดสอบจริงก่อนใช้ตัดสินใจ
- ไฟล์ `.eimg` ใน LINE Cache เป็นรูปแบบเข้ารหัสของ LINE — ต้องใช้ปุ่ม Save ในแชทเพื่อได้ไฟล์ต้นฉบับ
