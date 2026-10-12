"""艾莉絲新版三視圖：側面（面向左）與背面。沿用 jp_big 的明暗設定與比例變形。"""
from PIL import Image, ImageDraw
import jp_big, shade
from calib2 import cleanup

CODES = jp_big.CODES
FINAL = dict(hue=True, selout=True, clumps=True, rim=True, soft_face=True, despeckle=3, tidy=True, skin3=True,
             polish=True, hair2=True, hs="BD", persp=1.0, front=True, foot=0.65, body=0.46, neckk=0.1, legk=0.05,
             headk=0.86, hd=dict(chin=1.0, bangs="zig", mouth="dot", blush="wide", eye="vwide2", eh=6.5))

def canvas(Wpx, headk, body, neckk, legk, persp, foot, nar=1.0, hdx=0.0, hb=1.0, hx=1.0):
    sx, sy = Wpx/100, 72/150
    NECK = 62; SHIFT = NECK * (1 - headk * hb)
    def below(d):
        out = 0
        for length, f in [(6, neckk), (40, body), (26, legk), (16, max(body, 0.8))]:
            take = min(max(d, 0), length); out += take * f; d -= length
        return out
    Hpx = int(round((NECK * headk * hb + below(88)) * sy)) + 2
    def warp(x, y):
        if y <= NECK: x = 50 + (x - 50) * hb * hx + hdx  # 頭單獨放大、加寬、往右移（身體不受影響）
        x = 50 + (x - 50) * headk * nar
        y = NECK + below(y - NECK) if y > NECK else NECK - (NECK - y) * headk * hb
        y -= SHIFT
        t = y / 150; k = 1 + persp * (0.10 - 0.28 * t)
        return (50 + (x - 50) * k) * sx, (y * (1 - persp * 0.08 * t) + persp * 4) * sy
    return Hpx, warp

