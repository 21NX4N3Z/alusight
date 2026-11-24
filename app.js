/* ============================================================
   AluSight v2 — client-side analysis + ECA zones + chart + FEA + RCA
   No server. All data stays in the browser.
   ============================================================ */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MAXDIM = 1024;

  let current = null;       // rasterized image
  let pores = [];           // detected pores
  let incls = [];           // detected inclusions
  let porosityPct = 0;      // last analysis % porosity
  let zones = [];           // {id,v,i,state,porosity}
  let rca = [];             // {temp,pressure,cool,speed,label}
  let zoneSeq = 0;
  let batchResults = [];
  let calMode = false;
  let calPts = [];
  let serialPort = null;
  let serialReader = null;
  let serialReading = false;
  const SAVE_KEY = 'alusight-v2-session';

  const DATASETS = [
    'Kaggle — crack/scratch on aluminum profiles',
    'Zenodo 12568603 — pore dataset aluminum castings',
    'Mendeley 9t8pzw2995 — OM pore images',
    'PMC10004325 — aluminum defect analysis',
    'MDPI Materials — OM pore analysis',
    'Casting Defects — methodist.edu.in PDF',
    'Materials Defect Analysis — blister/delamination/corrosion'
  ];

  /* ---------------- image utilities ---------------- */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function rasterize(img) {
    let w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(1, MAXDIM / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    try {
      return { canvas, ctx, w, h, data: ctx.getImageData(0, 0, w, h) };
    } catch (e) {
      throw new Error('canvas-tainted');
    }
  }

  function grayscale(data) {
    const n = data.length / 4;
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return g;
  }

  function gaussianKernel(sigma) {
    const r = Math.max(1, Math.ceil(sigma * 2.5));
    const k = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k[i + r] = v; sum += v;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return k;
  }

  function gaussianBlur(g, w, h, sigma) {
    const k = gaussianKernel(sigma);
    const r = (k.length - 1) / 2;
    const tmp = new Float32Array(g.length);
    const out = new Float32Array(g.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -r; j <= r; j++) {
          const xx = Math.min(w - 1, Math.max(0, x + j));
          s += g[y * w + xx] * k[j + r];
        }
        tmp[y * w + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -r; j <= r; j++) {
          const yy = Math.min(h - 1, Math.max(0, y + j));
          s += tmp[yy * w + x] * k[j + r];
        }
        out[y * w + x] = s;
      }
    }
    return out;
  }

  function percentile(arr, pct) {
    const copy = Float32Array.from(arr);
    copy.sort();
    const idx = Math.min(copy.length - 1, Math.max(0, Math.floor((pct / 100) * copy.length)));
    return copy[idx];
  }

  function erode(mask, w, h) {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let ok = true;
      if (x > 0 && !mask[i - 1]) ok = false;
      if (x < w - 1 && !mask[i + 1]) ok = false;
      if (y > 0 && !mask[i - w]) ok = false;
      if (y < h - 1 && !mask[i + w]) ok = false;
      out[i] = ok ? 1 : 0;
    }
    return out;
  }

  function dilate(mask, w, h) {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) { out[i] = 1; continue; }
      let on = false;
      if (x > 0 && mask[i - 1]) on = true;
      if (x < w - 1 && mask[i + 1]) on = true;
      if (y > 0 && mask[i - w]) on = true;
      if (y < h - 1 && mask[i + w]) on = true;
      out[i] = on ? 1 : 0;
    }
    return out;
  }

  function opening(mask, w, h, iters) {
    let m = mask;
    for (let i = 0; i < iters; i++) m = dilate(erode(m, w, h), w, h);
    return m;
  }

  function label(mask, w, h) {
    const labels = new Int32Array(mask.length);
    let next = 1;
    const stack = new Int32Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || labels[i]) continue;
      let sp = 0; stack[sp++] = i; labels[i] = next;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w; }
      }
      next++;
    }
    return { labels, count: next - 1 };
  }

  function extract(labels, count, w, h, umPerPx) {
    const feats = [];
    for (let id = 1; id <= count; id++) {
      let area = 0, sx = 0, sy = 0, minx = w, maxx = 0, miny = h, maxy = 0;
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== id) continue;
        const x = i % w, y = (i / w) | 0;
        area++; sx += x; sy += y;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      if (!area) continue;
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      feats.push({
        id, area,
        cx: sx / area, cy: sy / area,
        bbox: [minx, miny, maxx, maxy],
        d: 2 * Math.sqrt(area / Math.PI) * umPerPx,
        fill: area / (bw * bh),
        aspect: Math.max(bw, bh) / Math.max(1, Math.min(bw, bh))
      });
    }
    return feats;
  }

  /* ---------------- analysis ---------------- */
  function compute(rr) {
    const pct = parseFloat($('pct').value);
    const minUm = parseFloat($('minArea').value);
    const umPer100 = parseFloat($('scale').value);
    const umPerPx = umPer100 / 100;
    const { data, w, h } = rr;
    const gray = grayscale(data.data);
    const blurred = gaussianBlur(gray, w, h, 3);
    const lo = percentile(blurred, pct);
    const hi = percentile(blurred, 100 - pct);
    let poreMask = new Uint8Array(blurred.length);
    let inclMask = new Uint8Array(blurred.length);
    for (let i = 0; i < blurred.length; i++) {
      if (blurred[i] < lo) poreMask[i] = 1;
      if (blurred[i] > hi) inclMask[i] = 1;
    }
    poreMask = opening(poreMask, w, h, 3);
    inclMask = opening(inclMask, w, h, 3);
    const pl = label(poreMask, w, h);
    const foundPores = extract(pl.labels, pl.count, w, h, umPerPx)
      .filter(f => f.d >= minUm && f.fill > 0.45 && f.aspect < 3);
    const il = label(inclMask, w, h);
    const foundIncls = extract(il.labels, il.count, w, h, umPerPx)
      .filter(f => f.d >= minUm * 1.2 && f.fill > 0.3 && f.aspect < 4);
    return {
      pores: foundPores,
      incls: foundIncls,
      porosityPct: 100 * foundPores.reduce((s, p) => s + p.area, 0) / (w * h),
      w, h
    };
  }

  function analyze() {
    if (!current) { setStatus('กรุณาอัปโหลดภาพก่อน'); return; }
    setStatus('กำลังวิเคราะห์…');
    setTimeout(() => {
      try {
        const res = compute(current);
        pores = res.pores; incls = res.incls; porosityPct = res.porosityPct;
        drawOverlay();
        updateStats(res.w, res.h);
        drawPoreMap();
        setStatus('วิเคราะห์เสร็จ · ' + pores.length + ' รูพรุน · ' + incls.length + ' อนุภาค');
        saveSession();
      } catch (e) {
        setStatus('วิเคราะห์ไม่สำเร็จ: ' + e.message);
      }
    }, 30);
  }

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawOverlay() {
    const { canvas, ctx, w, h } = current;
    const out = $('out');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    octx.drawImage(canvas, 0, 0);
    const blue = css('--accent-2') || '#2f81f7';
    const red = css('--red') || '#ff3b30';
    octx.strokeStyle = blue; octx.lineWidth = Math.max(1.5, w / 500);
    incls.forEach(p => {
      const [x0, y0, x1, y1] = p.bbox;
      octx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    });
    octx.strokeStyle = red;
    pores.forEach(p => {
      const [x0, y0, x1, y1] = p.bbox;
      octx.beginPath();
      octx.ellipse(p.cx, p.cy, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2);
      octx.stroke();
    });
    $('empty').style.display = 'none';
    $('detBadge').textContent = (pores.length + incls.length) + ' รายการ';
    if (calPts.length) {
      const green = css('--green') || '#3fb950';
      octx.strokeStyle = green; octx.lineWidth = Math.max(2, w / 400);
      if (calPts.length === 2) {
        octx.beginPath(); octx.moveTo(calPts[0].x, calPts[0].y); octx.lineTo(calPts[1].x, calPts[1].y); octx.stroke();
      }
      calPts.forEach(p => { octx.beginPath(); octx.arc(p.x, p.y, Math.max(4, w / 150), 0, Math.PI * 2); octx.fillStyle = green; octx.fill(); });
    }
  }

  function updateStats(w, h) {
    const pArea = pores.reduce((s, p) => s + p.area, 0);
    const maxD = pores.length ? Math.max.apply(null, pores.map(p => p.d)) : 0;
    $('sPores').textContent = pores.length;
    $('sIncl').textContent = incls.length;
    $('sPct').textContent = porosityPct.toFixed(2) + '%';
    $('sMax').textContent = maxD ? maxD.toFixed(1) : '—';
    const all = pores.map(p => ({ ...p, cls: 'Pore', th: 'รูพรุน' }))
      .concat(incls.map(p => ({ ...p, cls: 'Inclusion', th: 'อนุภาค' })))
      .sort((a, b) => b.area - a.area).slice(0, 12);
    $('detList').innerHTML = all.length
      ? '<table class="data"><thead><tr><th>ประเภท</th><th>#</th><th>⌀ (µm)</th><th>ตำแหน่ง (x,y)</th><th>พื้นที่</th></tr></thead><tbody>' +
        all.map(p => '<tr><td class="' + (p.cls === 'Pore' ? 'defect-text' : '') + '">' + p.cls + '</td><td>' + p.id + '</td><td>' + p.d.toFixed(1) + '</td><td>' + p.cx.toFixed(0) + ',' + p.cy.toFixed(0) + '</td><td>' + p.area.toLocaleString() + ' px</td></tr>').join('') +
        '</tbody></table>'
      : '<span class="muted">ไม่พบรอยบกพร่อง</span>';
  }

  function drawPoreMap() {
    if (!current) return;
    const W = 800, H = 400, pad = 40;
    const iw = W - pad * 2, ih = H - pad * 2;
    const sx = iw / current.w, sy = ih / current.h;
    const color = css('--red') || '#ff3b30';
    const blue = css('--accent-2') || '#2f81f7';
    let s = '<rect x="' + pad + '" y="' + pad + '" width="' + iw + '" height="' + ih + '" rx="12" fill="' + css('--surface') + '" stroke="' + css('--border') + '" stroke-width="2"/>';
    for (let g = 0; g <= 4; g++) {
      const x = pad + iw * g / 4;
      s += '<line x1="' + x + '" y1="' + pad + '" x2="' + x + '" y2="' + (pad + ih) + '" stroke="' + css('--border') + '" stroke-width="1" opacity="0.6"/>';
      s += '<text x="' + x + '" y="' + (pad + ih + 20) + '" fill="' + css('--muted') + '" font-size="13" text-anchor="middle">' + (g * 25) + '%</text>';
    }
    incls.forEach(p => {
      const x = pad + p.cx * sx, y = pad + p.cy * sy, r = Math.max(3, Math.min(12, p.d * 0.5));
      s += '<rect x="' + (x - r) + '" y="' + (y - r) + '" width="' + (r * 2) + '" height="' + (r * 2) + '" fill="' + blue + '" opacity="0.6"/>';
    });
    pores.forEach(p => {
      const x = pad + p.cx * sx, y = pad + p.cy * sy, r = Math.max(3, Math.min(12, p.d * 0.5));
      s += '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + color + '" opacity="0.8"/>';
    });
    $('poreMap').innerHTML = s;
  }

  /* ---------------- zones ---------------- */
  function resistance(z) {
    const v = parseFloat(z.v), i = parseFloat(z.i);
    return (i > 0 && isFinite(v)) ? v / i : 0;
  }

  function addZone(v, i, state, porosity) {
    zoneSeq++;
    zones.push({
      id: zoneSeq,
      v: (v === undefined ? '5.0' : String(v)),
      i: (i === undefined ? '0.5' : String(i)),
      state: (state === undefined ? 'normal' : state),
      porosity: (porosity === undefined ? (porosityPct ? porosityPct.toFixed(2) : '0.00') : String(porosity))
    });
    renderZones();
  }

  function renderZones() {
    const body = $('zoneBody');
    if (!zones.length) {
      body.innerHTML = '<tr><td colspan="7" class="muted">ยังไม่มีบริเวณ — กด "เพิ่มบริเวณ"</td></tr>';
    } else {
      body.innerHTML = zones.map((z, idx) => {
        const r = resistance(z);
        const cls = z.state === 'defect' ? 'defect-text' : 'normal-text';
        return '<tr>' +
          '<td>บริเวณ ' + (idx + 1) + '</td>' +
          '<td><input type="number" step="0.1" min="0" value="' + z.v + '" data-z="' + z.id + '" data-f="v" aria-label="Voltage บริเวณ ' + (idx + 1) + '"></td>' +
          '<td><input type="number" step="0.01" min="0" value="' + z.i + '" data-z="' + z.id + '" data-f="i" aria-label="Current บริเวณ ' + (idx + 1) + '"></td>' +
          '<td class="n">' + (r ? r.toFixed(3) : '—') + '</td>' +
          '<td><select data-z="' + z.id + '" data-f="state" aria-label="สภาพบริเวณ ' + (idx + 1) + '">' +
            '<option value="normal"' + (z.state === 'normal' ? ' selected' : '') + '>ปกติ</option>' +
            '<option value="defect"' + (z.state === 'defect' ? ' selected' : '') + '>ดีเฟค</option>' +
          '</select></td>' +
          '<td><input type="number" step="0.01" min="0" max="100" value="' + z.porosity + '" data-z="' + z.id + '" data-f="porosity" aria-label="เปอร์เซ็นต์รูพรุนบริเวณ ' + (idx + 1) + '"></td>' +
          '<td><button class="icon-btn" type="button" data-del="' + z.id + '" aria-label="ลบบริเวณ ' + (idx + 1) + '">×</button></td>' +
          '</tr>';
      }).join('');
    }
    $('zoneCount').textContent = zones.length + ' บริเวณ';
    body.querySelectorAll('input,select').forEach(el => {
      el.addEventListener('change', () => {
        const z = zones.find(x => x.id === parseInt(el.dataset.z, 10));
        if (!z) return;
        z[el.dataset.f] = el.value;
        renderZones();
        renderChart();
        renderFea();
      });
    });
    body.querySelectorAll('[data-del]').forEach(el => {
      el.addEventListener('click', () => {
        zones = zones.filter(x => x.id !== parseInt(el.dataset.del, 10));
        renderZones(); renderChart(); renderFea();
      });
    });
  }

  function autoZones() {
    if (!pores.length) { setStatus('ยังไม่มีผลตรวจจับ — วิเคราะห์ภาพก่อน'); return; }
    zones = [];
    zoneSeq = 0;
    const buckets = 6;
    for (let b = 0; b < buckets; b++) {
      const inBucket = pores.filter(p => Math.floor((p.cx / current.w) * buckets) === b);
      const avgD = inBucket.length ? inBucket.reduce((s, p) => s + p.d, 0) / inBucket.length : 0;
      const por = Math.min(12, (inBucket.length ? porosityPct * (0.5 + inBucket.length / 6) : porosityPct * 0.15) + (avgD > 10 ? avgD * 0.02 : 0));
      addZone((5 + b * 0.4).toFixed(1), (0.5 - b * 0.02).toFixed(3), inBucket.length >= 2 ? 'defect' : 'normal', por.toFixed(2));
    }
    setStatus('เติม ' + zones.length + ' บริเวณจากผลตรวจจับแล้ว');
    renderChart(); renderFea();
  }

  /* ---------------- chart ---------------- */
  function linreg(points) {
    const n = points.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    points.forEach(p => { sx += p.x; sy += p.y; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y; });
    const den = n * sxx - sx * sx;
    if (!den) return null;
    const b = (n * sxy - sx * sy) / den;
    const a = (sy - b * sx) / n;
    const r = (n * sxy - sx * sy) / Math.sqrt(den * (n * syy - sy * sy));
    return { a, b, r };
  }

  function renderChart() {
    const svg = $('resChart');
    const W = 800, H = 420, pad = 64;
    const iw = W - pad * 2, ih = H - pad * 2;
    const pts = zones.map(z => ({ x: resistance(z), y: parseFloat(z.porosity) || 0, state: z.state })).filter(p => p.x > 0 && isFinite(p.x));
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const xmax = Math.max(1, Math.max.apply(null, xs.concat([1])) * 1.15);
    const ymax = Math.max(1, Math.max.apply(null, ys.concat([1])) * 1.15);
    const X = v => pad + (v / xmax) * iw;
    const Y = v => pad + ih - (v / ymax) * ih;
    const border = css('--border'), muted = css('--muted'), accent = css('--accent');
    const red = css('--red'), green = css('--green'), surf = css('--surface-2');
    let s = '<rect x="' + pad + '" y="' + pad + '" width="' + iw + '" height="' + ih + '" rx="12" fill="' + surf + '" stroke="' + border + '" stroke-width="2"/>';
    for (let g = 0; g <= 5; g++) {
      const gx = pad + iw * g / 5, gy = pad + ih - ih * g / 5;
      s += '<line x1="' + gx + '" y1="' + pad + '" x2="' + gx + '" y2="' + (pad + ih) + '" stroke="' + border + '" opacity="0.5"/>';
      s += '<line x1="' + pad + '" y1="' + gy + '" x2="' + (pad + iw) + '" y2="' + gy + '" stroke="' + border + '" opacity="0.5"/>';
      s += '<text x="' + gx + '" y="' + (pad + ih + 22) + '" fill="' + muted + '" font-size="13" text-anchor="middle">' + (xmax * g / 5).toFixed(1) + '</text>';
      s += '<text x="' + (pad - 12) + '" y="' + (gy + 4) + '" fill="' + muted + '" font-size="13" text-anchor="end">' + (ymax * g / 5).toFixed(1) + '</text>';
    }
    s += '<text x="' + (pad + iw / 2) + '" y="' + (H - 12) + '" fill="' + muted + '" font-size="14" text-anchor="middle">ความต้านทาน R (Ω)</text>';
    s += '<text x="16" y="' + (pad + ih / 2) + '" fill="' + muted + '" font-size="14" text-anchor="middle" transform="rotate(-90 16 ' + (pad + ih / 2) + ')">% porosity</text>';
    const reg = linreg(pts);
    if (reg) {
      const x1 = 0, x2 = xmax;
      s += '<line x1="' + X(x1) + '" y1="' + Y(reg.a + reg.b * x1) + '" x2="' + X(x2) + '" y2="' + Y(reg.a + reg.b * x2) + '" stroke="' + accent + '" stroke-width="3" stroke-dasharray="8 6"/>';
      $('corrVal').textContent = 'r = ' + reg.r.toFixed(3) + ' · slope = ' + reg.b.toFixed(3);
    } else {
      $('corrVal').textContent = 'r = —';
    }
    pts.forEach(p => {
      const col = p.state === 'defect' ? red : green;
      s += '<circle cx="' + X(p.x) + '" cy="' + Y(p.y) + '" r="8" fill="' + col + '" stroke="' + surf + '" stroke-width="2"/>';
      s += '<text x="' + (X(p.x) + 12) + '" y="' + (Y(p.y) - 10) + '" fill="' + muted + '" font-size="12">' + p.y.toFixed(2) + '</text>';
    });
    if (!pts.length) {
      s += '<text x="' + (pad + iw / 2) + '" y="' + (pad + ih / 2) + '" fill="' + muted + '" font-size="16" text-anchor="middle">เพิ่มบริเวณวัดเพื่อดูกราฟ</text>';
    }
    svg.innerHTML = s;
  }

  /* ---------------- FEA heatmap ---------------- */
  function heatColor(t) {
    const a = [18, 98, 135], b = [248, 81, 73];
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return 'rgb(' + c.join(',') + ')';
  }

  function renderFea() {
    const svg = $('feaMap');
    const cols = 10, rows = 6, pad = 24;
    const cw = (640 - pad * 2) / cols, ch = (360 - pad * 2) / rows;
    const border = css('--border'), surf = css('--surface-2');
    const maxP = Math.max(1, Math.max.apply(null, zones.map(z => parseFloat(z.porosity) || 0).concat([1])));
    let s = '<rect x="0" y="0" width="640" height="360" rx="12" fill="' + surf + '"/>';
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const idx = Math.round((x / cols) * (zones.length - 1));
      const z = zones[idx];
      const p = z ? (parseFloat(z.porosity) || 0) : 0;
      const t = Math.min(1, p / maxP);
      s += '<rect x="' + (pad + x * cw + 2) + '" y="' + (pad + y * ch + 2) + '" width="' + (cw - 4) + '" height="' + (ch - 4) + '" rx="4" fill="' + heatColor(t) + '" opacity="' + (0.35 + t * 0.65).toFixed(2) + '"/>';
    }
    zones.forEach((z, i) => {
      const gx = Math.round((i / Math.max(1, zones.length - 1)) * (cols - 1));
      const gx2 = Math.min(cols - 1, Math.max(0, gx));
      const cx = pad + gx2 * cw + cw / 2;
      const cy = pad + ch / 2;
      s += '<text x="' + cx + '" y="' + cy + '" fill="#ffffff" font-size="14" font-weight="700" text-anchor="middle">' + (i + 1) + '</text>';
    });
    s += '<rect x="' + pad + '" y="' + pad + '" width="' + (cols * cw) + '" height="' + (rows * ch) + '" rx="12" fill="none" stroke="' + border + '" stroke-width="2"/>';
    svg.innerHTML = s;

    if (!zones.length) {
      $('riskScore').textContent = '—';
      $('riskText').textContent = 'เพิ่มบริเวณวัดเพื่อดูผลประเมิน';
      $('hotspot').textContent = '—';
      return;
    }
    const ps = zones.map(z => parseFloat(z.porosity) || 0);
    const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
    const defectRatio = zones.filter(z => z.state === 'defect').length / zones.length;
    const risk = Math.min(100, Math.round(avg * 8 + defectRatio * 30));
    $('riskScore').textContent = risk;
    $('riskText').textContent = 'ค่าเฉลี่ย porosity ' + avg.toFixed(2) + '% · บริเวณดีเฟค ' +
      zones.filter(z => z.state === 'defect').length + '/' + zones.length + ' · ความต้านทานเฉลี่ย ' +
      (zones.reduce((a, z) => a + resistance(z), 0) / zones.length).toFixed(3) + ' Ω';
    let hot = zones[0];
    zones.forEach(z => { if ((parseFloat(z.porosity) || 0) > (parseFloat(hot.porosity) || 0)) hot = z; });
    $('hotspot').innerHTML = 'บริเวณ ' + (zones.indexOf(hot) + 1) + ' · porosity ' +
      (parseFloat(hot.porosity) || 0).toFixed(2) + '% · R = ' + resistance(hot).toFixed(3) + ' Ω';
  }

  /* ---------------- RCA ---------------- */
  function renderRca() {
    const body = $('rcaBody');
    if (!rca.length) {
      body.innerHTML = '<tr><td colspan="7" class="muted">ยังไม่มี record — กด "เพิ่ม record"</td></tr>';
    } else {
      body.innerHTML = rca.map((r, i) =>
        '<tr><td>' + (i + 1) + '</td>' +
        ['temp', 'pressure', 'cool', 'speed'].map(f => '<td><input type="number" step="0.1" value="' + r[f] + '" data-r="' + i + '" data-f="' + f + '" aria-label="record ' + (i + 1) + ' ' + f + '"></td>').join('') +
        '<td><select data-r="' + i + '" data-f="label" aria-label="label record ' + (i + 1) + '">' +
          '<option value="good"' + (r.label === 'good' ? ' selected' : '') + '>ดี</option>' +
          '<option value="defect"' + (r.label === 'defect' ? ' selected' : '') + '>เสีย</option></select></td>' +
        '<td><button class="icon-btn" type="button" data-rdel="' + i + '" aria-label="ลบ record ' + (i + 1) + '">×</button></td></tr>'
      ).join('');
    }
    $('rcaCount').textContent = rca.length + ' record';
    body.querySelectorAll('input,select').forEach(el => {
      el.addEventListener('change', () => {
        rca[parseInt(el.dataset.r, 10)][el.dataset.f] = el.value;
      });
    });
    body.querySelectorAll('[data-rdel]').forEach(el => {
      el.addEventListener('click', () => {
        rca.splice(parseInt(el.dataset.rdel, 10), 1);
        renderRca();
      });
    });
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const data = {
      app: 'AluSight v2',
      exportedAt: new Date().toISOString(),
      general: {
        batch: $('gBatch').value, grade: $('gGrade').value,
        lengthMm: $('gLen').value, widthMm: $('gWid').value,
        thicknessMm: $('gThk').value, process: $('gProc').value
      },
      analysis: {
        pores: pores.length, inclusions: incls.length,
        porosityPct: +porosityPct.toFixed(3),
        parameters: { percentile: $('pct').value, minPoreUm: $('minArea').value, scaleUmPer100Px: $('scale').value },
        detections: pores.map(p => ({ id: p.id, cx: +p.cx.toFixed(1), cy: +p.cy.toFixed(1), diameterUm: +p.d.toFixed(2), areaPx: p.area }))
      },
      ecaZones: zones.map((z, i) => ({ zone: i + 1, voltage: +z.v, current: +z.i, resistanceOhm: +resistance(z).toFixed(4), state: z.state, porosityPct: +z.porosity })),
      rca: rca,
      references: DATASETS
    };
    download('alusight-session.json', JSON.stringify(data, null, 2), 'application/json');
    $('exportStatus').textContent = 'ส่งออก JSON แล้ว';
  }

  function exportCsv() {
    const head = 'zone,voltage,current,resistance,state,porosity_pct\n';
    const rows = zones.map((z, i) => [i + 1, z.v, z.i, resistance(z).toFixed(4), z.state, z.porosity].join(',')).join('\n');
    download('alusight-zones.csv', head + rows, 'text/csv');
    $('exportStatus').textContent = 'ส่งออก CSV แล้ว';
  }

  /* ---------------- persistence / import / export ---------------- */
  function sessionSnapshot() {
    return {
      app: 'AluSight v2',
      savedAt: new Date().toISOString(),
      general: {
        batch: $('gBatch').value, grade: $('gGrade').value,
        lengthMm: $('gLen').value, widthMm: $('gWid').value,
        thicknessMm: $('gThk').value, process: $('gProc').value
      },
      params: { percentile: $('pct').value, minPoreUm: $('minArea').value, scaleUmPer100Px: $('scale').value },
      zones: zones, rca: rca, batch: batchResults
    };
  }

  function applySession(d) {
    if (!d || typeof d !== 'object') throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
    const g = d.general || {};
    const set = (id, v) => { if (v !== undefined && $(id)) $(id).value = v; };
    set('gBatch', g.batch); set('gGrade', g.grade); set('gLen', g.lengthMm);
    set('gWid', g.widthMm); set('gThk', g.thicknessMm); set('gProc', g.process);
    const p = d.params || {};
    set('pct', p.percentile); set('minArea', p.minPoreUm); set('scale', p.scaleUmPer100Px);
    zones = Array.isArray(d.zones) ? d.zones : [];
    rca = Array.isArray(d.rca) ? d.rca : [];
    batchResults = Array.isArray(d.batch) ? d.batch : [];
    zoneSeq = zones.reduce((m, z) => Math.max(m, parseInt(z.id, 10) || 0), 0);
    sync(); renderZones(); renderRca(); renderChart(); renderFea(); renderBatch();
  }

  function saveSession() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(sessionSnapshot()));
      $('saveStatus').textContent = 'บันทึกอัตโนมัติ: ' + new Date().toLocaleTimeString('th-TH');
    } catch (e) {
      $('saveStatus').textContent = 'บันทึกอัตโนมัติ: ไม่ได้ (' + e.message + ')';
    }
  }

  function restoreSession() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) { applySession(JSON.parse(raw)); $('saveStatus').textContent = 'กู้คืน session ล่าสุดแล้ว'; }
    } catch (e) {
      $('saveStatus').textContent = 'กู้คืนไม่ได้: ' + e.message;
    }
  }

  function resetSession() {
    if (!window.confirm('ล้างข้อมูลทั่วไป โซนวัด RCA และผลชุดภาพทั้งหมด?')) return;
    localStorage.removeItem(SAVE_KEY);
    zones = []; rca = []; batchResults = []; zoneSeq = 0;
    ['gBatch', 'gGrade', 'gLen', 'gWid', 'gThk', 'gProc'].forEach(id => { if ($(id)) $(id).value = ''; });
    renderZones(); renderRca(); renderChart(); renderFea(); renderBatch();
    $('saveStatus').textContent = 'ล้างข้อมูลแล้ว';
  }

  function importSession(file) {
    const r = new FileReader();
    r.onload = ev => {
      try {
        applySession(JSON.parse(ev.target.result));
        saveSession();
        $('exportStatus').textContent = 'นำเข้า session แล้ว';
      } catch (e) {
        $('exportStatus').textContent = 'นำเข้าไม่สำเร็จ: ' + e.message;
      }
    };
    r.onerror = () => { $('exportStatus').textContent = 'อ่านไฟล์ไม่สำเร็จ'; };
    r.readAsText(file);
  }

  function exportRcaCsv() {
    const head = 'temp_c,pressure_bar,cool_s,speed_mm_s,label\n';
    const rows = rca.map(r => [r.temp, r.pressure, r.cool, r.speed, r.label].join(',')).join('\n');
    download('alusight-rca.csv', head + rows, 'text/csv');
    $('exportStatus').textContent = 'ส่งออก CSV (RCA) แล้ว';
  }

  /* ---------------- calibration ---------------- */
  function setupCalibration() {
    $('calBtn').addEventListener('click', () => {
      if (!current) { setStatus('ต้องโหลดภาพก่อน'); return; }
      calMode = !calMode; calPts = [];
      document.querySelector('.canvas-wrap').classList.toggle('calibrating', calMode);
      $('calHint').textContent = calMode
        ? 'กำลังปรับเทียบ — คลิกจุดแรกของมาตราอ้างอิงบนภาพ'
        : 'กดปุ่มแล้วคลิกสองจุดบนภาพที่เป็นมาตราอ้างอิง — ระบบจะคำนวณ µm/px ให้';
      drawOverlay();
    });
    $('out').addEventListener('click', e => {
      if (!calMode || !current) return;
      const r = $('out').getBoundingClientRect();
      const x = (e.clientX - r.left) * (current.w / r.width);
      const y = (e.clientY - r.top) * (current.h / r.height);
      calPts.push({ x, y });
      if (calPts.length === 1) {
        $('calHint').textContent = 'คลิกจุดที่สองของมาตราอ้างอิง';
      } else {
        const dist = Math.hypot(calPts[1].x - calPts[0].x, calPts[1].y - calPts[0].y);
        const known = parseFloat($('calLen').value) || 100;
        if (dist > 2) {
          const umPer100 = (known / dist) * 100;
          $('scale').value = Math.max(10, Math.min(100, umPer100));
          sync();
          $('calHint').textContent = 'ปรับเทียบแล้ว: ' + umPer100.toFixed(2) + ' µm/100px จากระยะ ' +
            dist.toFixed(1) + ' px ที่กำหนดเป็น ' + known + ' µm';
          setStatus('ปรับเทียบสเกลจากภาพแล้ว');
          saveSession();
        } else {
          $('calHint').textContent = 'ระยะสั้นเกินไป — กดปุ่มแล้วลองใหม่';
          calPts = [];
        }
        calMode = false;
        document.querySelector('.canvas-wrap').classList.remove('calibrating');
        drawOverlay();
      }
    });
  }

  /* ---------------- batch ---------------- */
  function renderBatch() {
    const box = $('batchResult');
    if (!batchResults.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="card"><h4>ผลวิเคราะห์ชุดภาพ <span class="tag-sm">' +
      batchResults.length + ' ภาพ</span></h4><div class="table-scroll"><table class="data">' +
      '<thead><tr><th>ไฟล์</th><th>รูพรุน</th><th>อนุภาค</th><th>% porosity</th><th>สถานะ</th></tr></thead><tbody>' +
      batchResults.map(r => '<tr><td>' + (r.name || '—') + '</td><td>' + (r.pores === undefined ? '—' : r.pores) +
        '</td><td>' + (r.incls === undefined ? '—' : r.incls) + '</td><td>' +
        (r.porosityPct === undefined ? '—' : Number(r.porosityPct).toFixed(2) + '%') + '</td><td>' +
        (r.error ? '<span class="defect-text">' + r.error + '</span>' : '<span class="normal-text">สำเร็จ</span>') +
        '</td></tr>').join('') + '</tbody></table></div></div>';
  }

  async function runBatch(files) {
    if (!files.length) return;
    batchResults = [];
    $('batchInfo').textContent = 'กำลังวิเคราะห์ ' + files.length + ' ภาพ…';
    for (const f of files) {
      try {
        const src = await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f);
        });
        const img = await loadImage(src);
        const rr = rasterize(img);
        const res = compute(rr);
        batchResults.push({
          name: f.name, pores: res.pores.length, incls: res.incls.length,
          porosityPct: +res.porosityPct.toFixed(3), w: res.w, h: res.h
        });
      } catch (e) {
        batchResults.push({ name: f.name, error: e.message });
      }
    }
    renderBatch();
    $('batchInfo').textContent = 'วิเคราะห์ชุดเสร็จ (' + batchResults.length + ' ภาพ)';
    setStatus('วิเคราะห์ชุดภาพเสร็จแล้ว');
    saveSession();
  }

  /* ---------------- ECA over WebSerial ---------------- */
  function parseSerialLine(line) {
    const s = String(line).trim();
    let m = s.match(/V\s*[:=]?\s*([0-9.]+)[\s,;]+I\s*[:=]?\s*([0-9.]+)/i);
    if (m) return { v: parseFloat(m[1]), i: parseFloat(m[2]) };
    m = s.match(/^([0-9.]+)[\s,;]+([0-9.]+)$/);
    if (m) return { v: parseFloat(m[1]), i: parseFloat(m[2]) };
    return null;
  }

  async function toggleSerial() {
    if (serialReading && serialReader) {
      serialReading = false;
      try { await serialReader.cancel(); } catch (e) { /* ignore */ }
      if (serialPort) { try { await serialPort.close(); } catch (e) { /* ignore */ } }
      serialReader = null; serialPort = null;
      $('serialBtn').textContent = 'เชื่อมเครื่อง ECA';
      $('serialStatus').textContent = 'หยุดอ่านข้อมูลแล้ว';
      return;
    }
    if (!('serial' in navigator)) {
      $('serialStatus').textContent = 'เบราว์เซอร์นี้ไม่รองรับ WebSerial — ใช้ Chrome หรือ Edge';
      return;
    }
    try {
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: 9600 });
      serialReading = true;
      $('serialBtn').textContent = 'หยุดอ่านเครื่อง';
      $('serialStatus').textContent = 'เชื่อมต่อแล้ว — รอข้อมูล V/I';
      serialReader = serialPort.readable.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (serialReading) {
        const got = await serialReader.read();
        if (got.done) break;
        buf += decoder.decode(got.value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(line => {
          const p = parseSerialLine(line);
          if (!p || !isFinite(p.v) || !isFinite(p.i) || p.i === 0) return;
          if (!zones.length) addZone();
          zones[0].v = p.v.toFixed(3);
          zones[0].i = p.i.toFixed(4);
          renderZones(); renderChart(); renderFea();
          $('serialStatus').textContent = 'V=' + p.v + ' I=' + p.i + ' R=' + (p.v / p.i).toFixed(3) + ' Ω';
          saveSession();
        });
      }
    } catch (e) {
      serialReading = false;
      $('serialStatus').textContent = 'เชื่อมต่อไม่ได้: ' + e.message;
      $('serialBtn').textContent = 'เชื่อมเครื่อง ECA';
    }
  }

  /* ---------------- wiring ---------------- */
  function setStatus(t) { $('status').textContent = t; }

  async function setImage(src) {
    setStatus('กำลังโหลดภาพ…');
    try {
      const img = await loadImage(src);
      current = rasterize(img);
      pores = []; incls = []; porosityPct = 0;
      const out = $('out');
      out.width = current.w; out.height = current.h;
      out.getContext('2d').drawImage(current.canvas, 0, 0);
      $('empty').style.display = 'none';
      setStatus('โหลดภาพแล้ว (' + current.w + '×' + current.h + ') — กด "วิเคราะห์ภาพ"');
      $('detBadge').textContent = '—';
      $('sPores').textContent = '–'; $('sIncl').textContent = '–';
      $('sPct').textContent = '–'; $('sMax').textContent = '–';
      $('detList').innerHTML = '<span class="muted">กด "วิเคราะห์ภาพ" เพื่อเริ่ม</span>';
    } catch (e) {
      setStatus(e.message === 'canvas-tainted'
        ? 'อ่านภาพจากไฟล์ในเครื่องไม่ได้ — เปิดผ่านเซิร์ฟเวอร์ เช่น python -m http.server'
        : 'โหลดภาพไม่สำเร็จ');
    }
  }

  const drop = $('drop'), file = $('file');
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = ev => setImage(ev.target.result);
    r.readAsDataURL(f);
  });
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = ev => setImage(ev.target.result);
    r.readAsDataURL(f);
  });
  document.querySelectorAll('.sample').forEach(b => b.addEventListener('click', () => setImage(SAMPLES[b.dataset.key])));

  $('run').addEventListener('click', analyze);
  $('addZone').addEventListener('click', () => { addZone(); saveSession(); });
  $('autoZone').addEventListener('click', () => { autoZones(); saveSession(); });
  $('serialBtn').addEventListener('click', toggleSerial);
  $('calBtn') && setupCalibration();
  $('batchBtn').addEventListener('click', () => $('batchFiles').click());
  $('batchFiles').addEventListener('change', e => {
    runBatch(Array.from(e.target.files || []));
  });
  $('addRca').addEventListener('click', () => {
    rca.push({ temp: '700', pressure: '80', cool: '12', speed: '45', label: 'good' });
    renderRca(); saveSession();
  });
  $('exportJson').addEventListener('click', exportJson);
  $('exportCsv').addEventListener('click', exportCsv);
  $('exportRcaCsv').addEventListener('click', exportRcaCsv);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) importSession(f);
  });
  $('printBtn').addEventListener('click', () => window.print());
  $('resetBtn').addEventListener('click', resetSession);

  const theme = $('themeToggle');
  theme.addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    theme.setAttribute('aria-checked', String(dark));
    $('themeLabel').textContent = dark ? 'โหมดมืด' : 'โหมดสว่าง';
    renderChart(); renderFea();
    if (pores.length) { drawOverlay(); drawPoreMap(); }
    saveSession();
  });

  const sync = () => {
    $('pctVal').textContent = parseFloat($('pct').value).toFixed(1) + '%';
    $('minAreaVal').textContent = $('minArea').value + ' µm';
    $('scaleVal').textContent = $('scale').value + ' µm/100px';
  };
  ['pct', 'minArea', 'scale'].forEach(id => $(id).addEventListener('input', sync));
  ['pct', 'minArea', 'scale'].forEach(id => $(id).addEventListener('change', saveSession));
  ['gBatch', 'gGrade', 'gLen', 'gWid', 'gThk', 'gProc'].forEach(id => $(id).addEventListener('change', saveSession));
  sync();

  renderZones(); renderRca(); renderChart(); renderFea(); renderBatch();
  restoreSession();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
