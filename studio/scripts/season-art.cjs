// 季節主題（§35）的背景插畫、飄落粒子（可平鋪）與小圖示，輸出 SVG 到 src/assets/seasons/。
// 執行：node scripts/season-art.cjs。粒子位置用固定種子，每次產生的結果相同。
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '..', 'src', 'assets', 'seasons');
fs.mkdirSync(target, { recursive: true });

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const svg = (w, h, body, extra = '') => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}' ${extra}>${body}</svg>`;
const write = (name, text) => fs.writeFileSync(path.join(target, name), text);
const f = (n) => Math.round(n * 10) / 10;

// 一排起伏的山或丘：從左到右的平滑曲線，下方填滿。
function ridge(r, { w, h, base, amp, step, fill, opacity = 1 }) {
  let d = `M0 ${h} L0 ${f(base)}`;
  let y = base;
  for (let x = 0; x <= w; x += step) {
    const ny = base - amp * (0.35 + r() * 0.65);
    const cx = x + step / 2;
    d += ` Q${f(cx)} ${f(ny)} ${f(x + step)} ${f(y = base - amp * r() * 0.5)}`;
  }
  d += ` L${w} ${h} Z`;
  return `<path d='${d}' fill='${fill}' opacity='${opacity}'/>`;
}

// 五瓣花。
function blossom(cx, cy, r, color, center = '#f7d26a', rotate = 0) {
  const petals = [0, 72, 144, 216, 288].map((a) => `<ellipse cx='0' cy='${f(-r * 0.55)}' rx='${f(r * 0.42)}' ry='${f(r * 0.58)}' transform='rotate(${a})' fill='${color}'/>`).join('');
  return `<g transform='translate(${f(cx)} ${f(cy)}) rotate(${f(rotate)})'>${petals}<circle r='${f(r * 0.18)}' fill='${center}'/></g>`;
}
// 單片花瓣（飄落用）。
const petal = (x, y, s, rot, color) => `<path transform='translate(${f(x)} ${f(y)}) rotate(${f(rot)}) scale(${f(s)})' d='M0 -6 C4 -6 6 -1 4 3 C3 5 1 6 0 4 C-1 6 -3 5 -4 3 C-6 -1 -4 -6 0 -6 Z' fill='${color}'/>`;
// 楓葉：五個尖裂片＋葉柄。
function maple(x, y, s, rot, color) {
  const pts = [];
  const lobes = [[-90, 10], [-40, 8.5], [10, 7], [170, 7], [220, 8.5]];
  for (const [angle, len] of lobes) {
    const a = (angle * Math.PI) / 180;
    const a1 = ((angle - 16) * Math.PI) / 180;
    const a2 = ((angle + 16) * Math.PI) / 180;
    pts.push([Math.cos(a1) * len * 0.45, Math.sin(a1) * len * 0.45], [Math.cos(a) * len, Math.sin(a) * len], [Math.cos(a2) * len * 0.45, Math.sin(a2) * len * 0.45]);
  }
  pts.push([1, 3.5], [0.4, 9], [-0.4, 9], [-1, 3.5]);
  const d = `M${pts.map(([px, py]) => `${f(px)} ${f(py)}`).join(' L')} Z`;
  return `<path transform='translate(${f(x)} ${f(y)}) rotate(${f(rot)}) scale(${f(s)})' d='${d}' fill='${color}'/>`;
}
// 雪花：六支主幹各帶兩根小枝。
function snowflake(x, y, s, color, width = 1.2) {
  const arms = [0, 60, 120, 180, 240, 300].map((a) => `<g transform='rotate(${a})'><line x1='0' y1='0' x2='0' y2='-10'/><line x1='0' y1='-6' x2='-3' y2='-9'/><line x1='0' y1='-6' x2='3' y2='-9'/></g>`).join('');
  return `<g transform='translate(${f(x)} ${f(y)}) scale(${f(s)})' stroke='${color}' stroke-width='${width}' stroke-linecap='round'>${arms}</g>`;
}
// 松樹剪影。
const pine = (x, base, h, color) => {
  const w = h * 0.42;
  return `<path d='M${f(x)} ${f(base - h)} L${f(x + w * 0.5)} ${f(base - h * 0.55)} L${f(x + w * 0.3)} ${f(base - h * 0.55)} L${f(x + w * 0.7)} ${f(base - h * 0.15)} L${f(x + w * 0.1)} ${f(base - h * 0.15)} L${f(x + w * 0.1)} ${f(base)} L${f(x - w * 0.1)} ${f(base)} L${f(x - w * 0.1)} ${f(base - h * 0.15)} L${f(x - w * 0.7)} ${f(base - h * 0.15)} L${f(x - w * 0.3)} ${f(base - h * 0.55)} L${f(x - w * 0.5)} ${f(base - h * 0.55)} Z' fill='${color}'/>`;
};

