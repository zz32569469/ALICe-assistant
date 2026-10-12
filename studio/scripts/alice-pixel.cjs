// ALICE 像素頭像（§39 第二輪）：依 docs/art/alice-reference.png 設定稿，用限制色盤畫的像素肖像。
// 做法：在像素格上定義形狀（頭髮、臉、瀏海髮束、衣服），依規則上陰影（光從左上、陰影偏冷），
// 描彩色外框（頭髮用最深的髮色、皮膚用深膚色，不用純黑），最後蓋上手排的眼睛、嘴巴與配件。
// 用法：const { draw } = require('./alice-pixel.cjs'); draw('c1', 'happy') 回傳 SVG 字串。
'use strict';

// ── 色盤（Lospec）：每個角色用到的色階，由深到淺 ──
const PALETTES = {
  // Apollo（AdamCYounis）：46 色，整體偏霧、偏暗。
  apollo: {
    hair: ['394a50', '577277', '819796', 'a8b5b2', 'c7cfcc', 'ebede9'],
    skin: ['7a4841', 'ad7757', 'c09473', 'd7b594', 'e7d5b3'],
    eye: ['19332d', '25562e', '468232', '75a743', 'a4dddb'],
    black: ['090a14', '10141f', '151d28', '202e37', '394a50'],
    blue: ['172038', '253a5e', '3c5e8b', '4f8fba', '73bed3'],
    mouth: ['4d2b32', '752438', 'a53030', 'df84a5'],
    blush: 'df84a5', white: ['a8b5b2', 'c7cfcc', 'ebede9'], line: '241527',
  },
  // Resurrect 64（Kerrie Lake）：64 色，色彩比 Apollo 飽和一些。
  resurrect: {
    hair: ['3e3546', '625565', '7f708a', '9babb2', 'c7dcd0', 'ffffff'],
    skin: ['753c54', 'cf657f', 'ed8099', 'fca790', 'fdcbb0'],
    eye: ['2e222f', '165a4c', '239063', '1ebc73', '8ff8e2'],
    black: ['2e222f', '3e3546', '45293f', '625565', '694f62'],
    blue: ['323353', '484a77', '4d65b4', '4d9be6', '8fd3ff'],
    mouth: ['6e2727', 'b33831', 'e83b3b', 'f68181'],
    blush: 'f68181', white: ['9babb2', 'c7dcd0', 'ffffff'], line: '2e222f',
  },
};

// ── 幾何小工具（以像素中心判斷）──
const inEllipse = (x, y, cx, cy, rx, ry) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
function inPoly(x, y, pts) {
  const px = x + 0.5; const py = y + 0.5;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// 二次曲線取樣成折線，讓髮束邊緣是彎的。
function curve(p0, c, p1, n = 6) {
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    out.push([(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t ** 2 * p1[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t ** 2 * p1[1]]);
  }
  return out;
}
const mirrorX = (pts, w) => pts.map(([x, y]) => [w - x, y]);

// ── 畫布：每格記「區域」與最後的顏色 ──
class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.region = Array.from({ length: h }, () => Array(w).fill(null));
    this.strand = Array.from({ length: h }, () => Array(w).fill(-1));
    this.color = Array.from({ length: h }, () => Array(w).fill(null));
  }
  fill(region, test, strand = -1) {
    for (let y = 0; y < this.h; y += 1) for (let x = 0; x < this.w; x += 1) {
      if (test(x, y)) { this.region[y][x] = region; this.strand[y][x] = strand; }
    }
  }
  at(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.region[y][x]; }
  set(x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h && c) this.color[y][x] = c; }
}

// ── 角色形狀：以 64 格為基準，依尺寸等比縮放；不同風格調參數 ──
function shapes(cv, g) {
  const S = cv.w / 64;
  const k = (v) => v * S;
  const W = cv.w;
  const hc = [k(32), k(g.headY)];
  // 後髮：頭頂圓頂往下長到畫面底，下緣稍微外擴。
  cv.fill('back', (x, y) => inEllipse(x, y, hc[0], hc[1], k(g.headR + 1), k(g.headR + 1))
    || inPoly(x, y, [[k(32 - g.headR - 0.6), hc[1] + k(2)], [k(32 - g.headR - 4), cv.h], [k(32 + g.headR + 4), cv.h], [k(32 + g.headR + 0.6), hc[1] + k(2)]]));
  // 衣服：黑色外套、高領，兩側藍色織帶。
  const sh = k(g.shoulderY);
  cv.fill('body', (x, y) => inPoly(x, y, [[k(4), cv.h], [k(9), sh + k(4)], [k(22), sh], [k(42), sh], [k(55), sh + k(4)], [k(60), cv.h]]));
  cv.fill('collar', (x, y) => y >= sh - k(3) && y < sh + k(4) && Math.abs(x + 0.5 - k(32)) <= k(5.5) - Math.max(0, y - sh) * 0.3);
  cv.fill('neck', (x, y) => y >= k(g.chinY) - k(4) && y < sh - k(3) && Math.abs(x + 0.5 - k(32)) <= k(4.5));
  // 臉：上半是橢圓，下半收成尖下巴。
  const fy = k(g.faceY); const fr = k(g.faceR);
  cv.fill('face', (x, y) => inEllipse(x, y, k(32), fy, fr, fr * 1.02)
    || inPoly(x, y, [[k(32) - fr, fy], [k(32) + fr, fy], [k(32) + fr * 0.62, k(g.chinY) - k(4)], [k(32), k(g.chinY)], [k(32) - fr * 0.62, k(g.chinY) - k(4)]]));
  // 臉旁髮束：從太陽穴往下收尖。
  const lock = [[k(32 - g.faceR - 1.5), k(g.faceY - 8)], ...curve([k(32 - g.faceR - 3), k(g.faceY + 2)], [k(32 - g.faceR - 3.5), k(g.chinY + 2)], [k(32 - g.faceR + 1), k(g.chinY + 9)]), [k(32 - g.faceR + 2.5), k(g.chinY - 2)], [k(32 - g.faceR + 2.6), k(g.faceY + 2)], [k(32 - g.faceR + 2), k(g.faceY - 6)]];
  cv.fill('side', (x, y) => inPoly(x, y, lock) || inPoly(x, y, mirrorX(lock, W)));
  // 瀏海：頭頂蓋子＋一束束往下的髮束（第 i 束的編號用來畫束與束之間的陰影線）。
  cv.fill('bangs', (x, y) => inEllipse(x, y, hc[0], hc[1], k(g.headR), k(g.headR)) && y < k(g.capY));
  g.strands.forEach(([root, tip, tipY, half], i) => {
    const poly = [[k(root - half - 2), k(g.capY - 4)], ...curve([k(root - half), k(g.capY)], [k((root + tip) / 2 - half * 0.6), k((g.capY + tipY) / 2)], [k(tip), k(tipY)]),
      ...curve([k(tip), k(tipY)], [k((root + tip) / 2 + half * 0.6), k((g.capY + tipY) / 2)], [k(root + half), k(g.capY)]), [k(root + half + 2), k(g.capY - 4)]];
    cv.fill('bangs', (x, y) => inPoly(x, y, poly) && (y >= k(g.capY) || inEllipse(x, y, hc[0], hc[1], k(g.headR), k(g.headR))), i);
  });
  return { S, k, hc };
}

