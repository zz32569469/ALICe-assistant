"""待機動畫：在正面的材質圖上把部位分組移動，再交給 shade 重新上明暗（每一幀的明暗規則都一樣）。"""
from PIL import Image
import jp_big, views

HAIR = set("hHLZ")

def base():
    """正面定稿的材質圖與深度圖。"""
    kw = {k: v for k, v in views.FINAL.items() if k in ("persp","front","foot","body","neckk","legk","headk","hd","hs","hair2","clumps","tidy","polish")}
    rows, depth = jp_big.build(**kw)
    return [list(r) for r in rows], [list(d) for d in depth]

def group_v1(x, y, c):
    """階段 1 的分組：feet 不動；head 頭與臉；tips 兩側垂下的髮尾；body 身體與手臂（含短褲，往下會壓短腿）。"""
    if y >= 36: return "feet"
    if y <= 25: return "head"
    if c in HAIR and (x <= 17 or x >= 30): return "tips"
    return "body"

def group(x, y, c):
    """階段 2 起：短褲最下面一列也固定，身體下沉時由外套下襬蓋住短褲，腿的長度不變。"""
    if c in HAIR and y >= 26 and (x <= 17 or x >= 30): return "tips"
    if y >= 35: return "feet"
    if y <= 25: return "head"
    return "body"

def group_v5(x, y, c):
    """階段 5 起：再分出 arms 手臂（袖子、藍帶、手）與 hem 外套下半段，讓它們可以比身體晚一步。"""
    gname = group(x, y, c)
    if gname != "body": return gname
    if y >= 27 and (x <= 16 or x >= 31): return "arms"
    if y >= 31: return "hem"
    return "body"

def frame(offsets, src=None, groups=group, fill=True):
    """offsets：{組名: 往下移幾格}。移動後的格子依深度決定誰在前面。
    fill：部位錯開移動時中間會裂開，用原本那一格補上（看起來像被拉長，不會破洞）。"""
    g, d = src or base()
    H, W = len(g), len(g[0])
    out = [["."] * W for _ in range(H)]; dep = [[0] * W for _ in range(H)]
    cells = [(d[y][x], x, y, g[y][x]) for y in range(H) for x in range(W) if g[y][x] != "."]
    for z, x, y, c in sorted(cells):                 # 深度小的先畫，深度大的蓋在上面
        Y = y + offsets.get(groups(x, y, c), 0)
        if 0 <= Y < H and (out[Y][x] == "." or z >= dep[Y][x]):
            out[Y][x] = c; dep[Y][x] = z
    if fill:
        for y in range(1, H - 1):
            for x in range(W):
                if out[y][x] == "." and g[y][x] != "." and out[y-1][x] != "." and out[y+1][x] != ".":
                    out[y][x] = g[y][x]; dep[y][x] = d[y][x]
    return ["".join(r) for r in out], dep

def check(frames, base_img):
    """自動檢查重大瑕疵：腳是否固定、輪廓內有沒有破洞、有沒有調色盤以外的顏色。"""
    pal = {p for p in base_img.getdata() if p[3]}
    W, H = base_img.size
    report = []
    for i, im in enumerate(frames):
        px = im.load(); bp = base_img.load()
        feet = sum(px[x, y] != bp[x, y] for y in range(37, H) for x in range(W))
        holes = sum(1 for y in range(1, H-1) for x in range(1, W-1)
                    if not px[x, y][3] and px[x-1, y][3] and px[x+1, y][3] and px[x, y-1][3] and px[x, y+1][3])
        new = {p for p in im.getdata() if p[3]} - pal
        report.append(f"幀{i}: 腳下變動 {feet} 格、破洞 {holes} 格、新顏色 {len(new)} 種")
    return report

def build_page(src="idle_out/page_src.html", out="idle_out/index.html"):
    """把比較頁裡的圖片內嵌成單一檔案（在哪裡打開都不會破圖）。"""
    import re, base64, pathlib
    root = pathlib.Path(src).parent
    def inline(m):
        f = root / m.group(1)
        mime = "image/gif" if f.suffix == ".gif" else "image/png"
        return f'src="data:{mime};base64,{base64.b64encode(f.read_bytes()).decode()}"'
    html = re.sub(r'src="(?!data:|https?:)([^"]+)"', inline, pathlib.Path(src).read_text(encoding="utf-8"))   # 所有相對路徑的圖片都內嵌
    pathlib.Path(out).write_text(html, encoding="utf-8")