const W = 1600;
const H = 900;
const sceneAttrs = "preserveAspectRatio='xMidYMax slice'";

// ───── 春 ─────
{
  const r = rng(11);
  let body = '';
  body += ridge(r, { w: W, h: H, base: 640, amp: 120, step: 260, fill: '#cfe3d4', opacity: 0.9 });
  body += ridge(r, { w: W, h: H, base: 720, amp: 90, step: 200, fill: '#b5d6bd' });
  body += ridge(r, { w: W, h: H, base: 810, amp: 60, step: 160, fill: '#9cc7a6' });
  // 右上角一枝櫻花。
  body += `<path d='M1600 40 C1480 70 1400 120 1300 200 C1260 230 1220 250 1170 262 M1420 110 C1400 160 1390 190 1350 230 M1330 180 C1290 170 1250 175 1210 190' stroke='#6b4a4f' stroke-width='9' fill='none' stroke-linecap='round'/>`;
  const branchPoints = [[1580, 50], [1520, 65], [1470, 85], [1430, 110], [1380, 150], [1330, 185], [1290, 215], [1240, 240], [1190, 258], [1400, 175], [1365, 222], [1260, 182], [1215, 192], [1500, 40], [1450, 60]];
  for (const [x, y] of branchPoints) {
    for (let k = 0; k < 3; k += 1) body += blossom(x + (r() - 0.5) * 40, y + (r() - 0.5) * 30, 10 + r() * 7, r() > 0.5 ? '#f6b8c9' : '#fbd3df', '#e88aa5', r() * 72);
  }
  write('spring-scene.svg', svg(W, H, body, sceneAttrs));
  const t = rng(12);
  let tile = '';
  for (let i = 0; i < 7; i += 1) tile += petal(t() * 260, t() * 260, 0.9 + t() * 0.9, t() * 360, ['#f6b8c9', '#f9c9d6', '#efa0b5'][i % 3]);
  write('spring-petals.svg', svg(260, 260, tile));
  write('icon-spring.svg', svg(24, 24, blossom(12, 12, 11, '#f19bb4', '#f7d26a')));
}