// ── 上色規則 ──
function paint(cv, g, P, geo) {
  const { k, hc } = geo;
  const hair = P.hair; const skin = P.skin; const blk = P.black;
  for (let y = 0; y < cv.h; y += 1) for (let x = 0; x < cv.w; x += 1) {
    const r = cv.region[y][x];
    if (r === null) continue;
    let c = null;
    const right = x + 0.5 > k(32);
    if (r === 'back') c = (Math.abs(x + 0.5 - k(32)) < k(g.faceR + 6) && y > hc[1]) ? hair[1] : hair[2];
    else if (r === 'side') c = right ? hair[2] : hair[3];
    else if (r === 'bangs') {
      c = hair[3];
      // 天使光圈：頭頂一道弧形亮帶，中間幾格最亮。
      const d = Math.hypot((x + 0.5 - hc[0]) / k(g.headR), (y + 0.5 - hc[1]) / k(g.headR));
      if (y < hc[1] - k(4) && d > g.ring[0] && d < g.ring[1]) c = Math.abs(x + 0.5 - k(26)) < k(5) ? hair[5] : hair[4];
      // 髮束之間的分線與髮尖陰影。
      const s = cv.strand[y][x];
      if (s >= 0 && y > k(g.capY + 1) && cv.strand[y][x + 1] !== s && cv.at(x + 1, y) === 'bangs') c = hair[2];
      if (s >= 0 && y > k(g.capY + 3) && cv.at(x, y + 1) !== 'bangs' && cv.at(x, y + 2) !== 'bangs') c = hair[2];
      if (right && x + 0.5 > k(32 + g.headR - 4) && c === hair[3]) c = hair[2];
    } else if (r === 'face') {
      c = skin[4];
      const above = [cv.at(x, y - 1), cv.at(x, y - 2)];
      if (above.includes('bangs') || above.includes('side')) c = skin[3];
      if (x + 0.5 > k(32 + g.faceR - 2.5)) c = skin[3];
    } else if (r === 'neck') c = y < k(g.chinY) - k(1) ? skin[1] : skin[2];
    else if (r === 'collar') c = y < k(g.shoulderY) - k(2) ? blk[3] : blk[2];
    else if (r === 'body') {
      c = blk[2];
      if (y < k(g.shoulderY) + k(2)) c = blk[3];
      const dx = Math.abs(x + 0.5 - k(32));
      if (Math.abs(dx - k(15)) < k(1.2) && y > k(g.shoulderY + 3)) c = P.blue[3]; // 織帶
      if (Math.abs(dx - k(15)) < k(1.2) && Math.abs(y + 0.5 - k(g.shoulderY + 7)) < k(1)) c = P.white[2]; // 銀扣
      if (Math.abs(dx - k(7.5)) < 0.6 && y > k(g.shoulderY + 4)) c = blk[1]; // 外套開口
    }
    cv.color[y][x] = c;
  }
  // 彩色外框：碰到空白的邊緣，用該區最深的顏色（不用純黑）。
  const dark = { back: hair[0], side: hair[0], bangs: hair[0], face: skin[0], neck: skin[0], body: blk[0], collar: blk[0] };
  const marks = [];
  for (let y = 0; y < cv.h; y += 1) for (let x = 0; x < cv.w; x += 1) {
    const r = cv.region[y][x];
    if (r === null) continue;
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => cv.at(x + dx, y + dy));
    if (n.includes(null) && y < cv.h - 1) marks.push([x, y, dark[r]]);
    // 臉與頭髮交界：臉側用深膚色、髮尖下緣用深髮色，形狀更清楚。
    else if (r === 'face' && (n[0] === 'side' || n[1] === 'side' || n[0] === 'back' || n[1] === 'back')) marks.push([x, y, skin[1]]);
    else if ((r === 'bangs' || r === 'side') && (n[2] === 'face')) marks.push([x, y, hair[1]]);
    else if (r === 'side' && (n[0] === 'back' || n[1] === 'back')) marks.push([x, y, hair[1]]);
    else if (r === 'face' && n[2] === 'neck') marks.push([x, y, skin[1]]);
    else if (r === 'collar' && (n[2] === 'body' || n[0] === 'body' || n[1] === 'body')) marks.push([x, y, blk[1]]);
  }
  marks.forEach(([x, y, c]) => cv.set(x, y, c));
}

// ── 眼睛：依大小產生；左右眼睫毛鏡像、亮點都在左上（光源同一邊）──
// 字元：K 睫毛、w 眼白、0～4 眼睛色階（深到淺）、h 亮點、l 下睫毛（深膚色）、. 不動。
const EYE_ART = {
  big: { // 7×9，64 格肖像用
    open: ['.KKKKK.', 'KKKKKKK', 'w00hh0w', 'w01hh0w', 'w01110w', 'w12221w', 'w12321w', '.w234w.', '..lll..'],
    half: ['.......', '.......', '.......', 'KKKKKKK', 'w01110w', 'w12221w', 'w12321w', '.w234w.', '..lll..'],
    narrow: ['.......', '.......', 'KKKKKKK', 'w0hh00w', 'w01110w', 'w12221w', 'w12321w', '.w234w.', '..lll..'],
    happy: ['.......', '.......', '.......', '..KKK..', '.K...K.', 'K.....K', '.......', '.......', '.......'],
    closed: ['.......', '.......', '.......', '.......', '.......', 'K.....K', '.K...K.', '..KKK..', '.......'],
  },
  mid: { // 5×7，48 格用
    open: ['.KKKK', 'KKKKK', 'w0hh0', 'w01h0', 'w1221', 'w1231', '.lll.'],
    half: ['.....', '.....', 'KKKKK', 'w0110', 'w1221', 'w1231', '.lll.'],
    narrow: ['.....', 'KKKKK', 'w0hh0', 'w0110', 'w1221', 'w1231', '.lll.'],
    happy: ['.....', '.....', '.KKK.', 'K...K', '.....', '.....', '.....'],
    closed: ['.....', '.....', '.....', 'K...K', '.KKK.', '.....', '.....'],
  },
  small: { // 3×5，32 格用
    open: ['KKK', '0h0', '011', '123', '...'],
    half: ['...', 'KKK', '011', '123', '...'],
    narrow: ['...', 'KKK', '0h1', '123', '...'],
    happy: ['...', '.K.', 'K.K', '...', '...'],
    closed: ['...', '...', 'K.K', '.K.', '...'],
  },
};
// 表情：左右眼狀態、眉毛傾斜（+ 是內高外低＝困惑，- 是內低外高＝認真、不滿）、嘴型、腮紅、符號。
const EXPRESSIONS = {
  calm: { eyes: ['open', 'open'], mouth: 'smile', blush: 1 },
  happy: { eyes: ['happy', 'happy'], mouth: 'open', blush: 2 },
  serious: { eyes: ['narrow', 'narrow'], brow: -1, mouth: 'flat', blush: 0 },
  sleepy: { eyes: ['half', 'half'], mouth: 'o', blush: 1, mark: 'z' },
  puzzled: { eyes: ['open', 'narrow'], brow: 1, mouth: 'wave', blush: 0, mark: '?' },
  playful: { eyes: ['happy', 'open'], mouth: 'tongue', blush: 2 },
  pout: { eyes: ['half', 'half'], brow: -1, mouth: 'pout', blush: 2 },
};
// 嘴：M 深色線、m 嘴內、t 舌頭；以中心為基準。
const MOUTHS = {
  big: { smile: ['M...M', '.MMM.'], open: ['MMMMM', 'MmmmM', '.MtM.'], flat: ['.MMM.'], o: ['.MM.', 'MmmM', '.MM.'], wave: ['.M..M', 'M.MM.'], tongue: ['MMMMM', '.MmtM', '..tt.'], pout: ['.MMM.', 'M...M'] },
  mid: { smile: ['M..M', '.MM.'], open: ['MMMM', 'MmmM', '.tt.'], flat: ['.MM.'], o: ['.M.', 'MmM', '.M.'], wave: ['.M.M', 'M.M.'], tongue: ['MMMM', '.Mtt', '..t.'], pout: ['.MM.', 'M..M'] },
  small: { smile: ['MM'], open: ['MM', 'tt'], flat: ['MM'], o: ['M'], wave: ['MM'], tongue: ['Mt'], pout: ['MM'] },
};

