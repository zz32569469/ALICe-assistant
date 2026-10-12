"""背面走路動畫（往畫面裡面走）。和正面、側面同一套節奏：6 幀、每幀 0.16 秒、上半身只在下沉時往下 1 格。
背面幾乎都是頭髮：腳往前跨是離鏡頭遠（畫面上往上）；頭髮是最主要的表現。"""
from PIL import Image
import idle, walk, walk_side, back_from_front as bf

HAIR = set("hHLZ")
BOB = [0, 0, 1, 0, 0, 1]
MS = 160

def base(cache={}):
    if "b" not in cache:
        bf.STYLE["layer"] = "AC"   # 和定稿同一組設定（否則結果取決於之前有沒有先畫過背面定稿）
        rows, d = bf.build_back()
        cache["b"] = ([list(r) for r in rows], [list(r) for r in d])
    return cache["b"]

def group(x, y, c):
    """背面的分組：頭（含蝴蝶結、半綁髮）、下半部頭髮（蓋住軀幹的長髮）、手臂、身體（髮縫間露出的外套和短褲）、左右腿。"""
    if c == "V": return "shadow"
    if y >= 36: return "legL" if x <= 23 else "legR"
    if y <= 25: return "head"
    if y >= 28 and x <= 14 and c not in HAIR: return "armL"
    if y >= 28 and x >= 33 and c not in HAIR: return "armR"
    if y >= 33: return "hairLow"   # 髮尾，連同髮縫間露出的外套和短褲（它們是透過髮縫看到的，要跟著髮尾一起擺）
    if c in HAIR: return "hair"
    return "body"

