"""坐在椅子上看著筆電打字（側面向左起步）。
坐姿是新的姿勢：上半身、頭沿用側面定稿；手臂改成前臂平伸到鍵盤；大腿往前、小腿和鞋子整塊往前搬；
另外加椅子、桌子、筆電三種新材質（各自一組色階，交給 shade 依同一套規則上明暗）。"""
from PIL import Image
import jp_big, shade, views, walk_side

# 新材質：字母避開已經用過大寫的（大寫在 shade 裡會被當成同材質的皺褶）
NEW = {
    "a": ["#5c5e70", "#8e92a6", "#c0c4d2", "#e6e8ef"],   # 椅子：白色辦公椅（和深色衣服分得開）
    "d": ["#5a3e34", "#86604e", "#ad8a6e", "#d0b090"],   # 桌子：木頭
    "c": ["#3c4050", "#6c7286", "#a4aabb", "#d8dce6"],   # 筆電：銀色
}
GLOW = {"o": "#bfe3ff", "O": "#7fb0e6"}                   # 螢幕朝向她的那一面：亮藍白；O＝螢幕上的字（一行行出現）
jp_big.HUE.update(NEW); jp_big.BASE.update(NEW); shade.FIXED.update(GLOW)

HAIR = set("hHLZ")
SCREEN = [(30, 8), (29, 8), (28, 8), (27, 7), (26, 7), (25, 7), (24, 6), (23, 6), (22, 6)]   # 螢幕（由下往上）：(列, 欄)，往後仰
ARM = (20, 27)          # 側面手臂的欄（和 idle_dirs 相同）

def put(g, d, x, y, c, z):
    if 0 <= x < len(g[0]) and 0 <= y < len(g) and (g[y][x] in ".V" or z >= d[y][x]):
        g[y][x] = c; d[y][x] = z

def rect(g, d, x0, y0, x1, y1, c, z):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1): put(g, d, x, y, c, z)

KEYS = (7, 15)   # 筆電底座（鍵盤）的欄，在第 31 列
LEG_DX = -7   # 腿往前搬幾格（膝蓋在大腿前端的正下方）

def leg_cells():
    """定稿的近側、遠側腿（小腿＋鞋）往前搬 LEG_DX 格。回傳 [(腿, (x, y, 材質, 深度))]。"""
    _, _, legs = walk_side.layers("left")
    return [(k, (x + LEG_DX, y, c, z)) for k in ("legF", "legN") for x, y, c, z in legs[k] if c != "V"]

def base_left():
    """向左坐姿的材質圖與深度。"""
    rows, dep = views.side_rows("left", "none")
    g = [list(r) for r in rows]; d = [list(r) for r in dep]
    H, W = len(g), len(g[0])
    # 1. 拿掉垂下的手臂（袖子、袖口藍帶、手），露出的地方是後面的外套
    for y in range(27, 35):
        for x in range(ARM[0], ARM[1] + 1):
            c = g[y][x]
            if c in HAIR or c == "t" or c == ".": continue
            if y <= 30: continue                                   # 上臂保留（從肩膀垂到手肘）
            g[y][x] = "j" if x <= 25 else "."; d[y][x] = 50 if x <= 25 else 0
    # 地面陰影先清掉，最後依椅子的位置重畫
    for y in range(H):
        for x in range(W):
            if g[y][x] == "V": g[y][x] = "."; d[y][x] = 0
    # 2. 椅子（在身體後面）：座墊、椅背（大多被長髮擋住）、中柱、五爪腳
    rect(g, d, 18, 36, 28, 36, "a", 30)        # 座墊
    rect(g, d, 19, 37, 27, 37, "a", 28)
    rect(g, d, 26, 26, 27, 35, "a", 10)        # 椅背（在頭髮後面；貼著背，中間留縫會像破洞）
    rect(g, d, 23, 38, 24, 39, "a", 30)        # 中柱
    rect(g, d, 19, 40, 28, 40, "a", 30)        # 腳
    for x in (19, 28): put(g, d, x, 41, "a", 30)   # 輪子
    # 3. 腿：大腿往前到膝蓋，小腿往下，鞋子在地上（腳尖朝前）
    rect(g, d, 14, 34, 19, 35, "k", 36)        # 大腿（過膝襪＋短褲的延伸）
    for key, (x, y, c, z) in leg_cells():      # 小腿和鞋：定稿的兩條腿整塊往前搬（自己畫的 1 格高鞋子會整條變成外框色）
        put(g, d, x, y, c, z)
    # 4. 桌子：桌面、兩端的桌腳
    rect(g, d, 2, 32, 18, 33, "d", 45)        # 桌面一直到她身前（桌邊和肚子之間留縫會像破洞）
    rect(g, d, 3, 34, 4, 40, "d", 15)
    rect(g, d, 15, 34, 16, 40, "d", 12)        # 靠她這端的桌腳（在她的腿後面）
    # 5. 筆電：底座在桌上、螢幕往後仰；朝向她的那一面發亮
    rect(g, d, KEYS[0], 31, KEYS[1], 31, "c", 55)   # 底座（鍵盤）
    for y, x in SCREEN:
        put(g, d, x, y, "c", 55); put(g, d, x + 1, y, "o", 56)
    # 6. 前臂平伸到鍵盤：袖子、袖口藍帶、手
    rect(g, d, 18, 30, 24, 31, "j", 65)        # 前臂靠在桌邊（和桌面之間留縫會像破洞）
    rect(g, d, 18, 30, 24, 30, "G", 65)        # 前臂上緣受光（否則和後面的外套同色、黏成一塊看不出手臂）
    rect(g, d, 16, 30, 17, 31, "b", 65)
    rect(g, d, 13, 31, 15, 31, "s", 66)        # 手（壓在鍵盤上）
    put(g, d, 14, 30, "s", 66); put(g, d, 15, 30, "s", 66)
    # 7. 地面陰影：椅子和腳下
    for y in range(H):
        for x in range(W):
            if g[y][x] == "." and ((x - 21) / 9.5) ** 2 + ((y - 40.5) / 1.6) ** 2 <= 1: g[y][x] = "V"; d[y][x] = 1
    return ["".join(r) for r in g], d