function stamp(cv, x0, y0, rows, colors, flip = false) {
  rows.forEach((row, dy) => {
    const chars = [...row];
    chars.forEach((ch, dx) => {
      if (ch === '.' || colors[ch] === undefined) return;
      cv.set(flip ? x0 + chars.length - 1 - dx : x0 + dx, y0 + dy, colors[ch]);
    });
  });
}

function features(cv, g, P, geo, expression) {
  const { k } = geo;
  const e = EXPRESSIONS[expression];
  const art = EYE_ART[g.eyeSize];
  const eyeW = art.open[0].length;
  const ey = Math.round(k(g.eyeY));
  const CX = g.cx ?? k(32);
  const lx = Math.round(CX - k(g.eyeGap / 2)) - eyeW;
  const rx = Math.round(CX + k(g.eyeGap / 2));
  const colors = { K: P.line, w: P.white[2], h: P.white[2], l: P.skin[1], 0: P.eye[0], 1: P.eye[1], 2: P.eye[2], 3: P.eye[3], 4: P.eye[4] };
  // 左眼正著畫，右眼睫毛鏡像（亮點仍在左上）。
  const drawEye = (x, state, flip) => {
    const rows = art[state];
    const lashOnly = rows.map((r) => r.replace(/[^Kl.]/g, '.'));
    const rest = rows.map((r) => r.replace(/[Kl]/g, '.'));
    stamp(cv, x, ey, rest, colors, false);
    stamp(cv, x, ey, lashOnly, colors, flip);
  };
  drawEye(lx, e.eyes[0], false);
  drawEye(rx, e.eyes[1], true);
  // 眉毛：畫在瀏海上，用深髮色。
  if (e.brow) {
    const by = ey - (g.eyeSize === 'small' ? 1 : 2);
    const len = Math.max(2, eyeW - 2);
    for (let i = 0; i < len; i += 1) {
      const t = i / (len - 1); // 0 外側 → 1 內側
      const dy = Math.round((e.brow > 0 ? -t : t) * (g.eyeSize === 'small' ? 1 : 1.6));
      cv.set(lx + 1 + i, by + dy, P.hair[0]);
      cv.set(rx + eyeW - 2 - i, by + dy, P.hair[0]);
    }
  }
  // 腮紅：0 無、1 淡（隔格點）、2 濃。
  if (e.blush) {
    const byy = ey + art.open.length - 1;
    const bw = g.eyeSize === 'big' ? 4 : g.eyeSize === 'mid' ? 3 : 2;
    for (const bx of [lx - 1, rx + eyeW - bw + 1]) for (let i = 0; i < bw; i += 1) if (e.blush === 2 || i % 2 === 0) cv.set(bx + i, byy, P.blush);
  }
  const mouth = MOUTHS[g.eyeSize][e.mouth];
  const mw = mouth[0].length;
  stamp(cv, Math.round(CX - mw / 2), Math.round(k(g.mouthY)), mouth, { M: P.mouth[1], m: P.mouth[0], t: P.mouth[3] });
  // 符號：睏倦的 z、疑惑的 ?（小尺寸省略）。
  if (e.mark && g.eyeSize !== 'small') {
    const mx = Math.round(k(g.markX ?? 52)); const my = Math.round(k(g.markY ?? g.eyeY - 2));
    const glyph = e.mark === 'z' ? ['ZZZ', '..Z', '.Z.', 'Z..', 'ZZZ'] : ['.ZZ.', 'Z..Z', '...Z', '..Z.', '....', '..Z.'];
    stamp(cv, mx, my, glyph, { Z: e.mark === 'z' ? P.blue[4] : P.blue[3] });
  }
}

// 配件：黑色蝴蝶結（右上）、X 髮夾；女僕版改成白色蕾絲頭飾＋白圍裙領。
function accessories(cv, g, P, geo) {
  const { k } = geo;
  const blk = P.black;
  if (g.maid) {
    const y0 = Math.round(k(g.headY - g.headR + 5));
    for (let x = Math.round(k(16)); x <= Math.round(k(48)); x += 1) {
      const lift = Math.round(Math.abs(x + 0.5 - k(32)) / k(9));
      cv.set(x, y0 + lift, P.white[2]); cv.set(x, y0 + lift + 1, x % 2 ? P.white[1] : P.white[2]);
      if (x % 2 === 0) cv.set(x, y0 + lift - 1, P.white[2]);
      cv.set(x, y0 + lift + 2, P.hair[0]);
    }
    const sy = Math.round(k(g.shoulderY));
    for (let y = sy; y < cv.h; y += 1) for (let x = 0; x < cv.w; x += 1) {
      const dx = Math.abs(x + 0.5 - k(32));
      if (cv.region[y][x] === 'body' && dx < k(3 + (y - sy) * 0.5) && y < sy + k(8)) cv.set(x, y, (y - sy) % 3 === 2 ? P.white[1] : P.white[2]);
    }
    for (let x = Math.round(k(29)); x < Math.round(k(35)); x += 1) cv.set(x, sy - 1, P.blue[3]);
    return;
  }
  const bx = k(g.bow[0]); const by = k(g.bow[1]); const s = k(g.bow[2]);
  const loopL = [[bx, by], [bx - s, by - s * 0.8], [bx - s * 1.1, by + s * 0.5], [bx, by + s * 0.2]];
  const loopR = [[bx, by], [bx + s, by - s * 0.9], [bx + s * 1.15, by + s * 0.45], [bx, by + s * 0.2]];
  for (let y = 0; y < cv.h; y += 1) for (let x = 0; x < cv.w; x += 1) {
    const inL = inPoly(x, y, loopL); const inR = inPoly(x, y, loopR);
    const knot = inEllipse(x, y, bx, by + s * 0.1, Math.max(1, s * 0.28), Math.max(1, s * 0.3));
    if (knot) cv.set(x, y, blk[4]);
    else if (inL || inR) {
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !(inPoly(x + dx, y + dy, loopL) || inPoly(x + dx, y + dy, loopR)));
      cv.set(x, y, edge ? blk[0] : ((inL && y + 0.5 < by - s * 0.35) || (inR && y + 0.5 < by - s * 0.4) ? blk[3] : blk[2]));
    }
  }
  const cx = Math.round(k(g.clip[0])); const cy = Math.round(k(g.clip[1]));
  const n = g.eyeSize === 'small' ? 1 : 2;
  for (let i = -n; i <= n; i += 1) { cv.set(cx + i, cy + i, blk[1]); cv.set(cx + i, cy - i, blk[1]); }
}

