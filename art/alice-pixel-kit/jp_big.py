"""大尺寸日系艾莉絲（48×72）：分層繪製，前面的層會在後面的層投下陰影。"""
from PIL import Image, ImageDraw
import shade
from calib2 import cleanup  # 先載入，避免它順帶載入的調色盤蓋掉這裡的設定

shade.RAMPS.clear(); shade.RAMPS.update({     # 外框、深影、陰影、底色、亮面
 "h": ["#4c5680", "#7884b0", "#a3aed2", "#cdd6ee", "#eef2fb"],
 "s": ["#a8686a", "#e8a898", "#f6c8b6", "#ffe2d4", "#fff2ea"],
 "j": ["#1c1f30", "#343a58", "#4c5478", "#68719a", "#8b94bb"],
 "t": ["#0e0f18", "#171826", "#222436", "#30334a"],
 "k": ["#12131f", "#1f2133", "#2e3148", "#40445f"],
 "b": ["#1a3f8a", "#2f63c0", "#4a8ff0", "#88bcff"],
 "w": ["#6a7088", "#a9b0c6", "#d8dcea", "#f6f7fb"],
 "r": ["#12131f", "#22243a", "#3a3e5c", "#595f86"],
 "n": ["#4a4e60", "#8a8fa3", "#c4c8d4"],
})
shade.FIXED.clear(); shade.FIXED.update({"e": "#241f38", "E": "#1f705a", "Q": "#9be3c6", "W": "#ffffff", "P": "#ffb3b0", "m": "#d86a74", "V": "#d2cde2"})
shade.CASTERS = set(); shade.LIGHTEN = {"L": "h", "G": "j", "Y": "k", "Z": "h"}; shade.LIGHTEN_AMT = {"Z": 0.8}; shade.LEVELS_PER = {}
CODES = ".hsjtkbwrnHJTKSLeEQWPmGYVZ"

# 正面鞋子的形狀（畫面左腳的設計座標，右腳鏡射）。襪子約 x 39～46。
# 微內八畫不出來：往內加寬到 x 50 以下時，縮小後和 straight 完全一樣；到 51 兩隻鞋會黏成一塊。
SHOES = {
    "out":      [(37,135),(46,135),(47,140),(47,146),(34,146),(34,142),(36,139)],   # 初版：圓頭朝外，看起來像外八
    "straight": [(38,135),(46,135),(47.5,139),(47.5,146),(37.5,146),(37.5,139)],    # 左右對稱、置中在腿下，腳尖朝前（定案）
}
SHOE = "straight"

