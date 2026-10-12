"""45 度視角（斜前方，臉朝畫面右）坐在桌前用筆電打字。
上半身用 view34 推出來的 45 度；桌子有正面的桌板（擋住下半身）、筆電在她右前方（看到的是螢幕背面），
近側的手伸到鍵盤上打字；白色椅背從背後露出來。椅子、桌子、筆電的材質和側面版（sit.py）相同。"""
from PIL import Image
import sit, view34, walk_side, jp_big, shade

# 馬克杯（白）、咖啡、熱氣：和家具一樣直接指定顏色
MUG = {"u": ["#8e92a6", "#c0c4d2", "#e6e8ef", "#ffffff"]}
MUG_FIXED = {"f": "#5a3a2c", "x": "#c9cde0"}               # f＝杯裡的咖啡、x＝熱氣
jp_big.HUE.update(MUG); jp_big.BASE.update(MUG); shade.FIXED.update(MUG_FIXED)

HAIR = set("hHLZ")
put, rect = sit.put, sit.rect
DESK_TOP, DESK_FRONT = (32, 34), (35, 40)
LID = (25, 31, 31, 41)           # 筆電螢幕背面：列 25–31、欄 31–41
NEAR_HAND = [(23, 31), (24, 31), (25, 31), (24, 30), (25, 30)]
KEYS = (22, 30)                   # 鍵盤露出來的那一段（在螢幕左邊），第 32 列

# 杯子放在打字那隻手的右邊、筆電前面（第一版放在桌子最左邊，手要伸很遠，看起來被拉長）
CUP_DESK = (27, 30)               # 杯子放在桌上時的左上角（4×4，杯底在第 33 列、桌面上）
STEAM = [[(28, 29), (29, 28), (28, 27)], [(29, 29), (28, 28), (29, 27)]]   # 熱氣兩種樣子輪流（杯子在桌上時）
SHOULDER = (17, 27)
ARM_X0 = 19   # 打字、伸手時前臂從哪一欄開始（身體邊緣）
# 喝咖啡時手臂的樣子：(手肘, 手的左上角, 杯子左上角, 杯口看得到咖啡)。上臂（肩→肘）、前臂（肘→手）各畫一段 3 格粗的線，
# 手肘跟著往前、往上，兩段長度差不多（只拉一條從固定手肘到嘴邊的長線，看起來手被拉長）
# 第四版（使用者回饋「彎曲改成看不見，不要有彎曲的手臂角度」）：每一格都只看得到一段直的手臂、手肘藏起來。
# 伸手時和打字一樣是一條水平的前臂（上臂被側髮擋住）；舉杯時前臂從桌子後面直直往上伸到杯子下方（手肘在桌子後面）。
# （前幾版畫上臂＋前臂兩段，不管怎麼調，看起來都是手被拉長、折成一個角度。）
ARMS = {  # (方向, 手的左上角, 杯子左上角, 杯口看得到咖啡)
    "reach": ("flat", (25, 30), CUP_DESK, True),     # 手往右挪一點，握住杯子
    "lift":  ("up", (24, 29), (25, 26), True),       # 拿起來，到胸前（只露出袖口）
    "mouth": ("up", (24, 24), (26, 21), False),      # 杯子到嘴前（蓋住嘴，不碰到眼睛）
    "sip":   ("up", (24, 23), (26, 20), False),      # 喝一口：杯子再抬高 1 格
}

def cup(g, d, x0, y0, coffee):
    """4×4 的馬克杯：杯口一列（從上面看得到咖啡時中間兩格是咖啡），右邊一個把手。"""
    for y in range(y0, y0 + 4):
        for x in range(x0, x0 + 4):
            put(g, d, x, y, "f" if (coffee and y == y0 and x0 < x < x0 + 3) else "u", 97)
    put(g, d, x0 + 4, y0 + 1, "u", 97); put(g, d, x0 + 4, y0 + 2, "u", 97)