// ── 風格：c GBA 動漫頭像、d 現代 RPG、e 16-bit RPG ──
const PORTRAIT = {
  headY: 26, headR: 21, capY: 18, ring: [0.6, 0.74], faceY: 34, faceR: 15, chinY: 51, shoulderY: 55,
  eyeY: 31, eyeGap: 8, mouthY: 45, bow: [49, 9, 7], clip: [42, 21],
  strands: [[14, 13, 34, 4], [21, 19, 30, 4], [27, 26, 31, 3.5], [33, 32, 36, 3], [38, 39, 30, 3.5], [44, 46, 31, 4], [50, 51, 35, 4]],
};
const STYLES = {
  h1: { name: '歧路旅人系列風・便服', size: 32, height: 40, traveler: true, palette: 'apollo', note: '32×40，側身朝左、近黑外框、明暗對比強，約 2.5 頭身。頭像取頭和肩膀。' },
  h2: { name: '歧路旅人系列風・女僕', size: 32, height: 40, traveler: true, palette: 'apollo', maid: true, note: 'h1 換成女僕裝：蕾絲頭飾、白圍裙、藍領結、白色過膝襪。' },
  h3: { name: '歧路旅人系列風・便服＋黑貓', size: 32, height: 40, traveler: true, palette: 'apollo', cat: true, note: 'h1 腳邊坐著黑貓。' },
  h4: { name: '歧路旅人系列風・朝右', size: 32, height: 40, traveler: true, palette: 'apollo', flip: true, note: 'h1 左右翻轉，朝右站。' },
  g1: { name: '歧路旅人風・便服', size: 32, height: 36, sprite: true, palette: 'apollo', note: '32×36 Q 版，約 2 頭身。眼睛 1×2 格、幾乎不畫嘴，每種材質 3～4 階。頭像取頭和肩膀。' },
  g2: { name: '歧路旅人風・女僕', size: 32, height: 36, sprite: true, palette: 'apollo', maid: true, note: 'g1 換成女僕裝：蕾絲頭飾、白圍裙、藍領結、白色過膝襪。' },
  g3: { name: '歧路旅人風・便服＋黑貓', size: 32, height: 36, sprite: true, palette: 'apollo', cat: true, note: 'g1 腳邊坐著設定稿裡的黑貓。' },
  c1: { name: 'GBA 動漫頭像・Apollo', size: 64, palette: 'apollo', eyeSize: 'big', ...PORTRAIT, note: '64×64 半身像，色階 5～6 階、彩色外框、陰影偏冷。Apollo 色盤，整體霧面偏暗。' },
  c2: { name: 'GBA 動漫頭像・Resurrect 64', size: 64, palette: 'resurrect', eyeSize: 'big', ...PORTRAIT, note: '同 c1 的線稿，換 Resurrect 64 色盤比較：膚色偏粉、眼睛偏青，飽和度高一點。' },
  d1: { name: '現代 RPG 頭像', size: 48, palette: 'apollo', eyeSize: 'mid', ...PORTRAIT, eyeY: 31.5, eyeGap: 9, mouthY: 45, note: '48×48，臉比較圓、眼睛比例更大，色調柔和。像星露谷那類現代像素 RPG 的對話頭像。' },
  d2: { name: '現代 RPG 頭像・女僕', size: 48, palette: 'apollo', eyeSize: 'mid', ...PORTRAIT, eyeY: 31.5, eyeGap: 9, mouthY: 45, maid: true, note: 'd1 換成設定稿的女僕裝：白色蕾絲頭飾、白圍裙領、藍色領結。' },
  f1: { name: 'Q 版全身・便服', size: 40, palette: 'apollo', chibi: true, note: '40×40 大頭小身，黑外套、過膝襪、運動鞋，旁邊坐著設定稿裡的黑貓。之後可以做眨眼、打字、睡覺的小動畫。' },
  f2: { name: 'Q 版全身・女僕', size: 40, palette: 'apollo', chibi: true, maid: true, note: 'f1 換成女僕裝：蕾絲頭飾、白圍裙、藍領結、白色過膝襪。' },
  e1: { name: '16-bit 經典 RPG', size: 32, palette: 'apollo', eyeSize: 'small', ...PORTRAIT, eyeY: 31, eyeGap: 8, mouthY: 45, note: '32×32，色數少、對比清楚，縮到 28px 也認得出來。像 SNES 時代 RPG 的選單頭像。' },
};

// ── f. Q 版全身小人（40×40，大頭小身，旁邊坐著設定稿裡的黑貓）──
function chibi(g, P, expression) {
  const cv = new Canvas(40, 40);
  const hair = P.hair; const skin = P.skin; const blk = P.black;
  const cx = 15;
  // 區域
  cv.fill('back', (x, y) => inEllipse(x, y, cx, 12, 11.5, 11) || inPoly(x, y, [[cx - 11.2, 13], [cx - 12.5, 29], [cx + 12.5, 29], [cx + 11.2, 13]]));
  cv.fill('body', (x, y) => inPoly(x, y, [[cx - 6, 22], [cx + 6, 22], [cx + 9, 32], [cx - 9, 32]]));
  cv.fill('body', (x, y) => (Math.abs(x + 0.5 - (cx - 9)) < 2.2 || Math.abs(x + 0.5 - (cx + 9)) < 2.2) && y >= 24 && y < 31); // 寬袖子
  cv.fill('hand', (x, y) => (Math.abs(x + 0.5 - (cx - 9)) < 1.3 || Math.abs(x + 0.5 - (cx + 9)) < 1.3) && y >= 31 && y < 33);
  cv.fill('collar', (x, y) => y >= 20 && y < 24 && Math.abs(x + 0.5 - cx) <= 3);
  cv.fill('legs', (x, y) => y >= 32 && y < 37 && (Math.abs(x + 0.5 - (cx - 3)) < 1.6 || Math.abs(x + 0.5 - (cx + 3)) < 1.6));
  cv.fill('shoe', (x, y) => y >= 37 && y < 39 && (Math.abs(x + 0.5 - (cx - 3.5)) < 2.2 || Math.abs(x + 0.5 - (cx + 3.5)) < 2.2));
  cv.fill('face', (x, y) => inEllipse(x, y, cx, 14, 8, 7.2) || inPoly(x, y, [[cx - 7.5, 15], [cx + 7.5, 15], [cx + 3, 20.5], [cx, 21.5], [cx - 3, 20.5]]));
  const lock = [[cx - 8.6, 8], [cx - 10.2, 16], [cx - 9.6, 23], [cx - 7.2, 26], [cx - 6.6, 19], [cx - 6.8, 12]];
  cv.fill('side', (x, y) => inPoly(x, y, lock) || inPoly(x, y, lock.map(([px, py]) => [2 * cx - px, py])));
  cv.fill('bangs', (x, y) => inEllipse(x, y, cx, 12, 11, 11) && y < 8);
  [[cx - 7, cx - 7.5, 14, 2.6], [cx - 3.5, cx - 4.3, 12, 2.4], [cx, cx - 0.2, 14.5, 2.2], [cx + 3.5, cx + 4.2, 12, 2.4], [cx + 7, cx + 7.6, 14, 2.6]].forEach(([root, tip, tipY, half], i) => {
    const poly = [[root - half - 1.5, 5], ...curve([root - half, 8], [(root + tip) / 2 - half * 0.5, (8 + tipY) / 2], [tip, tipY], 4), ...curve([tip, tipY], [(root + tip) / 2 + half * 0.5, (8 + tipY) / 2], [root + half, 8], 4), [root + half + 1.5, 5]];
    cv.fill('bangs', (x, y) => inPoly(x, y, poly) && (y >= 8 || inEllipse(x, y, cx, 12, 11, 11)), i);
  });
  // 黑貓：坐姿，右下角。
  cv.fill('cat', (x, y) => inEllipse(x, y, 33, 35.5, 4.6, 3.8) || inEllipse(x, y, 32.5, 30, 3.4, 3) || inPoly(x, y, [[29.6, 29.5], [30.2, 25.6], [32, 28]]) || inPoly(x, y, [[33.2, 28], [35, 25.6], [35.4, 29.5]])
    || inPoly(x, y, [[36.5, 37], [38.6, 33], [39.2, 30.5], [38.2, 30.5], [37.6, 33], [35.6, 36]]));
  // 上色
  for (let y = 0; y < 40; y += 1) for (let x = 0; x < 40; x += 1) {
    const r = cv.region[y][x];
    if (r === null) continue;
    const right = x + 0.5 > cx;
    let c;
    if (r === 'back') c = (Math.abs(x + 0.5 - cx) < 10 && y > 14) ? hair[1] : hair[2];
    else if (r === 'side') c = right ? hair[2] : hair[3];
    else if (r === 'bangs') {
      c = hair[3];
      const d = Math.hypot((x + 0.5 - cx) / 11, (y + 0.5 - 12) / 11);
      if (y < 8 && d > 0.6 && d < 0.78) c = Math.abs(x + 0.5 - (cx - 3)) < 3 ? hair[5] : hair[4];
      const s = cv.strand[y][x];
      if (s >= 0 && y > 9 && cv.at(x, y + 1) !== 'bangs') c = hair[2];
    } else if (r === 'face') c = [cv.at(x, y - 1), cv.at(x, y - 2)].some((n) => n === 'bangs' || n === 'side') ? skin[3] : skin[4];
    else if (r === 'hand') c = skin[3];
    else if (r === 'collar') c = blk[3];
    else if (r === 'body') {
      c = y < 25 ? blk[3] : blk[2];
      if (Math.abs(x + 0.5 - (right ? cx + 6 : cx - 6)) < 0.8 && y > 25) c = P.blue[3];
      if (Math.abs(x + 0.5 - cx) < 0.6 && y > 24) c = blk[1];
    } else if (r === 'legs') c = blk[1];
    else if (r === 'shoe') c = y === 38 ? P.white[2] : blk[3];
    else if (r === 'cat') c = (y < 31 && x < 32) || (y < 34 && x < 31) ? blk[3] : blk[2];
    cv.color[y][x] = c;
  }
  const dark = { back: hair[0], side: hair[0], bangs: hair[0], face: skin[0], hand: skin[0], body: blk[0], collar: blk[0], legs: blk[0], shoe: blk[0], cat: blk[0] };
  const marks = [];
  for (let y = 0; y < 40; y += 1) for (let x = 0; x < 40; x += 1) {
    const r = cv.region[y][x];
    if (r === null) continue;
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => cv.at(x + dx, y + dy));
    if (n.includes(null)) marks.push([x, y, dark[r]]);
    else if ((r === 'bangs' || r === 'side') && n[2] === 'face') marks.push([x, y, hair[1]]);
    else if (r === 'face' && (n[0] === 'side' || n[1] === 'side' || n[0] === 'back' || n[1] === 'back' || n[2] === 'collar')) marks.push([x, y, skin[1]]);
  }
  marks.forEach(([x, y, c]) => cv.set(x, y, c));
  cv.set(31, 30, P.eye[3]); cv.set(33, 30, P.eye[3]); // 貓眼
  if (g.maid) {
    for (let x = cx - 8; x <= cx + 8; x += 1) {
      const lift = Math.round(Math.abs(x + 0.5 - cx) / 5);
      cv.set(x, 3 + lift, P.white[2]); if (x % 2 === 0) cv.set(x, 2 + lift, P.white[2]); cv.set(x, 4 + lift, P.hair[0]);
    }
    for (let y = 25; y < 32; y += 1) for (let x = cx - 4; x <= cx + 4; x += 1) if (cv.region[y][x] === 'body' && Math.abs(x + 0.5 - cx) < 2 + (y - 25) * 0.5) cv.set(x, y, y === 31 ? P.white[1] : P.white[2]);
    for (const [x, y] of [[cx - 1, 23], [cx, 23], [cx - 1, 22], [cx + 1, 22]]) cv.set(x, y, P.blue[3]);
    for (let x = 0; x < 40; x += 1) for (let y = 32; y < 35; y += 1) if (cv.region[y][x] === 'legs') cv.set(x, y, P.white[1]);
  } else {
    // 蝴蝶結（右上）與 X 髮夾。
    const bow = ['KK...KK', 'KbBKBbK', 'KBBbBBK', 'KBK.KBK', 'KK...KK'];
    stamp(cv, 20, 1, bow, { K: blk[0], B: blk[2], b: blk[3] });
    for (const [x, y] of [[20, 9], [22, 9], [21, 10], [20, 11], [22, 11]]) cv.set(x, y, blk[1]);
  }
  features(cv, { eyeSize: 'mid', eyeY: 12, eyeGap: 3, mouthY: 19, markX: 25, markY: 8, cx }, P, { k: (v) => v }, expression);
  return cv;
}