def build(Wpx=48, Hpx=72, clumps=False, tidy=False, polish=False, hair2=False, hs="A", persp=0.0, turn=0.0, body=1.0, foot=1.0, headk=1.0, eyes=0, front=False, neckk=None, legk=None, facek=1.0, hairw=1.0, hd=None):
    sx, sy = Wpx/100, 72/150
    HD = dict(chin=0, bangs="zig", eye="lash", ew=4.5, eh=8.5, sp=11.5, brow=False, mouth="dot", blush="dot")
    if hd: HD.update(hd)
    MODE = {"face": False, "hair": False}
    NECK = 62
    SHIFT = NECK * (1 - headk)          # 頭縮小後，整體往上移，避免頭頂留白
    nk = body if neckk is None else neckk
    lg = body if legk is None else legk
    def below(d):   # 脖子 6、軀幹 40、腿 26、鞋 16（設計座標）
        segs = [(6, nk), (40, body), (26, lg), (16, max(body, 0.8))]
        out = 0
        for length, f in segs:
            take = min(max(d, 0), length); out += take * f; d -= length
        return out
    if body != 1.0 or headk != 1.0:   # 身體縮短或頭縮小時畫布跟著變矮
        Hpx = int(round((NECK * headk + below(88)) * sy)) + 2
    def warp(x, y):
        """俯視透視：上寬下窄、下半身略壓縮；turn 讓頭和上身往左轉一點"""
        if MODE["face"]: x, y = 50 + (x - 50) * facek, 45 + (y - 45) * facek     # 臉與五官的大小
        if MODE["hair"]: x = 50 + (x - 50) * hairw                               # 頭髮的厚度（左右寬度）
        x = 50 + (x - 50) * headk                           # 寬度整體跟著頭一起縮，避免頭小、頭髮和身體還很寬
        if y > NECK: y = NECK + below(y - NECK)             # 脖子、軀幹、腿、鞋分段壓縮
        else: y = NECK - (NECK - y) * headk                 # 頭部以脖子為中心縮放
        y -= SHIFT
        t = y / 150
        k = 1 + persp * (0.10 - 0.28 * t)
        a = turn * 0.2 * (1 - t)                     # 轉身：遠側（右）壓窄、近側（左）稍微放寬
        side = (1 - a) if x > 50 else (1 + a * 0.35)
        X = 50 + (x - 50) * k * side - turn * 5 * (1 - t) ** 2
        Y = y * (1 - persp * 0.08 * t) + persp * 4
        return X * sx, Y * sy
    def box(b):
        (x0, y0), (x1, y1) = warp(b[0], b[1]), warp(b[2], b[3])
        return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
    mat = Image.new("L", (Wpx, Hpx), 0); dep = Image.new("L", (Wpx, Hpx), 0)
    dm, dd = ImageDraw.Draw(mat), ImageDraw.Draw(dep)
    z = [0]
    def P(m, pts):
        p = [warp(x, y) for x,y in pts]; dm.polygon(p, fill=CODES.index(m)); dd.polygon(p, fill=z[0])
    def E(m, b):
        bb = box(b); dm.ellipse(bb, fill=CODES.index(m)); dd.ellipse(bb, fill=z[0])
    def R(m, b):
        bb = box(b); dm.rectangle(bb, fill=CODES.index(m)); dd.rectangle(bb, fill=z[0])
    def L(m, pts):
        p = [warp(x, y) for x,y in pts]; dm.line(p, fill=CODES.index(m)); dd.line(p, fill=z[0])
    mirror = lambda pts: [(100-x, y) for x,y in pts]

    if persp > 0:
        z[0] = 1
        E("V", (30 + 6*(1-foot), 140, 70 - 6*(1-foot), 150))                                   # 腳下的地面陰影
    z[0] = 10   # 後髮
    MODE["hair"] = True
    if hs == "F":   # 波浪長髮
        P("h", [(24,20),(76,20),(82,50),(78,62),(84,74),(80,86),(86,98),(80,104),(76,112),(72,102),(66,108),(64,98),(36,98),(34,108),(28,102),(24,112),(20,104),(14,98),(20,86),(16,74),(22,62),(18,50)])
    else:
        if front:
            P("h", [(26,20),(74,20),(77,60),(78,104),(74,100),(72,110),(68,101),(64,98),(36,98),(32,101),(28,110),(26,100),(22,104),(23,60)])
        else:
            P("h", [(24,20),(76,20),(82,60),(84,104),(79,100),(77,110),(72,101),(68,108),(64,98),(36,98),(32,108),(28,101),(23,110),(21,100),(16,104),(18,60)])
    if "A" in hs or "F" in hs:
        P("H", [(73,56),(80,60),(83,100),(79,99),(77,108),(72,100),(74,78)])
        L("L", [(18,64),(19,88)])
    if "B" in hs:   # 賽璐璐：背光側一大塊硬邊陰影
        P("H", [(66,40),(80,56),(84,104),(79,100),(77,110),(72,101),(68,108),(64,98),(70,70)])
    if "C" in hs:   # 細絲：亮暗交錯的細束
        for i, x in enumerate(range(18, 84, 4)):
            if 31 < x < 69: continue
            L("H", [(x, 58 + (i % 3) * 6), (x + 0.5, 100 - (i % 2) * 8)])
    if "D" in hs:   # 漸層：越往下越暗
        P("H", [(16,84),(84,84),(86,104),(79,100),(77,110),(72,101),(68,108),(64,98),(36,98),(32,108),(28,101),(23,110),(21,100),(14,104)])
    if "E" in hs:   # 線稿：用暗線勾出每一大束的輪廓
        for f in (lambda p: p, mirror):
            L("H", f([(20,62),(22,80),(24,100)])); L("H", f([(26,70),(27,92),(29,104)]))
    MODE["hair"] = False
    z[0] = 20   # 腿與鞋
    for f in (lambda p: p, mirror):
        P("s", f([(38,108),(47,108),(47,116),(38,116)]))
        P("k", f([(38,116),(47,116),(46,138),(39,138)]))
        if polish:
            L("Y", f([(38,117),(47,117)]))                            # 襪口
            fs = lambda pts: [(41 + (x-41)*foot, 146 - (146-y)*foot) for x, y in pts]
            shoe = SHOES[SHOE]
            P("w", f(fs(shoe)))                                       # 圓頭運動鞋
            xs = [x for x, _ in shoe]
            L("r", f(fs([(min(xs),145),(max(xs),145)])))              # 鞋底
            if foot >= 0.8: L("r", f(fs([(39,138),(44,138)])))        # 鞋帶（鞋太小就省略）
        else:
            P("w", f([(35,136),(47,136),(47,146),(33,146),(33,141)]))
            L("r", f([(33,145),(47,145)]))
    if polish:   # 受光側（左）的襪子亮線、膝蓋反光、鞋側藍標
        L("Y", [(39.5,119),(40,134)]); L("Y", [(53.5,119),(54,134)])
        bx = 41 + (35.5-41)*foot
        if foot >= 0.8:   # 鞋子縮小後藍標只會變成雜點，就不畫
            R("b", (bx-0.5,142,bx+0.5,143)); R("b", (100-bx-0.5,142,100-bx+0.5,143))
    z[0] = 30   # 肩膀皮膚
    P("s", [(31,66),(69,66),(70,74),(30,74)])
    z[0] = 35   # 短褲
    P("k", [(37,98),(63,98),(64,110),(51,110),(50,106),(49,110),(36,110)])
    for f in (lambda p: p, mirror): L("k", f([(42,104),(42,116)]))      # 吊帶
    z[0] = 40   # 高領內搭
    P("t", [(46,58),(54,58),(54,67),(62,70),(61,100),(39,100),(38,70),(46,67)])   # 細脖子（高領只留窄窄一截）
    L("T", [(50,70),(50,98)])
    z[0] = 50   # 外套前片（敞開）
    for f in (lambda p: p, mirror):
        P("j", f([(30,70),(40,72),(43,94),(42,104),(28,104),(25,88)]))
        L("J", f([(34,78),(31,100)]))
        L("G", f([(40,72),(43,94),(42,104)]))                 # 前襟亮邊
    z[0] = 60   # 袖子與手
    for f in (lambda p: p, mirror):
        P("j", f([(27,66),(36,70),(31,96),(21,98),(19,84)]))
        L("J", f([(29,74),(23,90)]))
        L("G", f([(27,66),(19,84)]))                           # 袖子受光邊
        L("b", f([(21,92),(32,93)])); L("b", f([(22,94),(32,95)]))
        xs = [p[0] for p in f([(20,96),(29,105)])]; E("s", (min(xs), 96, max(xs), 105))
    L("b", [(22,96),(19,106)])                                              # 左袖垂下的綁帶
    if polish:
        P("G", [(27,67),(30,68),(23,86),(21,92),(19,86)])                # 左袖外側受光面
        P("G", [(64,70),(67,69),(70,80),(68,82)])                        # 右袖靠身體側的受光面
        P("J", [(33,72),(36,71),(31,95),(28,96)])                        # 左袖內側陰影
        P("J", [(77,82),(81,84),(79,97),(75,96)])                        # 右袖外側陰影
        P("J", [(58,76),(61,74),(62,100),(58,102)])                      # 右前襟陰影
        for f in (lambda p: p, mirror):
            L("J", f([(21,97),(31,97)]))                                 # 袖口
            L("b", f([(21,92),(32,93)])); L("b", f([(22,94),(32,95)]))   # 藍色綁帶畫回最上層
    z[0] = 70   # 臉
    MODE["face"] = True
    if turn > 0:
        P("s", [(28,28),(69,28),(68,46),(60,57),(47,62),(35,57),(28,46)])
    else:
        c = HD["chin"]
        P("s", [(29,28),(71,28),(71,46-2*c),(63,57-4*c),(50,62-6*c),(37,57-4*c),(29,46-2*c)])
    if tidy:   # 刻意畫的臉部形狀陰影：右下顎一塊乾淨的陰影，取代演算法算出的零碎陰影
        c = HD["chin"]
        P("S", [(64,46-2*c),(71,46-2*c),(63,57-4*c),(52,62-6*c),(56,57-4*c)])
    MODE["face"] = False
    z[0] = 80   # 頭髮（頭頂、瀏海、鬢髮），會在臉和外套上投影
    MODE["hair"] = True
    E("h", (23,4,77,40))
    pts = [(22,14),(78,14),(78,30)]
    bs = HD["bangs"]
    for i in range(10, -1, -1):
        x = 26 + 48*i/10
        if bs == "blunt":   y = 35 + (1 if i % 3 == 0 else 0)                 # 齊瀏海
        elif bs == "part":  y = 27 + 10 * abs(i - 5) / 5 + (0 if i % 2 else 1) # 中分
        elif bs == "side":  y = 35 - 7 * i / 10 + (0 if i % 2 else 2)          # 斜瀏海（不蓋住眼睛）
        elif bs == "short": y = 27 if i % 2 else 32                            # 短瀏海
        else:               y = 30 if i % 2 else 38                            # 鋸齒（原本）
        pts.append((x, y))
    pts.append((22,30)); P("h", pts)
    if hair2 and hs != "A":
        for f in (lambda p: p, mirror):
            if "F" in hs:
                P("h", f([(22,26),(31,30),(33,62),(29,72),(32,82),(26,90),(24,76),(20,64),(20,46)]))
            else:
                P("h", f([(25,26),(31,30),(32,62),(30,80),(27,86),(24,70),(23,46)] if front else [(22,26),(31,30),(33,62),(31,82),(26,88),(22,70),(20,46)]))
        if HD["bangs"] in ("zig", "short"):
            for i in (1, 3, 5, 7, 9):
                x = 26 + 48*i/10; L("H", [(x, 25), (x, 30 if HD["bangs"] == "zig" else 26)])
        elif HD["bangs"] == "part":
            L("H", [(50, 12), (50, 27)])
        if "B" in hs:
            P("H", [(58,9),(72,12),(78,26),(78,34),(70,30),(64,22)])               # 頭的背光面
            P("H", [(66,30),(71,32),(70,62),(66,66)])
            if "D" not in hs:   # 和漸層一起用時，只留 D 的細光環，避免兩種光環疊成一團白塊
                P("L", [(28,15),(36,11),(46,10),(44,13),(40,12),(37,15),(33,14),(31,17)])  # 鋸齒光環
                P("L", [(54,10),(64,11),(70,14),(66,15),(63,13),(59,16),(56,13)])
        if "C" in hs:
            L("L", [(24,36),(25,62)]); L("H", [(28,40),(29,74)])
            L("H", [(70,36),(71,66)]); L("H", [(74,44),(75,76)])
            L("L", [(30,16),(36,13),(44,11)]); L("L", [(53,11),(60,12),(66,14)])
        if "D" in hs:
            L("L", [(30,16),(36,13),(44,11)]); L("L", [(53,11),(60,12),(66,14)])     # 頭頂光環
            for f in (lambda p: p, mirror): P("H", f([(21,64),(32,62),(31,82),(26,88),(22,70)]))
        if "E" in hs:
            L("H", [(30,14),(40,9),(50,8),(60,9),(70,14)])                           # 頭頂髮流
            for f in (lambda p: p, mirror):
                L("H", f([(26,18),(24,30),(25,40)])); L("H", f([(36,12),(34,22)]))
                L("H", f([(28,34),(29,60),(27,80)]))
        if "A" in hs and len(hs) > 1:
            P("H", [(68,32),(71,32),(70,62),(67,66)])
            L("H", [(29,46),(30,72)]); L("H", [(73,40),(74,74)])
        if "F" in hs or ("A" in hs and len(hs) > 1):
            P("H", [(64,8),(72,12),(77,26),(76,34),(71,26)])
            L("L", [(30,16),(36,13),(44,11)]); L("L", [(53,11),(60,12),(66,14)])
            L("H", [(31,20),(37,17),(45,15)]); L("H", [(53,15),(60,16),(65,18)])
            P("L", [(23,31),(25.5,31),(26,50),(23.5,54)])
    elif hair2:
        # 頭髮重畫：當成幾條大絲帶來畫，每束一個色調，只在束與束之間留暗縫
        for f in (lambda p: p, mirror):
            P("h", f([(22,26),(31,30),(33,62),(31,82),(26,88),(22,70),(20,46)]))
        P("L", [(23,31),(25.5,31),(26,50),(23.5,54)])                    # 左鬢髮受光（細、只在上半段）
        P("H", [(64,8),(72,12),(77,26),(76,34),(71,26)])                  # 頭的右後方陰影，做出頭形體積
        P("H", [(68,32),(71,32),(70,62),(67,66)])                       # 右鬢髮內側陰影
        L("H", [(29,46),(30,72)]); L("H", [(73,40),(74,74)])             # 鬢髮裡各一條長髮縫（左右位置不同）
        L("L", [(30,16),(36,13),(44,11)]); L("L", [(53,11),(60,12),(66,14)])   # 光環：沿頭形的兩段弧
        L("H", [(31,20),(37,17),(45,15)]); L("H", [(53,15),(60,16),(65,18)])   # 光環下緣的暗線，讓光環浮出來
        for i in (1, 3, 5, 7, 9):                                          # 瀏海分束：只從尖端之間往上
            x = 26 + 48*i/10
            L("H", [(x, 25), (x, 30)])
    else:
        for f in (lambda p: p, mirror):
            P("h", f([(22,26),(31,30),(33,62),(31,82),(26,88),(22,70),(20,46)]))
            L("H", f([(27,36),(27,78)]))
        if clumps:   # 頭髮分成幾束：弧形光環、束與束之間的暗縫、鬢髮亮面
            P("L", [(30,15),(40,11),(60,10),(70,13),(68,17),(58,14),(42,15),(32,19)])
            for x in (33, 41, 49, 57, 65): L("H", [(x, 24), (x+0.5, 31)])
            L("L", [(25,36),(26,66)]); L("H", [(29,40),(30,80)])
            if polish:
                L("H", [(18,64),(19,98)]); L("H", [(22,84),(23,104)])
                L("H", [(82,72),(81,94)]); L("H", [(78,60),(77,86)])
                L("L", [(17,72),(17,90)]); L("L", [(74,40),(75,52)])
            else:
                for f in (lambda p: p, mirror): L("H", f([(18,70),(20,100)]))
        else:
            L("L", [(34,12),(66,10)]); L("L", [(30,15),(70,13)])                     # 天使光環
        for x in (36, 46, 56, 64): L("H", [(x-0.5, 19), (x-2, 24)])   # 髮縫不切過光環
    MODE["hair"] = False
    z[0] = 90   # 五官與配件
    MODE["face"] = True
    eyes_mode = eyes
    if hd:
        ew, eh, y0 = HD["ew"], HD["eh"], 38
        for cx in (50 - HD["sp"], 50 + HD["sp"]):
            st = HD["eye"]
            if st == "lash":
                R("e", (cx-ew, y0, cx+ew, y0+1.5)); R("E", (cx-ew+1, y0+1.5, cx+ew-1, y0+eh)); R("W", (cx, y0+2.5, cx+1, y0+3.5))
            elif st == "round":
                R("E", (cx-ew+1, y0, cx+ew-1, y0+eh)); R("e", (cx-ew+1.5, y0, cx+ew-1.5, y0+1.5)); R("W", (cx, y0+1.5, cx+1, y0+2.5))
            elif st == "dot":
                R("e", (cx-1.2, y0+1, cx+1.2, y0+eh-1)); R("E", (cx-1.2, y0+eh*0.55, cx+1.2, y0+eh-1))
            elif st.startswith("v") and y0 == 38:
                y0 = 39.5                                                     # 直眼往下移，避免頂端壓到瀏海
            if st == "vdark":   # 直的細眼：全深色
                R("e", (cx-1.1, y0, cx+1.1, y0+eh))
            elif st == "vwide2":  # 直的雙格眼，不加亮點
                R("E", (cx-2.2, y0, cx+2.2, y0+eh)); R("e", (cx-2.2, y0, cx+2.2, y0+1.6))
            elif st == "vgreen":  # 直的細眼：上深下綠
                R("e", (cx-1.1, y0, cx+1.1, y0+eh)); R("E", (cx-1.1, y0+eh*0.62, cx+1.1, y0+eh))
            elif st == "vwide":   # 直的雙格眼：上緣深色、綠瞳、一格亮點
                R("E", (cx-2.2, y0, cx+2.2, y0+eh)); R("e", (cx-2.2, y0, cx+2.2, y0+1.6)); R("W", (cx-2.2, y0+2.2, cx-0.2, y0+3.8))
            elif st == "line":
                R("e", (cx-ew, y0+2, cx+ew, y0+3.5)); R("E", (cx-ew+1.5, y0+3.5, cx+ew-1.5, y0+5.5))
            elif st == "oval":
                R("E", (cx-ew+1.5, y0+1, cx+ew-1.5, y0+eh)); R("e", (cx-ew+2, y0, cx+ew-2, y0+1.5)); R("Q", (cx-ew+1.5, y0+eh-1.5, cx+ew-1.5, y0+eh))
            if HD["brow"]: R("e", (cx-ew+1.5, y0-2.6, cx+ew-1.5, y0-2.6))   # 細眉，一格高
        bl = HD["blush"]
        if bl == "dot":  R("P", (31,50,33,50.8)); R("P", (67,50,69,50.8))
        if bl == "wide": R("P", (30,49,36,50.5)); R("P", (64,49,70,50.5))
        mo = HD["mouth"]; my = 53 - 3*HD["chin"]
        if mo == "dot":  R("m", (49,my,51,my))
        if mo == "line": R("m", (47.5,my,52.5,my))
        if mo == "open": R("m", (48.5,my-0.5,51.5,my+1.5))
        eyes = []
    else:
        eyes = [(36.5, 1.0), (58.5, 0.75)] if turn > 0 else [(38.5, 1.0), (61.5, 1.0)]
    for cx, w in eyes:
        if eyes_mode == 0:
            R("e", (cx-5.5*w, 37, cx+5.5*w, 38.5)); R("E", (cx-4*w, 39.5, cx+4*w, 47)); R("Q", (cx-4*w, 45, cx+4*w, 47))
            R("W", (cx-1, 39.5, cx+1.5, 41.5))
        elif eyes_mode == 1:   # 微簡化：睫毛收短、亮點縮成 1 格
            R("e", (cx-4.5*w, 37, cx+4.5*w, 38.5)); R("E", (cx-3.5*w, 38.5, cx+3.5*w, 47)); R("Q", (cx-3.5*w, 45.5, cx+3.5*w, 47))
            R("W", (cx, 40, cx+1, 41))
        else:                  # 再簡化：拿掉下緣淺色，只剩睫毛、瞳孔、1 格亮點
            R("e", (cx-4.5*w, 37, cx+4.5*w, 38.5)); R("E", (cx-3.5*w, 38.5, cx+3.5*w, 46))
            R("W", (cx, 40, cx+1, 41))
    if hd: pass
    elif turn > 0:
        R("P", (29,49,33,50)); R("P", (62,49,65,50)); R("m", (46,53,48,53))
    else:
        R("P", (31,49,35,50)); R("P", (65,49,69,50)); R("m", (49,53,51,53))
    MODE["face"] = False
    if front:   # 簡化的蝴蝶結：兩個小三角＋一條藍緞帶
        P("r", [(20,7),(28,10),(20,14)]); P("r", [(28,10),(36,6),(36,14)])
        L("b", [(28,12),(27,22)])
    else:
        P("r", [(14,4),(26,9),(15,15)]); P("r", [(26,9),(37,3),(37,15)]); E("r", (23,6,29,12))
        L("b", [(25,12),(22,26)]); L("b", [(28,12),(29,24)])
    if XCLIP: L("r", [(64,18),(70,24)]); L("r", [(70,18),(64,24)])   # X 髮夾（人設已拿掉；縮小後本來就被清理掉，看不到）
    rows = ["".join(CODES[mat.getpixel((x,y))] for x in range(Wpx)) for y in range(Hpx)]
    if front:
        g = [list(r) for r in rows]
        for y in range(Hpx):
            for x in range(Wpx // 2, Wpx):
                if g[y][x] in "eEQWP": g[y][x] = "s"
            for x in range(Wpx // 2):
                if g[y][x] in "eEQWP": g[y][Wpx - 1 - x] = g[y][x]
        rows = ["".join(r) for r in g]
    if tidy:
        from calib2 import cleanup
        rows = cleanup(rows)
    depth = [[dep.getpixel((x,y)) for x in range(Wpx)] for y in range(Hpx)]
    if front and HALFUP:   # 半綁髮：蝴蝶結（角色右側）綁起一束頭髮；清理之後才畫，保留刻意的形狀
        g = [list(r) for r in rows]
        kx, ky = next((x, y) for y in range(3, 12) for x in range(6, 22) if g[y][x] == "b")   # 蝴蝶結中間的結
        for dx, dy, c in HALFUPS[HALFUP]:
            X, Y = kx + dx, ky + dy
            if 0 <= X < Wpx and 0 <= Y < Hpx and (c != "H" or g[Y][X] in "hHL"):
                g[Y][X] = c; depth[Y][X] = 80 if c == "H" else 95   # 綁起來的那束在蝴蝶結前面，不吃蝴蝶結的投影（會暗成一團）
        rows = ["".join(r) for r in g]
    if front:   # 脖子對齊高領中間：縮小後脖子（2 格）落在高領（4 格）的右半邊，比臉和高領的中線偏右 1 格，
                # 推 45 度時被誤導成「脖子在嘴巴正下方」（使用者 2026-10-07 指出、10-14 要求改正）
        g = [list(r) for r in rows]
        top = next((y for y in range(Hpx) if "t" in rows[y]), None)
        if top:
            ts = [x for x in range(Wpx) if g[top][x] == "t"]
            neck = [x for x in range(min(ts), max(ts) + 1) if g[top - 1][x] in "sS"]
            if neck and len(neck) < len(ts):
                x0 = round((min(ts) + max(ts) + 1) / 2 - len(neck) / 2)
                old = [(g[top - 1][x], depth[top - 1][x]) for x in neck]
                for x in neck: g[top - 1][x] = "h"; depth[top - 1][x] = depth[top - 1][min(ts) - 1]
                for i, (c, z) in enumerate(old): g[top - 1][x0 + i] = c; depth[top - 1][x0 + i] = z
        rows = ["".join(r) for r in g]
    return rows, depth

XCLIP = False
# 半綁髮的格子（以蝴蝶結的結為原點，畫面座標）。H＝陰影線（只畫在頭髮上），h＝頭髮，L＝亮邊
def _lock(length):
    """從蝴蝶結左下垂下的一束：2 格寬、外側一條亮邊，末端收成 1 格尖端。"""
    cells = []
    for dy in range(2, 2 + length):
        cells += [(-5, dy, "L"), (-4, dy, "h")]
    return cells + [(-4, 2 + length, "h")]
_split = lambda length: [(-3, y, "H") for y in range(3, 3 + length)]   # 那一束和頭部頭髮之間的陰影
HALFUPS = {
    "A1": _lock(6) + _split(6),                                                    # 外側一束，垂到眼睛上方
    "A2": [(0, y, "H") for y in range(3, 9)] + [(-2, y, "h") for y in range(3, 7)] + [(-3, y, "H") for y in range(3, 7)],   # 內側一束：只用陰影線勾出
    "A3": _lock(3) + _split(3) + [(2, 2, "H"), (3, 3, "H"), (4, 4, "H")],         # 短束＋往蝴蝶結收攏的髮絲線
}
HALFUP = "A1"   # 定案：外側一束（人設「自然半綁髮」）

HUE = {   # 色相偏移：暗部往藍紫、亮部往暖白
 "h": ["#40427a", "#727ab0", "#9ea8d4", "#cbd4ee", "#f8f5ee"],
 "s": ["#9a6070", "#e2a4a0", "#f5c4b2", "#ffe2d2", "#fff5ea"],
 "j": ["#1a1a1c", "#2e2e33", "#45454c", "#5f5f68", "#8a8a93"],   # 炭灰外套（J2）；舊值偏藍 #161731…#8d93b8
 "t": ["#0c0c1c", "#171932", "#24284a", "#353b62"],
 "k": ["#0c0c1c", "#1c1e3a", "#2b2f55", "#3d4270"],
 "w": ["#5c5e8a", "#9ea4c8", "#d4d8ec", "#fbf8f1"],
 "b": ["#1b2f7a", "#2b5bc8", "#4a8ff0", "#a0ccff"],
}
BASE = {k: list(v) for k, v in shade.RAMPS.items()}
def draw(Wpx=48, Hpx=72, cast=2, use_depth=True, hue=False, selout=False, clumps=False, rim=False, soft_face=False, despeckle=0, tidy=False, skin3=False, polish=False, hair2=False, hs="A", persp=0.0, turn=0.0, body=1.0, foot=1.0, headk=1.0, eyes=0, front=False, neckk=None, legk=None, facek=1.0, hairw=1.0, hd=None):
    shade.SOFT_CAST = {"s"} if soft_face else set()
    shade.FORM_SOLID = ({"s"} if soft_face else set()) | ({"j", "t", "k", "w"} if polish else set()) | ({"h"} if hair2 else set())
    if "B" in hs: shade.LEVELS_PER["h"] = 3
    shade.RAMPS.clear(); shade.RAMPS.update({k: list(v) for k, v in BASE.items()})
    if hue: shade.RAMPS.update(HUE)
    shade.LEVELS_PER = {"s": 3} if skin3 else {}
    rows, depth = build(Wpx, Hpx, clumps=clumps, tidy=tidy, polish=polish, hair2=hair2, hs=hs, persp=persp, turn=turn, body=body, foot=foot, headk=headk, eyes=eyes, front=front, neckk=neckk, legk=legk, facek=facek, hairw=hairw, hd=hd)
    return shade.render(rows, strands=False, depth=depth if use_depth else None, cast=cast,
                        selout=selout, rim=("h", "j") if rim else (), despeckle=despeckle)

if __name__ == "__main__":
    from pixelkit import sheet
    from PIL import ImageDraw
    steps = [("1 cast shadow", dict()),
             ("2 + hue shift", dict(hue=True)),
             ("3 + selective outline", dict(hue=True, selout=True)),
             ("4 + hair clumps", dict(hue=True, selout=True, clumps=True)),
             ("5 + rim light", dict(hue=True, selout=True, clumps=True, rim=True)),
             ("6 + soft face shadow", dict(hue=True, selout=True, clumps=True, rim=True, soft_face=True))]
    ims = []
    for label, kw in steps:
        img = draw(**kw); img.save(f"tech_{label[0]}.png")
        big = img.resize((img.width*6, img.height*6), Image.NEAREST)
        c = Image.new("RGBA", (big.width, big.height+22), "#eeeaf4"); c.alpha_composite(big, (0,22))
        ImageDraw.Draw(c).text((4,4), label, fill="#23263a"); ims.append(c)
    sheet(ims[:3], "tech_a.png"); sheet(ims[3:], "tech_b.png")
    a, b = Image.open("tech_a.png"), Image.open("tech_b.png")
    o = Image.new("RGB", (max(a.width, b.width), a.height+b.height), "#e9e6f0"); o.paste(a, (0,0)); o.paste(b, (0,a.height)); o.save("tech_steps.png")