def make_builder(view, face="A", nar=1.0, hdx=0.0, hb=1.0, hw=1.0, hlf=1.0, sq=False, light=0, smooth=False, top=4, bow=1.0, ts="ellipse", ring=True, bk=1.0, bhw=1.0, flat=False, hx=1.0, straight=False, fall=0, lock=0, bfall=0, rev=1, legs="both"):
    def build(Wpx=48, Hpx=72, persp=1.0, headk=0.86, body=0.46, neckk=0.1, legk=0.05, foot=0.65, tidy=True, **_):
        Hpx, warp = canvas(Wpx, headk, body, neckk, legk, persp, foot, nar, hdx, hb, hx)
        mat = Image.new("L", (Wpx, Hpx), 0); dep = Image.new("L", (Wpx, Hpx), 0)
        dm, dd = ImageDraw.Draw(mat), ImageDraw.Draw(dep); z = [0]
        def box(b):
            (x0, y0), (x1, y1) = warp(b[0], b[1]), warp(b[2], b[3])
            return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        P = lambda m, pts: (dm.polygon([warp(*p) for p in pts], fill=CODES.index(m)), dd.polygon([warp(*p) for p in pts], fill=z[0]))
        E = lambda m, b: (dm.ellipse(box(b), fill=CODES.index(m)), dd.ellipse(box(b), fill=z[0]))
        R = lambda m, b: (dm.rectangle(box(b), fill=CODES.index(m)), dd.rectangle(box(b), fill=z[0]))
        L = lambda m, pts: (dm.line([warp(*p) for p in pts], fill=CODES.index(m)), dd.line([warp(*p) for p in pts], fill=z[0]))
        fs = lambda cx, pts: [(cx + (x-cx)*foot, 146 - (146-y)*foot) for x, y in pts]
        z[0] = 1; E("V", (30 + 6*(1-foot), 140, 70 - 6*(1-foot), 150))       # 地面陰影

        if view == "back":
            z[0] = 20
            for cx, sgn in ((41, 1), (59, -1)):
                P("s", [(cx-4.5,108),(cx+4.5,108),(cx+4.5,116),(cx-4.5,116)])
                P("k", [(cx-4.5,116),(cx+4.5,116),(cx+4,138),(cx-4,138)])
                L("Y", [(cx-4.5,117),(cx+4.5,117)])
                P("w", fs(cx, [(cx-6,136),(cx+6,136),(cx+6.5,146),(cx-6.5,146)]))     # 鞋跟
                L("r", fs(cx, [(cx-6.5,145),(cx+6.5,145)]))
            z[0] = 35; P("k", [(37,98),(63,98),(64,110),(36,110)])
            z[0] = 50   # 外套背面
            P("j", [(28,66),(72,66),(76,104),(24,104)])
            L("J", [(50,70),(50,104)])
            P("J", [(62,70),(72,66),(76,104),(64,104)])                       # 右側背光
            z[0] = 60
            for sgn in (1, -1):
                f = (lambda p: p) if sgn == 1 else (lambda p: [(100-x, y) for x, y in p])
                P("j", f([(27,66),(34,70),(30,96),(21,98),(19,84)]))
                L("b", f([(21,92),(31,93)])); L("b", f([(22,94),(31,95)]))
                E("s", (20, 96, 28, 103) if sgn == 1 else (72, 96, 80, 103))
            if bfall:   # 新版背面：和側面同樣的步驟（不往內收、髮尾外翹、同層無分界、陰影和正面同一套）
                z[0] = 45   # 蓋在肩膀前面的兩束側髮，從背後只看得到肩膀外側露出的一點點
                for f in ((lambda p: p), (lambda p: [(100-x, y) for x, y in p])):
                    P("h", f([(21,58),(27,56),(27,76),(23,82),(20,70)]))
                z[0] = 80
                P("h", [(24,16),(28,8),(36,4.5),(64,4.5),(72,8),(76,16),(77,40),(23,40)])   # 平頂，高度和正面對齊
                BF = {   # 從頭的寬度往下，經過肩膀時收到比袖子窄，之後直直往下（不再往內收）
                 1: [(25,20),(75,20),(75,40),(71,54),(70,92),(67,97),(64,93),(61,98),(57,93),(53,97),(50,93),(47,97),(43,93),(39,98),(36,93),(33,97),(30,92),(29,54),(25,40)],
                 2: [(25,20),(75,20),(75,40),(71,54),(70,78),(74,88),(77,97),(72,96),(69,100),(65,94),(61,99),(57,93),(53,98),(50,93),(47,98),(43,93),(39,99),(35,94),(31,100),(28,96),(23,97),(26,88),(30,78),(29,54),(25,40)],
                 3: [(25,20),(75,20),(75,40),(71,54),(70,86),(73,100),(68,95),(66,90),(64,102),(60,92),(56,96),(53,90),(50,99),(47,90),(44,96),(40,92),(36,102),(34,90),(32,95),(27,100),(30,86),(29,54),(25,40)],
                 4: [(25,20),(75,20),(75,40),(71,54),(71,64),(76,72),(71,71),(70,90),(74,98),(69,97),(66,101),(62,94),(58,99),(54,93),(50,98),(46,93),(42,99),(38,94),(34,101),(31,97),(26,98),(30,90),(29,71),(24,72),(29,64),(29,54),(25,40)],
                }
                P("h", BF[bfall])
                P("r", [(80,7),(72,10),(80,14)]); P("r", [(72,10),(64,6),(64,14)])        # 蝴蝶結和頭髮同層，不壓出陰影
                L("b", [(72,12),(73,22)])
            else:
                z[0] = 80   # 頭髮蓋住整個後腦和背
                P("h", [(24,16),(28,8),(36,4.5),(64,4.5),(72,8),(76,16),(77,40),(23,40)])   # 頭頂平一點，高度和正面對齊
                # 後髮：和側面一致，變薄、只留背光側一條細陰影，不做整片漸暗
                P("h", [(25,20),(75,20),(72,50),(67,62),(67,92),(64,88),(61,95),(57,88),(53,94),(50,88),(47,94),(43,88),(39,95),(36,88),(33,92),(33,62),(28,50)])
                P("H", [(64,40),(69,48),(67,62),(67,92),(64,88),(64,60)])
                for x in (42, 50, 58): L("H", [(x, 40), (x + 0.5, 84)])
                L("L", [(30,16),(36,13),(44,11)]); L("L", [(53,11),(60,12),(66,14)])
                L("H", [(31,20),(37,17),(45,15)]); L("H", [(53,15),(60,16),(65,18)])
                z[0] = 90   # 從背後看，蝴蝶結在畫面右側
                P("r", [(80,7),(72,10),(80,14)]); P("r", [(72,10),(64,6),(64,14)])
                L("b", [(72,12),(73,22)])

        else:   # 側面，面向左
            z[0] = 10   # 後髮（垂在背後）
            hl = lambda pts: [(56 + (x - 56) * bhw if x > 56 else x, 40 + (y - 40) * hlf if y > 40 else y) for x, y in pts]   # 後髮長度與厚度
            FALL = {   # 後髮下垂的形狀：不往背部（左）靠，直直往下或往下後往外（右）
             1: ([(50,20),(70,18),(72,40),(72,92),(70,97),(68,93),(66,98),(63,93),(61,97),(59,92),(58,60),(56,40)], [(70,30),(70,90)]),
             2: ([(50,20),(70,18),(72,40),(72,78),(76,88),(80,96),(75,95),(73,99),(70,94),(67,98),(64,92),(60,95),(58,86),(58,60),(56,40)], [(70,30),(70,78),(74,88)]),
             3: ([(50,20),(70,18),(73,40),(77,70),(80,94),(76,92),(74,97),(71,92),(68,96),(66,90),(63,92),(61,70),(58,50)], [(71,30),(75,70),(78,90)]),
             4: ([(50,20),(70,18),(72,40),(72,80),(78,100),(73,96),(71,92),(70,102),(67,92),(64,96),(62,88),(59,90),(58,60),(56,40)], [(70,30),(70,80),(75,96)]),
             5: ([(50,20),(70,18),(72,40),(73,62),(77,70),(73,70),(72,90),(76,98),(71,96),(68,99),(65,94),(62,97),(59,90),(58,60),(56,40)], [(70,30),(70,62),(71,88)]),
             6: ([(50,20),(70,18),(72,40),(70,60),(73,76),(78,92),(80,98),(75,97),(72,100),(69,95),(66,98),(63,92),(60,94),(60,76),(58,60),(56,40)], [(70,30),(68,58),(71,74),(76,90)]),
            }
            if fall:
                main, edge = FALL[fall]
                z[0] = 80                      # 和頭頂同一層，頭和後髮之間就不會投出一條像馬尾分界的陰影
                P("h", main)
                if lock: pass   # 陰影最後統一用「和正面同一套」的方式加
                else:
                    lo = [p for p in edge if p[1] >= 70]   # 只在髮尾外側留一小段陰影
                    if len(lo) >= 1: L("H", [(lo[0][0], 74)] + lo)
                z[0] = 10
            elif straight:     # 後髮直直往下貼著背，髮尾往外翹
                P("h", [(50,20),(70,18),(71,40),(69,60),(68,86),(71,91),(76,96),(78,100),(72,99),(69,96),(67,100),(64,95),(61,98),(59,92),(58,60),(56,40)])
                P("H", [(66,34),(69,42),(68,86),(66,84)])
            elif light >= 2:   # 後髮變細，髮尾分成幾束
                P("h", hl([(50,20),(72,18),(76,60),(77,98),(74,94),(72,102),(69,94),(66,100),(63,92),(60,98),(58,60)]))
            else:
                P("h", hl([(48,20),(74,18),(80,60),(80,100),(76,96),(73,104),(68,96),(64,102),(60,92),(56,60)]))
            if straight or fall: pass
            elif light == 0:
                P("H", hl([(66,30),(78,40),(80,100),(76,96),(73,104),(68,96),(66,60)]))
                P("H", hl([(56,84),(80,84),(80,100),(76,96),(73,104),(68,96),(64,102),(60,92)]))
            else:            # 陰影只留背光側一條細的，不做整塊漸暗
                P("H", hl([(72,34),(76,42),(77,96),(74,94),(73,60)]))
            if light >= 3:   # 髮束之間的亮線，讓頭髮輕盈
                L("L", hl([(62,30),(64,80)])); L("L", hl([(68,40),(70,86)]))
            z[0] = 20   # 腿：遠側的腿在後面、近側的腿在前
            for cx, zz in ((52, 18), (46, 22)):
                if legs != "both" and legs != ("far" if cx == 52 else "near"): continue   # 走路動畫要把兩條腿分層取出
                z[0] = zz
                P("s", [(cx-4,108),(cx+4,108),(cx+4,116),(cx-4,116)])
                P("k", [(cx-4,116),(cx+4,116),(cx+3.5,138),(cx-3.5,138)])
                L("Y", [(cx-4,117),(cx+4,117)])
                if rev >= 2:   # 鞋頭縮短（正面是小鞋子）；藍標縮小後只會變雜點，不畫
                    P("w", fs(cx, [(cx-6,137),(cx+4,136),(cx+5,146),(cx-8,146),(cx-8,142)]))
                    L("r", fs(cx, [(cx-8,145),(cx+5,145)]))
                else:
                    P("w", fs(cx, [(cx-9,137),(cx+4,136),(cx+5,146),(cx-11,146),(cx-11,142)]))   # 鞋尖朝左
                    L("r", fs(cx, [(cx-11,145),(cx+5,145)]))
                    R("b", (cx+2, 141, cx+3, 142))
            back = lambda pts: [(46 + (x-46)*bk if x > 46 else x, y) for x, y in pts]   # 背部往回收
            z[0] = 35; P("k", back([(38,98),(60,98),(61,110),(37,110)]))
            z[0] = 40; P("t", back([(46,58),(49,58),(49,67),(58,70),(58,100),(38,100),(38,70),(46,67)]))   # 內搭（細脖子）
            z[0] = 50   # 外套：前襟在左、背在右
            P("j", back([(40,66),(62,64),(66,104),(52,104),(54,72),(44,70)]))
            L("G", back([(44,70),(52,104)]))
            P("J", back([(58,66),(62,64),(66,104),(60,104)]))
            z[0] = 60   # 近側手臂（插口袋，手肘微彎）
            P("j", [(44,64),(56,66),(54,92),(44,96),(40,82)])
            L("G", [(44,64),(40,82)]); P("J", [(52,68),(56,66),(54,92),(50,94)])
            L("b", [(42,92),(55,93)])                                        # 綁帶高度和正面對齊
            E("s", (45, 97, 49, 103) if rev >= 2 else (44, 96, 50, 104))      # 手的高度和正面對齊（rev 2：縮成和正面差不多大）
            z[0] = 70   # 臉（只露出左前方）
            P("s", [(28,26),(50,24),(52,48),(44,58),(34,60),(28,56),(25,47),(26,36)])   # 側臉：額頭內收、臉頰最突出、下巴往後收
            z[0] = 80   # 頭髮
            if sq:   # 方圓形的頭
                P("h", [(50 + (x-50)*hw, y) for x, y in [(25,12),(31,4),(69,4),(75,12),(77,30),(73,42),(27,42),(23,30)]])
            elif ts != "ellipse":   # 簡化的頭頂：不用正圓，避免側面像蛋頭
                shapes = {
                 "flat":  [(24,16),(28,8),(36,4.5),(64,4.5),(72,8),(77,16),(78,40),(24,40)],
                 "slope": [(24,16),(28,8),(36,4.5),(58,4.5),(68,9),(76,18),(80,34),(80,46),(24,40)],
                 "back":  [(24,16),(28,8),(36,4.5),(60,4.5),(68,9),(72,18),(72,46),(24,40)],   # 後腦直直往下接後髮
                 "puff":  [(24,18),(28,10),(36,7),(44,9),(50,6),(62,7),(71,11),(77,20),(78,40),(24,40)],
                }
                P("h", [(lambda X: 60 + (X - 60) * bhw if X > 60 else X)(50 + (x-50)*hw) if True else 0 for x, y in shapes[ts]] and
                  [((lambda X: 60 + (X - 60) * bhw if X > 60 else X)(50 + (x-50)*hw), y) for x, y in shapes[ts]])
            else:
                E("h", (50 - 26*hw, top if smooth else 4, 50 + 26*hw, 40))
            bt = max(14, top + 8) if smooth else 14
            P("h", [(25,bt),(50,bt-2),(50,28),(46,30),(44,34),(41,29),(38,35),(35,30),(32,36),(29,31),(26,34)])  # 瀏海
            LOCK = {   # 蓋住肩膀的側髮（在身體前面）
             1: [(48,22),(60,20),(61,60),(58,74),(56,88),(53,92),(51,84),(52,66),(50,40)],                     # 細長一束垂到胸前
             2: [(48,22),(61,20),(63,60),(61,76),(60,90),(57,86),(55,92),(53,84),(51,90),(50,70),(50,40)],     # 寬一點、髮尾分兩束
             3: [(48,22),(60,20),(60,58),(55,72),(49,84),(45,90),(46,80),(49,66),(50,40)],                     # 往前（左）搭在胸前
             4: [(48,22),(60,20),(62,60),(60,70),(57,74),(53,70),(51,58),(50,40)],                             # 短短的，剛好蓋住肩膀
             5: [(48,22),(60,20),(62,58),(63,72),(61,84),(58,80),(56,86),(54,76),(52,62),(50,40)],             # 從肩膀上方滑下，偏後
             # 以 1、2、3 為基礎的變體與合成
             11: [(48,22),(61,20),(62,60),(60,74),(57,90),(53,94),(51,84),(51,66),(50,40)],                    # 1 加寬
             12: [(48,22),(60,20),(61,60),(58,74),(55,86),(51,92),(47,93),(50,86),(52,72),(50,40)],            # 1＋髮尾往前勾
             13: [(48,22),(61,20),(63,60),(61,74),(59,82),(57,79),(55,84),(53,78),(51,82),(50,66),(50,40)],    # 2 短版
             14: [(48,22),(61,20),(62,58),(58,72),(53,84),(50,90),(49,84),(47,90),(46,82),(49,66),(50,40)],    # 2＋往前
             15: [(48,22),(60,20),(60,58),(55,70),(50,78),(47,82),(48,74),(49,62),(50,40)],                    # 3 短版
             16: [(48,22),(60,20),(60,58),(55,72),(50,84),(46,90),(47,82),(44,86),(46,76),(49,64),(50,40)],    # 3＋分岔
             17: [(48,22),(61,20),(62,60),(60,76),(58,92),(55,88),(53,94),(51,82),(51,64),(50,40)],            # 1＋2 中等寬度
             18: [[(48,22),(61,20),(62,60),(60,76),(58,90),(55,86),(53,84),(52,64),(50,40)],                  # 兩束：後面一束長的
                  [(48,24),(54,24),(55,58),(51,70),(46,80),(45,74),(48,62),(49,40)]],                         #       前面一束往前搭
            }
            if lock:   # 新的陰影：用色塊分層，不畫分隔線
                lk = LOCK[lock]
                for poly in (lk if isinstance(lk[0], list) else [lk]): P("h", poly)
            else:
                P("h", [(48,22),(60,20),(61,62),(55,70),(51,58),(50,40)])   # 耳前的側髮
            if ts != "ellipse":
                if ring and not lock: L("L", [(32,13),(40,10),(52,10)])      # 一小段亮面，不做完整光環
            elif smooth:   # 頭頂平滑：不畫零碎的陰影塊，光環改成沿頭形的一條平順弧線
                import math
                cx, cy, rx, ry = 50, (top + 40) / 2, 26*hw*0.78, (40 - top) / 2 * 0.62
                arc = [(cx + rx*math.cos(a), cy - 2 + ry*math.sin(a)) for a in [math.radians(d) for d in range(200, 300, 12)]]
                L("L", arc)
            else:
                if light == 0:
                    P("H", [(60,8),(72,12),(77,26),(76,40),(66,30)])
                else:
                    P("H", [(68,12),(74,18),(77,30),(74,34)])                         # 頭頂陰影縮小
                L("L", [(30,16),(36,12),(46,10)]); L("H", [(31,20),(37,16),(46,14)])
            if light >= 3: L("L", [(56,10),(64,12),(70,18)])                      # 第二段光環
            for x in (34, 40): L("H", [(x, 24), (x, 29)])
            if not fall: L("H", [(55,26),(56,58)])   # 這條縫在後髮版本會像馬尾的分界，拿掉
            z[0] = 90
            R("e", (33,39,38,40.5)); R("E", (33,40.5,38,45))                    # 側面的直眼（只有一隻）
            R("P", (30,49,36,50.5))
            by = 1.8 if ts != "ellipse" else ((top - 4) * 0.8 if smooth else 0)   # 蝴蝶結高度和正面對齊
            bw = lambda pts: [(44 + (x-44)*bow, 10 + by + (y-10)*bow) for x, y in pts]
            if fall: z[0] = 80                 # 蝴蝶結和頭髮同層，頭頂不會被壓出一圈陰影
            if rev < 2:   # rev 2 的蝴蝶結由 side() 依面向另外蓋上
                P("r", bw([(36,6),(44,10),(36,14)])); P("r", bw([(44,10),(52,5),(52,14)]))  # 蝴蝶結
                L("b", bw([(44,12),(42,22)]))
        if view == "back" and bfall:   # 背面：和正面同一套陰影（右側背光一大塊、往下漸暗、頭頂光環）
            hair = {CODES.index(c) for c in "hHLZ"}
            def shade_region_b(pts, code):
                m = Image.new("L", (Wpx, Hpx), 0); ImageDraw.Draw(m).polygon([warp(*p) for p in pts], fill=1)
                for yy in range(Hpx):
                    for xx in range(Wpx):
                        if m.getpixel((xx, yy)) and mat.getpixel((xx, yy)) in hair:
                            mat.putpixel((xx, yy), CODES.index(code))
            shade_region_b([(60,0),(100,0),(100,130),(64,130),(63,70),(61,40)], "H")           # 右側背光，邊界微斜
            shade_region_b([(0,84),(20,82),(36,86),(50,83),(64,86),(80,82),(100,84),(100,130),(0,130)], "H")   # 髮尾漸暗，上緣不規則
            shade_region_b([(30,13),(36,10.5),(46,9.5),(46,11),(36,12),(31,14.5)], "L")
            shade_region_b([(31,16),(37,13.5),(46,12.5),(46,14),(37,15),(32,17.5)], "H")
            shade_region_b([(53,9.5),(60,10),(66,12),(65,13.5),(60,11.5),(53,11)], "L")
        if view == "side" and lock and rev < 2:   # 和正面同一套陰影（rev 2 由 side() 在翻轉後另外加）：背光側一大塊陰影＋越往下越暗＋頭頂光環
            hair = {CODES.index(c) for c in "hHLZ"}
            def shade_region(pts, code):
                m = Image.new("L", (Wpx, Hpx), 0); ImageDraw.Draw(m).polygon([warp(*p) for p in pts], fill=1)
                for yy in range(Hpx):
                    for xx in range(Wpx):
                        if m.getpixel((xx, yy)) and mat.getpixel((xx, yy)) in hair:
                            mat.putpixel((xx, yy), CODES.index(code))
            shade_region([(64,4),(80,8),(90,30),(90,120),(66,120),(66,40)], "H")     # 背光側（後腦、後髮外側）
            shade_region([(0,82),(100,82),(100,130),(0,130)], "H")                   # 下半段漸暗（髮尾）
            shade_region([(30,13),(36,10.5),(48,9.5),(48,11),(36,12),(31,14.5)], "L")  # 光環
            shade_region([(31,16),(37,13.5),(48,12.5),(48,14),(37,15),(32,17.5)], "H") # 光環下緣
        rows = ["".join(CODES[mat.getpixel((x, y))] for x in range(Wpx)) for y in range(Hpx)]
        rows = cleanup(rows)
        depth = [[dep.getpixel((x, y)) for x in range(Wpx)] for y in range(Hpx)]
        if view == "side":   # 側臉逐格修正：圓弧輪廓、眼睛靠前、嘴巴落在輪廓上
            g = [list(r) for r in rows]
            dy = round(20 * (hb - 1))      # 頭放大時，臉的列數會往下移
            row20 = rows[20 + dy]; edge = next(i for i, c in enumerate(row20) if c != ".")
            sh = edge - 13                     # 變窄後臉的前緣會往右移，五官跟著移
            front = {y: v + sh for y, v in {16: 14, 17: 13, 18: 13, 19: 13, 20: 13, 21: 13, 22: 13, 23: 13, 24: 14, 25: 16}.items()}
            front = {y + dy: v for y, v in front.items()}   # 前緣平順，不做出鼻子的凸起
            for y, fx in front.items():
                for x in range(10 + sh, 21 + sh):
                    if x < fx: g[y][x] = "."
                    elif g[y][x] not in "hHL" or x < 16 + sh:
                        g[y][x] = "s"; depth[y][x] = 70
            for x in range(21 + sh, 25 + sh):  # 補上臉和頭髮之間的空洞
                for y in (23 + dy, 24 + dy):
                    if g[y][x] == ".": g[y][x] = "h"; depth[y][x] = 80
            for y in range(16 + dy, 26 + dy):            # 先清掉原本的五官
                for x in range(13 + sh, 25 + sh):
                    if g[y][x] in "eEPmS": g[y][x] = "s"
            def eye(x0):    # 和正面一樣大：3 格寬，上面兩列深色、下面兩列綠色
                for dx in range(3):
                    for y, c in ((17+dy,"e"), (18+dy,"e"), (19+dy,"E"), (20+dy,"E")): g[y][x0+dx] = c; depth[y][x0+dx] = 90
            def blush(x0):  # 和正面一樣：4×2
                for dx in range(4):
                    for y in (21+dy, 22+dy): g[y][x0+dx] = "P"; depth[y][x0+dx] = 90
            if face == "B":   # 3/4 側臉：兩隻眼睛都看得到
                for y in range(17 + dy, 24 + dy):
                    for x in range(13, 25):
                        if x >= front.get(y, 13) and g[y][x] in "hHL" and x < 24: g[y][x] = "s"; depth[y][x] = 70
                eye(14); eye(20); blush(13); blush(21)
                for x in (17, 18): g[22+dy][x] = "m"; depth[22+dy][x] = 90
            else:             # 側面：一隻眼睛，大小和正面相同
                eye(14 + sh); blush(16 + sh)                                       # 腮紅往後一點
                for x in (14 + sh, 15 + sh): g[22+dy][x] = "m"; depth[22+dy][x] = 90   # 嘴巴在腮紅前方，和正面同一列
            for x in range(10 + sh, 20 + sh):  # 下巴下方的零碎膚色
                if g[26+dy][x] == "s": g[26+dy][x] = "."
            if flat:   # 扁臉：和正面一樣，瀏海蓋到眼睛上緣、下巴提早收
                for x in range(len(g[0])):
                    if g[16+dy][x] == "s": g[16+dy][x] = "h"; depth[16+dy][x] = 80     # 額頭交給瀏海
                for x in range(len(g[0])):
                    if g[25+dy][x] == "s": g[25+dy][x] = "."      # 下巴下面不補成衣服，讓脖子保持細
                    if g[24+dy][x] == "s" and x < 14 + sh: g[24+dy][x] = "."    # Q 版平面設計：下巴不往回縮，只把角磨圓
                for x in (21 + sh, 22 + sh):     # 細細的脖子：只留兩格
                    g[25+dy][x] = "t"; depth[25+dy][x] = 40
            if rev >= 2:
                for x in range(19 + sh, 24 + sh):   # 下巴底部只留前端 4 格，後面改成垂在下巴後的頭髮（下顎線往後收）
                    if g[24+dy][x] == "s": g[24+dy][x] = "h"; depth[24+dy][x] = 80
                for x in (22 + sh, 23 + sh):
                    if g[23+dy][x] == "s": g[23+dy][x] = "h"; depth[23+dy][x] = 80
                # 露肩（和正面一致）：外套上緣往下一列，露出高領和一小截肩膀
                g[26+dy][20 + sh] = "t"; depth[26+dy][20 + sh] = 40
                for x in (21 + sh, 22 + sh):
                    g[26+dy][x] = "s"; depth[26+dy][x] = 45
            rows = ["".join(r) for r in g]
        return rows, depth
    return build