// ── g. 歧路旅人 2 風格的站姿角色（32×36）：Q 版約 2 頭身、眼睛 1×2 格、幾乎不畫嘴、每種材質 3～4 階 ──
function sprite(g, P, expression) {
  const cv = new Canvas(32, 36);
  const hair = P.hair; const skin = P.skin; const blk = P.black;
  const cx = 16;
  const sym = (pts) => pts.map(([x, y]) => [2 * cx - x, y]);
  const near = (x, c, r) => Math.abs(x + 0.5 - c) < r;
  // 區域（後畫的蓋前面的）
  cv.fill('back', (x, y) => inEllipse(x, y, cx, 12, 9.6, 9.8) || inPoly(x, y, [[6.6, 12], [5.6, 25], [7.6, 27.6], [24.4, 27.6], [26.4, 25], [25.4, 12]]));
  cv.fill('thigh', (x, y) => y >= 28 && y < 29 && (near(x, 13.5, 1.5) || near(x, 18.5, 1.5)));
  cv.fill('sock', (x, y) => y >= 29 && y < 32 && (near(x, 13.5, 1.5) || near(x, 18.5, 1.5)));
  cv.fill('shoe', (x, y) => y >= 32 && y < 35 && (near(x, 13.1, 2.1) || near(x, 18.9, 2.1)));
  cv.fill('shorts', (x, y) => y >= 26 && y < 28 && near(x, cx, 4.2));
  const arm = [[11.6, 22], [9.2, 23.2], [8, 26.8], [10.6, 27.2], [11.2, 24.5]];
  cv.fill('body', (x, y) => inPoly(x, y, [[11.4, 21.5], [20.6, 21.5], [22.2, 27.4], [9.8, 27.4]]));
  cv.fill('sleeve', (x, y) => inPoly(x, y, arm) || inPoly(x, y, sym(arm)));
  cv.fill('hand', (x, y) => inEllipse(x, y, 9.2, 27.8, 1.2, 1.1) || inEllipse(x, y, 22.8, 27.8, 1.2, 1.1));
  cv.fill('collar', (x, y) => y >= 20 && y < 23 && near(x, cx, 2.6));
  cv.fill('face', (x, y) => inEllipse(x, y, cx, 14, 6.7, 6.1) || inPoly(x, y, [[9.4, 14.5], [22.6, 14.5], [20, 19], [cx, 20.6], [12, 19]]));
  const lock = [[8.4, 8], [7, 15], [7.4, 22], [9.4, 25], [10.2, 18], [10.4, 11]];
  cv.fill('side', (x, y) => inPoly(x, y, lock) || inPoly(x, y, sym(lock)));
  cv.fill('bangs', (x, y) => inEllipse(x, y, cx, 12, 9.4, 9.6) && y < 11);
  [[10, 9.4, 15, 2.7], [13, 12.6, 13, 2.5], [16, 15.8, 14.4, 2.5], [19, 19.4, 13, 2.5], [22, 22.6, 15, 2.7]].forEach(([root, tip, tipY, half], i) => {
    const poly = [[root - half - 1, 6], ...curve([root - half, 8], [(root + tip) / 2 - half * 0.4, (8 + tipY) / 2], [tip, tipY], 4), ...curve([tip, tipY], [(root + tip) / 2 + half * 0.4, (8 + tipY) / 2], [root + half, 8], 4), [root + half + 1, 6]];
    cv.fill('bangs', (x, y) => inPoly(x, y, poly) && (y >= 8 || inEllipse(x, y, cx, 12, 9.4, 9.6)), i);
  });
  if (g.cat) cv.fill('cat', (x, y) => inEllipse(x, y, 27.4, 32.4, 3.1, 2.3) || inEllipse(x, y, 26.6, 28.8, 2.3, 2) || inPoly(x, y, [[24.4, 28.4], [24.8, 25.8], [26.2, 27.2]]) || inPoly(x, y, [[27.2, 27.2], [28.6, 25.8], [28.9, 28.4]])
    || inPoly(x, y, [[30, 33.4], [31.6, 30.6], [31.8, 28.8], [31, 28.8], [30.8, 30.6], [29.4, 32.4]]));
  // 上色：光從左上，右側與下方偏暗。
  for (let y = 0; y < cv.h; y += 1) for (let x = 0; x < cv.w; x += 1) {
    const r = cv.region[y][x];
    if (r === null) continue;
    const right = x + 0.5 > cx + 0.5;
    let c;
    if (r === 'back') c = y > 20 && near(x, cx, 8) ? hair[1] : right ? hair[1] : hair[2];
    else if (r === 'side') c = right ? hair[2] : hair[3];
    else if (r === 'bangs') {
      c = hair[3];
      const d = Math.hypot((x + 0.5 - cx) / 9.4, (y + 0.5 - 12) / 9.6);
      if (y < 8 && d > 0.6 && d < 0.8) c = near(x, 12.5, 3) ? hair[5] : hair[4];
      if (cv.strand[y][x] >= 0 && y > 9 && cv.at(x, y + 1) !== 'bangs') c = hair[2];
      if (x + 0.5 > cx + 6 && c === hair[3]) c = hair[2];
    } else if (r === 'face') c = [cv.at(x, y - 1)].some((n) => n === 'bangs' || n === 'side') || x + 0.5 > cx + 5 ? skin[3] : skin[4];
    else if (r === 'hand' || r === 'thigh') c = right ? skin[2] : skin[3];
    else if (r === 'collar') c = blk[2];
    else if (r === 'body') c = x + 0.5 < cx - 2 ? blk[3] : blk[2];
    else if (r === 'sleeve') c = right ? blk[2] : blk[3];
    else if (r === 'shorts') c = blk[1];
    else if (r === 'sock') c = right ? blk[1] : blk[2];
    else if (r === 'shoe') c = y === 34 ? P.white[1] : y === 33 ? P.white[2] : blk[3];
    else if (r === 'cat') c = y < 30 && x < 27 ? blk[3] : blk[2];
    cv.color[y][x] = c;
  }
  // 外框：外圍用該材質最深的顏色；袖子和身體之間、臉與頭髮之間補一條分界。
  const dark = { back: hair[0], side: hair[0], bangs: hair[0], face: skin[1], hand: skin[1], thigh: skin[1], body: blk[0], sleeve: blk[0], collar: blk[0], shorts: blk[0], sock: blk[0], shoe: blk[0], cat: blk[0] };
  const marks = [];
  for (let y = 0; y < cv.h; y += 1) for (let x = 0; x < cv.w; x += 1) {
    const r = cv.region[y][x];
    if (r === null) continue;
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => cv.at(x + dx, y + dy));
    if (n.includes(null)) marks.push([x, y, dark[r]]);
    else if (r === 'sleeve' && n.includes('body')) marks.push([x, y, blk[1]]);
    else if ((r === 'bangs' || r === 'side') && n[2] === 'face') marks.push([x, y, hair[1]]);
    else if (r === 'face' && (n[0] === 'side' || n[1] === 'side')) marks.push([x, y, skin[2]]);
  }
  marks.forEach(([x, y, c]) => cv.set(x, y, c));
  // 藍色織帶從外套垂下來、銀扣。
  for (let y = 24; y <= 29; y += 1) { cv.set(11, y, P.blue[y > 27 ? 2 : 3]); cv.set(20, y, P.blue[y > 27 ? 2 : 3]); }
  cv.set(11, 26, P.white[2]); cv.set(20, 26, P.white[2]);
  if (g.cat) { cv.set(25, 28, P.eye[3]); cv.set(27, 28, P.eye[3]); }
  if (g.maid) {
    // 白色蕾絲頭飾、白圍裙、藍色領結、白色過膝襪。
    for (let x = 9; x <= 23; x += 1) { const lift = Math.round(Math.abs(x + 0.5 - cx) / 4); cv.set(x, 3 + lift, P.white[2]); if (x % 2 === 0) cv.set(x, 2 + lift, P.white[1]); }
    for (let y = 23; y < 28; y += 1) for (let x = 0; x < 32; x += 1) if ((cv.region[y][x] === 'body' || cv.region[y][x] === 'shorts') && near(x, cx, 2 + (y - 23) * 0.35)) cv.set(x, y, y === 27 ? P.white[0] : (x + 0.5 > cx + 1 ? P.white[1] : P.white[2]));
    for (const [x, y] of [[15, 21], [16, 21], [14, 20], [17, 20]]) cv.set(x, y, P.blue[3]);
    for (let y = 29; y < 32; y += 1) for (let x = 0; x < 32; x += 1) if (cv.region[y][x] === 'sock') cv.set(x, y, x + 0.5 > 16.5 ? P.white[1] : P.white[2]);
    for (let y = 24; y <= 29; y += 1) { cv.set(11, y, cv.color[y][10] ?? null); cv.set(20, y, cv.color[y][21] ?? null); }
  } else {
    stamp(cv, 20, 1, ['KK...KK', 'KbBKBbK', 'KBBbBBK', '.KK.KK.'], { K: blk[0], B: blk[2], b: blk[3] });
    cv.set(20, 7, blk[0]); cv.set(22, 7, blk[0]); cv.set(21, 8, blk[0]); cv.set(20, 9, blk[0]); cv.set(22, 9, blk[0]); // X 髮夾（小）
  }
  // 表情：眼睛 1×2（上深下綠），歧路旅人式幾乎不畫嘴。
  const e = EXPRESSIONS[expression];
  const eye = (x, state) => {
    if (state === 'happy') { cv.set(x - 1, 15, P.line); cv.set(x, 14, P.line); cv.set(x + 1, 15, P.line); }
    else if (state === 'half') { cv.set(x, 15, P.line); cv.set(x + (x < cx ? -1 : 1), 15, P.line); }
    else if (state === 'narrow') { cv.set(x, 14, P.line); cv.set(x + (x < cx ? -1 : 1), 14, P.line); cv.set(x, 15, P.eye[2]); }
    else { cv.set(x, 14, P.line); cv.set(x, 15, P.eye[2]); }
  };
  eye(12, e.eyes[0]); eye(19, e.eyes[1]);
  if (e.brow) { cv.set(11, 12 + (e.brow > 0 ? 1 : 0), hair[0]); cv.set(12, 12 + (e.brow > 0 ? 0 : 1), hair[0]); cv.set(19, 12 + (e.brow > 0 ? 0 : 1), hair[0]); cv.set(20, 12 + (e.brow > 0 ? 1 : 0), hair[0]); }
  if (e.blush) { cv.set(11, 17, P.blush); cv.set(20, 17, P.blush); if (e.blush === 2) { cv.set(12, 17, P.blush); cv.set(19, 17, P.blush); } }
  const mouth = { open: [[15, 18, P.mouth[1]], [16, 18, P.mouth[1]]], tongue: [[15, 18, P.mouth[1]], [16, 18, P.mouth[3]]], o: [[16, 18, P.mouth[1]]], pout: [[15, 18, skin[1]], [16, 18, skin[1]]], wave: [[15, 18, skin[1]], [17, 18, skin[1]]], flat: [[15, 18, skin[2]], [16, 18, skin[2]]], smile: [] }[e.mouth];
  mouth.forEach(([x, y, c]) => cv.set(x, y, c));
  if (e.mark === 'z') stamp(cv, 5, 3, ['ZZZ', '.Z.', 'ZZZ'], { Z: P.blue[4] });
  if (e.mark === '?') stamp(cv, 5, 2, ['ZZ.', '..Z', '.Z.', '...', '.Z.'], { Z: P.blue[3] });
  return cv;
}