# ---- 各階段（保留每次重要修改，方便比較） ----
def stage1():
    """2 幀，腳以上全部一起往下 1 格。"""
    seq = [({}, 500), ({"head": 1, "tips": 1, "body": 1}, 500)]
    return [render(*frame(o, groups=group_v1, fill=False)) for o, _ in seq], [t for _, t in seq]

def stage2():
    """6 幀：頭先動、身體跟上、髮尾最後；回程身體先回、頭、髮尾最後。最高點與最低點停久一點。"""
    seq = [({}, 600),
           ({"head": 1}, 150),
           ({"head": 1, "body": 1}, 150),
           ({"head": 1, "body": 1, "tips": 1}, 450),
           ({"head": 1, "tips": 1}, 150),
           ({"tips": 1}, 150)]
    return [render(*frame(o)) for o, _ in seq], [t for _, t in seq]

# 階段 3 起的基本循環：往下時髮尾跟著身體（手下面一直有頭髮墊著，不會閃出暗紅外框）；
# 回程時髮尾晚一步（跟隨動作）。
CYCLE = [({}, 600),
         ({"head": 1}, 160),
         ({"head": 1, "body": 1, "tips": 1}, 450),
         ({"head": 1, "tips": 1}, 160),
         ({"tips": 1}, 160)]

def stage3():
    """修掉階段 2 的閃爍：手的暗紅邊、襪子明暗、袖口亮藍；腳固定用定稿像素。5 幀。"""
    return [render(*frame(o), pin=True) for o, _ in CYCLE], [t for _, t in CYCLE]

def stage4():
    """加眨眼：循環兩次，第二次在最高點停住時眨一下（太頻繁會不自然）。"""
    seq = [(o, t, False) for o, t in CYCLE]
    seq += [({}, 260, False), ({}, 120, True), ({}, 220, False)] + [(o, t, False) for o, t in CYCLE[1:]]
    frames = []
    for o, t, closed in seq:
        rows, dep = frame(o)
        frames.append(render(blink(rows) if closed else rows, dep, pin=True))
    return frames, [t for _, t, _ in seq]

# 階段 5 的循環：一次呼吸約 2.9 秒（階段 4 約 1.5 秒）。慢下來靠多幾個中間幀，不只是拉長停頓。
# 往下：頭 → 上半身 → 外套下半段 → 手臂和髮尾一起（手下面一直有頭髮墊著）
# 回程：上半身 → 手臂 → 頭 → 外套下半段 → 髮尾最後
CYCLE5 = [({}, 900),
          ({"head": 1}, 180),
          ({"head": 1, "body": 1}, 180),
          ({"head": 1, "body": 1, "hem": 1}, 180),
          ({"head": 1, "body": 1, "hem": 1, "arms": 1, "tips": 1}, 700),
          ({"head": 1, "hem": 1, "arms": 1, "tips": 1}, 180),
          ({"head": 1, "hem": 1, "tips": 1}, 180),
          ({"hem": 1, "tips": 1}, 180),
          ({"tips": 1}, 180)]

CLOTH = set("jJG")   # 外套：j 底色、J 皺褶（壓暗）、G 光澤（提亮）

# 布料只改顏色、不動輪廓。座標用定稿（不移動時）的位置，會跟著那一格所屬的部位一起移動。
# 深色布料上只壓暗一格幾乎看不出來（亮度只差約 28），皺褶要畫成「上亮下暗」一對：
# 光從左上來，隆起的折痕上緣受光（G），下面落一格陰影（J）。袖子原本的光澤不要動（動了會髒）。
FABRIC = {
    "squash":  [(18, 31, "G"), (18, 32, "J"),            # 外套被擠短：兩片前襟靠腰處浮出折痕
                (29, 31, "G"), (29, 32, "J"),
                (30, 27, "j")],                          # 右肩光澤縮短
    "stretch": [(19, 29, "G"), (19, 30, "G"),            # 外套被拉長：折痕消失，前襟亮邊變寬
                (29, 28, "G")],                          # 右肩光澤變長
}

