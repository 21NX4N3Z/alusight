/* ============================================================
   AluSight Tool — client-side image analysis (no server)
   pipeline: grayscale → gaussian blur → percentile threshold
             → morphological opening → connected components
   ============================================================ */
(function () {
  const $ = (id) => document.getElementById(id);
  const MAXDIM = 1024; // downscale for performance

  let current = null; // { img, canvas, ctx, w, h, data }

  /* ---------- image loading ---------- */
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

  /* ---------- image processing ---------- */
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
    // horizontal
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
    // vertical
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
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        let ok = true;
        if (x > 0 && !mask[i - 1]) ok = false;
        if (x < w - 1 && !mask[i + 1]) ok = false;
        if (y > 0 && !mask[i - w]) ok = false;
        if (y < h - 1 && !mask[i + w]) ok = false;
        out[i] = ok ? 1 : 0;
      }
    }
    return out;
  }

  function dilate(mask, w, h) {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (mask[i]) { out[i] = 1; continue; }
        let on = false;
        if (x > 0 && mask[i - 1]) on = true;
        if (x < w - 1 && mask[i + 1]) on = true;
        if (y > 0 && mask[i - w]) on = true;
        if (y < h - 1 && mask[i + w]) on = true;
        out[i] = on ? 1 : 0;
      }
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
      const fill = area / (bw * bh);
      const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
      feats.push({
        id, area,
        cx: sx / area, cy: sy / area,
        bbox: [minx, miny, maxx, maxy],
        d: 2 * Math.sqrt(area / Math.PI) * umPerPx,
        fill, aspect,
      });
    }
    return feats;
  }

  /* ---------- analysis ---------- */
  function analyze() {
    if (!current) { setStatus('กรุณาอัปโหลดภาพก่อน'); return; }
    const pct = parseFloat($('pct').value);
    const minUm = parseFloat($('minArea').value);
    const umPer100 = parseFloat($('scale').value);
    const umPerPx = umPer100 / 100;

    setStatus('กำลังวิเคราะห์…');
    // let the UI paint
    setTimeout(() => {
      const { data, w, h } = current;
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

      const minAreaPx = Math.pow(minUm / umPerPx, 2) / Math.PI * 4; // area for diameter minUm
      const pores = extract(label(poreMask, w, h).labels, label(poreMask, w, h).count, w, h, umPerPx)
        .filter(f => f.d >= minUm && f.fill > 0.45 && f.aspect < 3);
      const il = label(inclMask, w, h);
      const incls = extract(il.labels, il.count, w, h, umPerPx)
        .filter(f => f.d >= minUm * 1.2 && f.fill > 0.3 && f.aspect < 4);

      drawOverlay(pores, incls);
      updateStats(pores, incls, w, h);
      drawPoreMap(pores, incls, w, h);
      setStatus(`วิเคราะห์เสร็จ · ${pores.length} รูพรุน · ${incls.length} อนุภาค`);
    }, 30);
  }

  /* ---------- rendering ---------- */
  function drawOverlay(pores, incls) {
    const { canvas, ctx, w, h } = current;
    const out = $('out');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    octx.drawImage(canvas, 0, 0);
    // inclusions (blue squares)
    octx.strokeStyle = '#2563eb'; octx.lineWidth = Math.max(1.5, w / 500);
    incls.forEach(p => {
      const [x0, y0, x1, y1] = p.bbox;
      octx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    });
    // pores (red ellipses)
    octx.strokeStyle = '#ff3b30';
    pores.forEach(p => {
      const [x0, y0, x1, y1] = p.bbox;
      octx.beginPath();
      octx.ellipse(p.cx, p.cy, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2);
      octx.stroke();
    });
    $('empty').style.display = 'none';
    $('detBadge').textContent = (pores.length + incls.length) + ' รายการ';
  }

  function updateStats(pores, incls, w, h) {
    const total = w * h;
    const pArea = pores.reduce((s, p) => s + p.area, 0);
    const maxD = pores.length ? Math.max(...pores.map(p => p.d)) : 0;
    $('sPores').textContent = pores.length;
    $('sIncl').textContent = incls.length;
    $('sPct').textContent = (100 * pArea / total).toFixed(2) + '%';
    $('sMax').textContent = maxD ? maxD.toFixed(1) + ' µm' : '—';

    const all = [...pores.map(p => ({ ...p, cls: 'Pore', th: 'รูพรุน' })),
                 ...incls.map(p => ({ ...p, cls: 'Inclusion', th: 'อนุภาค' }))]
      .sort((a, b) => b.area - a.area).slice(0, 12);
    $('detList').innerHTML = all.length
      ? '<table style="width:100%;border-collapse:collapse;font-size:12.5px">' +
        '<tr style="color:var(--muted);text-align:left"><th>ประเภท</th><th>#</th><th>⌀ (µm)</th><th>พื้นที่</th></tr>' +
        all.map(p => `<tr><td><span style="color:${p.cls === 'Pore' ? 'var(--red)' : '#2563eb'};font-weight:700">${p.cls === 'Pore' ? 'PORE' : 'INCL'}</span></td><td>${p.id}</td><td>${p.d.toFixed(1)}</td><td>${p.area.toLocaleString()} px</td></tr>`).join('') +
        '</table>'
      : '<span style="color:var(--muted)">ไม่พบรอยบกพร่อง</span>';
  }

  function drawPoreMap(pores, incls, w, h) {
    const W = 800, H = 400, pad = 40;
    const iw = W - pad * 2, ih = H - pad * 2;
    const sx = iw / w, sy = ih / h;
    let s = `<rect x="${pad}" y="${pad}" width="${iw}" height="${ih}" rx="10" fill="#fff" stroke="var(--border)" stroke-width="1.5"/>`;
    for (let g = 0; g <= 4; g++) {
      const x = pad + iw * g / 4;
      s += `<line x1="${x}" y1="${pad}" x2="${x}" y2="${pad + ih}" stroke="var(--border)" stroke-width="0.5" opacity="0.6"/>`;
      s += `<text x="${x}" y="${pad + ih + 18}" fill="var(--muted)" font-size="11" text-anchor="middle">${(g * 25)}%</text>`;
    }
    incls.forEach(p => {
      const x = pad + p.cx * sx, y = pad + p.cy * sy, r = Math.max(2, Math.min(8, p.d * 0.4));
      s += `<rect x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" fill="#2563eb" opacity="0.6"/>`;
    });
    pores.forEach(p => {
      const x = pad + p.cx * sx, y = pad + p.cy * sy, r = Math.max(2, Math.min(8, p.d * 0.4));
      s += `<circle cx="${x}" cy="${y}" r="${r}" fill="var(--red)" opacity="0.8"/>`;
    });
    $('poreMap').innerHTML = s;
  }

  function setStatus(t) { $('status').textContent = t; }

  /* ---------- wiring ---------- */
  async function setImage(src, label) {
    setStatus('กำลังโหลดภาพ…');
    try {
      const img = await loadImage(src);
      current = rasterize(img);
      // draw original to output
      const out = $('out');
      out.width = current.w; out.height = current.h;
      out.getContext('2d').drawImage(current.canvas, 0, 0);
      $('empty').style.display = 'none';
      setStatus('โหลดภาพแล้ว (' + current.w + '×' + current.h + ') — กด "วิเคราะห์ภาพ"');
      $('detBadge').textContent = '—';
      $('sPores').textContent = '–'; $('sIncl').textContent = '–';
      $('sPct').textContent = '–'; $('sMax').textContent = '–';
      $('detList').innerHTML = '<span style="color:var(--muted)">กด "วิเคราะห์ภาพ" เพื่อเริ่ม</span>';
    } catch (e) {
      setStatus(e.message === 'canvas-tainted'
        ? 'ไม่สามารถอ่านภาพจากไฟล์ในเครื่อง (file://) — กรุณาใช้เวอร์ชันออนไลน์ หรือเปิดผ่านเซิร์ฟเวอร์ (เช่น python -m http.server)'
        : 'โหลดภาพไม่สำเร็จ');
    }
  }

  const drop = $('drop'), file = $('file');
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => setImage(ev.target.result, f.name);
    r.readAsDataURL(f);
  });
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => setImage(ev.target.result, f.name);
    r.readAsDataURL(f);
  });

  document.querySelectorAll('.sample').forEach(b => b.addEventListener('click', () => setImage(SAMPLES[b.dataset.key])));

  $('run').addEventListener('click', analyze);

  // parameter labels
  const sync = () => {
    $('pctVal').textContent = parseFloat($('pct').value).toFixed(1) + '%';
    $('minAreaVal').textContent = $('minArea').value + ' µm';
    $('scaleVal').textContent = $('scale').value + ' µm/100px';
  };
  ['pct', 'minArea', 'scale'].forEach(id => $(id).addEventListener('input', sync));
  sync();
})();