def render(rows, dep, ref_rows=None):
    im = walk_side.draw_rows(rows, dep)
    ref = walk_side.refs("left")
    for k, (x, y, c, z) in leg_cells():          # 腿和鞋搬移定稿像素（和站姿、走路的鞋子同一個樣子）
        if rows[y][x] == c: im.putpixel((x, y), ref[k].getpixel((x - LEG_DX, y)))
    ref = Image.open("final_side.png").convert("RGBA")
    ref_rows = ref_rows or views.side_rows("left")[0]
    for y in range(min(26, len(rows))):          # 頭和臉直接用定稿像素（和其他動作是同一張臉）
        for x in range(len(rows[0])):
            if rows[y][x] == ref_rows[y][x] and rows[y][x] != ".": im.putpixel((x, y), ref.getpixel((x, y)))
    return im

NEAR_HAND = [(13, 31), (14, 31), (15, 31), (14, 30), (15, 30)]
TEXT_ROWS = [23, 25, 27, 29]   # 螢幕上會出現字的列

def frame(up=0, dx=0, closed=False, text=0):
    """up：手抬起幾格；dx：手往左（鍵盤另一邊）移幾格；closed：眨眼；text：螢幕上已經出現幾行字。
    （另一隻手在近側的手後面只露出 2 格，上色後是一根深咖啡色的棍子，不畫。）"""
    rows, dep = base_left()
    g = [list(r) for r in rows]; d = [list(r) for r in dep]
    if up or dx:
        cells = [(x, y, g[y][x], d[y][x]) for x, y in NEAR_HAND]
        for x, y, c, z in cells:                 # 手移開後露出底下的鍵盤（畫手時把鍵盤蓋掉了）
            under = y == 31 and KEYS[0] <= x <= KEYS[1]
            g[y][x] = "c" if under else "."; d[y][x] = 55 if under else 0
        for x, y, c, z in cells: g[y - up][x - dx] = c; d[y - up][x - dx] = z
        for x in range(16 - dx, 16):            # 手往左伸時，袖口跟著往前拉長
            g[30][x] = g[31][x] = "b"; d[30][x] = d[31][x] = 65
        if up and not dx: g[30][16] = "b"
    for y in TEXT_ROWS[:text]:
        for yy, x in SCREEN:
            if yy == y: g[y][x + 1] = "O"
    rows = ["".join(r) for r in g]
    if closed:
        import idle_dirs
        rows = idle_dirs.blink("left", rows)
    return rows, d

# 打字的節奏：一陣快速輪流敲（每下約 0.09 秒），停下來看螢幕，再打一陣；字一行一行出現；每停一次眨一次眼
SEQ = [  # (手抬起, 手往左, 閉眼, 螢幕字數, 毫秒)
    (0, 0, False, 0, 300),
    (1, 0, False, 0, 90), (0, 0, False, 0, 90), (1, 0, False, 1, 90), (0, 0, False, 1, 90), (1, 1, False, 1, 90), (0, 1, False, 1, 90),
    (1, 0, False, 2, 90), (0, 0, False, 2, 90), (1, 0, False, 2, 90), (0, 0, False, 2, 500),
    (0, 0, True, 2, 120), (0, 0, False, 2, 300),
    (1, 0, False, 3, 90), (0, 0, False, 3, 90), (1, 1, False, 4, 90), (0, 1, False, 4, 90), (0, 0, False, 4, 600),
    (0, 0, True, 4, 120), (0, 0, False, 0, 300),
]

def stage1():
    frames = [render(*frame(n, f, c, t)) for n, f, c, t, ms in SEQ]
    return frames, [ms for *_, ms in SEQ]
