"""自己設計的動作（正面，初版）：使用者 2026-10-13「嘗試看看自己設計動作，列出來看每一個動作的效果，越多越好」。
做法和待機一樣：正面材質圖分組移動（這裡多了左右移動），再換表情、重畫手臂，交給同一套明暗規則；
頭上的小符號（驚嘆號、問號、愛心、音符……）是另外一層，畫在角色上面（和睡覺的 zzz 一樣）。"""
import math
from PIL import Image
import idle, jp_big, shade, sleep, views

shade.FIXED.update({"M": "#9c4656",   # 張開的嘴（嘴裡）
                    "R": "#f2939b"})  # 害羞、生氣時更紅的腮紅
HAIR = set("hHLZ")
SKIN = set("sS")
EYES = {"L": (18, 20), "R": (27, 29)}   # 兩隻眼睛的欄（畫面左、右），眼睛在第 17～20 列
EYE_Y = 17
MOUTH = [(23, 22), (24, 22)]
MOUTH_FIXED = True   # 嘴巴一律不變（使用者 2026-10-14）
SHOULDER = {"L": (16, 28), "R": (31, 28)}

# ---------------- 姿勢：分組移動 ----------------
def grp(x, y, c):
    if c == "V": return "shadow"
    g = idle.group_v5(x, y, c)
    if g == "arms": return "armL" if x <= 16 else "armR"
    return g

def frame(o, arms_off=()):
    """o：{組名: 往下移幾格 或 (往右, 往下)}。arms_off：要拿掉、之後重畫的手臂（"L"、"R"）。"""
    g, d = idle.base()
    H, W = len(g), len(g[0])
    for side in arms_off:                       # 拿掉垂下的手臂：原本被手臂擋住的是垂下的頭髮
        for y in range(27, 36):
            for x in range(W):
                if g[y][x] != "." and grp(x, y, g[y][x]) == "arm" + side:
                    g[y][x], d[y][x] = ("H", 10) if y <= 33 else (".", 0)
    off = lambda k: (0, o[k]) if isinstance(o.get(k, 0), int) else o[k]
    out = [["."] * W for _ in range(H)]; dep = [[0] * W for _ in range(H)]
    for z, x, y, c in sorted((d[y][x], x, y, g[y][x]) for y in range(H) for x in range(W) if g[y][x] != "."):
        dx, dy = off(grp(x, y, c)) if o.get(grp(x, y, c)) else (0, 0)
        X, Y = x + dx, y + dy
        if 0 <= X < W and 0 <= Y < H and (out[Y][X] == "." or z >= dep[Y][X]):
            out[Y][X] = c; dep[Y][X] = z
    for y in range(1, H - 1):                   # 錯開時中間裂開：用原本那一格補上（上下、左右都補）
        for x in range(1, W - 1):
            if out[y][x] == "." and g[y][x] != "." and g[y][x] != "V" and (
                    (out[y-1][x] != "." and out[y+1][x] != ".") or (out[y][x-1] != "." and out[y][x+1] != ".")):
                out[y][x] = g[y][x]; dep[y][x] = d[y][x]
    return [list(r) for r in out], dep

# ---------------- 手臂 ----------------
def line(a, b):
    (x0, y0), (x1, y1) = a, b
    n = max(abs(x1 - x0), abs(y1 - y0), 1)
    return [(round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n)) for i in range(n + 1)]

def put(g, d, x, y, c, z):
    if 0 <= x < len(g[0]) and 0 <= y < len(g) and (g[y][x] == "." or z >= d[y][x]):
        g[y][x] = c; d[y][x] = z

def arm(g, d, side, pts, z=92, hand=True, dy=0):
    """pts：肩膀之後的轉折點（手肘、手腕），每一段都是 3 格粗的袖子；最後一段尾端 2 格是袖口藍帶，再往外是 2×2 的手。"""
    sx, sy = SHOULDER[side]
    path = [(sx, sy + dy)] + [(x, y + dy) for x, y in pts]
    spine = []
    for a, b in zip(path, path[1:]): spine += line(a, b)
    cells = {(x + i, y + j) for x, y in spine for i in (-1, 0, 1) for j in (-1, 0, 1)}
    for x, y in sorted(cells):
        lit = (x, y - 1) not in cells or (x - 1, y) not in cells
        dark = (x, y + 1) not in cells or (x + 1, y) not in cells
        put(g, d, x, y, "G" if lit and not dark else ("J" if dark and not lit else "j"), z)
    (ax, ay), (bx, by) = path[-2], path[-1]
    n = max(abs(bx - ax), abs(by - ay), 1); ux, uy = (bx - ax) / n, (by - ay) / n
    brush = lambda p: {(p[0] + i, p[1] + j) for i in (-1, 0, 1) for j in (-1, 0, 1)}
    cuff = brush(spine[-1]) - (brush(spine[-3]) if len(spine) >= 3 else set())   # 袖口藍帶：袖子最尾端那一段（斜的時候也是整條帶子，不會變成格子花紋）
    for x, y in cuff: put(g, d, x, y, "b", z + 1)
    if hand:                                     # 手：手腕再往外 2 格的 2×2
        hx, hy = round(bx + ux * 2), round(by + uy * 2)
        for i in (0, 1):
            for j in (0, 1): put(g, d, hx + i - (ux < 0), hy + j - (uy < 0), "s", z + 2)