ARM_SHOULDER = (20, 27)   # 近側肩膀（外套肩線，露肩那一小截的左邊）

def sleeve(g, d, wrist, z):
    """從肩膀到手腕的一段直袖子：沿著線蓋 3×3 的方塊（斜的、直的都一樣粗）；上緣、左緣受光，下緣、右緣陰影。"""
    cells = {(x + dx, y + dy) for x, y in line(ARM_SHOULDER, wrist) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if y + dy < DESK_TOP[0]}
    for x, y in sorted(cells):
        lit = (x, y - 1) not in cells or (x - 1, y) not in cells
        dark = (x, y + 1) not in cells or (x + 1, y) not in cells
        put(g, d, x, y, "G" if lit and not dark else ("J" if dark and not lit else "j"), z)

def line(a, b):
    (x0, y0), (x1, y1) = a, b
    n = max(abs(x1 - x0), abs(y1 - y0), 1)
    return sorted({(round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n)) for i in range(n + 1)})

# 脖子和高領（使用者 2026-10-07 依草圖選「甲」）：頭當成球轉 30 度時，脖子跟著臉被推到嘴巴正下方、高領也偏右 →
# 脖子（下巴下面 1 列、2 格寬）和高領（2 列、4 格寬）一起往左搬 2 格，對齊身體中間的黑色內搭；高領兩邊是露出的肩膀。
NECK = [(24, 27, 28, "S", 70), (25, 26, 29, "t", 40), (26, 22, 25, "s", 30), (26, 26, 29, "t", 40), (26, 30, 32, "s", 30)]   # (列, 起欄, 迄欄, 材質, 深度)
COLLAR = [(x, y) for y, x0, x1, c, z in NECK if c == "t" for x in range(x0, x1 + 1)]
COLLAR_LIT, COLLAR_EDGE = jp_big.HUE["t"][2], jp_big.HUE["t"][1]   # 高領比下面的內搭亮一階（右緣維持內搭色），否則黏成一大塊黑；取自內搭色階，不增加新顏色

def neck(g, d):
    for y in (24, 25):              # 原本的脖子、高領（偏右）先清成脖子後面的長髮
        for x in range(20, 33):
            if g[y][x] in "sSt": g[y][x] = "h"; d[y][x] = 10
    for x in range(20, 33):
        if g[26][x] in "sSt": g[26][x] = "s"; d[26][x] = 30
    for y, x0, x1, c, z in NECK:
        for x in range(x0, x1 + 1): g[y][x] = c; d[y][x] = z

