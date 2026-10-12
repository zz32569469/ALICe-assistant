// 參謀手帳、女僕茶會、遊戲選單（§36、§37）的背景圖、紋理與裝飾，輸出 SVG 到 src/assets/themes/。
// 執行：node scripts/theme-art.cjs。隨機位置用固定種子，每次產生的結果相同。
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '..', 'src', 'assets', 'themes');
fs.mkdirSync(target, { recursive: true });
const write = (name, text) => fs.writeFileSync(path.join(target, name), text);
const svg = (w, h, body, extra = '') => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}' width='${w}' height='${h}' ${extra}>${body}</svg>`;
const f = (n) => Math.round(n * 10) / 10;
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// ───── 共用：顆粒雜訊（紙紋）─────
const noise = (size, freq, alpha, tone) => svg(size, size, `<filter id='n' x='0' y='0'><feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 ${tone} 0 0 0 0 ${tone} 0 0 0 0 ${tone} 0 0 0 ${alpha} 0'/></filter><rect width='100%' height='100%' filter='url(#n)'/>`);
write('paper-grain.svg', noise(240, 0.85, 0.09, 0.2));

// ───── a. 參謀手帳：印章 ─────
{
  const ring = (r, w) => `<circle cx='90' cy='90' r='${r}' fill='none' stroke='#a6416a' stroke-width='${w}'/>`;
  let ticks = '';
  for (let i = 0; i < 48; i += 1) ticks += `<line x1='90' y1='14' x2='90' y2='${i % 4 === 0 ? 22 : 18}' stroke='#a6416a' stroke-width='1.4' transform='rotate(${i * 7.5} 90 90)'/>`;
  const body = `${ring(80, 4)}${ring(72, 1.5)}${ticks}${ring(48, 1.5)}`
    + `<text x='90' y='86' text-anchor='middle' font-family='Segoe UI, sans-serif' font-weight='700' font-size='22' letter-spacing='4' fill='#a6416a'>ALICE</text>`
    + `<text x='90' y='108' text-anchor='middle' font-family='Microsoft JhengHei, sans-serif' font-weight='700' font-size='14' letter-spacing='6' fill='#a6416a'>參謀室</text>`
    + `<path d='M54 118 h72' stroke='#a6416a' stroke-width='1.2'/>`
    + `<text x='90' y='62' text-anchor='middle' font-family='Segoe UI, sans-serif' font-size='9' letter-spacing='3' fill='#a6416a'>★ CONFIDENTIAL ★</text>`;
  write('stamp.svg', svg(180, 180, `<g opacity='0.92'>${body}</g>`));
}

