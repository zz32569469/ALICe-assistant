"""校準角色第二版起：可分階段輸出。stage 2=比例與皺褶，3=細節，4=清理與打磨"""
import sys
from PIL import Image, ImageDraw
import shade
import calib  # 沿用調色盤設定
shade.RAMPS["n"] = ["#26272c", "#474952", "#727581", "#9a9da8"]

CODES = ".csfporgdnyeYaCSFPORGDNA"
def build(Wpx, Hpx, stage):
    sx, sy = min(Wpx, 48)/100, Hpx/140
    ox = (Wpx - min(Wpx, 48)) / 2
    img = Image.new("L", (Wpx, Hpx), 0); d = ImageDraw.Draw(img)
    k = lambda m: CODES.index(m)
    ident = lambda x: x
    cur = [ident]
    tf = lambda pts: [(cur[0](x)*sx + ox, y*sy) for x,y in pts]
    def tb(b):
        x0, x1 = sorted((cur[0](b[0]), cur[0](b[2])))
        return (x0*sx + ox, b[1]*sy, x1*sx + ox, b[3]*sy)
    P = lambda m, pts: d.polygon(tf(pts), fill=k(m))
    E = lambda m, b: d.ellipse(tb(b), fill=k(m))
    R = lambda m, b: d.rectangle(tb(b), fill=k(m))
    L = lambda m, pts, w=1: d.line(tf(pts), fill=k(m), width=w)
    wide = stage >= 6
    WIDEN = (lambda x: 50 + (x-50)*1.22) if wide else ident
    LEFT = (lambda x: x - 7) if wide else ident
    RIGHT = (lambda x: x + 6) if wide else ident
    det = stage >= 3

    # --- 背後 ---
    cur[0] = RIGHT
    E("p", (53,20,85,33))
    if det: L("D", [(60,21),(60,32)]); L("D", [(76,21),(76,32)])
    P("a", [(55,30),(80,33),(82,72),(58,74)])
    if det:
        P("A", [(58,44),(80,46),(80,52),(58,50)])          # 背包翻蓋陰影
        R("n", (68,50,70,52))                               # 扣環
    # 手杖與提燈
    cur[0] = LEFT
    L("d", [(24,16),(29,134)], 2)
    if det: E("d", (21,12,28,19))                           # 杖頭
    L("n", [(24,18),(17,22)], 1)
    if det: P("n", [(11,23),(17,19),(24,23)])               # 燈罩頂
    R("n", (12,23,23,39)); R("y", (14,26,21,36)); R("Y", (16,29,19,33))
    if det: L("n", [(17.5,24),(17.5,38)])                   # 燈框中柱
    # --- 腿（拉長、跨步）---
    cur[0] = (lambda x: 50 + (x-50)*1.1) if wide else ident
    P("p", [(52,96),(61,96),(60,115),(62,124),(56,124),(53,114)])
    P("o", [(54,121),(64,121),(69,133),(53,133)])
    P("p", [(37,96),(47,96),(43,113),(39,123),(33,122),(36,112)])
    P("o", [(30,120),(42,120),(42,133),(24,133),(25,128)])
    if det:
        R("a", (54,121,63,123)); R("a", (30,120,41,122))    # 靴口翻邊
        L("P", [(44,98),(41,112)])                          # 褲子皺褶
    # --- 斗篷（下襬不規則、到膝上）---
    cur[0] = WIDEN
    P("c", [(34,40),(65,40),(71,64),(76,100),(68,98),(62,104),(55,99),(46,104),(39,98),(30,103),(24,99),(30,64)])
    if stage >= 4: P("g", [(45,52),(53,52),(55,96),(44,96)])
    else: P("g", [(43,52),(54,52),(57,96),(41,96)])               # 內衫
    if stage >= 2:
        L("C", [(38,62),(33,98)]); L("C", [(63,58),(69,96)]); L("C", [(58,76),(61,99)])
        L("C", [(31,80),(28,98)])
        L("G", [(48,60),(47,94)])
    R("d", (40,73,58,77)); R("a", (54,77,60,86))            # 腰帶與小袋
    if det:
        R("n", (47,74,49,76))                               # 皮帶扣
        R("g", (64,84,68,90)); L("A", [(64,84),(64,90)])    # 斗篷補丁
    # --- 握杖手臂 ---
    cur[0] = LEFT
    P("c", [(33,43),(43,47),(38,64),(32,72),(23,69),(27,56)])
    if stage >= 2: L("C", [(35,50),(29,66)])
    if stage >= 5:
        L("d", [(26.5,62),(27.5,76)], 2)
        E("s", (23,64,32,73)); L("S", [(24,67),(31,67)]); L("S", [(24,70),(31,70)])  # 手握在杖前，指縫
    else:
        E("s", (23,64,31,73))
        L("d", [(26.5,62),(27.5,76)], 2)
    if det:
        rope = "a" if stage >= 4 else "r"
        L(rope, [(24,76),(31,76)]); L(rope, [(24,78),(31,78)])  # 杖上纏繩
        R("s", (31,67,32,70))                               # 拇指
    # --- 頭 ---
    cur[0] = (lambda x: 50 + (x-50)*1.1) if wide else ident  # 兜帽稍微加寬
    if stage >= 4:
        if stage >= 5: P("c", [(31,27),(36,11),(46,4),(55,5),(63,9),(69,22),(70,43),(60,45),(36,45),(31,39)])
        else: P("c", [(31,27),(37,11),(52,2),(56,6),(63,9),(69,22),(70,43),(60,45),(36,45),(31,39)])
    else:
        P("c", [(31,27),(36,12),(48,5),(62,8),(69,22),(69,43),(60,45),(36,45),(31,39)])
    if stage >= 2: L("C", [(60,12),(66,36)])
    cur[0] = ident
    P("s", [(37,22),(55,20),(57,32),(51,40),(42,40),(37,32)])
    P("s", [(35,28),(38,28),(38,31),(35,31)])
    if stage < 4:
        P("f", [(38,32),(55,30),(56,38),(51,49),(44,51),(39,42)])
        if det: L("F", [(44,38),(45,48)]); L("F", [(50,37),(50,45)])
    L("f", [(40,25),(44,24)]); L("f", [(48,24),(53,25)])
    R("e", (41,27,43,27)); R("e", (49,27,51,27))
    P("c", [(35,23),(41,15),(54,14),(59,19),(58,24),(51,19),(42,20),(37,27)])
    P("r", [(35,40),(58,38),(61,46),(51,49),(35,48)])
    P("r", [(52,46),(59,46),(61,63),(54,65)])
    if stage >= 2: L("R", [(37,44),(57,42)])
    if stage >= 4:
        # 鬍子：從臉頰往下長、蓋過圍巾，露出臉頰皮膚
        P("f", [(39,34),(42,33),(46,35),(50,33),(55,32),(56,40),(53,52),(47,56),(42,53),(39,44)])
        L("F", [(42,34),(50,34)])                               # 八字鬍下緣
        L("F", [(45,42),(46,52)]); L("F", [(51,40),(51,49)])
    if det: R("n", (44,45,46,47))                           # 胸前別針
    rows = ["".join(CODES[img.getpixel((x,y))] for x in range(Wpx)) for y in range(Hpx)]
    if stage >= 4: rows = cleanup(rows)
    return rows

