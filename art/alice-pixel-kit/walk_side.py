"""側面走路動畫（向左、向右各一套）。和正面走路同一套節奏：6 幀、每幀 0.16 秒、上半身只在下沉時往下 1 格。
側面兩條腿幾乎重疊，所以從畫圖的源頭把近側、遠側的腿各自取成一層，再分別移動。"""
from PIL import Image
import idle, views, jp_big

HAIR = set("hHLZ")
BOB = [0, 0, 1, 0, 0, 1]   # 和正面定案相同：只在著地後下沉 1 格
MS = 160                   # 和正面相同

def layers(facing):
    """回傳 (沒有腿的材質圖, 深度, {"legN": 近側腿的格子, "legF": 遠側腿的格子})；格子是 (x, y, 材質, 深度)。"""
    none, dn = views.side_rows(facing, "none")
    out = {}
    for key, which in (("legN", "near"), ("legF", "far")):
        r, d = views.side_rows(facing, which)
        out[key] = [(x, y, r[y][x], d[y][x]) for y in range(len(r)) for x in range(len(r[0])) if r[y][x] != none[y][x]]
    return none, dn, out

def group(x, y, c):
    """上半身的分組：頭、髮尾（身後的長髮）、手（手掌和袖口藍帶）、身體（含短褲）。"""
    if y <= 25: return "head"
    if c in HAIR: return "tips"
    if (c == "s" and 32 <= y <= 34) or (c == "b" and y == 32): return "hand"
    return "body"

def enclosed(rows, empty=".V"):
    """被包住的透明區域：從畫面外圍往內填，填不到的透明格子（不管洞多大都抓得到）。回傳區域清單。"""
    H, W = len(rows), len(rows[0])
    outside = set(); stack = [(x, y) for x in range(W) for y in (0, H - 1)] + [(x, y) for y in range(H) for x in (0, W - 1)]
    while stack:
        x, y = stack.pop()
        if (x, y) in outside or not (0 <= x < W and 0 <= y < H) or rows[y][x] not in empty: continue
        outside.add((x, y)); stack += [(x+1, y), (x-1, y), (x, y+1), (x, y-1)]
    seen, regions = set(), []
    for y in range(H):
        for x in range(W):
            if rows[y][x] == "." and (x, y) not in outside and (x, y) not in seen:
                reg, st = [], [(x, y)]
                while st:
                    a, b = st.pop()
                    if (a, b) in seen or not (0 <= a < W and 0 <= b < H) or rows[b][a] != "." or (a, b) in outside: continue
                    seen.add((a, b)); reg.append((a, b)); st += [(a+1, b), (a-1, b), (a, b+1), (a, b-1)]
                regions.append(reg)
    return regions

