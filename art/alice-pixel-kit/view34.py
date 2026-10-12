"""45 度視角（斜前方，臉朝畫面右）：從正面定稿推出來。
頭當成球、身體當成圓柱，每一列依它在正面的寬度轉一個角度：正面看得到的東西往右移、靠右邊緣的被壓扁，
左邊空出來的是轉過來露出的後腦頭髮。朝右轉的理由：蝴蝶結和半綁髮在她頭的右側，往這邊轉會轉到看得到的一面。"""
import math
import idle, walk_side, views, jp_big

HAIR = set("hHLZ")
STRETCH = {"L": "h", "G": "j", "Z": "h"}

def remap_row(src, dsrc, x0, x1, phi, back="h", back_z=80):
    """把一列 [x0, x1] 的格子轉 phi 度（往右）。回傳 {x: (材質, 深度)}。"""
    c = (x0 + x1 + 1) / 2; R = (x1 - x0 + 1) / 2
    out = {}; prev = None
    for xt in range(x0, x1 + 1):
        u = max(-1.0, min(1.0, (xt + 0.5 - c) / R))
        th = math.asin(u) - phi
        if th < -math.pi / 2:                      # 轉過來露出的後腦（原本在背面）
            out[xt] = (back, back_z); continue
        xf = c + R * math.sin(th) - 0.5
        xs = min(max(round(xf), x0), x1)
        c_ = src[xs]
        if xs == prev and c_ in STRETCH: c_ = STRETCH[c_]   # 邊緣被拉寬：重複的格子用基本色（亮邊只留一格，否則變成一大塊白）
        out[xt] = (c_, dsrc[xs]); prev = xs
    return out

KNOT = (14, 6)   # 正面蝴蝶結的結（第一個藍色緞帶格）

def clean_front():
    """正面拿掉蝴蝶結和半綁髮（轉完再照原形狀貼回去；一起轉會被拉成頭頂一條黑色寬帶）。"""
    g0, d0 = idle.base()
    g = [list(r) for r in g0]; d = [list(r) for r in d0]
    kx, ky = KNOT
    for y in range(3, 12):
        for x in range(6, 20):
            if g[y][x] in "rb":
                inside = ((x + 0.5 - 23) / 14.5) ** 2 + ((y + 0.5 - 15) / 12.5) ** 2 <= 1   # 依頭形（圓弧）決定：頭裡面補頭髮、外面變透明
                g[y][x] = "h" if inside else "."; d[y][x] = 80 if inside else 0
    for dx, dy, c in jp_big.HALFUPS[jp_big.HALFUP]:   # 半綁髮原本垂在頭的外側：頭形外面的變透明（否則轉完在左上角鼓出一塊）
        x, y = kx + dx, ky + dy
        if g[y][x] in HAIR:
            inside = ((x + 0.5 - 23) / 14.5) ** 2 + ((y + 0.5 - 15) / 12.5) ** 2 <= 1 or x >= 11
            g[y][x] = "h" if inside else "."; d[y][x] = 80 if inside else 0
    return g, d

def build(phi_head=30, phi_body=20, body_k=1.0):
    """body_k：身體（第 26 列以下）往右收窄的比例。轉身時近側那束頭髮會被拉寬（4 格 → 7 格），
    身體總寬又和正面一樣，側面看起來太胖（使用者回饋）→ 身體少轉一點、再從左邊往裡收。"""
    g0, d0 = clean_front()
    H, W = len(g0), len(g0[0])
    g = [list(r) for r in g0]; d = [list(r) for r in d0]
    for y in range(H):
        if y >= 36: continue                       # 腿和地面陰影先不動
        xs = [x for x in range(W) if g0[y][x] not in ".V"]
        if not xs: continue
        x0, x1 = min(xs), max(xs)
        phi = math.radians(phi_head if y <= 25 else phi_body)
        row = remap_row(g0[y], d0[y], x0, x1, phi)
        if y > 25 and body_k < 1:                  # 以右緣為準往右收窄：目標格 xt 取原本 x1 - (x1 - xt) / k
            nx0 = round(x1 - (x1 - x0) * body_k)
            row = {xt: row[min(x1, max(x0, round(x1 - (x1 - xt) / body_k)))] for xt in range(nx0, x1 + 1)}
            for x in range(x0, nx0): g[y][x] = "."; d[y][x] = 0
        for x, (c, z) in row.items():
            g[y][x] = c; d[y][x] = z
    # 蝴蝶結的結跟著頭轉到新位置，再貼上正面的蝴蝶結與半綁髮
    kx, ky = KNOT
    xs = [x for x in range(W) if g0[10][x] not in ".V"]   # 用頭最寬的一列當球的大小（結那一列拿掉蝴蝶結後變窄）
    c = (min(xs) + max(xs) + 1) / 2; R = (max(xs) - min(xs) + 1) / 2
    nkx = round(c + R * math.sin(math.asin((kx + 0.5 - c) / R) + math.radians(phi_head)) - 0.5)
    for (dx, dy), code in views.bow_template().items():
        X, Y = nkx + dx, ky + dy
        if 0 <= X < W and 0 <= Y < H: g[Y][X] = code; d[Y][X] = 90
    for dx, dy, code in jp_big.HALFUPS[jp_big.HALFUP]:   # 那一束在頭髮內側：亮邊會變成白線，改成陰影線夾出一束（和側面向右相同）
        X, Y = nkx + dx, ky + dy
        code = "H" if code == "L" else code
        if g[Y][X] in HAIR: g[Y][X] = code; d[Y][X] = 80 if code == "H" else 95
    # 腮紅：近側 5 格寬縮成 4 格；遠側超出臉的輪廓的那一格改成臉後面的頭髮
    for y in range(18, 25):
        row = g[y]
        ps = [x for x in range(W) if row[x] == "P"]
        if not ps: continue
        near = [x for x in ps if x < 28]
        if len(near) > 4: row[min(near)] = "s"
        far = [x for x in ps if x >= 28]
        if far and max(far) >= 35: row[max(far)] = "H"
    build.knot = (nkx, ky)
    return ["".join(r) for r in g], d

def render(rows, dep):
    return walk_side.draw_rows(rows, dep)
