"""睡覺動作（站著睡）：沿用待機的分組與呼吸，閉眼、低頭（只在臉上表現）、呼吸更慢更深。
先做正面的幾種候選，使用者選定後再延伸到側面、背面（和待機一樣四個方向同一個節奏）。"""
import idle, idle_dirs

idle_dirs.REF.setdefault("down", "final_front.png")   # 讓 idle_dirs.check 也能檢查正面

SLOW = 1.4   # 睡著的呼吸比待機慢：待機一次約 2.9 秒 → 約 4 秒
HAIR = set("hHLZ")
SKIN = set("sS")

# 低頭不能把整顆頭往下壓：下巴會埋進高領和肩膀，看起來像沒有脖子（使用者回饋「肩膀跟頭合在一起時會非常奇怪」）。
# 改成頭的外輪廓和肩膀都不動，只在臉上表現「臉往下轉」：瀏海往下蓋、閉眼線和嘴巴往下 1 格、頭頂光環往下 1 格（頭頂露出更多）。
# 各方向的低頭參數：光環在哪幾列、從哪一欄起（正面避開蝴蝶結旁和半綁髮的亮邊）、瀏海比正面多蓋幾列。
# 側面閉眼時上緣眼線改成皮膚（不像正面變成瀏海），瀏海和閉眼線之間會多露出額頭，看起來反而像抬頭 → 多蓋 1 列。
# 背面沒有臉，只有光環往下。
BOW = {"down": ((7, 6), 19, 48, 0), "left": ((7, 6, 5), 0, 48, 1), "right": ((7, 6, 5), 0, 48, 1), "back": ((6,), 17, 31, 0)}

def bow(rows, level, dy, view="down"):
    """level：低頭程度（0 不低頭、1 瀏海多蓋 1 列、2 多蓋 2 列）；dy：這一幀頭的位移（臉跟著頭移動）。"""
    if not level: return rows
    halo, x0, x1, more = BOW[view]
    level += more
    g = [list(r) for r in rows]
    W = len(g[0])
    for y in (h + dy for h in halo):                        # 頭頂光環往下 1 格（由下往上搬，避免搬兩次）
        for x in range(x0, min(x1, W)):
            if g[y][x] == "L" and g[y + 1][x] in "hH": g[y][x], g[y + 1][x] = g[y + 1][x], "L"   # 和下面那格對調（亮面、背光面都跟著）
    for y in range(23 + dy, 15 + dy, -1):                   # 閉眼線、嘴巴往下 1 格（由下往上搬）
        for x in range(W):
            if g[y][x] in "em" and g[y + 1][x] in SKIN: g[y + 1][x] = g[y][x]; g[y][x] = "s"
    for x in range(W):                                      # 瀏海往下蓋：每一欄最上面的 level 格皮膚變成頭髮（碰到眼線、腮紅就停）
        y = 14 + dy
        while y < 24 + dy and g[y][x] in HAIR | {"."}: y += 1
        if y >= 24 + dy or (g[y - 1][x] not in HAIR and view == "down"): continue   # 側面臉最前緣那一欄上面是空白，也要蓋（否則留一條皮膚像柱子凸出來）
        for _ in range(level):
            if g[y][x] not in SKIN: break
            g[y][x] = "h"; y += 1
    return ["".join(r) for r in g]

def breath(level):
    """一次呼吸（和待機 CYCLE5 同樣的動作順序與布料狀態），時間放慢；每一幀都帶低頭程度。"""
    return [(o, round(t * SLOW), s, level) for (o, t), s in zip(idle.CYCLE5, idle.FABRIC5)]

def render(o, closed=True, state=None, level=0):
    rows, dep = idle.frame(o, groups=idle.group_v5)
    rows = idle.fabric(rows, o, state)
    rows = idle.blink(rows) if closed else rows
    return idle.render(bow(rows, level, o.get("head", 0)), dep, pin=True)

# 每一幀：(位移, 毫秒, 布料狀態, 低頭程度, 是否閉眼)
def seq_甲():
    """安靜站著睡：一直低頭（程度 1）、閉眼，慢慢深呼吸。最安靜、最優雅。"""
    return [(o, t, s, l, True) for o, t, s, l in breath(1)] * 2

def seq_乙():
    """打瞌睡點頭：頭一次呼吸比一次低（程度 1 → 2），然後突然抬頭、眼睛睜開一下，又慢慢閉上。"""
    out = [(o, t, s, l, True) for o, t, s, l in breath(1) + breath(2)]
    out += [({}, 140, None, 0, False),       # 猛然抬頭、睜眼
            ({}, 500, None, 0, False),
            ({}, 160, None, 0, True),        # 又閉上
            ({}, 400, None, 1, True)]        # 頭慢慢再低下去
    return out