def draw(view, face="A", nar=1.0, hdx=0.0, hb=1.0, hw=1.0, hlf=1.0, sq=False, light=0, smooth=False, top=4, bow=1.0, ts="ellipse", ring=True, bk=1.0, bhw=1.0, flat=False, hx=1.0, straight=False, fall=0, lock=0, bfall=0, rev=1):
    if view == "front":
        return jp_big.draw(**FINAL)
    orig = jp_big.build
    jp_big.build = make_builder(view, face, nar, hdx, hb, hw, hlf, sq, light, smooth, top, bow, ts, ring, bk, bhw, flat, hx, straight, fall, lock, bfall, rev)
    try:
        return jp_big.draw(**FINAL)
    finally:
        jp_big.build = orig

if __name__ == "__main__":
    from pixelkit import sheet
    ims = []
    for v in ("front", "side", "back"):
        img = draw(v); img.save(f"view_{v}.png")
        i = img.resize((img.width*7, img.height*7), Image.NEAREST)
        bg = Image.new("RGBA", (i.width, i.height+22), "#eeeaf4"); bg.alpha_composite(i, (0,22))
        ImageDraw.Draw(bg).text((4,4), v, fill="#23263a"); ims.append(bg)
    sheet(ims, "three_views.png")

# ---- 側面 rev 2：左右各一張（蝴蝶結在角色右側，面向左時在另一側、面向右時在看得到的這一側）----
SIDE_FINAL = dict(nar=0.92, hdx=4.4, hb=1.0, hw=1.0, light=1, flat=True, bk=0.7, hx=1.13, ts="back", fall=2, lock=18)
SIDE_SHADE = [   # 和正面同一套陰影，畫面座標（光源固定在左上，所以翻轉後不跟著翻）
    ([(64,4),(80,8),(90,30),(90,120),(66,120),(66,40)], "H"),          # 右側背光
    ([(0,82),(100,82),(100,130),(0,130)], "H"),                        # 下半段漸暗
    ([(30,13),(36,10.5),(48,9.5),(48,11),(36,12),(31,14.5)], "L"),     # 光環
    ([(31,16),(37,13.5),(48,12.5),(48,14),(37,15),(32,17.5)], "H"),    # 光環下緣
]
# 蝴蝶結中間的結放在哪一格。面向左時在頭的另一側：左右翻過來、放在後腦上方，只露出往後突出的一個三角
# （放在頭頂正上方會露出兩個尖角，像貓耳朵）
BOW_KNOT = {"left": (32, 6), "right": (25, 5)}