def cleanup(rows):
    """清掉孤立像素：四周都不是同材質的單格，改成鄰居多數的材質。"""
    g = [list(r) for r in rows]; H, W = len(g), len(g[0])
    base = lambda c: c.lower() if c.isupper() and c not in "EY" else c
    for y in range(1, H-1):
        for x in range(1, W-1):
            c = g[y][x]
            if c == "." or c in shade.FIXED or c in "nN": continue
            nb = [g[y+dy][x+dx] for dx,dy in [(-1,0),(1,0),(0,-1),(0,1)]]
            if all(base(v) != base(c) for v in nb):
                best = max([nb[2], nb[3], nb[0], nb[1]], key=nb.count)   # 平手時依上、下、左、右的順序選，結果才固定（set 的順序每次執行都不同）
                if best != ".": g[y][x] = best
    return ["".join(r) for r in g]

def run(stage, W=None, H=None, sc=None):
    W, H, sc = (52, 68, 6) if stage >= 6 else (48, 68, 6) if stage >= 5 else (44, 62, 7)
    img = shade.render(build(W, H, stage), strands=False)
    big = img.resize((W*sc, H*sc), Image.NEAREST)
    bg = Image.new("RGBA", big.size, "#e9e6f0"); bg.alpha_composite(big)
    bg.convert("RGB").save(f"stage{stage}.png")
    img.save(f"stage{stage}_1x.png")

if __name__ == "__main__":
    for st in map(int, sys.argv[1:]): run(st)
