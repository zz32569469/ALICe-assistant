// 塔羅牌面圖示：每張牌都不一樣。
// 大阿爾克那：羅馬數字＋各自的符號（占星、牌面上的物件）。
// 小阿爾克那：花色符號；王牌一個大符號、二～十排出對應數量（像撲克牌的點數）、宮廷牌是棋子＋花色。
// 符號後面加 U+FE0E，要求文字樣式，避免 Windows 換成彩色 emoji。

const TEXT = "︎";

const MAJOR: Record<string, [numeral: string, symbol: string]> = {
  愚者: ["0", "⚘"], 魔術師: ["I", "∞"], 女祭司: ["II", "☽"], 皇后: ["III", "♀"], 皇帝: ["IV", "♈"],
  教皇: ["V", "✠"], 戀人: ["VI", "♡"], 戰車: ["VII", "♋"], 力量: ["VIII", "♌"], 隱者: ["IX", "✶"],
  命運之輪: ["X", "☸"], 正義: ["XI", "⚖"], 吊人: ["XII", "♆"], 死神: ["XIII", "☠"], 節制: ["XIV", "♐"],
  惡魔: ["XV", "♑"], 高塔: ["XVI", "⚡"], 星星: ["XVII", "★"], 月亮: ["XVIII", "◑"], 太陽: ["XIX", "☀"],
  審判: ["XX", "♫"], 世界: ["XXI", "◎"],
};

const SUITS: Record<string, string> = { 權杖: "♣", 聖杯: "♥", 寶劍: "♠", 錢幣: "♦" };
const PIPS: Record<string, number> = { 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const COURT: Record<string, string> = { 侍者: "♟", 騎士: "♞", 皇后: "♛", 國王: "♚" };

export type TarotGlyph =
  | { kind: "major"; numeral: string; symbol: string }
  | { kind: "ace"; suit: string }
  | { kind: "pips"; suit: string; count: number }
  | { kind: "court"; suit: string; piece: string }
  | { kind: "unknown"; symbol: string };

export function tarotGlyph(name: string): TarotGlyph {
  const major = MAJOR[name];
  if (major !== undefined) return { kind: "major", numeral: major[0], symbol: major[1] + TEXT };
  const suitName = Object.keys(SUITS).find((suit) => name.startsWith(suit));
  if (suitName !== undefined) {
    const suit = SUITS[suitName]! + TEXT;
    const rank = name.slice(suitName.length);
    if (rank === "王牌") return { kind: "ace", suit };
    if (PIPS[rank] !== undefined) return { kind: "pips", suit, count: PIPS[rank]! };
    if (COURT[rank] !== undefined) return { kind: "court", suit, piece: COURT[rank]! + TEXT };
  }
  return { kind: "unknown", symbol: "✦" };
}