def bow_template():
    """從正面圖取出蝴蝶結（兩個三角形＋結＋緞帶），座標以結為原點，三個視圖用同一個造型。"""
    import align_check as ac
    rows = ac.rows_of("front")
    kx, ky = next((x, y) for y in range(3, 12) for x in range(8, 20) if rows[y][x] == "b")
    return {(x - kx, y - ky): rows[y][x] for y in range(2, 12) for x in range(6, 20) if rows[y][x] in "rb"}

def side_rows(facing="left", legs="both"):
    _, warp = canvas(48, 0.86, 0.46, 0.1, 0.05, 1.0, 0.65, SIDE_FINAL["nar"], SIDE_FINAL["hdx"], SIDE_FINAL["hb"], SIDE_FINAL["hx"])
    rows, depth = make_builder("side", "A", rev=2, legs=legs, **SIDE_FINAL)()
    g = [list(r) for r in rows]; d = [list(r) for r in depth]
    H, W = len(g), len(g[0])
    if facing == "right":
        g = [r[::-1] for r in g]; d = [r[::-1] for r in d]
    hair = set("hHLZ")
    for pts, code in SIDE_SHADE:
        m = Image.new("L", (W, H), 0); ImageDraw.Draw(m).polygon([warp(*q) for q in pts], fill=1)
        for y in range(H):
            for x in range(W):
                if m.getpixel((x, y)) and g[y][x] in hair: g[y][x] = code
    kx, ky = BOW_KNOT[facing]
    if facing == "right":   # 臉不接受頭髮投影（翻轉後頭髮在臉的左上，會在臉頰投出一大塊暗色，像髒掉）
        for y in range(H):
            for x in range(W):
                if g[y][x] in "seEPm": d[y][x] = max(d[y][x], 85)
    for (dx, dy), c in bow_template().items():
        if facing == "left": dx = -dx
        X, Y = kx + dx, ky + dy
        if not (0 <= X < W and 0 <= Y < H): continue
        if facing == "left" and g[Y][X] != ".": continue   # 在頭的另一側：只看得到突出頭頂的部分
        g[Y][X] = c; d[Y][X] = 90 if facing == "right" else 5
    if facing == "right" and jp_big.HALFUP:   # 半綁髮：蝴蝶結在這一側，綁起來的那束垂在頭側（和正面同一組格子）；向左時在另一側被頭擋住
        for dx, dy, c in jp_big.HALFUPS[jp_big.HALFUP]:
            X, Y = kx + dx, ky + dy
            c = "H" if c == "L" else c   # 那束在頭髮內側：外側亮邊會變成一條白線，改成兩道陰影線夾出一束
            if 0 <= X < W and 0 <= Y < H and g[Y][X] in hair:
                g[Y][X] = c; d[Y][X] = 80 if c == "H" else 95
    return ["".join(r) for r in g], d

def side(facing="left"):
    rows, depth = side_rows(facing)
    orig = jp_big.build
    jp_big.build = lambda *a, **k: (rows, depth)
    try:
        im = jp_big.draw(**FINAL)
    finally:
        jp_big.build = orig
    if facing == "right":   # 臉直接用面向左那張左右翻轉：兩個方向是同一張臉（重新上明暗會在臉的前緣畫出一條深色外框）
        left = side("left")
        W = im.width
        for y in range(im.height):
            for x in range(W):
                if rows[y][x] in "seEPm": im.putpixel((x, y), left.getpixel((W - 1 - x, y)))
    return im