def base(arm="type", steam=0):
    rows, dep = view34.build(30, 12, 0.85)   # 身體少轉一點、往右收窄 15%（原本 18 度不收窄，側面看起來太胖）
    g = [list(r) for r in rows]; d = [list(r) for r in dep]
    H, W = len(g), len(g[0])
    neck(g, d)
    for y in range(H):              # 桌板以下（腿、地面陰影）全部清掉
        for x in range(W):
            if y >= 32: g[y][x] = "."; d[y][x] = 0
    # 近側的手臂：拿掉原本垂下的手臂（左邊、第 27 列以下的外套與手），重畫成往前伸到鍵盤
    for y in range(27, 32):
        for x in range(0, 22):
            if g[y][x] not in HAIR and g[y][x] != ".": g[y][x] = "." if x < 16 else "H"; d[y][x] = 0 if x < 16 else 10   # 手原本的位置：身體外面變透明、側髮那一段補成頭髮（補成外套會讓身體變寬）
    # 椅背：在她背後（畫面左邊），從頭髮旁邊露出來
    rect(g, d, 11, 21, 13, 31, "a", 5)                      # 貼在她背後（在頭髮後面，只露出左邊）
    # 桌子：桌面（上面受光）、正面的桌板
    rect(g, d, 4, DESK_TOP[0], 45, DESK_TOP[1], "d", 70)
    rect(g, d, 5, DESK_FRONT[0], 44, DESK_FRONT[1], "D", 70)
    # 筆電：鍵盤（螢幕左邊露出一段）、螢幕背面
    rect(g, d, KEYS[0], 32, KEYS[1], 32, "c", 72)
    r0, r1, c0, c1 = LID
    for y in range(r0, r1 + 1):
        sh = (r1 - y) // 4                                   # 螢幕往後仰：上面往右偏一點
        rect(g, d, c0 + sh, y, c1 + sh, y, "c", 95)       # 螢幕在她前面：深度要比頭髮、臉都大
    put(g, d, 36, 28, "o", 96)                              # 螢幕背面的小燈
    # 近側的手臂：每一格都是一段直的袖子，從肩膀直接連到手腕（看不到手肘彎折，也不會和肩膀斷開）。
    # 歷程（使用者回饋）：手臂往外彎出去太多 → 只畫前臂又像斷掉、沒和肩膀連在一起 → 改成肩膀到手腕一段直線。
    if arm == "type":
        sleeve(g, d, (20, 30), 85)
        rect(g, d, 22, 29, 22, 31, "b", 85)                 # 袖口藍帶
        cup(g, d, *CUP_DESK, True)
        base.under = {(x, y): (g[y][x], d[y][x]) for x, y in NEAR_HAND}   # 手底下原本是什麼（手抬起時補回去）
        for x, y in NEAR_HAND: put(g, d, x, y, "s", 86)
    else:
        way, (hx, hy), (cx, cy), coffee = ARMS[arm]
        cup(g, d, cx, cy, coffee)
        if way == "flat":                                    # 伸手拿杯子：和打字一樣，只是手往右 2 格
            sleeve(g, d, (hx - 3, 30), 85)
            rect(g, d, hx - 1, 29, hx - 1, 31, "b", 85)
        else:                                                # 舉杯：袖子從肩膀直直連到杯子下面的手
            sleeve(g, d, (hx, hy + 3), 98)
            for x in (hx, hx + 1):                           # 袖口藍帶 2×2，在手的正下方
                for y in (hy + 2, hy + 3):
                    if y < DESK_TOP[0]: put(g, d, x, y, "b", 98)
        for x in (hx, hx + 1):
            for y in (hy, hy + 1): put(g, d, x, y, "s", 99 if way == "up" else 86)   # 手：握著杯子（在杯子前面）
    if arm in ("type", "reach"):
        for x, y in STEAM[steam]:
            if g[y][x] == ".": put(g, d, x, y, "x", 97)
    # 身體收窄後，椅背和身體之間被圍起來的空隙：是背後垂下來的長髮（及腰長髮從背後看得到）
    for reg in walk_side.enclosed(["".join(r) for r in g]):
        for x, y in reg: g[y][x] = "H"; d[y][x] = 8
    # 地面陰影
    for y in range(H):
        for x in range(W):
            if g[y][x] == "." and ((x - 24.5) / 20.5) ** 2 + ((y - 41) / 1.5) ** 2 <= 1: g[y][x] = "V"; d[y][x] = 1
    return ["".join(r) for r in g], d

def frame(up=0, dx=0, closed=False, steam=0, arm="type"):
    rows, dep = base(arm, steam)
    g = [list(r) for r in rows]; d = [list(r) for r in dep]
    if up or dx:
        cells = [(x, y, g[y][x], d[y][x]) for x, y in NEAR_HAND]
        for x, y, c, z in cells: g[y][x], d[y][x] = base.under[(x, y)]
        for x, y, c, z in cells: g[y - up][x + dx] = c; d[y - up][x + dx] = z
        if up and not dx: g[30][22] = "b"
    rows = ["".join(r) for r in g]
    if closed:
        rows = blink(rows)
    return rows, d

def blink(rows):
    """45 度的閉眼：和正面同一套（上緣眼線變成瀏海、瞳孔第一列變成閉眼線）。"""
    import idle
    return idle.blink(rows)

SEQ = sit.SEQ

def hexrgb(h): return tuple(int(h[i:i+2], 16) for i in (1, 3, 5)) + (255,)

