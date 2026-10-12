"""四個方向的待機：側面向左、向右、背面沿用正面待機（idle.py）的呼吸節奏與動作順序。
幀數、每幀時間和正面完全相同（眨眼幀在背面只是停住），換方向時節奏能接得上。
和側面、背面走路一樣，移動的部位直接搬移定稿像素（重新上明暗時外套亮邊、藍帶、鞋子會閃）。"""
from PIL import Image
import idle, jp_big, views, walk_back, walk_side

HAIR = set("hHLZ")
FACE = "seEPm"
REF = {"left": "final_side.png", "right": "final_side_right.png", "back": "final_back.png"}
ARM = (20, 27)   # 側面手臂（袖子、藍帶、手）所在的欄；向左、向右剛好是同一段

def base(view, cache={}):
    if view not in cache:
        if view == "back":
            rows, d = walk_back.base()
        else:
            rows, d = views.side_rows(view)
        cache[view] = ([list(r) for r in rows], [list(r) for r in d])
    return cache[view]

def group(view, x, y, c):
    """和正面 idle.group_v5 同一套組名：head、body、hem（外套下半段）、arms、tips（頭髮）、feet（固定）。"""
    if c == "V": return "feet"
    if c in HAIR and y >= 26: return "tips"
    if y >= 35: return "feet"
    if y <= 25: return "head"
    if view == "back":
        if y >= 28 and (x <= 14 or x >= 33): return "arms"
        return "tips" if y >= 33 else "body"   # 髮縫間露出的外套、短褲：是透過髮縫看到的，跟著頭髮動
    if y >= 27 and ARM[0] <= x <= ARM[1] and c != "t": return "arms"
    return "hem" if y >= 31 else "body"

def frame(view, offsets):
    """offsets：{組名: 往下幾格}。錯開造成的上下空隙用原本那一格補上（拉長），記在 frame.stretched。"""
    g, d = base(view)
    H, W = len(g), len(g[0])
    out = [["."] * W for _ in range(H)]; dep = [[0] * W for _ in range(H)]
    cells = [(d[y][x], x, y, g[y][x]) for y in range(H) for x in range(W) if g[y][x] != "."]
    for z, x, y, c in sorted(cells):
        Y = y + offsets.get(group(view, x, y, c), 0)
        if 0 <= Y < H and (out[Y][x] in ".V" or z >= dep[Y][x]):
            out[Y][x] = c; dep[Y][x] = z
    frame.stretched = set()
    for y in range(1, H - 1):
        for x in range(W):
            if out[y][x] in ".V" and g[y][x] not in ".V" and out[y-1][x] not in ".V" and out[y+1][x] not in ".V":
                out[y][x] = g[y][x]; dep[y][x] = d[y][x]; frame.stretched.add((x, y))
    return ["".join(r) for r in out], dep

def blink(view, rows):
    """側面閉眼：上面兩列深色眼線和綠色瞳孔都改成皮膚，只在原本瞳孔第一列留一條深色閉眼線。
    （正面是把上緣眼線改成頭髮讓瀏海蓋下來；側面眼睛兩旁都是皮膚，改成頭髮會在臉上多一塊頭髮。）"""
    if view == "back": return rows
    g = [list(r) for r in rows]
    tops = {}
    for y, r in enumerate(g):
        for x, c in enumerate(r):
            if c == "E": tops.setdefault(x, y)
    for y, r in enumerate(g):
        for x, c in enumerate(r):
            if c == "e": g[y][x] = "s"
            elif c == "E": g[y][x] = "e" if tops.get(x) == y else "s"
    return ["".join(r) for r in g]

def render(view, offsets, closed=False, state=None, edit=None):
    """edit：閉眼之後再改材質圖的函式（睡覺動作的低頭用，sleep.py）；不給就和待機完全相同。"""
    rows, dep = frame(view, offsets)
    stretched = set(frame.stretched)
    rows = blink(view, rows) if closed else rows
    rows = edit(rows) if edit else rows
    im = walk_side.draw_rows(rows, dep)
    ref = Image.open(REF[view]).convert("RGBA")
    g, d = base(view)
    for z, x, y, c in sorted((d[y][x], x, y, g[y][x]) for y in range(len(g)) for x in range(len(g[0])) if g[y][x] != "."):
        Y = y + offsets.get(group(view, x, y, c), 0)
        if 0 <= Y < im.height and rows[Y][x] == c and (x, Y) not in stretched:
            im.putpixel((x, Y), ref.getpixel((x, y)))
    for x, y in stretched:   # 拉長的格子：用定稿同一格的顏色（就是被拉長的那一列）
        if rows[y][x] == g[y][x]: im.putpixel((x, y), ref.getpixel((x, y)))
    if view == "right":      # 臉用向左同一幀的臉左右翻轉（和定稿、側面走路一樣，兩邊同一張臉）
        left = render("left", offsets, closed, state, edit)
        lrows = frame("left", offsets)[0]
        lrows = blink("left", lrows) if closed else lrows
        lrows = edit(lrows) if edit else lrows
        W = im.width
        for y in range(im.height):
            for x in range(W):
                if rows[y][x] in FACE and lrows[y][W-1-x] == rows[y][x]:
                    im.putpixel((x, y), left.getpixel((W - 1 - x, y)))
    fabric(view, im, rows, offsets, state)
    return im