// ── h. 歧路旅人系列風格（32×40）：側身 3/4 朝左、近黑外框、明暗對比強、髮束一塊一塊、眼睛 1×2 格 ──
function traveler(g, P, expression) {
  const W = 32; const H = 40;
  const cv = new Canvas(W, H);
  const hair = P.hair; const skin = P.skin; const blk = P.black;
  const near = (x, c, r) => Math.abs(x + 0.5 - c) < r;
  const HX = 16.5; const HY = 12.5; // 頭髮中心
  const FX = 14.6; // 臉中心（往左偏＝臉朝左）
  // 區域：先畫的在後面
  cv.fill('back', (x, y) => inEllipse(x, y, HX, HY, 10, 10) || inPoly(x, y, [[6.6, 13], [6, 24], [7, 28.4], [8.6, 26.6], [10.2, 29.2], [12, 27], [21.6, 27], [23.4, 29.6], [25, 27.2], [26.6, 29], [27.2, 24], [26.6, 13]]));
  cv.fill('farArm', (x, y) => inPoly(x, y, [[19.6, 21.6], [22.6, 23.4], [23.6, 29.6], [21.2, 30], [20.2, 25]]));
  cv.fill('farHand', (x, y) => inEllipse(x, y, 22.5, 30.6, 1.2, 1.1));
  cv.fill('farLeg', (x, y) => y >= 30 && y < 35 && near(x, 18.4, 1.5));
  cv.fill('farShoe', (x, y) => inPoly(x, y, [[16.4, 35], [20.2, 35], [20.2, 37.4], [15.8, 37.4]]));
  cv.fill('shorts', (x, y) => y >= 28 && y < 31 && x >= 10 && x <= 20);
  cv.fill('nearLeg', (x, y) => y >= 30 && y < 36 && near(x, 13.2, 1.6));
  cv.fill('nearShoe', (x, y) => inPoly(x, y, [[10.2, 36], [15, 36], [15, 38.6], [9.4, 38.6]]));
  cv.fill('body', (x, y) => inPoly(x, y, [[10.6, 20.6], [20.4, 20.6], [21.8, 29.6], [9.2, 29.6]]));
  cv.fill('collar', (x, y) => y >= 19 && y < 22 && x >= 12 && x <= 16);
  cv.fill('nearArm', (x, y) => inPoly(x, y, [[11.2, 21.2], [8.2, 22.8], [6.8, 29.8], [9.8, 30.4], [10.8, 25]]));
  cv.fill('nearHand', (x, y) => inEllipse(x, y, 8, 30.9, 1.3, 1.2));
  cv.fill('face', (x, y) => inEllipse(x, y, FX, 14.4, 6.1, 5.9) || inPoly(x, y, [[8.6, 15], [20.4, 15], [17.6, 19], [13.2, 20.6], [10.2, 19]]));
  cv.fill('farLock', (x, y) => inPoly(x, y, [[22.4, 10], [24.8, 16], [24.6, 23], [23, 25.8], [21.4, 18], [21.2, 12]]));
  cv.fill('lock', (x, y) => inPoly(x, y, [[8.4, 9], [6.8, 16], [7.2, 23.6], [9.2, 26.2], [9.4, 18], [9.6, 12]]));
  cv.fill('bangs', (x, y) => inEllipse(x, y, HX, HY, 9.8, 9.8) && y < 12);
  [[9.6, 9, 16, 2.5], [12.6, 11.9, 13.6, 2.4], [15.6, 15.1, 15, 2.4], [18.6, 18.7, 13.4, 2.4], [21.4, 21.9, 15.4, 2.5], [24, 24.5, 16.4, 2.1]].forEach(([root, tip, tipY, half], i) => {
    const poly = [[root - half - 1, 7], ...curve([root - half, 9], [(root + tip) / 2 - half * 0.4, (9 + tipY) / 2], [tip, tipY], 4), ...curve([tip, tipY], [(root + tip) / 2 + half * 0.4, (9 + tipY) / 2], [root + half, 9], 4), [root + half + 1, 7]];
    cv.fill('bangs', (x, y) => inPoly(x, y, poly) && (y >= 9 || inEllipse(x, y, HX, HY, 9.8, 9.8)), i);
  });
  if (g.cat) cv.fill('cat', (x, y) => inEllipse(x, y, 27.6, 36.4, 3.1, 2.3) || inEllipse(x, y, 26.6, 32.8, 2.3, 2) || inPoly(x, y, [[24.4, 32.4], [24.8, 29.8], [26.2, 31.2]]) || inPoly(x, y, [[27.2, 31.2], [28.6, 29.8], [28.9, 32.4]])
    || inPoly(x, y, [[30.2, 37.4], [31.6, 34.6], [31.8, 32.8], [31, 32.8], [30.8, 34.6], [29.6, 36.4]]));
  // 上色：光從左上前方，對比拉開（亮部用最亮兩階、暗部直接用深色）。
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const r = cv.region[y][x];
    if (r === null) continue;
    let c;
    const above = cv.at(x, y - 1);
    switch (r) {
      case 'back': c = x < 9 && y < 20 ? hair[2] : hair[1]; if (y > 15 && (x === 8 || x === 23 || x === 26)) c = hair[0]; if (y > 17 && (x === 7 || x === 24)) c = hair[2]; if (y > 25 && cv.at(x, y + 1) === null) c = hair[0]; break;
      case 'lock': c = x < 8 ? hair[3] : hair[2]; if (y > 18 && x === 8) c = hair[1]; break;
      case 'farLock': c = x === 22 ? hair[2] : hair[1]; break;
      case 'bangs': {
        c = hair[3];
        const d = Math.hypot((x + 0.5 - (HX - 1.5)) / 9.8, (y + 0.5 - HY) / 9.8);
        if (y < 9 && d > 0.56 && d < 0.8) c = x + 0.5 < HX - 1 ? hair[5] : hair[4];
        if (x + 0.5 > HX + 5.5 && c === hair[3]) c = hair[2];
        const s = cv.strand[y][x];
        if (s >= 0 && y > 10 && cv.strand[y][x + 1] !== s && cv.at(x + 1, y) === 'bangs') c = hair[1];
        if (s >= 0 && y > 11 && cv.at(x, y + 1) !== 'bangs') c = hair[2];
        break;
      }
      case 'face': c = above === 'bangs' || above === 'lock' || above === 'farLock' ? skin[2] : cv.at(x, y - 2) === 'bangs' ? skin[3] : x + 0.5 > FX + 4 ? skin[3] : skin[4];
        if (cv.at(x, y + 1) === 'collar' || (y >= 19 && x > 14)) c = skin[2];
        break;
      case 'nearHand': c = skin[3]; break;
      case 'farHand': c = skin[2]; break;
      case 'collar': c = y === 19 ? blk[4] : blk[3]; break;
      case 'body': c = x < 12 ? blk[4] : x > 18 ? blk[2] : blk[3]; if (x === 15 && y > 22) c = blk[1]; if (y === 28 || y === 29) c = blk[2]; break;
      case 'nearArm': c = x < 9 ? blk[4] : blk[3]; if (y >= 28) c = blk[2]; break;
      case 'farArm': c = blk[2]; break;
      case 'shorts': c = blk[1]; break;
      case 'nearLeg': c = y === 30 ? skin[3] : x < 13 ? blk[3] : blk[2]; break;
      case 'farLeg': c = y === 30 ? skin[2] : blk[1]; break;
      case 'nearShoe': c = y === 38 ? P.white[1] : y === 37 ? P.white[2] : x < 11 ? blk[4] : blk[3]; break;
      case 'farShoe': c = y === 37 ? P.white[0] : y === 36 ? P.white[1] : blk[2]; break;
      case 'cat': c = y < 34 && x < 27 ? blk[3] : blk[2]; break;
      default: c = null;
    }
    cv.color[y][x] = c;
  }
  // 外框：外圍一律近黑；內部交界（袖子與身體、雙腿、頭髮與臉）也用深色線。
  const marks = [];
  const groups = { back: 'hair', lock: 'hair', farLock: 'hair', bangs: 'hair', face: 'skin', nearHand: 'skin', farHand: 'skin', collar: 'cloth', body: 'cloth', shorts: 'cloth', nearArm: 'arm', farArm: 'farArm', nearLeg: 'leg', farLeg: 'farLeg', nearShoe: 'shoe', farShoe: 'farShoe', cat: 'cat' };
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const r = cv.region[y][x];
    if (r === null) continue;
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => cv.at(x + dx, y + dy));
    if (n.includes(null)) marks.push([x, y, P.line]);
    else if (r === 'nearArm' && n.some((m) => m === 'body' || m === 'collar')) marks.push([x, y, blk[0]]);
    else if (r === 'nearLeg' && n.includes('farLeg')) marks.push([x, y, blk[0]]);
    else if ((r === 'bangs' || r === 'lock' || r === 'farLock') && n[2] === 'face') marks.push([x, y, hair[0]]);
    else if ((r === 'lock' || r === 'farLock') && n.some((m) => m === 'back')) marks.push([x, y, hair[0]]);
    else if (r === 'face' && n.some((m) => m === 'lock' || m === 'farLock' || m === 'back')) marks.push([x, y, skin[1]]);
    else if (groups[r] && n.some((m) => m !== null && groups[m] && groups[m] !== groups[r] && (r === 'body' || r === 'shorts') && (m === 'nearLeg' || m === 'farLeg'))) marks.push([x, y, blk[0]]);
  }
  marks.forEach(([x, y, c]) => cv.set(x, y, c));
  // 細節：外套上的藍色織帶與銀扣、袖口反光。
  for (let y = 23; y <= 31; y += 1) cv.set(10, y, P.blue[y > 29 ? 2 : 3]);
  for (let y = 23; y <= 29; y += 1) cv.set(19, y, P.blue[2]);
  cv.set(10, 26, P.white[2]); cv.set(19, 26, P.white[1]);
  cv.set(8, 29, blk[4]); cv.set(9, 29, blk[4]);
  if (g.cat) { cv.set(25, 32, P.eye[3]); cv.set(27, 32, P.eye[3]); cv.set(26, 30, blk[4]); }
  if (g.maid) {
    for (let x = 8; x <= 24; x += 1) { const lift = Math.round(Math.abs(x + 0.5 - 15.5) / 4); cv.set(x, 4 + lift, P.white[2]); if (x % 2 === 0) cv.set(x, 3 + lift, P.white[1]); cv.set(x, 5 + lift, hair[0]); }
    for (let y = 22; y < 31; y += 1) for (let x = 0; x < W; x += 1) if ((cv.region[y][x] === 'body' || cv.region[y][x] === 'shorts') && near(x, 14.5, 1.6 + (y - 22) * 0.4)) cv.set(x, y, y === 30 ? P.line : x + 0.5 > 16 ? P.white[1] : P.white[2]);
    for (const [x, y] of [[13, 21], [14, 21], [12, 20], [15, 20]]) cv.set(x, y, P.blue[3]);
    for (let y = 31; y < 36; y += 1) for (let x = 0; x < W; x += 1) if (cv.region[y][x] === 'nearLeg') cv.set(x, y, x < 13 ? P.white[2] : P.white[1]); else if (cv.region[y][x] === 'farLeg') cv.set(x, y, P.white[0]);
    for (let y = 23; y <= 31; y += 1) { cv.set(10, y, cv.color[y][11] ?? null); cv.set(19, y, cv.color[y][18] ?? null); }
  } else {
    stamp(cv, 20, 1, ['KK...KK', 'KbBKBbK', 'KBBbBBK', '.KK.KK.'], { K: P.line, B: blk[2], b: blk[4] }); // 蝴蝶結（頭的右後方）
    for (const [x, y] of [[19, 8], [21, 8], [20, 9], [19, 10], [21, 10]]) cv.set(x, y, P.line); // X 髮夾
  }
  // 表情：眼睛 1×2；臉朝左，遠側眼（左）靠近臉緣、近側眼（右）在臉中間。
  const e = EXPRESSIONS[expression];
  const EYE = [10, 15]; const EY = 14;
  const eye = (x, state, side) => {
    if (state === 'happy') { cv.set(x - 1, EY + 1, P.line); cv.set(x, EY, P.line); cv.set(x + 1, EY + 1, P.line); }
    else if (state === 'half') { cv.set(x, EY + 1, P.line); cv.set(x + side, EY + 1, P.line); }
    else if (state === 'narrow') { cv.set(x, EY, P.line); cv.set(x + side, EY, P.line); cv.set(x, EY + 1, P.eye[2]); }
    else { cv.set(x, EY, P.line); cv.set(x, EY + 1, P.eye[2]); if (side > 0) cv.set(x + 1, EY, P.line); }
  };
  eye(EYE[0], e.eyes[0], -1); eye(EYE[1], e.eyes[1], 1);
  if (e.brow) { cv.set(EYE[0], EY - 2 + (e.brow > 0 ? 0 : 1), hair[0]); cv.set(EYE[1], EY - 2 + (e.brow > 0 ? 0 : 1), hair[0]); cv.set(EYE[1] + 1, EY - 2 + (e.brow > 0 ? 1 : 0), hair[0]); }
  if (e.blush) { cv.set(16, 17, P.blush); if (e.blush === 2) { cv.set(17, 17, P.blush); cv.set(10, 17, P.blush); } }
  const MX = 12;
  const mouth = { open: [[MX, 18, P.mouth[1]], [MX + 1, 18, P.mouth[1]]], tongue: [[MX, 18, P.mouth[1]], [MX + 1, 18, P.mouth[3]]], o: [[MX + 1, 18, P.mouth[1]]], pout: [[MX, 18, skin[1]], [MX + 1, 18, skin[1]]], wave: [[MX, 18, skin[1]], [MX + 2, 18, skin[1]]], flat: [[MX, 18, skin[2]], [MX + 1, 18, skin[2]]], smile: [[MX + 1, 18, skin[2]]] }[e.mouth];
  mouth.forEach(([x, y, c]) => cv.set(x, y, c));
  if (e.mark === 'z') stamp(cv, 4, 3, ['ZZZ', '.Z.', 'ZZZ'], { Z: P.blue[4] });
  if (e.mark === '?') stamp(cv, 4, 2, ['ZZ.', '..Z', '.Z.', '...', '.Z.'], { Z: P.blue[3] });
  if (g.flip) cv.color = cv.color.map((row) => [...row].reverse());
  return cv;
}