// ───── 夏 ─────
{
  const r = rng(21);
  let body = '';
  body += `<defs><radialGradient id='sun'><stop offset='0' stop-color='#fff7d6'/><stop offset='0.35' stop-color='#ffe08a' stop-opacity='0.9'/><stop offset='1' stop-color='#ffe08a' stop-opacity='0'/></radialGradient></defs>`;
  body += `<circle cx='1330' cy='170' r='260' fill='url(#sun)'/><circle cx='1330' cy='170' r='70' fill='#fff3c2'/>`;
  body += `<path d='M180 600 Q260 520 360 560 Q430 500 520 600 Z' fill='#5fae9c' opacity='0.85'/>`;
  body += `<rect x='0' y='598' width='${W}' height='${H - 598}' fill='#58b7d6'/>`;
  body += `<rect x='0' y='598' width='${W}' height='6' fill='#ffffff' opacity='0.5'/>`;
  for (const [x, y, s] of [[900, 240, 1], [960, 270, 0.7], [1050, 220, 0.8], [700, 300, 0.6]]) {
    body += `<path d='M${x} ${y} q${10 * s} ${-10 * s} ${20 * s} 0 q${10 * s} ${-10 * s} ${20 * s} 0' stroke='#3c5a6e' stroke-width='3' fill='none' stroke-linecap='round'/>`;
  }
  for (let i = 0; i < 40; i += 1) {
    const x = r() * W;
    const y = 640 + r() * 240;
    body += `<path d='M${f(x)} ${f(y)} h${f(20 + r() * 60)}' stroke='#ffffff' stroke-width='2' opacity='${f(0.25 + r() * 0.35)}' stroke-linecap='round'/>`;
  }
  write('summer-scene.svg', svg(W, H, body, sceneAttrs));
  // 海浪：可水平平鋪的浪（寬 800），由 CSS 慢慢往左移。
  const wave = (y, amp, color, opacity) => {
    let d = `M0 ${y}`;
    for (let x = 0; x < 800; x += 200) d += ` q50 ${-amp} 100 0 t100 0`;
    return `<path d='${d} V200 H0 Z' fill='${color}' opacity='${opacity}'/>`;
  };
  write('summer-waves.svg', svg(800, 200, wave(70, 22, '#7fd0e6', 0.7) + wave(110, 18, '#3fa6c9', 0.85) + wave(150, 14, '#2a8db3', 1)));
  const t = rng(22);
  let tile = '';
  for (let i = 0; i < 9; i += 1) tile += `<circle cx='${f(t() * 260)}' cy='${f(t() * 260)}' r='${f(1.5 + t() * 3.5)}' fill='none' stroke='#ffffff' stroke-width='1.2' opacity='${f(0.35 + t() * 0.4)}'/>`;
  write('summer-bubbles.svg', svg(260, 260, tile));
  write('icon-summer.svg', svg(24, 24, `<circle cx='12' cy='12' r='5' fill='#ffcf4a'/>${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<line x1='12' y1='2.5' x2='12' y2='5.5' stroke='#ffb020' stroke-width='2' stroke-linecap='round' transform='rotate(${a} 12 12)'/>`).join('')}`));
}

// ───── 秋 ─────
{
  const r = rng(31);
  let body = '';
  body += `<defs><radialGradient id='dusk'><stop offset='0' stop-color='#ffe2a8'/><stop offset='1' stop-color='#ffe2a8' stop-opacity='0'/></radialGradient></defs>`;
  body += `<circle cx='420' cy='430' r='300' fill='url(#dusk)' opacity='0.9'/><circle cx='420' cy='430' r='80' fill='#ffd27a' opacity='0.95'/>`;
  body += ridge(r, { w: W, h: H, base: 600, amp: 170, step: 300, fill: '#e3a679', opacity: 0.9 });
  body += ridge(r, { w: W, h: H, base: 690, amp: 130, step: 240, fill: '#cf7a4c' });
  body += ridge(r, { w: W, h: H, base: 790, amp: 90, step: 180, fill: '#a9512f' });
  for (let i = 0; i < 26; i += 1) {
    const x = r() * W;
    const base = 830 + r() * 60;
    const h = 60 + r() * 70;
    body += `<rect x='${f(x - 3)}' y='${f(base - h * 0.4)}' width='6' height='${f(h * 0.4)}' fill='#5a2c1c'/><circle cx='${f(x)}' cy='${f(base - h * 0.6)}' r='${f(h * 0.32)}' fill='${['#8f3a22', '#b5532b', '#7a2f1d'][i % 3]}'/>`;
  }
  write('autumn-scene.svg', svg(W, H, body, sceneAttrs));
  const t = rng(32);
  let tile = '';
  for (let i = 0; i < 6; i += 1) tile += maple(t() * 300, t() * 300, 0.9 + t() * 0.9, t() * 360, ['#d24b2a', '#e8892f', '#c23b2b', '#f0a43a'][i % 4]);
  write('autumn-leaves.svg', svg(300, 300, tile));
  write('icon-autumn.svg', svg(24, 24, maple(12, 11, 1.05, 0, '#d24b2a')));
}

// ───── 冬 ─────
{
  const r = rng(41);
  let body = '';
  for (let i = 0; i < 90; i += 1) body += `<circle cx='${f(r() * W)}' cy='${f(r() * 480)}' r='${f(0.6 + r() * 1.4)}' fill='#ffffff' opacity='${f(0.3 + r() * 0.6)}'/>`;
  body += `<circle cx='1260' cy='160' r='58' fill='#f4f1e6'/><circle cx='1284' cy='146' r='54' fill='#22345a' opacity='0.0'/>`;
  body += `<circle cx='1260' cy='160' r='110' fill='#f4f1e6' opacity='0.08'/>`;
  body += ridge(r, { w: W, h: H, base: 620, amp: 150, step: 280, fill: '#4c6a92', opacity: 0.9 });
  body += ridge(r, { w: W, h: H, base: 700, amp: 100, step: 220, fill: '#c9d8ea' });
  for (let i = 0; i < 34; i += 1) body += pine(r() * W, 760 + r() * 40, 70 + r() * 90, ['#1d3048', '#25405e'][i % 2]);
  body += ridge(r, { w: W, h: H, base: 800, amp: 60, step: 200, fill: '#eef4fb' });
  write('winter-scene.svg', svg(W, H, body, sceneAttrs));
  const t = rng(42);
  let small = '';
  for (let i = 0; i < 26; i += 1) small += `<circle cx='${f(t() * 240)}' cy='${f(t() * 240)}' r='${f(1 + t() * 1.8)}' fill='#ffffff' opacity='${f(0.5 + t() * 0.5)}'/>`;
  write('winter-snow-small.svg', svg(240, 240, small));
  let large = '';
  for (let i = 0; i < 5; i += 1) large += snowflake(t() * 360, t() * 360, 0.8 + t() * 0.7, '#ffffff', 1.4);
  write('winter-snow-large.svg', svg(360, 360, large));
  write('icon-winter.svg', svg(24, 24, snowflake(12, 12, 1.05, '#8fd3ff', 1.8)));
}

console.log('已寫入', target, fs.readdirSync(target).join(', '));
