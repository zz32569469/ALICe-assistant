"""背面：直接從正面的形狀推出來（左右鏡射），每一列的寬度、頭髮長度、手和袖子的位置都和正面一致。"""
import jp_big, views
import align_check as ac

ORIG_BUILD = jp_big.build
FACE = set("sSeEQWPm")
HAIR = set("hHLZ")

STYLE = {"layer": ""}
# 背後的頭髮要是同一片：舊版下半段整片變暗＋中段一條鋸齒分界（上下兩層），看起來像兩片頭髮。
# 使用者回饋「頭髮陰影不用分開」（2026-10-04）→ 預設關掉；只保留右側背光和細的分束髮縫。
SPLIT = False

def build_back(*_a, **_k):
    kw = {k: v for k, v in views.FINAL.items() if k in ("persp","front","foot","body","neckk","legk","headk","hd","hs","hair2","clumps","tidy","polish")}
    rows_f, depth_f = ORIG_BUILD(**kw)
    H, W = len(rows_f), len(rows_f[0])
    g = [list(r[::-1]) for r in rows_f]                 # 背面＝正面左右鏡射
    d = [list(r[::-1]) for r in depth_f]
    neck = 25
    for y in range(H):
        for x in range(W):
            c = g[y][x]
            if y < neck and (c in FACE or c in HAIR):  # 臉和瀏海全部變成後腦的頭髮
                g[y][x] = "h"; d[y][x] = 80
    hair_bottom = max(y for y in range(H) if any(c in HAIR for c in g[y]) and y < H - 6)
    for y in range(neck, hair_bottom + 1):              # 後髮：寬度和正面頭髮的外輪廓一樣
        xs = [x for x in range(W) if g[y][x] in HAIR]
        if not xs: continue
        for x in range(min(xs), max(xs) + 1):
            if 14 <= x <= W - 15 or g[y][x] in HAIR:    # 中間的軀幹被頭髮蓋住，兩側的手臂和手保留
                g[y][x] = "h"; d[y][x] = 80
    # 髮尾：最下面一列做成一束一束的尖端，不要平平一條
    for yy, off in ((hair_bottom, 0), (hair_bottom - 1, 1)):   # 兩列錯開，做出一束一束的尖端
        xs = [x for x in range(W) if g[yy][x] in HAIR]
        if not xs: continue
        for x in range(min(xs) + 1, max(xs)):
            if (x - min(xs) + off) % 4 in ((2, 3) if off == 0 else (3,)) and g[yy][x] in HAIR:
                below = rows_f[yy][::-1][x]
                g[yy][x] = below if below not in HAIR and below != "." else ("k" if 18 <= x <= 29 else ".")
    for y in range(H):
        for x in range(W):
            if g[y][x] in "tT": g[y][x] = "j"          # 背面看不到內搭，露出來的部分是外套
            if g[y][x] in HAIR: g[y][x] = "h"
    # 陰影：和正面同一套（光從畫面左上來）
    hair_rows = [y for y in range(H) if any(c == "h" for c in g[y])]
    for y in hair_rows:
        for x in range(W):
            if g[y][x] != "h": continue
            edge = int(W * 0.6) + (1 if y > 18 else 0) - (1 if y < 8 else 0)   # 背光邊界跟著頭形微微彎
            if x >= edge or (y >= 29 and SPLIT):        # 右側背光（SPLIT 時下半段也整片變暗）
                g[y][x] = "H"
    for x in (18, 23, 27):                              # 髮尾附近幾道短短的分束（只在下段，不切過頭部）
        for y in (hair_bottom - 2, hair_bottom - 1):
            if g[y][x] == "H": g[y][x] = "h"
    for y in range(0, neck):                            # 頭頂光環：位置和正面相同（不鏡射，因為光源在畫面左上）
        for x in range(W):
            if rows_f[y][x] == "L" and g[y][x] in "hH": g[y][x] = "L"
    # 鞋子改成鞋跟：沒有鞋帶，下面一條深色鞋底，後面中間一小塊藍色鞋跟標
    for y in range(H - 7, H):
        for x in range(W):
            if g[y][x] in "rb" and any(g[yy][x] == "w" for yy in range(H - 7, H)): g[y][x] = "w"
    shoe_rows = [y for y in range(H) if "w" in "".join(g[y])]
    if shoe_rows:
        bot = max(shoe_rows); top = min(shoe_rows)
        cols = [x for x in range(W) if any(g[y][x] == "w" for y in shoe_rows)]
        groups, cur = [], [cols[0]]
        for x in cols[1:]:
            if x == cur[-1] + 1: cur.append(x)
            else: groups.append(cur); cur = [x]
        groups.append(cur)
        for grp in groups:
            for x in grp:
                if g[bot][x] == "w": g[bot][x] = "r"
            mid = grp[len(grp)//2]
            if g[top][mid] == "w": g[top][mid] = "b"
    # 頭髮層次（多種畫法）
    lay = STYLE["layer"]
    def light(x, y): return g[y][x] == "h"
    if "A" in lay:   # 分束：幾道長短不一的髮縫，只畫在亮面
        for x, y0 in ((17, 11), (21, 15), (25, 12), (28, 17)):
            for y in range(y0, hair_bottom - 1):
                if light(x, y): g[y][x] = "H"
    if "B" in lay:   # 中間一束受光的亮面
        for y in range(9, 25):
            for x in (17, 18):
                if light(x, y): g[y][x] = "Z"     # 柔和的亮面（比光環暗）
    if "C" in lay and SPLIT:   # 上下兩層：上層頭髮在肩膀附近結束，下面露出較暗的下層
        for x in range(W):
            yb = 24 + (0 if (x // 2) % 2 else 1)
            for y in (yb, yb + 1):
                if g[y][x] == "h": g[y][x] = "H"
    if "D" in lay:   # 髮尾分束：下段每隔幾格一道亮線，像一束束頭髮
        for x in (16, 20, 24, 28, 32):
            for y in range(hair_bottom - 5, hair_bottom):
                if g[y][x] == "H": g[y][x] = "h"
    rows = ["".join(r) for r in g]
    depth = [[int(v) for v in r] for r in d]
    return rows, depth

def draw(layer=""):
    STYLE["layer"] = layer
    orig = jp_big.build
    jp_big.build = build_back
    try:
        return jp_big.draw(**views.FINAL)
    finally:
        jp_big.build = orig

if __name__ == "__main__":
    from PIL import Image, ImageDraw
    from pixelkit import sheet
    SIDE = dict(nar=0.92, hdx=4.4, hb=1.0, hw=1.0, light=1, flat=True, bk=0.7, hx=1.13, ts="back", fall=2, lock=18)
    fr = views.draw("front"); sd = views.draw("side", "A", **SIDE); bk = draw()
    bk.save("final_back.png"); sd.save("final_side.png"); fr.save("final_front.png")
    rows, _ = build_back()
    print(ac.marks(rows)); print(ac.marks(ac.rows_of("front")))
    for y, r in enumerate(rows): print(f"{y:2d}", r)