def sleeve(g, d, side, wrist, hand_at, z=92, dy=0, w=3, shine="edge"):
    """精修版的手臂（使用者 2026-10-14：手彎折會看起來過長）：從肩膀到手腕只有一段直的袖子，看不到手肘；
    袖口藍帶只有尾端 1 格深；手 2×2 直接指定位置（左上角）。shine：edge＝只有外側上緣一格受光、none＝不加亮邊。"""
    sx, sy = SHOULDER[side]
    wx, wy = wrist
    spine = line((sx, sy + dy), (wx, wy + dy))
    r = range(-(w // 2), w - w // 2)
    brush = lambda p: {(p[0] + i, p[1] + j) for i in r for j in r}
    cells = set().union(*(brush(p) for p in spine))
    for x, y in sorted(cells):
        dark = (x, y + 1) not in cells or (x + (1 if side == "L" else -1), y) not in cells and (x, y + 1) not in cells
        top = (x, y - 1) not in cells
        outer = x <= sx if side == "L" else x >= sx
        c = "J" if dark else ("G" if shine == "edge" and top and outer else "j")
        put(g, d, x, y, c, z)
    cuff = brush(spine[-1]) - (brush(spine[-2]) if len(spine) >= 2 else set())
    for x, y in cuff: put(g, d, x, y, "b", z + 1)
    hx, hy = hand_at
    for i in (0, 1):
        for j in (0, 1): put(g, d, hx + i, hy + j + dy, "s", z + 2)

# ---------------- 表情 ----------------
def eyes(g, kind, dy=0, dx=0, which="LR"):
    """kind：open／closed（閉眼線）／happy（^ ^）／wide（瞳孔縮小、驚訝）／half（半閉）／look-1、look1（往左右看）／down（往下看）。"""
    if kind == "open": return
    for side in which:
        x0, x1 = EYES[side]; x0 += dx; x1 += dx; y0 = EYE_Y + dy
        box = [(x, y) for y in range(y0, y0 + 4) for x in range(x0, x1 + 1)]
        if kind == "closed":
            for x, y in box: g[y][x] = "h" if y < y0 + 2 else ("e" if y == y0 + 2 else "s")
        elif kind == "happy":
            for x, y in box: g[y][x] = "h" if y < y0 + 2 else "s"
            g[y0 + 2][x0 + 1] = "e"; g[y0 + 3][x0] = "e"; g[y0 + 3][x1] = "e"
        elif kind == "wide":                     # 眼睛睜大：上緣眼線往上 1 格、瞳孔只剩中間一點
            for x in range(x0, x1 + 1): g[y0 - 1][x] = "e"
            for x, y in box:
                if y >= y0 + 1: g[y][x] = "s"
            g[y0 + 1][x0 + 1] = "E"; g[y0 + 2][x0 + 1] = "E"
        elif kind == "half":
            for x, y in box: g[y][x] = "h" if y < y0 + 2 else ("e" if y == y0 + 2 else "E")
        elif kind in ("look-1", "look1"):
            s = -1 if kind == "look-1" else 1
            for y in (y0 + 2, y0 + 3):
                row = [g[y][x] for x in range(x0, x1 + 1)]
                for x in range(x0, x1 + 1): g[y][x] = "s"
                for i, c in enumerate(row): g[y][x0 + i + s] = c
        elif kind == "down":                     # 往下看：上緣眼線往下 1 格（變成瀏海），瞳孔只剩下面一列
            for x, y in box: g[y][x] = "h" if y < y0 + 2 else ("e" if y == y0 + 2 else "E")
        elif kind == "x":                        # 頭暈：>< 的眼睛
            for x, y in box: g[y][x] = "h" if y < y0 + 2 else "s"
            g[y0 + 1][x0] = "h"; g[y0 + 2][x0 + 1] = "e"; g[y0 + 1][x1] = "h"
            g[y0 + 2][x0] = "e"; g[y0 + 2][x1] = "e"; g[y0 + 3][x0 + 1] = "e"
        elif kind == "star":                     # 眼睛發亮：瞳孔中間一格變亮綠
            g[y0 + 2][x0 + 1] = "Q"

def mouth(g, kind, dy=0, dx=0):
    """kind：dot（原本）／smile／open（張嘴笑）／o（驚訝的 o）／frown（嘴角往下）／flat（抿嘴）／yawn（大大張開）。
    使用者 2026-10-14：「嘴巴笑臉有點奇怪，可以都改成嘴巴不用動，原本那樣就好」→ 所有動作都維持原本的嘴（下面的形狀先保留不用）。"""
    if MOUTH_FIXED or kind == "dot": return
    (ax, ay), (bx, _) = MOUTH; ay += dy; ax += dx; bx += dx
    for x in (ax, bx): g[ay][x] = "s"
    cells = {"smile": [(ax - 1, ay - 1, "m"), (ax, ay, "m"), (bx, ay, "m"), (bx + 1, ay - 1, "m")],
             "open":  [(ax - 1, ay - 1, "m"), (ax, ay, "M"), (bx, ay, "M"), (bx + 1, ay - 1, "m"), (ax, ay + 1, "m"), (bx, ay + 1, "m")],
             "o":     [(ax, ay, "M"), (bx, ay, "M"), (ax, ay + 1, "M"), (bx, ay + 1, "M")],
             "frown": [(ax - 1, ay + 1, "m"), (ax, ay, "m"), (bx, ay, "m"), (bx + 1, ay + 1, "m")],
             "flat":  [(ax - 1, ay, "m"), (ax, ay, "m"), (bx, ay, "m"), (bx + 1, ay, "m")],
             "yawn":  [(ax, ay - 1, "M"), (bx, ay - 1, "M"), (ax, ay, "M"), (bx, ay, "M"), (ax, ay + 1, "M"), (bx, ay + 1, "M")],
             "wavy":  [(ax - 1, ay, "m"), (ax, ay - 1, "m"), (bx, ay, "m"), (bx + 1, ay - 1, "m")]}[kind]
    for x, y, c in cells: g[y][x] = c

def blush(g, strong=True):
    for row in g:
        for x, c in enumerate(row):
            if c == "P": row[x] = "R"

# ---------------- 畫出一格 ----------------
def pose(o=None, eye="open", mth="dot", arms=None, bow=0, red=False, eye_dx=0, sleeves=None, fab=None):
    """arms：{"L": [轉折點…], "R": [...]}（座標以頭沒移動時為準，跟著 body 一起上下）。bow：臉往下轉（和睡覺同一套）。"""
    o = dict(o or {}); arms = arms or {}; sleeves = sleeves or {}
    if "arms" in o: o["armL"] = o["armR"] = o.pop("arms")      # 待機的呼吸用 arms（兩隻手一起）
    g, d = frame(o, arms_off=tuple(arms) + tuple(sleeves))
    hdx, hdy = (0, o.get("head", 0)) if isinstance(o.get("head", 0), int) else o["head"]
    bdy = o.get("body", 0) if isinstance(o.get("body", 0), int) else o["body"][1]
    eyes(g, eye, hdy, hdx + eye_dx if eye.startswith("look") else hdx)
    mouth(g, mth, hdy, hdx)
    if red: blush(g)
    for side, pts in arms.items():
        arm(g, d, side, pts, dy=bdy)
    for side, (wrist, hand_at) in sleeves.items():
        sleeve(g, d, side, wrist, hand_at, dy=bdy)
    rows = ["".join(r) for r in g]
    if fab: rows = idle.fabric(rows, {k: v for k, v in o.items() if isinstance(v, int)}, fab)
    if bow: rows = sleep.bow(rows, bow, hdy)
    pin = not any(k in o for k in ("feet", "shadow"))
    return idle.render(rows, d, pin=pin)

# ---------------- 整個人移動（跳）：角色往上搬、地面陰影留在原地並縮小 ----------------
SHADOW_C = (0xd2, 0xcd, 0xe2)
def lift(im, k):
    if not k: return im
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            p = px[x, y]
            if p[3] and p[:3] == SHADOW_C: continue
            if p[3] and 0 <= y - k < im.height: out.putpixel((x, y - k), p)
    cx, cy, rx, ry = 24, 39.5, max(3.5, 7.5 - k * 1.2), 1.6
    for y in range(36, 43):
        for x in range(48):
            if ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1 and not out.getpixel((x, y))[3]:
                out.putpixel((x, y), SHADOW_C + (255,))
    return out

def shift(im, dx):
    out = Image.new("RGBA", im.size, (0, 0, 0, 0)); out.paste(im, (dx, 0)); return out

# ---------------- 頭上的小符號（另一層） ----------------
C = {"b": (0x4a, 0x8f, 0xf0, 255), "l": (0xa0, 0xcc, 0xff, 255), "w": (0xf8, 0xf5, 0xee, 255), "d": (0x40, 0x42, 0x7a, 255),
     "p": (0xff, 0x8f, 0xa3, 255), "r": (0xd8, 0x4a, 0x5e, 255), "y": (0xff, 0xd8, 0x5e, 255), "o": (0xc9, 0x8a, 0x2a, 255),
     "m": (0x72, 0x7a, 0xb0, 255)}
SPR = {
    "!":     ["bb", "bb", "bb", "bb", "..", "bb"],
    "?":     [".bbb.", "b...b", "...b.", "..b..", ".....", "..b.."],
    "heart": [".pp.pp.", "prpprpp", "ppppppp", ".ppppp.", "..ppp..", "...p..."],
    "heart_s": ["p.p", "ppp", ".p."],
    "note":  ["..bb", "..bl", "..b.", "bbb.", "bbb."],
    "note2": [".bbbb", ".b..b", ".b..b", "bb.bb", "bb.bb"],
    "spark": ["..l..", "..b..", "lbwbl", "..b..", "..l.."],
    "spark_s": [".b.", "bwb", ".b."],
    "sweat": [".l.", "lwl", "lll", ".l."],
    "tear":  ["l", "l"],
    "anger": ["r.r", ".r.", "r.r"],
    "vein":  [".rr.rr.", "r.r.r.r", "rr...rr", ".......", "rr...rr", "r.r.r.r", ".rr.rr."],
    "bulb":  [".yyy.", "yywyy", "yyyyy", ".yyy.", ".ddd.", "..d.."],
    "dot":   ["mm", "mm"],
    "swirl": [".bbb.", "b...b", "b.b.b", "b..bb", ".b..."],
    "star":  ["..y..", ".yyy.", "yyyyy", ".y.y."],
    "puff":  [".ww.", "wwww", ".ww."],
    "ray":   ["y", ".", "y"],
}

def fx(items):
    """items：[(符號, x, y)]，回傳一張 48×43 的透明層。"""
    im = Image.new("RGBA", (48, 43), (0, 0, 0, 0))
    for name, x, y in items:
        for r, row in enumerate(SPR[name]):
            for c, ch in enumerate(row):
                if ch != "." and 0 <= x + c < 48 and 0 <= y + r < 43: im.putpixel((x + c, y + r), C[ch])
    return im

def over(im, layer):
    im = im.copy(); im.alpha_composite(layer); return im

# ---------------- 動作 ----------------
SQ = {"head": 1, "body": 1, "armL": 1, "armR": 1, "tips": 1}   # 往下蹲 1 格（待機的「擠」）
WAVE_R = [[(35, 24), (37, 19)], [(35, 24), (35, 19)]]           # 揮手：上臂往外、前臂往上，手左右擺

def a_wave():
    f = []
    for i in range(6):
        im = pose(eye="happy" if i % 3 == 2 else "open", mth="smile", arms={"R": WAVE_R[i % 2]}, o={"head": (0, 0)})
        f.append((im, 180))
    return [(pose(mth="smile"), 300)] + f + [(pose(mth="smile"), 400)]

def a_bow():
    clasp = {"L": [(21, 32)], "R": [(26, 32)]}
    s = []
    s.append((pose(mth="smile", arms=clasp), 400))
    s.append((pose(o={"head": 1}, eye="closed", mth="smile", arms=clasp, bow=1), 200))
    s.append((pose(o={"head": 1, "body": 1, "tips": 1}, eye="closed", mth="dot", arms=clasp, bow=2), 900))
    s.append((pose(o={"head": 1}, eye="closed", mth="smile", arms=clasp, bow=1), 200))
    s.append((pose(eye="happy", mth="smile", arms=clasp), 700))
    return s

def a_hop():
    st = pose(eye="happy", mth="open")
    sq = pose(o=SQ, eye="happy", mth="open")
    seq = [(pose(mth="smile"), 300), (sq, 120)]
    for k, t in ((2, 90), (4, 120), (4, 120), (2, 90)):
        seq.append((over(lift(st, k), fx([("spark_s", 8, 6 - k), ("spark_s", 38, 9 - k)])), t))
    seq += [(sq, 120), (st, 300)]
    return seq

def a_cheer():
    up = {"L": [(12, 22), (11, 16)], "R": [(35, 22), (36, 16)]}
    mid = {"L": [(11, 25), (9, 21)], "R": [(36, 25), (38, 21)]}
    a = pose(eye="happy", mth="open", arms=up); b = pose(eye="happy", mth="open", arms=mid)
    sp = [fx([("spark", 3, 5), ("spark_s", 41, 12)]), fx([("spark_s", 5, 12), ("spark", 39, 4)])]
    return [(pose(mth="smile"), 300), (over(b, sp[0]), 140), (over(lift(a, 2), sp[1]), 200), (over(a, sp[0]), 160),
            (over(b, sp[1]), 140), (over(lift(a, 2), sp[0]), 200), (over(a, sp[1]), 300), (pose(mth="smile"), 300)]

def a_nod():
    s = [(pose(mth="smile"), 300)]
    for _ in range(2):
        s += [(pose(o={"head": 1}, eye="closed", mth="smile", bow=1), 180), (pose(eye="happy", mth="smile"), 220)]
    return s + [(pose(mth="smile"), 400)]

def a_shake():
    s = [(pose(mth="flat"), 300)]
    for dx in (-1, 1, -1, 1):
        s.append((pose(o={"head": (dx, 0), "tips": (dx, 0)}, eye="closed", mth="flat"), 140))
    return s + [(pose(eye="half", mth="flat"), 500)]

def a_think():
    hand = {"R": [(33, 31), (27, 26)]}           # 手托下巴
    s = []
    for i in range(4):
        dots = [("dot", 36, 12), ("dot", 39, 9), ("dot", 42, 6)][: i % 4]
        s.append((over(pose(eye="look1", mth="flat", arms=hand, eye_dx=0), fx(dots)), 380))
    return [(pose(), 300)] + s + s[1:]

def a_puzzled():
    tilt = {"head": (1, 0), "tips": (1, 0)}
    q = [fx([("?", 36, 5)]), fx([("?", 36, 4)])]
    return [(pose(), 300)] + [(over(pose(o=tilt, eye="look1", mth="wavy"), q[i % 2]), 300) for i in range(4)] + [(pose(), 300)]

def a_surprise():
    w = pose(eye="wide", mth="o")
    return [(pose(), 400), (over(lift(w, 2), fx([("!", 38, 6), ("ray", 35, 7), ("ray", 41, 7)])), 150),
            (over(w, fx([("!", 38, 7)])), 600), (over(w, fx([("!", 38, 7)])), 300), (pose(eye="open", mth="o"), 300)]

def a_idea():
    up = {"R": [(34, 24), (34, 19)]}               # 舉起一隻手（食指往上的感覺）
    b = [fx([("bulb", 36, 4)]), fx([("bulb", 36, 4), ("ray", 34, 3), ("ray", 42, 3)])]
    return [(pose(eye="look1", mth="flat"), 400), (over(pose(eye="star", mth="o", arms=up), b[0]), 200)] + \
           [(over(pose(eye="star", mth="open", arms=up), b[i % 2]), 220) for i in range(4)] + [(pose(mth="smile"), 300)]

def a_shy():
    clasp = {"L": [(21, 32)], "R": [(26, 32)]}
    s = []
    for i, dx in enumerate((0, -1, 0, 1, 0, -1)):
        s.append((over(pose(o={"head": (dx, 0), "tips": (dx, 0)}, eye="down", mth="wavy", arms=clasp, red=True),
                       fx([("heart_s", 38, 8 - i)]) if i < 4 else fx([])), 260))
    return [(pose(), 300)] + s

def a_wink():
    return [(pose(mth="smile"), 400), (pose(mth="smile", eye="closed"), 100),
            (over(pose(mth="smile"), fx([])), 100)] + \
           [(over(_wink(), fx([("star", 33, 13 - i)])), 140) for i in range(4)] + [(_wink(), 300), (pose(mth="smile"), 400)]

def _wink():
    o = {}; g, d = frame(o)
    eyes(g, "closed", which="R"); eyes(g, "happy", which="R") if False else None
    mouth(g, "smile")
    return idle.render(["".join(r) for r in g], d, pin=True)

def a_look():
    s = [(pose(), 400)]
    for dx, e in ((-1, "look-1"), (-1, "look-1"), (0, "open"), (1, "look1"), (1, "look1"), (0, "open")):
        s.append((pose(o={"head": (dx, 0), "tips": (dx, 0)}, eye=e), 450 if e != "open" else 200))
    return s

def a_hum():
    s = []
    notes = [("note", 37, 10), ("note2", 40, 4), ("note", 4, 8)]
    for i in range(8):
        dx = (0, 1, 0, -1)[i % 4]
        lay = fx([(n, x, y - (i % 4)) for k, (n, x, y) in enumerate(notes) if (i // 2 + k) % 3 != 2])
        s.append((over(pose(o={"head": (dx, 0), "tips": (dx, 0)}, eye="happy", mth="smile"), lay), 280))
    return s

def a_stretch():
    up = {"L": [(12, 21), (12, 14)], "R": [(35, 21), (35, 14)]}   # 手臂從頭的兩側往上伸（從臉前面伸上去會把臉擋住）
    hi = {"head": -1, "body": -1, "armL": -1, "armR": -1, "tips": -1, "hem": -1}
    return [(pose(), 300), (pose(eye="closed", arms=up), 200), (pose(o=hi, eye="closed", mth="yawn", arms=up), 900),
            (pose(eye="closed", mth="o", arms=up), 300), (pose(o=SQ, eye="happy", mth="smile"), 200), (pose(eye="happy", mth="smile"), 400)]

def a_yawn():
    cover = {"L": [(19, 30), (22, 25)]}            # 手遮嘴
    return [(pose(eye="half"), 400), (pose(o={"head": -1}, eye="closed", mth="yawn"), 300),
            (pose(o={"head": -1}, eye="closed", mth="yawn", arms=cover), 700),
            (over(pose(eye="closed", arms=cover), fx([("tear", 21, 20)])), 300),
            (over(pose(eye="half"), fx([("tear", 21, 21)])), 500)]

def a_pout():
    s = [(pose(), 300)]
    for i in range(4):
        o = SQ if i % 2 else {}
        s.append((over(pose(o=o, eye="half", mth="frown", red=True), fx([("vein", 33, 4 + (i % 2))])), 200))
    return s + [(over(pose(eye="closed", mth="flat", red=True), fx([("puff", 36, 18), ("puff", 8, 18)])), 500)]

def a_sad():
    return [(pose(), 300), (pose(o={"head": 1}, eye="down", mth="frown", bow=1), 600),
            (over(pose(o={"head": 1}, eye="down", mth="frown", bow=1), fx([("tear", 19, 22)])), 400),
            (over(pose(o={"head": 1}, eye="down", mth="frown", bow=1), fx([("tear", 19, 24)])), 400),
            (pose(o={"head": 1}, eye="closed", mth="frown", bow=1), 600)]

def a_awkward():
    s = [(pose(eye="open", mth="wavy"), 300)]
    for i in range(5):
        s.append((over(pose(eye="look-1" if i < 3 else "half", mth="wavy"), fx([("sweat", 35, 12 + i)])), 260))
    return s

def a_dizzy():
    s = []
    for i in range(8):
        dx = (0, 1, 0, -1)[i % 4]
        sw = fx([("swirl", 20 + dx * 2, 0), ("spark_s", 14 + (i % 4) * 4, 3 + (i % 2))])
        s.append((over(pose(o={"head": (dx, 0), "tips": (dx, 0)}, eye="x", mth="wavy"), sw), 200))
    return s

def a_love():
    s = [(pose(mth="smile"), 300)]
    clasp = {"L": [(20, 30), (22, 26)], "R": [(27, 30), (25, 26)]}   # 雙手在胸前（下巴下面）合起來
    for i in range(6):
        lay = fx([("heart", 35, 12 - i * 2)] + ([("heart_s", 8, 14 - i)] if i > 1 else []))
        s.append((over(pose(eye="happy", mth="smile", red=True, arms=clasp), lay), 220))
    return s

def a_spin():
    ims = [Image.open(p).convert("RGBA") for p in ("final_front.png", "final_side_right.png", "final_back.png", "final_side.png")]
    return [(ims[0], 400)] + [(ims[i % 4], 110) for i in range(1, 9)] + [(ims[0], 300)]

def a_clap():
    apart = {"L": [(18, 32), (20, 28)], "R": [(29, 32), (27, 28)]}
    toget = {"L": [(19, 32), (22, 28)], "R": [(28, 32), (24, 28)]}
    s = [(pose(mth="smile"), 300)]
    for i in range(6):
        if i % 2: s.append((over(pose(eye="happy", mth="open", arms=toget), fx([("ray", 20, 25), ("ray", 28, 25)])), 140))
        else: s.append((pose(eye="happy", mth="open", arms=apart), 160))
    return s + [(pose(eye="happy", mth="smile"), 300)]

def a_point():
    out = {"R": [(36, 27), (41, 27)]}             # 手往右邊伸直：「在這裡」
    return [(pose(mth="smile"), 300), (pose(mth="smile", arms={"R": [(35, 29), (39, 28)]}), 140),
            (pose(eye="look1", mth="smile", arms=out), 900), (over(pose(eye="happy", mth="open", arms=out), fx([("spark_s", 44, 22)])), 500),
            (pose(mth="smile"), 300)]

def a_loading():
    """頭的右上方三個點繞圈（頭頂上面沒有空間），眼睛跟著往上看、偶爾眨眼。"""
    s = []
    ring = [(round(42 + 4 * math.cos(a)), round(9 + 4 * math.sin(a))) for a in (k * math.pi / 4 - math.pi / 2 for k in range(8))]
    for i in range(8):
        lay = Image.new("RGBA", (48, 43), (0, 0, 0, 0))
        for k, col in ((0, C["b"]), (1, C["l"]), (2, C["m"])):   # 前面那個點最深，後面兩個漸淡
            x, y = ring[(i - k) % 8]
            for dx in (0, 1):
                for dy in (0, 1): lay.putpixel((x + dx, y + dy), col)
        s.append((over(pose(eye="closed" if i == 5 else "look1", mth="dot"), lay), 140))
    return s

def a_sneeze():
    return [(pose(eye="half", mth="o"), 300), (pose(o={"head": -1}, eye="closed", mth="o"), 300),
            (pose(o={"head": -1}, eye="closed", mth="yawn"), 200),
            (over(pose(o={"head": 1, "body": 1, "tips": 1}, eye="closed", mth="flat", bow=1), fx([("puff", 32, 23), ("puff", 13, 23), ("!", 38, 8)])), 400),
            (pose(eye="closed", mth="wavy", red=True), 300), (pose(eye="half", mth="smile"), 400)]

ACTIONS = [  # (代號, 名稱, 說明, 適合的情況)
    ("wave", "揮手打招呼", "舉起右手左右擺，眼睛笑成 ^ ^", "打開 Studio、對話開始"),
    ("bow", "鞠躬", "雙手交握在身前、閉眼低頭，再抬頭笑", "歡迎、道謝、女僕感"),
    ("hop", "開心跳一下", "先蹲預備、跳起 4 格；起跳時頭髮慢一步、落下時頭髮往上飄，落地蹲一下吸收", "任務完成、收到稱讚"),
    ("cheer", "歡呼", "雙手高舉、^ ^ 眼、跳兩下，周圍閃亮", "大成功、測試全過"),
    ("nod", "點頭", "臉往下點兩次，抬頭時 ^ ^ 眼", "同意、收到指示"),
    ("shake", "搖頭", "閉眼，頭左右擺", "拒絕、找不到、失敗"),
    ("think", "思考", "手托下巴、眼睛往旁邊看，頭上冒出 …", "處理中、想答案"),
    ("puzzled", "疑問", "頭歪一邊、眼睛往旁邊看，頭上有 ?", "看不懂、需要確認"),
    ("surprise", "驚訝", "眼睛睜大，跳一下、頭上有 !", "收到通知、出錯"),
    ("idea", "靈光一閃", "舉手、眼睛發亮，頭上燈泡亮起來", "想到辦法、建議"),
    ("shy", "害羞", "雙手交握、臉紅往下看，偷瞄一眼又低下去，手指不安地動", "被稱讚"),
    ("wink", "眨眼", "頭輕輕一歪、右眼眨成 ^，星星從眼角冒出來飄走", "俏皮的回應"),
    ("look", "左右張望", "頭和眼睛往左看、再往右看", "等待、找東西"),
    ("hum", "哼歌", "閉眼笑、頭左右晃，音符飄起來", "閒置、心情好"),
    ("stretch", "伸懶腰", "雙手往上伸、整個人往上拉、閉眼，然後放鬆", "長時間工作後"),
    ("yawn", "打哈欠", "閉眼、手遮嘴，眼角有淚", "很晚、閒置很久"),
    ("pout", "生氣（鼓臉）", "半閉眼、臉紅，生氣符號一跳一跳、跺兩下，最後「哼」把頭轉開噴一口氣", "被戳太多次"),
    ("sad", "難過", "低頭、肩膀垂下，眼角冒出一滴淚滑下臉頰，最後閉上眼睛", "失敗、出錯"),
    ("awkward", "尷尬冒汗", "眼睛飄走，一滴汗往下滑", "小失誤、不好意思"),
    ("dizzy", "頭暈", "> < 眼、頭晃來晃去，頭上轉圈圈", "太多任務、當機"),
    ("love", "愛心", "雙手在胸前、臉紅、^ ^ 眼；愛心從小變大、晃著往上飄，另一邊再冒一顆小的", "謝謝、喜歡"),
    ("spin", "轉一圈", "蹲一下、輕輕跳起來轉一圈（用四方向定稿），落地 ^ ^ 眼和閃光", "換裝、開心、展示"),
    ("clap", "拍手", "手抬到胸前拍三下，拍的時候頭輕點、冒小閃光", "恭喜、完成"),
    ("point", "指向一邊", "右手往旁邊伸直、眼睛看過去", "介紹畫面上的東西"),
    ("loading", "讀取中", "照常呼吸，三個點在頭的右上方繞圈，眼睛看著點、偶爾眨眼", "等待回應"),
    ("sneeze", "打噴嚏", "吸氣抬頭、哈啾往前點頭，臉紅", "彩蛋"),
]

def build(code, draft=False):
    """精修過的動作（r_）優先；draft=True 拿初版（a_）。"""
    f = globals().get("r_" + code)
    return (globals()["a_" + code] if draft or not f else f)()


# ================= 精修（使用者 2026-10-14 選：6 拍手、7 跳一下、9 愛心、10 眨眼、12 轉一圈、16 讀取中、19 害羞、20 生氣、21 難過） =================
# 共同原則：手臂只有一段從肩膀到手腕的直袖子（手彎折會看起來過長）；停著的地方帶待機的呼吸，不會僵住。
REFINED = ["clap", "hop", "love", "wink", "spin", "loading", "shy", "pout", "sad"]
BREATH = idle.CYCLE5                      # 待機的一次呼吸：(位移, 毫秒) × 9，共 2860 毫秒
SPR.update({
    "vein5": [".r.r.", "rr.rr", ".....", "rr.rr", ".r.r."],               # 生氣符號（小）：和初版同一個形狀縮小，一大一小輪流＝跳動
    "vein7": [".rr.rr.", "r.r.r.r", "rr...rr", ".......", "rr...rr", "r.r.r.r", ".rr.rr."],   # 生氣符號（大，初版那個）
    "heart_m": [".p.p.", "prppp", "ppppp", ".ppp.", "..p.."],
    "drop1": ["l"], "drop2": ["l", "l"],
    "cloud": [".mm.", "mmmm"],
})
HANDS = {  # 精修用的手臂：(手腕, 手的左上角)
    "clap_open": {"L": ((19, 30), (20, 30)), "R": ((28, 30), (26, 30))},
    "clap_shut": {"L": ((20, 30), (22, 30)), "R": ((27, 30), (24, 30))},
    "chest":     {"L": ((20, 29), (22, 28)), "R": ((27, 29), (24, 28))},
    "clasp":     {"L": ((19, 31), (22, 32)), "R": ((28, 31), (24, 32))},
    "clasp_up":  {"L": ((19, 30), (22, 31)), "R": ((28, 30), (24, 31))},
}

def r_clap():
    """拍三下：手從身體兩側抬到胸前，合起來那一格頭跟著輕點 1 格、兩邊冒出小閃光。"""
    op, sh = HANDS["clap_open"], HANDS["clap_shut"]
    pop = fx([("ray", 19, 27), ("ray", 28, 27)])
    s = [(pose(), 400), (pose(eye="happy", sleeves=op), 160)]
    for _ in range(3):
        s += [(over(pose(o={"head": 1}, eye="happy", sleeves=sh), pop), 130), (pose(eye="happy", sleeves=op), 170)]
    return s + [(pose(eye="happy", sleeves=sh), 400), (pose(eye="happy"), 300)]

def r_hop():
    """先蹲（預備）→ 起跳時頭髮慢一步留在下面 → 最高點頭髮跟上 → 落下時頭髮往上飄 → 落地再蹲一下吸收。地面陰影跟著高度縮放。"""
    st = lambda o=None: pose(o=o, eye="happy")
    sp = lambda k: fx([("spark_s", 7, 7 - k), ("spark", 37, 8 - k)])
    return [(pose(), 400), (pose(o=SQ, eye="closed"), 140),
            (lift(st({"tips": 1, "hem": 1}), 2), 80),
            (over(lift(st(), 4), sp(4)), 140),
            (over(lift(st({"tips": -1}), 3), sp(3)), 90),
            (lift(st({"tips": -1}), 1), 70),
            (pose(o=dict(SQ, hem=1), eye="happy"), 130),
            (st({"tips": 1}), 160), (st(), 450)]

def r_love():
    """雙手在胸前、臉紅、^ ^ 眼；愛心從小到大冒出來、左右輕輕晃著往上飄，再變小消失；第二顆小愛心晚一點從另一邊冒。"""
    ch = HANDS["chest"]
    path = [("heart_s", 36, 14), ("heart_m", 35, 12), ("heart", 35, 10), ("heart", 36, 8), ("heart", 35, 6), ("heart_m", 36, 4), ("heart_s", 37, 3), None]
    path2 = [None, None, None, ("heart_s", 8, 15), ("heart_s", 7, 13), ("heart_s", 8, 11), None, None]
    s = [(pose(), 300), (pose(eye="happy", red=True, sleeves=ch), 200)]
    for i in range(8):
        o = BREATH[[0, 1, 2, 4, 4, 5, 7, 8][i]][0]
        s.append((over(pose(o=o, eye="happy", red=True, sleeves=ch), fx([h for h in (path[i], path2[i]) if h])), 200))
    return s + [(pose(eye="happy", red=True), 300)]

def wink_pose(o=None, star=None):
    """眨眼：畫面右邊那隻眼睛閉成 ^（另一隻張開），頭往右歪 1 格。"""
    o = dict(o or {}); g, d = frame(o)
    hdx, hdy = o.get("head", (0, 0)) if isinstance(o.get("head", 0), tuple) else (0, o.get("head", 0))
    eyes(g, "happy", hdy, hdx, which="R")
    im = idle.render(["".join(r) for r in g], d, pin=True)
    return over(im, fx([star])) if star else im

def r_wink():
    tilt = {"head": (1, 0), "tips": (1, 0)}
    return [(pose(), 600), (wink_pose(tilt), 90), (wink_pose(tilt, ("spark_s", 32, 15)), 110),
            (wink_pose(tilt, ("star", 33, 13)), 160), (wink_pose(tilt, ("star", 34, 11)), 160), (wink_pose(tilt, ("spark_s", 36, 10)), 160),
            (wink_pose(tilt), 300), (pose(), 500)]

def r_spin():
    """原地轉一圈（正面 → 向右 → 背面 → 向左 → 正面），轉的時候輕輕跳起來（1～2 格），落地蹲一下、^ ^ 眼。"""
    fr, rt, bk, lf = (Image.open(p).convert("RGBA") for p in ("final_front.png", "final_side_right.png", "final_back.png", "final_side.png"))
    return [(fr, 400), (pose(o=SQ), 110), (lift(rt, 1), 100), (lift(bk, 2), 100), (lift(lf, 1), 100),
            (fr, 80), (pose(o=SQ, eye="happy"), 130), (over(pose(eye="happy"), fx([("spark_s", 8, 9), ("spark", 37, 6)])), 500)]

def r_loading():
    """等待：待機的呼吸照常，三個點在頭的右上方繞圈（一次呼吸繞兩圈），眼睛往右上看、呼吸到最低點時眨一下眼。"""
    tick = 143; n = 20                          # 20 × 143 ≈ 2860（一次呼吸）
    ring = [(round(41.5 + 4 * math.cos(a)), round(8 + 4 * math.sin(a))) for a in (k * 2 * math.pi / 10 - math.pi / 2 for k in range(10))]
    starts = [0]
    for _, t in BREATH: starts.append(starts[-1] + t)
    s = []
    for i in range(n):
        t = i * tick
        k = max(j for j in range(len(BREATH)) if starts[j] <= t)
        lay = Image.new("RGBA", (48, 43), (0, 0, 0, 0))
        for back, col in ((0, C["b"]), (2, C["l"]), (4, C["m"])):   # 三個點隔開（相鄰會黏成一條線）
            x, y = ring[(i - back) % 10]
            for dx in (0, 1):
                for dy in (0, 1): lay.putpixel((x + dx, y + dy), col)
        blink = i == 9
        s.append((over(pose(o=BREATH[k][0], eye="closed" if blink else "look1", fab=idle.FABRIC5[k]), lay), tick))
    return s

def r_shy():
    """雙手在身前交握、臉紅、往下看；偷瞄一眼旁邊又低下去，手指不安地上下動；頭輕輕左右晃，偶爾冒一顆小愛心。"""
    cl, up = HANDS["clasp"], HANDS["clasp_up"]
    seq = [  # (頭左右, 眼睛, 手, 小愛心)
        (0, "down", cl, None), (-1, "down", cl, None), (-1, "down", up, None), (0, "down", cl, ("heart_s", 36, 12)),
        (1, "look1", cl, ("heart_s", 37, 10)), (1, "look1", cl, ("heart_s", 37, 8)), (1, "down", up, None), (0, "down", cl, None)]
    s = [(pose(), 300)]
    for k, (dx, e, hands, h) in enumerate(seq):
        o = {"head": (dx, 0), "tips": (dx, 0)}
        s.append((over(pose(o=o, eye=e, red=True, sleeves=hands), fx([h] if h else [])), 300 if e == "look1" else 260))
    return s

def r_pout():
    """生氣：半閉眼、臉頰鼓紅；頭上的生氣符號一跳一跳，身體跟著跺兩下；最後「哼」一聲把頭轉開、閉眼，旁邊噴出一小團氣。"""
    s = [(pose(), 300)]
    for i in range(4):
        o = SQ if i % 2 else {}
        s.append((over(pose(o=o, eye="half", red=True), fx([("vein7", 33, 4)] if i % 2 == 0 else [("vein5", 34, 5)])), 170))
    turn = {"head": (-1, 0), "tips": (-1, 0)}
    s += [(over(pose(o=turn, eye="closed", red=True), fx([("vein5", 33, 5)])), 200),
          (over(pose(o=turn, eye="closed", red=True), fx([("vein5", 33, 5), ("puff", 7, 21)])), 260),
          (over(pose(o=turn, eye="closed", red=True), fx([("vein5", 33, 5), ("puff", 5, 20)])), 260),
          (over(pose(o=turn, eye="closed", red=True), fx([("vein5", 33, 5)])), 500)]
    return s

def r_sad():
    """難過：低頭（臉往下轉）、往下看，肩膀垂下 1 格；眼角慢慢冒出一滴淚、滑下臉頰再掉下去；最後閉上眼睛。呼吸放慢。"""
    down = {"head": 1, "body": 1, "arms": 1, "tips": 1}
    tear = [None, ("drop1", 20, 21), ("drop2", 20, 21), ("drop2", 20, 23), ("drop2", 20, 25), ("drop1", 20, 28), None]
    s = [(pose(), 300), (pose(o={"head": 1}, eye="down", bow=1), 300)]
    for i, t in enumerate(tear):
        s.append((over(pose(o=down, eye="down", bow=1, fab="squash"), fx([t] if t else [])), 260 if t else 400))
    return s + [(pose(o=down, eye="closed", bow=1, fab="squash"), 800), (pose(o={"head": 1}, eye="down", bow=1), 300)]


GROUPS = [("打招呼與回應", ["wave", "bow", "nod", "shake", "point", "clap"]),
          ("開心", ["hop", "cheer", "love", "wink", "hum", "spin"]),
          ("思考與等待", ["think", "puzzled", "idea", "loading", "look"]),
          ("情緒", ["surprise", "shy", "pout", "sad", "awkward", "dizzy"]),
          ("累了", ["stretch", "yawn", "sneeze"])]
NUM = {c: i + 1 for i, c in enumerate(c for _, g in GROUPS for c in g)}   # 頁面上的編號（使用者用編號挑選）

def save_gifs(codes=None, folder="actions_out", scale=6):
    for code in codes or [a[0] for a in ACTIONS]:
        seq = build(code)
        for bg, suf in (("#ebe8f2", ""), ("#2a2b33", "_dark")):
            big = []
            for im, t in seq:
                b = Image.new("RGBA", im.size, bg); b.alpha_composite(im)
                big.append(b.convert("RGB").resize((48 * scale, 43 * scale), Image.NEAREST))
            big[0].save(f"{folder}/{code}{suf}.gif", save_all=True, append_images=big[1:], duration=[t for _, t in seq], loop=0, disposal=2)

LOOP = {"loading"}   # 會一直循環的；其他都是播一次的反應

def final(code):
    """成品（給 Studio）：播一次的動作第一格和最後一格都是正面待機第 0 格，從待機切過來、播完接回去畫面不會跳。"""
    seq = build(code)
    if code not in LOOP and seq[-1][0].tobytes() != pose().tobytes(): seq = seq + [(pose(), 250)]
    return [im for im, _ in seq], [t for _, t in seq]

def save_final(code, folder="actions_out/final"):
    fr, du = final(code)
    for i, im in enumerate(fr): im.save(f"{folder}/{code}_f{i}.png")
    return fr, du
