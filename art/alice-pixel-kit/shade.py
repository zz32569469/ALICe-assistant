"""材質圖 -> 自動明暗 + 依材質變色的外框。
畫的人只要畫平塗的材質字母，明暗交給規則。"""
from PIL import Image

RAMPS = {  # 由暗到亮，整體降飽和
 "h": ["#262a3e", "#434c66", "#66718c", "#8f9ab2", "#bcc4d4"],   # 頭髮
 "s": ["#7e524e", "#c4887c", "#e4b4a0", "#f4d4c2"],              # 皮膚
 "j": ["#121319", "#22242f", "#353849", "#4c5066"],              # 外套
 "t": ["#0d0e14", "#1a1b25", "#282a38"],                         # 內搭/短褲
 "k": ["#0d0e14", "#1c1d29", "#2e3042"],                         # 過膝襪
 "b": ["#18335e", "#2b5596", "#4a7fc0"],                         # 藍色綁帶
 "w": ["#4e5262", "#9fa4b2", "#dcdfe6"],                         # 鞋
 "r": ["#0d0e14", "#1e2030", "#3a3d52"],                         # 蝴蝶結
}
FIXED = {"e": "#14302a", "E": "#2d6b58", "m": "#a8625f"}
CASTERS = {"h"}
LIGHTEN = {}
LEVELS_PER = {}
LIGHTEN_AMT = {}  # 個別亮色字元的提亮量（預設 1.5）
SOFT_CAST = set()
FORM_SOLID = set()  # 這些材質的明暗只看整體輪廓，不受內部其他材質的交界影響（避免臉上出現亮痕）  # 這些材質只吃 1 格的投影（例如臉，避免整片變暗）  # 個別材質的明暗階數，例如 {"s": 2}  # 例如 {"L": "h"}：該字元 = 指定材質並提亮  # 會在下方皮膚投影的材質
DIRS_LIT = [(-1,0),(0,-1),(-1,-1)]   # 光從左上來
DIRS_DARK = [(1,0),(0,1),(1,1)]