function render(styleId, expression = 'calm') {
  const g = STYLES[styleId];
  if (g === undefined) throw new Error(`沒有畫法 ${styleId}`);
  const P = PALETTES[g.palette];
  const hex = (palette) => Object.fromEntries(Object.entries(palette).map(([key, v]) => [key, Array.isArray(v) ? v.map((c) => `#${c}`) : `#${v}`]));
  const Ph = hex(P);
  if (g.chibi) return chibi(g, Ph, expression);
  if (g.sprite) return sprite(g, Ph, expression);
  if (g.traveler) return traveler(g, Ph, expression);
  const cv = new Canvas(g.size, g.size);
  const geo = shapes(cv, g);
  paint(cv, g, Ph, geo);
  accessories(cv, g, Ph, geo);
  features(cv, g, Ph, geo, expression);
  return cv;
}

function draw(styleId, expression = 'calm', { crop = false } = {}) {
  const cv = render(styleId, expression);
  // 站姿角色當頭像時只取頭和肩膀。
  const view = crop && STYLES[styleId].traveler ? (STYLES[styleId].flip ? '5 0 24 24' : '3 0 24 24') : crop && STYLES[styleId].sprite ? '4 0 24 24' : `0 0 ${cv.w} ${cv.h}`;
  const rects = [];
  cv.color.forEach((row, y) => row.forEach((c, x) => { if (c) rects.push(`<rect x='${x}' y='${y}' width='1.02' height='1.02' fill='${c}'/>`); }));
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${view}' shape-rendering='crispEdges'>${rects.join('')}</svg>`;
}

module.exports = { draw, render, STYLES, PALETTES, EXPRESSIONS: Object.keys(EXPRESSIONS) };