def seq_丙():
    """輕輕點頭：和乙一樣越睡越低，但不驚醒，頭慢慢浮回來（更溫柔，不像被嚇到）。"""
    out = [(o, t, s, l, True) for o, t, s, l in breath(1) + breath(2)]
    out += [({}, 600, None, 1, True)]        # 頭慢慢浮回程度 1，接回第一次呼吸
    return out

VARIANTS = {"甲": seq_甲, "乙": seq_乙, "丙": seq_丙}

def stage1(variant):
    """第一版：整顆頭往下壓（已被取代，輸出在 sleep_out/stage1）。"""
    raise NotImplementedError("第一版的寫法已移除；結果保留在 sleep_out/stage1")

def stage2(variant):
    seq = VARIANTS[variant]()
    return [render(o, c, s, l) for o, t, s, l, c in seq], [t for _, t, _, _, _ in seq], [o for o, _, _, _, _ in seq]

# ---- 階段 3：使用者選丙，並要求「多加 zzz 特效等」 ----
# 特效畫在獨立的一層（和角色同一個 48×43 畫布、同一個基準點），Studio 可以疊上去，也可以不用。
# 丙有幾格停很久（最長約 1.3 秒），z 跟著停住會很僵：把每格切成不超過 TICK 毫秒的小格，姿勢不變、z 每一小格都往上飄。
import math
from PIL import Image

TICK = 250
ZGLYPH = {2: ["XXXX", "..X.", ".X..", "XXXX"],                         # 小、大兩種 z（3×3 的 z 會變成「工」字）
          3: ["XXXXX", "...X.", "..X..", ".X...", "XXXXX"]}
WHITE, DARK = (0xf8, 0xf5, 0xee, 255), (0x40, 0x42, 0x7a, 255)        # 頭髮最亮、最暗的顏色
HAIRMID = (0x72, 0x7a, 0xb0, 255)                                      # 頭髮中間調：淺色背景、深色背景都看得到（白色 z 在淺色背景上幾乎看不見）
BLUE, BLUE_L = (0x4a, 0x8f, 0xf0, 255), (0xa0, 0xcc, 0xff, 255)       # 蝴蝶結緞帶的藍

