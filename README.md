# AluSight

**AI-Powered Aluminum Defect Inspection** — ระบบตรวจจับรูพรุนและข้อบกพร่องทางโครงสร้างอะลูมิเนียมหล่อ ด้วยปัญญาประดิษฐ์ (AI) + กล้องจุลทรรศน์ (Optical Microscope) + Eddy Current Array (ECA)

> ผลงานเข้าร่วมประกวด **นวัตกรรมสายอุดมศึกษา ประจำปี 2570 (Higher Education Innovation Awards 2027)**
> ด้านวิศวกรรมศาสตร์ เทคโนโลยีปัญญาประดิษฐ์ และอุปกรณ์อัจฉริยะ

## ฟีเจอร์

- **Microstructure Map** — ภาพจุลทรรศน์ + การตรวจจับรูพรุน/อนุภาคอัตโนมัติ
- **Electrical Map** — แผนที่สัญญาณ Eddy Current Array บนกริด X,Y
- **AI Defect Detection** — จำแนกและระบุตำแหน่งรอยบกพร่องพร้อม confidence score
- **Pore Map** — การกระจายตัวของรูพรุนบนชิ้นงาน
- **Traceability** — เทียบ defect กับกระบวนการผลิตและแสดงแนวโน้มการปรับปรุง

## โครงสร้าง

```
├── index.html      ← หน้าเว็บหลัก (10 ส่วน)
├── styles.css      ← ดีไซน์
├── script.js       ← interactions
├── dashboard.html  ← dashboard วิเคราะห์ข้อมูล
└── assets/         ← ภาพประกอบ
```

## รันในเครื่อง

เปิด `index.html` ในเบราว์เซอร์ได้ทันที (static site ไม่ต้อง build)

## เทคโนโลยี

- Static HTML / CSS / JavaScript (self-contained)
- Python + OpenCV/scipy สำหรับการวิเคราะห์ภาพ (pipeline แยก)

## ทีม

- นิสิต: —
- อาจารย์ที่ปรึกษา: —
- สถาบัน: —
