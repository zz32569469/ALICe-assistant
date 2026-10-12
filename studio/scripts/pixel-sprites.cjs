// 像素主題（§33）的圖：ALICE 16×16 頭像（依 persona 外觀：銀青長髮、綠眼、女僕頭飾）、愛心、星星。
// 執行：node scripts/pixel-sprites.cjs，輸出到 src/assets/pixel/*.svg。
const fs = require('fs');
const path = require('path');

const palette = {
  K: '#1a1c2c', // 外框
  W: '#f4f4f4', // 女僕頭飾、領子
  L: '#c8f4fa', // 髮色亮
  H: '#94b0c2', // 銀青髮
  D: '#566c86', // 髮色暗
  S: '#f5d0b0', // 皮膚
  s: '#f0a8a0', // 腮紅
  E: '#38b764', // 綠眼
  M: '#b13e53', // 嘴
  R: '#b13e53', // 緞帶
  B: '#333c57', // 黑色洋裝
};
const alice = [
  '................',
  '.....KKKKKK.....',
  '....KWWWWWWK....',
  '...KLLLLLLLLK...',
  '..KHLHHHHHHLHK..',
  '..KHHSSSSSSHHK..',
  '..KHSSSSSSSSHK..',
  '..KHSESSSSESHK..',
  '..KHSESSSSESHK..',
  '..KHsSSMMSSsHK..',
  '..KDHSSSSSSHDK..',
  '.KDHKKWRRWKKHDK.',
  '.KDHKBWWWWBKHDK.',
  'KDHHKBBWWBBKHHDK',
  'KDHHKBBBBBBKHHDK',
  'KKKKKKKKKKKKKKKK',
];
// 7×6 像素愛心（截止日用）。
const heart = [
  '.KK.KK.',
  'KRRKRRK',
  'KRWRRRK',
  '.KRRRK.',
  '..KRK..',
  '...K...',
];
// 5×5 星星（裝飾）。
const star = [
  '..Y..',
  '..Y..',
  'YYWYY',
  '..Y..',
  '..Y..',
];

function svg(rows, colors) {
  const width = rows[0].length;
  const rects = [];
  rows.forEach((row, y) => {
    if (row.length !== width) throw new Error(`第 ${y} 列長度 ${row.length}`);
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      rects.push(`<rect x='${x}' y='${y}' width='1' height='1' fill='${colors[ch]}'/>`);
    });
  });
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${rows.length}' shape-rendering='crispEdges'>${rects.join('')}</svg>`;
}

const target = path.resolve(__dirname, '..', 'src', 'assets', 'pixel');
fs.mkdirSync(target, { recursive: true });
for (const [name, rows, colors] of [['alice', alice, palette], ['heart', heart, { K: '#1a1c2c', R: '#b13e53', W: '#f4f4f4' }], ['star', star, { Y: '#ffcd75', W: '#f4f4f4' }]]) {
  fs.writeFileSync(path.join(target, `${name}.svg`), svg(rows, colors));
}
console.log('已寫入', target);