def stage1(view):
    """和正面定案（idle.stage6）同一個序列：呼吸兩次，第二次前在最高點眨一下眼；布料顏色變化先不做。"""
    cyc = idle.CYCLE5
    seq = [(o, t, False) for o, t in cyc]
    seq += [({}, 400, False), ({}, 130, True), ({}, 370, False)] + [(o, t, False) for o, t in cyc[1:]]
    return [render(view, o, c) for o, t, c in seq], [t for _, t, _ in seq], [o for o, _, _ in seq]

# 階段 2：布料皺褶與光澤（和正面 idle.FABRIC 同一套做法：只改外套的顏色、不動輪廓，「上亮下暗」一對才看得出折痕）。
# 側面看得到的外套幾乎只有袖子，所以畫在袖子上。座標是向左定稿的位置，向右時左右翻轉。
# 不改材質交給 shade 上色：向右時袖子在背光面，重新上色後亮暗都落在同一個深灰、折痕看不出來。
# 改成在外套色階上直接調：+1＝亮一階、-1＝暗一階。
FABRIC = {
    "squash":  [(21, 30, +1), (22, 30, +1),              # 上半身一沉，袖子在袖口藍帶上方擠出一道折痕
                (21, 31, -1), (22, 31, -1),
                (21, 27, -1)],                           # 肩膀光澤縮短
    "stretch": [(20, 30, +1), (21, 28, +1)],             # 上半身先回去、袖子被拉長：前緣光澤變長、變寬
}
RAMP = [tuple(int(h[i:i+2], 16) for i in (1, 3, 5)) for h in jp_big.HUE["j"]]   # 外套色階，暗 → 亮

def fabric(view, im, rows, offsets, state):
    """在已經上好色的圖上，把布料狀態的格子在外套色階上調亮或調暗；只動目前仍是外套的格子。"""
    if not state or view == "back": return   # 背面的外套幾乎都被頭髮蓋住
    g0, _ = base(view)
    W = len(g0[0])
    used = {q[:3] for q in Image.open(REF[view]).convert("RGBA").getdata() if q[3]}
    r = [c for c in RAMP if c in used]   # 只用這個方向定稿裡有的顏色（否則那個顏色只在折痕幀出現）
    for x, y, step in FABRIC[state]:
        if view == "right": x = W - 1 - x
        Y = y + offsets.get(group(view, x, y, g0[y][x]), 0)
        p = im.getpixel((x, Y))
        if rows[Y][x] in idle.CLOTH and p[:3] in r:
            i = min(max(r.index(p[:3]) + step, 0), len(r) - 1)
            im.putpixel((x, Y), r[i] + (255,))

def stage2(view):
    """階段 1 ＋ 布料皺褶與光澤（時機和正面 idle.FABRIC5 相同）。"""
    cyc = [(o, t, s) for (o, t), s in zip(idle.CYCLE5, idle.FABRIC5)]
    seq = [(o, t, s, False) for o, t, s in cyc]
    seq += [({}, 400, None, False), ({}, 130, None, True), ({}, 370, None, False)] + [(o, t, s, False) for o, t, s in cyc[1:]]
    return [render(view, o, c, s) for o, t, s, c in seq], [t for _, t, _, _ in seq], [o for o, _, _, _ in seq]

def check(view, frames, offsets):
    """和走路同一套：破洞（外圍填色填不到的透明區，碰到地面陰影的不算）、新顏色、夾縫、腳下變動。"""
    ref = Image.open(REF[view]).convert("RGBA")
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
        o = offsets[i]
        moved = lambda pts: {(x, y + dy) for x, y in pts for dy in {0, o.get("head", 0), o.get("body", 0), o.get("tips", 0)}}
        feet = sum(im.getpixel((x, y)) != ref.getpixel((x, y)) for y in range(37, H) for x in range(W))
        new = {p for p in im.getdata() if p[3]} - pal
        out.append(f"幀{i}: 破洞 {len(holes(im) - moved(h0))}、新顏色 {len(new)}、夾縫 {len(seams(im) - moved(s0))}、腳下變動 {feet}")
    return out

def final(view):
    """目前成品：階段 2（使用者 2026-10-05：呼吸「看起來很順」，加上布料皺褶與光澤）。"""
    return stage2(view)[:2]