def fabric(rows, offsets, state, groups=group_v5):
    """把布料狀態的顏色變化畫上去：只改目前仍是外套的格子，所以輪廓不會變。"""
    if not state: return rows
    g0, _ = base()
    g = [list(r) for r in rows]
    for x, y, c in FABRIC[state]:
        Y = y + offsets.get(groups(x, y, g0[y][x]), 0)
        if g[Y][x] in CLOTH: g[Y][x] = c
    return ["".join(r) for r in g]

# 每一幀的布料狀態（對應 CYCLE5）：上半身一沉就擠出折痕，停在最低點時折痕留著
# （外套下半段跟上時，折痕跟著往下滑 1 格）；上半身先回去時外套被拉長，折痕消失、光澤變長。
FABRIC5 = [None, None, "squash", "squash", "squash", "stretch", "stretch", None, None]

def stage6():
    """在階段 5 上加布料皺褶與光澤的顏色變化（只改顏色、不動輪廓）；動作和節奏不變。"""
    cyc = [(o, t, s) for (o, t), s in zip(CYCLE5, FABRIC5)]
    seq = [(o, t, s, False) for o, t, s in cyc]
    seq += [({}, 400, None, False), ({}, 130, None, True), ({}, 370, None, False)] + [(o, t, s, False) for o, t, s in cyc[1:]]
    frames = []
    for o, t, s, closed in seq:
        rows, dep = frame(o, groups=group_v5)
        rows = fabric(rows, o, s)
        frames.append(render(blink(rows) if closed else rows, dep, pin=True))
    return frames, [t for _, t, _, _ in seq]

def final():
    """目前成品：階段 6。"""
    return stage6()

def stage5():
    """加手臂與外套下半段的跟隨擺動，呼吸放慢；眨眼仍是每兩個循環一次。"""
    seq = [(o, t, False) for o, t in CYCLE5]
    seq += [({}, 400, False), ({}, 130, True), ({}, 370, False)] + [(o, t, False) for o, t in CYCLE5[1:]]
    frames = []
    for o, t, closed in seq:
        rows, dep = frame(o, groups=group_v5)
        frames.append(render(blink(rows) if closed else rows, dep, pin=True))
    return frames, [t for _, t, _ in seq]

def render(rows, dep, pin=False):
    """pin：腳和地面陰影（第 37 列以下）直接用定稿的像素，不重新上明暗，保證腳不會閃。"""
    orig = jp_big.build
    jp_big.build = lambda *a, **k: (rows, dep)
    try:
        im = jp_big.draw(**views.FINAL)
    finally:
        jp_big.build = orig
    if pin:
        ref = Image.open("final_front.png").convert("RGBA")
        im.paste(ref.crop((0, 37, ref.width, ref.height)), (0, 37))
    return im

def blink(rows):
    """閉眼：上緣深色眼線嵌在瀏海裡，改成頭髮讓瀏海蓋下來（改成皮膚會在瀏海上開出方洞）；
    原本綠色瞳孔的第一列改成一條深色閉眼線，其餘改成皮膚。"""
    g = [list(r) for r in rows]
    tops = {}
    for y, r in enumerate(g):
        for x, c in enumerate(r):
            if c == "E": tops.setdefault(x, y)
    for y, r in enumerate(g):
        for x, c in enumerate(r):
            if c == "e": g[y][x] = "h"
            elif c == "E": g[y][x] = "e" if tops.get(x) == y else "s"
    return ["".join(r) for r in g]

def save(frames, durations, name, scale=8, bg="#ebe8f2"):
    """輸出原尺寸幀、放大 GIF、放大並排圖。"""
    big = []
    for i, im in enumerate(frames):
        im.save(f"{name}_f{i}.png")
        b = Image.new("RGBA", im.size, bg); b.alpha_composite(im)
        big.append(b.convert("RGB").resize((im.width*scale, im.height*scale), Image.NEAREST))
    big[0].save(f"{name}.gif", save_all=True, append_images=big[1:], duration=durations, loop=0, disposal=2)
    W, H = big[0].size; gap = 12
    sheet = Image.new("RGB", (len(big)*(W+gap) - gap, H), "#ffffff")
    for i, b in enumerate(big): sheet.paste(b, (i*(W+gap), 0))
    sheet.save(f"{name}_sheet.png")