def render(rows, scale=8, strands=True, outline=None, levels=None, depth=None, cast=1.5, selout=False, rim=(), despeckle=0):
    W = max(len(r) for r in rows)
    g = [list(r.ljust(W, ".")) for r in rows]
    H = len(g)
    def mat(c):
        if c in FIXED: return c
        if c in LIGHTEN: return LIGHTEN[c]
        if c.isupper() and c.lower() in RAMPS: return c.lower()
        return c
    at = lambda x, y: mat(g[y][x]) if 0 <= x < W and 0 <= y < H else "."
    out = [[None]*W for _ in range(H)]
    LV = [[None]*W for _ in range(H)]   # (材質, 階數, 是否外框)
    for y in range(H):
        for x in range(W):
            raw = g[y][x]; m = mat(raw)
            if m == ".": continue
            if m in FIXED: out[y][x] = FIXED[m]; continue
            ramp = RAMPS[m]; n = len(ramp)
            # 往光源方向越快碰到邊界 -> 越亮；往背光方向越快碰到邊界 -> 越暗
            same = (lambda v: v != ".") if m in FORM_SOLID else (lambda v: v == m)
            lit = sum(same(at(x+dx*k, y+dy*k)) for dx,dy in DIRS_LIT for k in (1,2,3))
            dark = sum(same(at(x+dx*k, y+dy*k)) for dx,dy in DIRS_DARK for k in (1,2,3))
            lvl = (n - 1) / 2 + (dark - lit) / 4
            if m == "s" and at(x, y-1) in CASTERS: lvl -= 1
            if depth is not None:   # 投影：光源方向（左上）有更前面的東西擋住 -> 壓暗
                d0 = depth[y][x]
                offs = [(-1,-1),(0,-1),(-1,0)] if m in SOFT_CAST else [(-1,-1),(0,-1),(-1,0),(-1,-2),(0,-2),(-2,-1),(-2,-2),(-1,-3),(0,-3)]
                for dx, dy in offs:
                    X, Y = x+dx, y+dy
                    if 0 <= X < W and 0 <= Y < H and depth[Y][X] > d0 and g[Y][X] != "." and mat(g[Y][X]) not in FIXED and mat(g[Y][X]) != m:
                        lvl -= cast; break
            if raw in LIGHTEN: lvl += LIGHTEN_AMT.get(raw, 1.5)
            elif raw != m: lvl -= 1.5            # 大寫 = 皺褶/凹陷，固定壓暗          # 瀏海投影
            if m == "h" and strands and (x*2 + y//3) % 5 == 0: lvl -= 0.8  # 髮絲
            # 不同材質交界：右方或下方是別的材質時壓暗一階，讓形體分開
            for dx,dy in ([(1,0),(0,1)] if depth is None else []):
                v = at(x+dx, y+dy)
                if v not in (".", m) and v not in FIXED:
                    lvl -= 1; break
            lvl = max(1, min(n-1, round(lvl)))
            base_lvl = lvl
            # 反光（bounce / rim）：背光側、離邊緣第二格的地方提亮一階
            if m in rim and at(x+2, y) == "." and at(x+1, y) != ".":   # 只在右側（背光側）的直邊
                lvl = min(n-1, lvl + 1)
            # 外框：碰到空白就用最暗色；只在左上碰到空白則用次暗（受光斷線）
            nb = {(dx,dy): at(x+dx, y+dy) for dx,dy in [(-1,0),(1,0),(0,-1),(0,1)]}
            empty = [d for d,v in nb.items() if v == "."]
            if empty:
                lit_side = all(d in [(-1,0),(0,-1)] for d in empty)
                if selout:   # 選擇性外框：比內側暗一到兩階，受光側更淡
                    lvl = max(1, base_lvl - 1) if lit_side else max(0, base_lvl - 2)
                else:
                    lvl = 1 if lit_side else 0
            lv = LEVELS_PER.get(m, levels)
            if lv == 2 and lvl > 0:
                lvl = 1 if lvl <= (n-1)/2 else 2
            elif lv == 3 and lvl > 0:
                lvl = 1 if lvl < (n-1)/2 - 0.2 else (n-1 if lvl >= n-1 else 2)
            col = ramp[lvl]
            if outline == "black" and lvl == 0: col = "#1b1a24"
            if outline == "brown" and lvl == 0: col = "#3a2a2c"
            out[y][x] = col
            LV[y][x] = (m, lvl, bool(empty), raw)
    # 清理雜點：同材質內，跟周圍明暗都不一樣的零碎像素（看起來像髒污）改成周圍多數的明暗
    for _ in range(despeckle):
        changed = 0
        for y in range(H):
            for x in range(W):
                c = LV[y][x]
                if not c or c[2] or c[3] != c[0]: continue          # 外框、刻意畫的線條（大寫/亮線）不動
                nb = []
                for dx, dy in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(1,-1),(-1,1),(1,1)]:
                    X, Y = x+dx, y+dy
                    if 0 <= X < W and 0 <= Y < H and LV[Y][X] and LV[Y][X][0] == c[0] and not LV[Y][X][2]:
                        nb.append(LV[Y][X][1])
                if len(nb) < 3: continue
                same = nb.count(c[1])
                if same <= 1:
                    best = max(set(nb), key=nb.count)
                    if best != c[1]:
                        LV[y][x] = (c[0], best, False, c[3]); out[y][x] = RAMPS[c[0]][best]; changed += 1
        if not changed: break
    img = Image.new("RGBA", (W, H), (0,0,0,0))
    for y in range(H):
        for x in range(W):
            if out[y][x]:
                c = out[y][x].lstrip("#")
                img.putpixel((x,y), tuple(int(c[i:i+2],16) for i in (0,2,4)) + (255,))
    return img
