// Deterministic position+color extractor for a conformance manifest.
//
// Turns a reference frame (a screen crop from a design/video) into a
// RefManifest the structural reward compares against — with chip rects MEASURED
// from the frame, not guessed. Position comes from OCR word boxes (tesseract),
// color from region-averaging the original crop.
//
// Pipeline (run the preprocess first, then this):
//   # 1. upscale 3x + invert (light-on-dark → dark-on-light) for clean OCR
//   ffmpeg -y -i ref.png -vf \
//     "scale=iw*3:ih*3:flags=lanczos,negate,format=gray,eq=contrast=1.5:brightness=0.05" \
//     ref-inv3.png
//   # 2. OCR → word boxes (sparse-text mode)
//   tesseract ref-inv3.png ref-ocr --psm 11 tsv
//   # 3. this script (scale = the upscale factor from step 1)
//   node derive-manifest-ocr.cjs ref-ocr.tsv ref.png tags.json 3 <name> out.json overlay.png
//
// tags.json is the ordered tag list (row-major). Multi-word chips ("Current
// Events") are matched by consuming consecutive OCR words. The overlay (boxes
// drawn on the crop) is the verification step — eyeball that boxes land on the
// real elements before trusting the manifest.

const { PNG } = require('pngjs');
const fs = require('fs');

const [tsvPath, cropPath, tagsPath, scaleS, name, outPath, overlayPath] = process.argv.slice(2);
const scale = Number(scaleS);
const tags = JSON.parse(fs.readFileSync(tagsPath, 'utf8'));
const crop = PNG.sync.read(fs.readFileSync(cropPath));
const W = crop.width;
const H = crop.height;
const UW = W * scale;
const UH = H * scale;

const rows = fs.readFileSync(tsvPath, 'utf8').trim().split('\n').slice(1);
const words = [];
for (const r of rows) {
  const c = r.split('\t');
  const conf = Number(c[10]);
  const text = (c[11] || '').trim();
  if (conf < 40 || !text) continue;
  words.push({ text, L: +c[6], T: +c[7], W: +c[8], H: +c[9] });
}

let wi = 0;
const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
const elements = [];
const PADX = 0.7;
const PADYR = 0.6; // padding as a fraction of text height (approximates the pill)
for (const tag of tags) {
  const parts = tag.split(' ');
  while (wi < words.length && norm(words[wi].text) !== norm(parts[0])) wi++;
  if (wi >= words.length) {
    console.error('MISS', tag);
    continue;
  }
  const grp = [words[wi]];
  wi++;
  for (let k = 1; k < parts.length; k++) {
    if (wi < words.length) {
      grp.push(words[wi]);
      wi++;
    }
  }
  const minL = Math.min(...grp.map((g) => g.L));
  const minT = Math.min(...grp.map((g) => g.T));
  const maxR = Math.max(...grp.map((g) => g.L + g.W));
  const maxB = Math.max(...grp.map((g) => g.T + g.H));
  const th = maxB - minT;
  const px = th * PADX;
  const py = th * PADYR;
  const bx = minL - px;
  const by = minT - py;
  const bw = maxR - minL + 2 * px;
  const bh = maxB - minT + 2 * py;
  const rect = {
    x: +(bx / UW).toFixed(4),
    y: +(by / UH).toFixed(4),
    w: +(bw / UW).toFixed(4),
    h: +(bh / UH).toFixed(4),
  };
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const x0 = Math.max(0, (rect.x * W) | 0);
  const y0 = Math.max(0, (rect.y * H) | 0);
  const x1 = Math.min(W, ((rect.x + rect.w) * W) | 0);
  const y1 = Math.min(H, ((rect.y + rect.h) * H) | 0);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      r += crop.data[i];
      g += crop.data[i + 1];
      b += crop.data[i + 2];
      n++;
    }
  const color = n
    ? '#' + [r / n, g / n, b / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
    : undefined;
  elements.push({ id: `tag-${tag}`, role: 'chip', text: tag, rect, color });
}

console.error(`${name}: matched ${elements.length}/${tags.length} chips`);
fs.writeFileSync(outPath, JSON.stringify({ name, elements }, null, 2));

const ov = PNG.sync.read(fs.readFileSync(cropPath));
const draw = (px, py) => {
  const k = (py * W + px) * 4;
  if (k >= 0 && k < ov.data.length) {
    ov.data[k] = 0;
    ov.data[k + 1] = 255;
    ov.data[k + 2] = 90;
    ov.data[k + 3] = 255;
  }
};
for (const e of elements) {
  const bx = (e.rect.x * W) | 0;
  const by = (e.rect.y * H) | 0;
  const bw = (e.rect.w * W) | 0;
  const bh = (e.rect.h * H) | 0;
  for (let x = bx; x <= bx + bw; x++) {
    draw(x, by);
    draw(x, by + bh);
  }
  for (let y = by; y <= by + bh; y++) {
    draw(bx, y);
    draw(bx + bw, y);
  }
}
fs.writeFileSync(overlayPath, PNG.sync.write(ov));