def frame(offsets):
    g, d = base()
    H, W = len(g), len(g[0])
    out = [["."] * W for _ in range(H)]; dep = [[0] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            if walk.in_shadow(W - 1 - x, y): out[y][x] = "V"; dep[y][x] = 1   # 背面是正面鏡射，地面陰影也要鏡射
    cells = [(d[y][x], x, y, g[y][x], group(x, y, g[y][x])) for y in range(H) for x in range(W) if g[y][x] not in ".V"]
    for z, x, y, c, k in sorted(cells):
        dx, dy = offsets.get(k, (0, 0))
        X, Y = x + dx, y + dy
        if 0 <= X < W and 0 <= Y < H and (out[Y][X] in ".V" or z >= dep[Y][X]):
            out[Y][X] = c; dep[Y][X] = z
    # 上下錯開的空隙：腿（襪子）、短褲最下一列、頭髮拉長補上
    src = {(x, y): (c, z) for z, x, y, c, k in cells}
    frame.stretched = set()   # 拉長補上的格子：render 時直接複製下方（或上方）那一格的顏色，不重新上明暗（否則會成一條橫線）
    for y in range(1, H - 1):
        for x in range(W):
            if out[y][x] in ".V" and out[y-1][x] not in ".V" and out[y+1][x] not in ".V":
                c, z = src.get((x, y), (None, 0))
                if c and (c == "k" or c in HAIR): out[y][x] = c; dep[y][x] = z; frame.stretched.add((x, y))
                elif out[y+1][x] in HAIR: out[y][x] = "H"; dep[y][x] = 10   # 手往上後下方空出的格子：垂在後面的頭髮
    # 被包住的整塊洞：碰到頭髮補成頭髮（長髮有厚度），否則補成後面的外套；原本就透明的缺口不補
    for reg in walk_side.enclosed(out):
        touch = {out[b][a] for x, y in reg for a, b in ((x+1, y), (x-1, y), (x, y+1), (x, y-1)) if 0 <= a < W and 0 <= b < H and out[b][a] != "."}
        if not any(g[y][x] != "." for x, y in reg): continue
        code, z = ("H", 10) if touch & HAIR else ("j", 50)
        for x, y in reg: out[y][x] = code; dep[y][x] = z
    return ["".join(r) for r in out], dep

def render(offsets):
    """所有部位都直接搬移定稿的像素（只有拉長、補洞的格子才重新上明暗），避免鞋子、藍帶、頭髮亮度跳動。"""
    rows, dep = frame(offsets)
    stretched = set(frame.stretched)
    im = idle.render(rows, dep)
    ref = Image.open("final_back.png").convert("RGBA")
    g, _ = base()
    order = sorted(((d, x, y, g[y][x]) for (x, y), d in ((xy, base()[1][xy[1]][xy[0]]) for xy in
             ((x, y) for y in range(len(g)) for x in range(len(g[0])) if g[y][x] not in ".V"))))
    for z, x, y, c in order:
        dx, dy = offsets.get(group(x, y, c), (0, 0))
        X, Y = x + dx, y + dy
        if 0 <= X < im.width and 0 <= Y < im.height and rows[Y][X] == c:
            im.putpixel((X, Y), ref.getpixel((x, y)))
    for x, y in sorted(stretched):   # 拉長的格子：和下方同材質就複製下方，否則複製上方
        ny = y + 1 if rows[y + 1][x] == rows[y][x] else y - 1
        im.putpixel((x, y), im.getpixel((x, ny)))
    return im

def check(frames, offsets):
    """和側面走路同一套檢查（破洞用外圍填色判斷；定稿本來的缺口可跟著頭或身體移動；兩腿間空隙不算）。"""
    ref = Image.open("final_back.png").convert("RGBA")
    pal = {p for p in ref.getdata() if p[3]}
    W, H = ref.size
    shadow = Image.new("RGBA", (1, 1), "#d2cde2").getpixel((0, 0))
    def holes(im):
        px = im.load()
        rows = ["".join("." if not px[x, y][3] else ("V" if px[x, y] == shadow else "#") for x in range(W)) for y in range(H)]
        ground = lambda reg: any(0 <= y + 1 < H and rows[y + 1][x] == "V" for x, y in reg)
        return {c for reg in walk_side.enclosed(rows) if not ground(reg) for c in reg}
    def seams(im):
        px = im.load()
        return {(x, y) for y in range(1, H-1) for x in range(W) if not px[x, y][3] and px[x, y-1][3] and px[x, y+1][3] and px[x, y+1] != shadow}
    h0, s0 = holes(ref), seams(ref)
    out = []
    for i, im in enumerate(frames):
        im = im.convert("RGBA")
        rows, _ = frame(offsets[i])
        moved = lambda pts: {(x + ox, y + oy) for x, y in pts for ox, oy in (offsets[i].get("head", (0, 0)), offsets[i].get("hair", (0, 0)), (0, 0))}
        gaps = [(x, y) for y in range(35, H) for x in range(W) if rows[y][x] == "k" and rows[y-1][x] == "."]
        new = {p for p in im.getdata() if p[3]} - pal
        out.append(f"幀{i}: 破洞 {len(holes(im) - moved(h0))}、新顏色 {len(new)}、夾縫 {len(seams(im) - moved(s0))}、腿斷開 {len(gaps)}")
    return out

# ---- 階段 1 ----
VARIANTS = {   # 著地時後腳的位移、髮尾是否左右擺
    "甲": (0, False),    # 後腳不動
    "乙": (1, False),    # 後腳往下 1 格（離鏡頭近），前後腳差別更明顯
    "丙": (1, True),     # 乙＋髮尾左右輕擺
}
SWAY = [0, 1, 1, 0, -1, -1]   # 髮尾左右擺（慢一拍跟著重心）

def steps(variant):
    back, sway = VARIANTS[variant]
    # 往前跨＝離鏡頭遠＝畫面上往上；經過時抬起的腳也往上 1 格
    legs = [dict(legL=(0, -1)), dict(legL=(0, -1), legR=(0, back)), dict(legL=(0, -1), legR=(0, back)),
            dict(legR=(0, -1)), dict(legR=(0, -1), legL=(0, back)), dict(legR=(0, -1), legL=(0, back))]
    fwd_arm = [None, "R", "R", None, "L", "L"]   # 和腳反向：左腳往前時右手往前
    out = []
    for i, b in enumerate(BOB):
        lag = min(max(b, BOB[i - 1]), b + 1)   # 頭髮在身體往上時慢一幀
        sx = SWAY[i] if sway else 0
        o = {"head": (0, b), "body": (0, b), "armL": (0, b), "armR": (0, b), "hair": (0, lag), "hairLow": (sx, lag)}
        if fwd_arm[i]:   # 往前擺的手只往上 1 格：背面的手多被頭髮蓋住，往內收會和外側長髮之間裂出直縫；也不做往下擺
            a = fwd_arm[i]; o["arm" + a] = (0, b - 1)
        o.update(legs[i])
        out.append(o)
    return out

def stage1(variant="乙"):
    seq = steps(variant)
    return [render(o) for o in seq], [MS] * len(seq)

def final():
    """目前成品：丙（後腳往下 1 格＋髮尾左右輕擺）。
    2026-10-04 起背面定稿的頭髮是同一片（使用者回饋「頭髮陰影不用分開」，back_from_front.SPLIT = False）；
    walk_back_out/stage1 是改之前的輸出。"""
    return stage1("丙")