// ───── c. 女僕茶會：蕾絲、碎花、茶具、蒸氣、緞帶 ─────
{
  // 蕾絲：半圓扇形邊＋小孔，可水平平鋪。
  write('lace.svg', svg(28, 14, `<path d='M0 0 H28 V4 A7 7 0 0 1 14 4 A7 7 0 0 1 0 4 Z' fill='#ffffff'/><path d='M0 4 A7 7 0 0 0 14 4 A7 7 0 0 0 28 4' fill='none' stroke='#d8c6e6' stroke-width='1'/><circle cx='7' cy='5' r='1.3' fill='#d8c6e6'/><circle cx='21' cy='5' r='1.3' fill='#d8c6e6'/>`));
  // 碎花壁紙。
  const flower = (x, y, s, color) => `<g transform='translate(${x} ${y}) scale(${s})'>${[0, 90, 180, 270].map((a) => `<ellipse cx='0' cy='-3.6' rx='2.8' ry='3.6' fill='${color}' transform='rotate(${a})'/>`).join('')}<circle r='1.6' fill='#f3d27a'/></g>`;
  write('floral.svg', svg(64, 64, `${flower(16, 16, 1, '#e7b9d3')}${flower(48, 48, 0.9, '#cdb6ea')}<circle cx='48' cy='14' r='1.4' fill='#e7b9d3'/><circle cx='14' cy='48' r='1.4' fill='#cdb6ea'/><path d='M30 32 q2 -3 4 0' stroke='#b9d9c4' stroke-width='1.2' fill='none'/>`));
  // 茶具線稿：茶壺、茶杯與盤、馬卡龍。
  const line = "stroke='#9a6fd0' stroke-width='2.2' fill='none' stroke-linecap='round' stroke-linejoin='round'";
  let tea = '';
  tea += `<path ${line} d='M70 200 C60 150 70 110 120 104 C170 110 180 150 170 200 Z'/>`;
  tea += `<path ${line} d='M96 104 C100 92 140 92 144 104 M120 92 v-8'/><circle cx='120' cy='80' r='5' ${line}/>`;
  tea += `<path ${line} d='M170 140 C196 132 204 168 172 182 M70 130 C40 120 30 100 22 92'/>`;
  tea += `<path ${line} d='M90 150 q30 12 60 0'/>`;
  tea += `<path ${line} d='M220 200 C222 170 228 160 230 156 H300 C302 160 308 170 310 200 Z'/><path ${line} d='M310 168 C330 166 332 190 310 192'/>`;
  tea += `<ellipse cx='265' cy='206' rx='62' ry='8' ${line}/>`;
  tea += `<path d='M240 176 q25 8 50 0' stroke='#e7739b' stroke-width='2.2' fill='none' stroke-linecap='round'/>`;
  for (const [x, y, color] of [[360, 196, '#e7739b'], [360, 176, '#b48be0'], [360, 156, '#9cd3b8']]) {
    tea += `<path d='M${x - 22} ${y} q22 -14 44 0 q-22 10 -44 0 Z' fill='${color}' fill-opacity='0.35' stroke='${color}' stroke-width='2'/><path d='M${x - 20} ${y + 4} h40' stroke='${color}' stroke-width='2'/>`;
  }
  tea += `<path d='M20 214 H400' stroke='#d8c6e6' stroke-width='1.5' stroke-dasharray='2 6' stroke-linecap='round'/>`;
  write('teaset.svg', svg(420, 230, tea));
  write('steam.svg', svg(60, 80, `<path d='M20 76 C10 60 30 50 20 34 C12 22 26 14 22 4' stroke='#b48be0' stroke-width='2' fill='none' stroke-linecap='round' opacity='0.6'/><path d='M38 76 C30 62 46 54 38 40 C32 30 42 22 40 12' stroke='#e7739b' stroke-width='2' fill='none' stroke-linecap='round' opacity='0.45'/>`));
  write('ribbon.svg', svg(180, 16, `<path d='M0 8 H70 M110 8 H180' stroke='#e7b9d3' stroke-width='1.5'/><path d='M90 8 L72 1 L74 15 Z M90 8 L108 1 L106 15 Z' fill='#e7739b'/><circle cx='90' cy='8' r='3.5' fill='#c95a85'/>`));
}

// ───── e. 遊戲選單：速度線、爆炸星 ─────
{
  const r = rng(5);
  let lines = '';
  for (let i = 0; i < 64; i += 1) {
    const a = (i / 64) * Math.PI * 2 + r() * 0.04;
    const inner = 140 + r() * 80;
    const outer = 560;
    const w = 1 + r() * 4;
    lines += `<line x1='${f(400 + Math.cos(a) * inner)}' y1='${f(400 + Math.sin(a) * inner)}' x2='${f(400 + Math.cos(a) * outer)}' y2='${f(400 + Math.sin(a) * outer)}' stroke='#ffffff' stroke-opacity='${f(0.05 + r() * 0.08)}' stroke-width='${f(w)}'/>`;
  }
  write('speedlines.svg', svg(800, 800, lines));
  const burst = (cx, cy, rOut, rIn, n, fill, rot) => {
    let d = '';
    for (let i = 0; i < n * 2; i += 1) {
      const a = (i / (n * 2)) * Math.PI * 2 + rot;
      const rr = i % 2 === 0 ? rOut : rIn;
      d += `${i === 0 ? 'M' : 'L'}${f(cx + Math.cos(a) * rr)} ${f(cy + Math.sin(a) * rr)} `;
    }
    return `<path d='${d}Z' fill='${fill}' stroke='#22113a' stroke-width='3' stroke-linejoin='round'/>`;
  };
  let bursts = '';
  bursts += burst(90, 90, 44, 26, 12, '#ffd23f', 0.1);
  bursts += burst(330, 180, 28, 16, 10, '#ff3d8b', 0.3);
  bursts += burst(190, 330, 20, 11, 8, '#5ce8ff', 0);
  for (const [x, y, s] of [[300, 60, 6], [60, 260, 5], [380, 340, 4], [230, 120, 3]]) bursts += `<path d='M${x} ${y - s * 2} L${x + s * 0.5} ${y - s * 0.5} L${x + s * 2} ${y} L${x + s * 0.5} ${y + s * 0.5} L${x} ${y + s * 2} L${x - s * 0.5} ${y + s * 0.5} L${x - s * 2} ${y} L${x - s * 0.5} ${y - s * 0.5} Z' fill='#ffffff'/>`;
  write('bursts.svg', svg(420, 420, bursts));
}

console.log('已寫入', target, fs.readdirSync(target).join(', '));