def ticks(seq):
    """把每一格切成不超過 TICK 的小格。回傳 [(原本第幾格, 開始時間, 毫秒)]。"""
    out, t0 = [], 0
    for i, (_, t, *_rest) in enumerate(seq):
        n = math.ceil(t / TICK)
        parts = [t // n + (1 if k < t % n else 0) for k in range(n)]
        for p in parts: out.append((i, t0, p)); t0 += p
    return out, t0

def glyph(im, x, y, size, fill, outline):
    g = ZGLYPH[size]
    cells = {(x + c, y + r) for r, row in enumerate(g) for c, ch in enumerate(row) if ch == "X"}
    if outline:   # 只在右下方落一格陰影：四周都描邊會把 z 中間的空隙填滿，縮小後像框起來的沙漏
        for cx, cy in cells:
            ax, ay = cx + 1, cy + 1
            if (ax, ay) not in cells and 0 <= ax < im.width and 0 <= ay < im.height: im.putpixel((ax, ay), outline)
    for cx, cy in cells:
        if 0 <= cx < im.width and 0 <= cy < im.height: im.putpixel((cx, cy), fill)

ZPATH = {"down": ((38, 11), (42, 0))}   # 從頭的右上方冒出、往右上飄（蝴蝶結在左上）；起點離頭髮 1 格，路線斜一點、同時出現的兩個 z 才不會疊在一起

def zzz(t, total, view="down", fill=HAIRMID, outline=None, count=4, life=3200):
    """t 時間點的 z 特效層：一輪內平均冒出 count 個 z，每個飄 life 毫秒；越往上越大，最後消失。首尾接得上。"""
    im = Image.new("RGBA", (48, 43), (0, 0, 0, 0))
    (sx, sy), (ex, ey) = ZPATH[view]
    for k in range(count):
        age = (t - k * total / count) % total
        if age >= life: continue
        p = age / life
        size = 2 if p < 0.45 else 3
        x = round(sx + (ex - sx) * p + math.sin(p * 2 * math.pi))      # 飄的時候左右輕輕晃
        y = round(sy + (ey - sy) * p)
        if p > 0.92: continue                                           # 最後一小段直接消失（不用半透明）
        glyph(im, x, y, size, fill, outline)
    return im

BUBBLE = {0: [], 1: [(0, 0, "o")],                                     # 鼻涕泡泡：隨呼氣變大、點頭浮回時破掉
          2: [(0, 0, "o"), (1, 0, "o"), (0, 1, "o"), (1, 1, "f")],
          3: [(1, 0, "o"), (0, 1, "o"), (1, 1, "w"), (2, 1, "o"), (1, 2, "o"), (2, 2, "f"), (0, 2, "o"), (2, 0, "o"), (0, 0, "o")]}

def bubble(im, level, at=(25, 21)):
    for dx, dy, c in BUBBLE[level]:
        im.putpixel((at[0] + dx, at[1] + dy), {"o": BLUE, "f": BLUE_L, "w": WHITE}[c])

def bubble_level(i):
    """丙的第 i 格（19 格）：每次呼氣（第 1～4 格）泡泡變大、吸氣變小；第二次呼吸更大；最後頭浮回時破掉。"""
    grow = [0, 1, 1, 2, 2, 1, 1, 0, 0]
    if i < 9: return grow[i]
    if i < 18: return min(grow[i - 9] + 1, 3) if grow[i - 9] else 0
    return 0

def stage3(fx):
    """fx：甲＝頭髮色的 z；乙＝緞帶藍的 z。（sleep_out/stage3 是第一次試的白色 z＋描邊＋鼻涕泡泡：
    白色在淺色背景看不到、描邊糊成沙漏形、泡泡在這個尺寸只有幾格藍點看起來像眼淚，都不採用。）"""
    seq = seq_丙()
    poses = [render(o, c, s, l) for o, t, s, l, c in seq]
    tk, total = ticks(seq)
    chars, layers, durs = [], [], []
    for i, t0, d in tk:
        layer = zzz(t0, total, fill=BLUE if fx == "乙" else HAIRMID)
        chars.append(poses[i]); layers.append(layer); durs.append(d)
    return chars, layers, durs

def combine(chars, layers):
    out = []
    for c, l in zip(chars, layers):
        im = c.convert("RGBA").copy(); im.alpha_composite(l); out.append(im)
    return out

# ---- 階段 4：使用者選丙＋乙（緞帶藍 z），延伸到側面、背面 ----
# z 的路線（z 左上角的起點 → 終點）：側面從臉那一側往上飄；背面的蝴蝶結在右上，改從左上飄。
ZPATH.update({"left": ((8, 11), (3, 0)), "right": ((36, 11), (40, 0)), "back": ((6, 11), (1, 0))})

def pose(view, o, closed, state, level):
    if view == "down": return render(o, closed, state, level)
    if view == "back" and level >= 2:   # 背面看不到臉，頭最低時整顆頭多低 1 格（後髮蓋住脖子和肩膀，不會像正面那樣黏在一起）
        o = dict(o); o["head"] = o.get("head", 0) + 1
    return idle_dirs.render(view, o, closed, state, edit=lambda r: bow(r, level, o.get("head", 0), view))

def stage4(view):
    """回傳 (角色幀, 特效層, 每幀毫秒, 19 個姿勢, 姿勢位移)。角色幀和特效層都已切成小格，一一對應。"""
    seq = seq_丙()
    poses = [pose(view, o, c, s, l) for o, t, s, l, c in seq]
    tk, total = ticks(seq)
    chars = [poses[i] for i, _, _ in tk]
    layers = [zzz(t0, total, view, fill=BLUE) for _, t0, _ in tk]
    return chars, layers, [d for _, _, d in tk], poses, [o for o, *_ in seq]

def final(view):
    return stage4(view)[:3]

def save_final(view, folder="sleep_out/final", scale=8):
    """成品：角色每一幀（export_studio 比對用）＋疊上 z 的放大預覽 GIF（淺色、深色背景）。z 是程式算的，不另存。"""
    ch, ly, du = final(view)
    for i, im in enumerate(ch): im.save(f"{folder}/{view}_f{i}.png")
    for name, bg in ((view, "#ebe8f2"), (f"{view}_dark", "#2a2b33")):
        big = []
        for im in combine(ch, ly):
            b = Image.new("RGBA", im.size, bg); b.alpha_composite(im)
            big.append(b.convert("RGB").resize((im.width * scale, im.height * scale), Image.NEAREST))
        big[0].save(f"{folder}/{name}.gif", save_all=True, append_images=big[1:], duration=du, loop=0, disposal=2)