def frame(facing, offsets, cache={}, fill_regions=False):
    if facing not in cache: cache[facing] = layers(facing)
    g, d, legs = cache[facing]
    H, W = len(g), len(g[0])
    out = [["."] * W for _ in range(H)]; dep = [[0] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            if g[y][x] == "V": out[y][x] = "V"; dep[y][x] = 1
    cells = [(d[y][x], x, y, g[y][x], group(x, y, g[y][x])) for y in range(H) for x in range(W) if g[y][x] not in ".V"]
    cells += [(z, x, y, c, k) for k, lst in legs.items() for x, y, c, z in lst if c != "V"]
    for z, x, y, c, k in sorted(cells):
        dx, dy = offsets.get(k, (0, 0))
        X, Y = x + dx, y + dy
        if 0 <= X < W and 0 <= Y < H and (out[Y][X] in ".V" or z >= dep[Y][X]):
            out[Y][X] = c; dep[Y][X] = z
    # 錯開造成的上下空隙：腿（襪子）、短褲最下一列、頭髮拉長補上；被包住的空洞補成暗色頭髮
    base = {(x, y): (c, z) for z, x, y, c, k in cells}
    neck = offsets.get("head", (0, 0))[0] != offsets.get("body", (0, 0))[0]   # 只有頭和身體分開移動時才拉長高領
    for y in range(1, H - 1):
        for x in range(W):
            if out[y][x] in ".V" and out[y-1][x] not in ".V" and out[y+1][x] not in ".V":
                c, z = base.get((x, y), (None, 0))
                if c and (c == "k" or c in HAIR):
                    out[y][x] = c; dep[y][x] = z
                elif neck and out[y+1][x] == "t" and y <= 26:   # 頭不動、身體往前時，下巴和高領之間的空隙：高領往上拉長（脖子跟著前傾）
                    out[y][x] = "t"; dep[y][x] = 40
    for _ in range(2):   # 跑兩輪，兩格高的洞（手往旁邊擺後空出來的）也補得到
        for y in range(1, H - 1):
            for x in range(1, W - 1):
                if out[y][x] != "." or g[y][x] == ".": continue   # 原本就透明的缺口（例如蝴蝶結旁、兩腿之間）不補
                filled = lambda c: c not in ".V"
                if (filled(out[y][x-1]) and filled(out[y][x+1])) or (filled(out[y-1][x]) and filled(out[y+1][x])):
                    nb = [out[y-1][x], out[y+1][x], out[y][x-1], out[y][x+1]]
                    if any(c in HAIR for c in nb): out[y][x] = "H"; dep[y][x] = 10   # 後面的頭髮
                    else: out[y][x] = "j"; dep[y][x] = 50                            # 手移開後露出後面的外套
    if fill_regions:   # 階段 3 起：被包住的整塊洞一起補（2×2 的洞逐格補不到）；原本就透明的缺口（蝴蝶結旁）不補
        for reg in enclosed(out):
            touch = {out[b][a] for x, y in reg for a, b in ((x+1, y), (x-1, y), (x, y+1), (x, y-1))
                     if 0 <= a < W and 0 <= b < H and out[b][a] != "."}
            had = any(g[y][x] != "." for x, y in reg)
            if touch & HAIR and had: code, z = "H", 10        # 長髮有厚度，往後拖時後面露出來的仍是頭髮
            elif neck and "t" in touch: code, z = "t", 40     # 脖子旁：高領
            elif had: code, z = "j", 50                       # 手移開後的外套
            else: continue
            for x, y in reg: out[y][x] = code; dep[y][x] = z
    return ["".join(r) for r in out], dep

RIGID = {"legN", "legF", "hand"}   # 硬的部位：搬移原本的像素，不重新上明暗（鞋子、袖口藍帶重新上明暗會忽亮忽暗）

def draw_rows(rows, dep):
    orig = jp_big.build
    jp_big.build = lambda *a, **k: (rows, dep)
    try:
        return jp_big.draw(**views.FINAL)
    finally:
        jp_big.build = orig

def refs(facing, cache={}):
    """各硬部位的參考像素：手用定稿；每條腿用「只有那一條腿」的圖（兩條腿重疊時不會互相影響）。"""
    if facing not in cache:
        final = Image.open("final_side.png" if facing == "left" else "final_side_right.png").convert("RGBA")
        both, _ = views.side_rows(facing)
        _, _, legs = layers(facing)
        near_cells = {(x, y) for x, y, c, z in legs["legN"]}
        r = {"hand": final, "head": final, "body": final, "tips": final}
        for key, which in (("legN", "near"), ("legF", "far")):
            alone = draw_rows(*views.side_rows(facing, which)).convert("RGBA")
            mix = alone.copy()
            for x, y, c, z in legs[key]:   # 定稿裡看得到的格子用定稿的顏色（站著不動時和定稿完全相同），被擋住的才用單腿圖
                if both[y][x] == c and (key == "legN" or (x, y) not in near_cells):
                    mix.putpixel((x, y), final.getpixel((x, y)))
            r[key] = mix
        cache[facing] = r
    return cache[facing]

RIGID2 = RIGID | {"head", "body", "tips"}   # 階段 2 起：上半身只是整塊平移，也搬移定稿像素（重新上明暗時外套亮邊會閃）

def render(facing, offsets, rigid=RIGID, fill_regions=False):
    rows, dep = frame(facing, offsets, fill_regions=fill_regions)
    im = draw_rows(rows, dep)
    g, d, legs = frame.__defaults__[0][facing]
    ref = refs(facing)
    # 依前後順序貼：遠側腿 → 近側腿 → 手（兩條腿重疊的格子要讓近側腿蓋在上面）
    cells = [(x, y, c, k) for k in ("legF", "legN") if k in rigid for x, y, c, z in legs[k] if c != "V"]
    cells += [(x, y, g[y][x], group(x, y, g[y][x])) for y in range(len(g)) for x in range(len(g[0]))
              if g[y][x] not in ".V" and group(x, y, g[y][x]) in rigid]
    for x, y, c, k in cells:
        dx, dy = offsets.get(k, (0, 0))
        X, Y = x + dx, y + dy
        if 0 <= X < im.width and 0 <= Y < im.height and rows[Y][X] == c:
            im.putpixel((X, Y), ref[k].getpixel((x, y)))
    if facing == "right" and "head" not in rigid:   # 臉用向左同一幀的臉左右翻轉（和定稿一樣，兩邊是同一張臉）
        mirrored = {k: (-dx, dy) for k, (dx, dy) in offsets.items()}
        left = render("left", mirrored, rigid, fill_regions); lrows, _ = frame("left", mirrored, fill_regions=fill_regions)
        W = im.width
        for y in range(im.height):
            for x in range(W):
                if rows[y][x] in "seEPm" and lrows[y][W-1-x] == rows[y][x]:
                    im.putpixel((x, y), left.getpixel((W - 1 - x, y)))
    return im

def steps(stride, facing="left"):
    """stride：前後腳離中點幾格（1＝兩腳相距 2 格，2＝相距 4 格）。
    兩條腿原本就前後錯開 2 格（近側在前），所以以兩腿的中點為準：近側腿＝中點−1、遠側腿＝中點＋1。
    6 幀：近側腿經過（抬起）→ 近側腿著地往前 → 下沉 → 遠側腿經過 → 遠側腿著地往前 → 下沉。
    手和腳反向擺；髮尾在身體往上時慢一幀。向右時前後方向相反。"""
    f = -1 if facing == "left" else 1          # 往前是哪個方向
    s = stride
    front = lambda base: f * s - base           # 走到前面需要的位移（base：這條腿原本離中點多遠，以往前為正）
    back = lambda base: -f * s - base
    nN, nF = f * 1, -f * 1                      # 近側腿原本在中點前 1 格、遠側腿在中點後 1 格
    legs = [dict(legN=(-nN, -1), legF=(-nF, 0)),            # 近側腿經過：兩腿都在中點，近側抬起
            dict(legN=(front(nN), 0), legF=(back(nF), 0)),  # 近側腿著地在前、遠側在後
            dict(legN=(front(nN), 0), legF=(back(nF), 0)),  # 下沉
            dict(legF=(-nF, -1), legN=(-nN, 0)),            # 遠側腿經過
            dict(legF=(front(nF), 0), legN=(back(nN), 0)),  # 遠側腿著地在前
            dict(legF=(front(nF), 0), legN=(back(nN), 0))]  # 下沉
    hand = [0, -f, -f, 0, f, f]                 # 近側腿在前時手往後擺，遠側腿在前時手往前擺
    out = []
    for i, b in enumerate(BOB):
        tips = min(max(b, BOB[i - 1]), b + 1)
        o = {"head": (0, b), "body": (0, b), "hand": (hand[i], b), "tips": (0, tips)}
        o.update(legs[i])
        out.append(o)
    return out

def stage1(stride=1, facing="left"):
    seq = steps(stride, facing)
    return [render(facing, o) for o in seq], [MS] * len(seq)

# 階段 2：使用者選跨步中；回饋「像左右腳交換，需要前進感、重心遷移」。
# 1. 支撐腳連續往後滑（身體往前，踩著的腳相對身體一格一格往後），不再停在原地再跳位置
# 2. 重心推進：兩腳經過時重心壓到支撐腳上，上半身往前 1 格；身後的長髮不跟，被拖在後面
FEET = [   # 每一幀（近側腿位置, 近側抬起, 遠側腿位置, 遠側抬起）；位置＝離兩腿中點幾格，往前為正
    (0, 1, 0, 0),     # 近側腿經過（抬起），遠側腿踩在身體正下方
    (2, 0, -2, 0),    # 近側腿著地在前、遠側在後
    (1, 0, -2, 0),    # 下沉：支撐腳往後滑 1 格
    (0, 0, 0, 1),     # 遠側腿經過，近側腿滑到正下方
    (-2, 0, 2, 0),    # 遠側腿著地在前、近側在後
    (-2, 0, 1, 0),    # 下沉
]
SURGE = {"甲": [0, 0, 0, 0, 0, 0],   # 只有腳連續滑動
         "乙": [1, 0, 0, 1, 0, 0],   # ＋經過時上半身往前 1 格
         "丙": [1, 1, 0, 1, 1, 0]}   # ＋推進延長到著地，下沉時才收回

def steps2(variant="乙", facing="left"):
    f = -1 if facing == "left" else 1
    hand = [0, -f, -f, 0, f, f]
    out = []
    for i, b in enumerate(BOB):
        nN, lN, nF, lF = FEET[i]
        sx = f * SURGE[variant][i]
        tips = min(max(b, BOB[i - 1]), b + 1)
        o = {"head": (sx, b), "body": (sx, b), "hand": (sx + hand[i], b), "tips": (0, tips),
             "legN": (f * (nN - 1), -lN), "legF": (f * (nF + 1), -lF)}   # 近側腿原本在中點前 1 格、遠側在後 1 格
        out.append(o)
    return out

def stage2(variant="乙", facing="left"):
    seq = steps2(variant, facing)
    return [render(facing, o, RIGID2) for o in seq], [MS] * len(seq)

# 階段 3：使用者覺得甲、丙都好，以這兩版做變體與合成。拆開「誰往前推」和「頭髮怎麼拖」：
VARIANTS3 = {   # 基礎版本、頭是否跟著推、身體和手是否跟著推、頭髮往後拖
    "丁": ("丙", False, True, False),   # 只推身體和手，頭不動（頭佔全身 86%，頭穩定就不會像在跳）
    "戊": ("丙", True, False, False),   # 只推頭，像身體往前傾、由頭帶動
    "己": ("甲", False, False, True),   # 甲＋頭髮往後拖 1 格（上半身不動，靠長髮表現前進）
    "庚": ("丙", True, True, True),     # 丙＋頭髮往後拖 1 格
}
DRAG = [1, 1, 0, 1, 1, 0]   # 頭髮往後拖的時機（和丙的推進相同：經過到著地，下沉時收回）

def steps3(variant, facing="left"):
    base, head, body, drag = VARIANTS3[variant]
    f = -1 if facing == "left" else 1
    out = []
    for i, o in enumerate(steps2(base, facing)):
        o = dict(o)
        sx = f * SURGE[base][i]
        if not head: o["head"] = (o["head"][0] - sx, o["head"][1])
        if not body:
            o["body"] = (o["body"][0] - sx, o["body"][1]); o["hand"] = (o["hand"][0] - sx, o["hand"][1])
        if drag: o["tips"] = (o["tips"][0] - f * DRAG[i], o["tips"][1])   # 往前的反方向
        out.append(o)
    return out

def stage3(variant="丁", facing="left"):
    seq = steps3(variant, facing)
    return [render(facing, o, RIGID2, True) for o in seq], [MS] * len(seq)

def check(frames, facing, offsets):
    """側面走路的自動檢查（和定稿比較，扣掉定稿本來就有的）：破洞、新顏色、夾縫、腿和身體斷開。"""
    ref = Image.open("final_side.png" if facing == "left" else "final_side_right.png").convert("RGBA")
    pal = {p for p in ref.getdata() if p[3]}
    W, H = ref.size
    shadow = Image.new("RGBA", (1, 1), "#d2cde2").getpixel((0, 0))
    def holes(im):   # 被包住的透明格子（從外圍填色填不到的），不管洞多大都算
        px = im.load()
        rows = ["".join("." if not px[x, y][3] else ("V" if px[x, y] == shadow else "#") for x in range(W)) for y in range(H)]
        touches_ground = lambda reg: any(0 <= y + 1 < H and rows[y + 1][x] == "V" for x, y in reg)
        # 碰到地面陰影的區域是兩腿之間的空隙（鞋底碰在一起時會被圍起來），本來就該看得到背景，不算破洞
        return {c for reg in enclosed(rows) if not touches_ground(reg) for c in reg}
    def seams(im):
        px = im.load()
        return {(x, y) for y in range(1, H-1) for x in range(W) if not px[x, y][3] and px[x, y-1][3] and px[x, y+1][3] and px[x, y+1] != shadow}
    h0, s0 = holes(ref), seams(ref)
    out = []
    for i, im in enumerate(frames):
        im = im.convert("RGBA")
        rows, _ = frame(facing, offsets[i])
        gaps = [(x, y) for y in range(35, H) for x in range(W) if rows[y][x] == "k" and rows[y-1][x] == "."]
        new = {p for p in im.getdata() if p[3]} - pal
        # 定稿本來就有的小缺口（瀏海和臉之間、下巴和脖子之間、蝴蝶結旁）會跟著頭或身體移動，移過去的不算新的；
        # 不能只比數量：舊缺口被蓋掉、新破洞出現時會互相抵銷（庚的脖子後白點就是這樣漏掉的）
        moved = lambda pts: {(x + ox, y + oy) for x, y in pts for ox, oy in (offsets[i].get("head", (0, 0)), offsets[i].get("body", (0, 0)), (0, 0))}
        out.append(f"幀{i}: 破洞 {len(holes(im) - moved(h0))}、新顏色 {len(new)}、夾縫 {len(seams(im) - moved(s0))}、腿斷開 {len(gaps)}")
    return out

def final(facing="left"):
    """目前成品：階段 3 己（腳連續滑動＋頭髮往後拖，上半身不動）。
    使用者選擇理由：有前進感、上半身晃動小，體現女僕在日常狀態下的優雅。"""
    return stage3("己", facing)