def flat(im, rows):
    """家具形狀簡單，不交給明暗規則（桌面會出現一塊塊深淺斑點）：直接指定顏色，都取自各自的色階。
    上緣、左緣受光；右緣、下緣背光；外圍一圈最暗。"""
    R = sit.NEW
    H, W = len(rows), len(rows[0])
    code = lambda x, y: ("c" if rows[y][x] == "o" else rows[y][x].lower()) if 0 <= x < W and 0 <= y < H else "."   # 螢幕背面的小燈算在螢幕裡（否則燈的四周被畫上一圈外框）
    for y in range(H):
        for x in range(W):
            c = rows[y][x]
            if c.lower() not in "adcu": continue
            m = c.lower(); ramp = R.get(m) or MUG[m]
            edge_r = code(x + 1, y) != m; edge_b = code(x, y + 1) != m
            edge_l = code(x - 1, y) != m; edge_t = code(x, y - 1) != m
            if m == "d":
                if c == "D": lvl = 0 if (edge_b or edge_r or edge_l) else 1     # 桌板正面
                else: lvl = 3 if edge_t else 2                                  # 桌面：上緣最亮
                if c == "d" and (edge_l or edge_r): lvl = 1
            elif m == "c":
                lvl = 3 if (edge_t or edge_l) else (0 if (edge_r or edge_b) else 2)
                if y == 32: lvl = 1                                             # 鍵盤
            elif m == "u":
                ramp = MUG["u"]
                lvl = 3 if edge_l else (0 if (edge_r and code(x - 1, y) == "u") or edge_b else 2)
            else:
                lvl = 3 if edge_l or edge_t else (1 if edge_r else 2)
            im.putpixel((x, y), hexrgb(ramp[lvl]))
    return im

def render(rows, dep):
    im = flat(walk_side.draw_rows(rows, dep), rows)
    for x, y in COLLAR:             # 高領：右緣（背光）用中間色，其餘用亮色
        if rows[y][x] == "t": im.putpixel((x, y), hexrgb(COLLAR_EDGE if rows[y][x + 1] != "t" else COLLAR_LIT))
    return im

def stage1():
    """打字（第一版，沒有杯子）。"""
    raise NotImplementedError("第一版沒有杯子；輸出保留在 sit_out/stage2")

def stage2():
    """打字＋桌上的咖啡杯（熱氣每兩格換一個樣子）。"""
    frames = [render(*frame(n, f, c, (i // 2) % 2)) for i, (n, f, c, t, ms) in enumerate(SEQ)]
    return frames, [ms for *_, ms in SEQ]

def final():
    """目前成品：45 度打字＋桌上的咖啡杯（使用者 2026-10-05 選 45 度；加喝咖啡動作時，打字的桌上也放同一個杯子）。"""
    return stage2()

# 喝一口咖啡：從打字的姿勢開始、回到打字的姿勢（Studio 可以在打字中間穿插）
DRINK = [  # (手臂, 閉眼, 熱氣, 毫秒)
    ("type", False, 0, 300),
    ("reach", False, 1, 180),
    ("reach", False, 0, 160),       # 握住
    ("lift", False, 0, 180),
    ("mouth", False, 0, 200),
    ("sip", True, 0, 700),          # 閉眼喝一口
    ("mouth", True, 0, 300),
    ("mouth", False, 0, 250),
    ("lift", False, 0, 180),
    ("reach", False, 1, 180),       # 放回桌上
    ("type", False, 0, 300),
]

def drink():
    frames = [render(*frame(closed=c, steam=st, arm=a)) for a, c, st, ms in DRINK]
    return frames, [ms for *_, ms in DRINK]

def final_drink():
    """目前成品：喝一口咖啡（從打字第一格開始、回到打字第一格；使用者 2026-10-05～07：杯子放近、手臂加粗、身體收窄、
    手臂改成從肩膀直接連到手腕的一段直袖子）。"""
    return drink()
