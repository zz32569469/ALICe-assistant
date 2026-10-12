"""走路動畫（正面，朝畫面走過來）：沿用 idle.py 的做法——在材質圖上把部位分組移動，再重新上明暗。
和待機不同的地方：腳要動，所以地面陰影改成獨立的一層（固定不動），腳抬起時下面才看得到陰影。"""
from PIL import Image
import idle

HAIR = idle.HAIR
SHADOW = (23, 39, 7.5, 2.5)   # 地面陰影橢圓：中心 x、y，半寬、半高（和定稿的陰影位置一致）

def in_shadow(x, y):
    cx, cy, rx, ry = SHADOW
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0

def group(x, y, c):
    """走路的分組（左右以畫面為準）：頭、身體（含短褲）、左右手臂、左右髮尾、左右腿（襪子＋鞋）。"""
    if c == "V": return "shadow"
    if c in HAIR and y >= 26 and (x <= 17 or x >= 30): return "tipsL" if x < 24 else "tipsR"
    if y <= 25: return "head"
    if y >= 36: return "legL" if x <= 23 else "legR"
    if y >= 27 and x <= 16: return "armL"
    if y >= 27 and x >= 31: return "armR"
    return "body"

STRETCH = {"legL", "legR", "tipsL", "tipsR"}   # 這些部位和身體錯開時，中間的空隙用原本那一格補上（看起來被拉長）

def frame(offsets, shorts=True, hair_fill=True, drape=False):
    """offsets：{組名: (dx, dy)}。陰影先畫在最底層、固定不動；其他部位依深度蓋上去。
    shorts：短褲最下面一列（第 35 列）也可以被拉長補空隙——身體抬高、腳還踩在地上時，
    腿和身體之間才不會斷開一列（階段 1 沒有這條，保留原樣以便比較）。"""
    g, d = idle.base()
    H, W = len(g), len(g[0])
    out = [["."] * W for _ in range(H)]; dep = [[0] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            if in_shadow(x, y): out[y][x] = "V"; dep[y][x] = 1
    cells = [(d[y][x], x, y, g[y][x]) for y in range(H) for x in range(W) if g[y][x] not in ".V"]
    for z, x, y, c in sorted(cells):
        grp = group(x, y, c)
        if grp in ("armL", "armR") and y >= 33 and "hand" + grp[-1] in offsets:
            grp = "hand" + grp[-1]   # 有指定時，手掌和袖口（第 33 列以下）可以和手臂分開動
        dx, dy = offsets.get(grp, (0, 0))
        X, Y = x + dx, y + dy
        if 0 <= X < W and 0 <= Y < H and (out[Y][X] in ".V" or z >= dep[Y][X]):
            out[Y][X] = c; dep[Y][X] = z
    for y in range(1, H - 1):
        for x in range(W):
            stretch = group(x, y, g[y][x]) in STRETCH or (shorts and y == 35 and g[y][x] == "k") \
                      or (hair_fill and y == 25 and g[y][x] in HAIR)   # 頭往上、髮尾還在下面：頭髮最下面一列拉長
            if out[y][x] in ".V" and g[y][x] not in ".V" and stretch \
               and out[y-1][x] not in ".V" and out[y+1][x] not in ".V":
                out[y][x] = g[y][x]; dep[y][x] = d[y][x]
    if hair_fill:   # 手臂和兩側長髮交錯，錯開時中間露出的空洞，補成後面的暗色頭髮
        for y in range(1, H - 1):
            for x in range(1, W - 1):
                nb = [out[y-1][x], out[y+1][x], out[y][x-1], out[y][x+1]]
                enclosed = all(c not in ".V" for c in nb) and any(c in HAIR for c in nb)
                # 手往上擺時，手下面的髮梢不能浮在半空中：髮梢上方的空隙補成從手臂後面垂下來的頭髮
                hanging = out[y+1][x] in HAIR and out[y-1][x] not in ".V"
                # drape（階段 6 起）：手臂往下移時肩膀上方空出的格子，補成從肩上垂下來的頭髮
                draped = drape and out[y-1][x] in HAIR and out[y+1][x] not in ".V"
                if out[y][x] == "." and (enclosed or hanging or draped):
                    out[y][x] = "H"; dep[y][x] = 10
    return ["".join(r) for r in out], dep

def leg_gaps(rows):
    """腿和身體有沒有斷開：襪子（k）的正上方是空白的格子。"""
    return [(x, y) for y in range(30, len(rows)) for x in range(17, 31) if rows[y][x] == "k" and rows[y-1][x] == "."]

def check(frames, base_img, offsets=None):
    """走路版的自動檢查：輪廓內破洞、調色盤以外的顏色、腿和身體斷開（腳會動，不檢查腳是否固定）。"""
    pal = {p for p in base_img.getdata() if p[3]}
    W, H = base_img.size
    shadow = Image.new("RGBA", (1, 1), "#d2cde2").getpixel((0, 0))
    def seams(im):   # 夾縫：上下都有東西、自己卻是空白（橫向裂開）；下面是地面陰影的不算（那只是背景）
        px = im.load()
        return sum(1 for y in range(1, H-1) for x in range(W)
                   if not px[x, y][3] and px[x, y-1][3] and px[x, y+1][3] and px[x, y+1] != shadow)
    s0 = seams(base_img)
    out = []
    for i, im in enumerate(frames):
        gaps = len(leg_gaps(frame(offsets[i])[0])) if offsets else "未檢查"
        extra = seams(im) - s0
        px = im.load()
        holes = sum(1 for y in range(1, H-1) for x in range(1, W-1)
                    if not px[x, y][3] and px[x-1, y][3] and px[x+1, y][3] and px[x, y-1][3] and px[x, y+1][3])
        new = {p for p in im.getdata() if p[3]} - pal
        out.append(f"幀{i}: 破洞 {holes} 格、新顏色 {len(new)} 種、腿和身體斷開 {gaps} 格、夾縫比定稿多 {extra} 格")
    return out

def body(dy, **extra):
    """整個上半身（頭、身體、手臂、髮尾）一起移動 dy，再加上個別部位的位移。"""
    o = {k: (0, dy) for k in ("head", "body", "armL", "armR", "tipsL", "tipsR")}
    o.update(extra)
    return o

RIGID = {"legL", "legR"}   # 硬的部位：直接搬移定稿的像素，不重新上明暗（重新上明暗時鞋子會忽亮忽暗）

def render(offsets, **kw):
    """畫出一幀；RIGID 部位的每一格，只要搬過去後沒被別的部位蓋住，就換回定稿的顏色。"""
    rows, dep = frame(offsets, **kw)
    im = idle.render(rows, dep)
    ref = Image.open("final_front.png").convert("RGBA")
    g, _ = idle.base()
    for y in range(len(g)):
        for x in range(len(g[0])):
            c = g[y][x]
            if c in ".V" or group(x, y, c) not in RIGID: continue
            dx, dy = offsets.get(group(x, y, c), (0, 0))
            X, Y = x + dx, y + dy
            if 0 <= X < im.width and 0 <= Y < im.height and rows[Y][X] == c:
                im.putpixel((X, Y), ref.getpixel((x, y)))
    return im

# ---- 各階段 ----
def stage1():
    """6 幀：左右各一步，每步「經過 → 著地 → 下沉」；頭的起伏每步下 1、下 1、上 2（經過時最高）。
    著地時前腳往下 1 格、後腳抬高 1 格；經過時抬起的腳縮在身體下面。"""
    return [idle.render(*frame(o, shorts=False, hair_fill=False)) for o in STEPS], [130] * len(STEPS)

STEPS = [body(-1, legL=(0, -1)),                 # 左腳經過（抬起）
         body(0,  legL=(0, 1), legR=(0, -1)),    # 左腳著地（往前），右腳在後
         body(1,  legL=(0, 1)),                  # 下沉
         body(-1, legR=(0, -1)),                 # 右腳經過
         body(0,  legR=(0, 1), legL=(0, -1)),    # 右腳著地
         body(1,  legR=(0, 1))]                  # 下沉

BOB = [-1, 0, 1, -1, 0, 1]   # 每一幀身體的上下位移（經過時最高；每步下 1、下 1、上 2）

def steps3():
    """階段 3 的每一幀：
    手臂和腳反向擺：左腳往前（第 1、2 幀）時右手往前，右腳往前（第 4、5 幀）時左手往前；往前擺的手抬高 1 格。
    髮尾：身體往上彈（經過）時髮尾慢一步，取「這一幀和上一幀」比較低的位置，下一幀才跟上；
    但最多只比身體低 1 格（慢 2 格時兩側長髮整片往下掉，太誇張，還會和袖子錯開出破洞）。
    髮尾永遠不比身體高，手的下面就一直有頭髮墊著（避免手的下緣閃出暗紅邊）。"""
    legs = [dict(legL=(0, -1)), dict(legL=(0, 1), legR=(0, -1)), dict(legL=(0, 1)),
            dict(legR=(0, -1)), dict(legR=(0, 1), legL=(0, -1)), dict(legR=(0, 1))]
    swing = [{}, {"armR": -1}, {"armR": -1}, {}, {"armL": -1}, {"armL": -1}]
    out = []
    for i, b in enumerate(BOB):
        tips = min(max(b, BOB[i - 1]), b + 1)
        o = body(b, **legs[i])
        o.update(tipsL=(0, tips), tipsR=(0, tips))
        for arm, s in swing[i].items(): o[arm] = (0, b + s)
        out.append(o)
    return out

def stage3():
    """加手臂擺動與頭髮的慢半拍。"""
    seq = steps3()
    return [render(o) for o in seq], [130] * len(seq)

# 階段 4：使用者回饋「像在跳」。階段 1～3 的「下 1、下 1、上 2」其實是參考文章裡「跑步」的節奏，
# 加上頭佔全身 86%，整個上半身動 2 格就像在跳。走路改成：上半身幾乎不動，動作交給腳。
LIFT = 2   # 經過時抬起的腳抬高 2 格（階段 1～3 是 1 格），抬腳和前後腳的差別更清楚

def steps4(bob):
    """bob：每一幀上半身的上下位移。A 版只在下沉時往下 1 格；B 版完全不動。
    腳：經過時抬起 LIFT 格；著地時前腳往下 1 格、後腳抬高 1 格。手臂、髮尾的規則和階段 3 相同。"""
    legs = [dict(legL=(0, -LIFT)), dict(legL=(0, 1), legR=(0, -1)), dict(legL=(0, 1)),
            dict(legR=(0, -LIFT)), dict(legR=(0, 1), legL=(0, -1)), dict(legR=(0, 1))]
    swing = [{}, {"armR": -1}, {"armR": -1}, {}, {"armL": -1}, {"armL": -1}]
    out = []
    for i, b in enumerate(bob):
        tips = min(max(b, bob[i - 1]), b + 1)
        o = body(b, **legs[i])
        o.update(tipsL=(0, tips), tipsR=(0, tips))
        for arm, s in swing[i].items(): o[arm] = (0, b + s)
        out.append(o)
    return out

BOB_A = [0, 0, 1, 0, 0, 1]   # 只在著地後下沉 1 格
BOB_B = [0] * 6              # 上半身完全不上下動

def stage4(variant="A"):
    seq = steps4(BOB_A if variant == "A" else BOB_B)
    return [render(o) for o in seq], [130] * len(seq)

# 階段 5：使用者選 A 版，要求放慢，並且腳的上下幅度要小一點（腳很短，抬太高還是像在跳）。
# 做 3 種腳的幅度 × 3 種速度，排成表格比較。
AMP = {   # 經過時抬腳幾格、著地時前腳往下幾格、著地時後腳抬高幾格
    "大": (2, 1, 1),   # 階段 4 的幅度
    "中": (1, 1, 0),
    "小": (1, 0, 0),   # 只有經過時抬腳 1 格
}
SPEED = [160, 200, 240]   # 每幀幾毫秒（階段 4 是 130）

def steps5(amp):
    lift, fwd, back = AMP[amp]
    legs = [dict(legL=(0, -lift)), dict(legL=(0, fwd), legR=(0, -back)), dict(legL=(0, fwd)),
            dict(legR=(0, -lift)), dict(legR=(0, fwd), legL=(0, -back)), dict(legR=(0, fwd))]
    swing = [{}, {"armR": -1}, {"armR": -1}, {}, {"armL": -1}, {"armL": -1}]
    out = []
    for i, b in enumerate(BOB_A):
        tips = min(max(b, BOB_A[i - 1]), b + 1)
        o = body(b, **legs[i])
        o.update(tipsL=(0, tips), tipsR=(0, tips))
        for arm, s in swing[i].items(): o[arm] = (0, b + s)
        out.append(o)
    return out

def stage5(amp="中", ms=200):
    seq = steps5(amp)
    return [render(o) for o in seq], [ms] * len(seq)

# 階段 6：使用者選「中・0.20 秒」，再試手的些微擺動。
# 左腳往前（第 1、2 幀）時右手往前、左手往後；右腳往前（第 4、5 幀）時相反。
ARMS = {
    "甲": dict(fwd=-1, back=0, inward=0),   # 階段 3～5：往前擺的手臂往上 1 格
    "乙": dict(fwd=-1, back=1, inward=0),   # 往後擺的手臂再往下 1 格，一上一下
    "丙": dict(fwd=-1, back=1, inward=1),   # 乙＋往前擺的手往身體中間靠 1 格（正面看手往前時會往內收）
}

def steps6(arms):
    a = ARMS[arms]
    out = steps5("中")
    sides = [None, ("R", "L"), ("R", "L"), None, ("L", "R"), ("L", "R")]   # （往前擺的手, 往後擺的手）
    for i, o in enumerate(out):
        if not sides[i]: continue
        f, k = sides[i]
        b = BOB_A[i]
        o["arm" + f] = (0, b + a["fwd"]); o["arm" + k] = (0, b + a["back"])
        # 往後擺的手往下移時，同一側的髮尾跟著往下，手底下才一直有頭髮墊著（否則手的下緣閃出暗紅邊）
        o["tips" + k] = (0, max(o["tips" + k][1], b + a["back"]))
        if a["inward"]:   # 只移動手掌和袖口，往身體中間靠（畫面左邊的手往右、右邊的手往左）
            o["hand" + f] = (a["inward"] if f == "L" else -a["inward"], b + a["fwd"])
    return out

SPEED_RANGE = (160, 200)   # 使用者指定：每幀 0.16～0.20 秒之間調整
WALK_MS = 160              # 定案：0.16 秒最有連貫感

def stage6(arms="乙", ms=200):
    seq = steps6(arms)
    return [render(o, drape=True) for o in seq], [ms] * len(seq)

def final(ms=WALK_MS):
    """目前成品：階段 6 丙（中幅度、手的擺動丙），每幀預設 0.16 秒。"""
    return stage6("丙", ms)

def speed_page(frames_dir="walk_out/final", prefix="walk", out="walk_out/speed.html", scale=8):
    """可以拖滑桿調速度的預覽頁（每幀 0.16～0.20 秒）。各幀圖片內嵌，單一檔案即可開啟。"""
    import base64, pathlib, json
    frames = sorted(pathlib.Path(frames_dir).glob(f"{prefix}_f*.png"), key=lambda p: int(p.stem.split("_f")[1]))
    data = [ "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode() for p in frames ]
    lo, hi = SPEED_RANGE
    html = f"""<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>走路速度調整</title>
<style>
  :root {{ --bg:#f4f2f8; --card:#fff; --ink:#23263a; --sub:#5c5e7a; --line:#dcd8e6; --accent:#3a6ad0; }}
  body {{ margin:0; background:var(--bg); color:var(--ink); font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif; }}
  main {{ max-width:720px; margin:0 auto; padding:24px 16px 40px; }}
  h1 {{ font-size:24px; margin:0 0 4px; }} .sub {{ color:var(--sub); margin:0 0 20px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; }}
  canvas {{ display:block; margin:0 auto 16px; image-rendering:pixelated; background:#ebe8f2; border-radius:8px; max-width:100%; }}
  .val {{ font-size:28px; font-weight:bold; text-align:center; }} .cyc {{ text-align:center; color:var(--sub); margin-bottom:12px; }}
  input[type=range] {{ width:100%; accent-color:var(--accent); }}
  .ticks {{ display:flex; justify-content:space-between; color:var(--sub); font-size:13px; }}
  .btns {{ display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-top:14px; }}
  button {{ border:1px solid var(--line); background:#fff; border-radius:8px; padding:6px 12px; font-size:15px; cursor:pointer; }}
  button.on {{ background:var(--accent); color:#fff; border-color:var(--accent); }}
</style></head>
<body><main>
  <h1>走路速度調整</h1>
  <p class="sub">正面走路（目前成品），拖動滑桿或按下方按鈕調整每幀秒數（{lo/1000:.2f}～{hi/1000:.2f} 秒）。一個循環＝左右各一步＝{len(data)} 幀。</p>
  <div class="card">
    <canvas id="c" width="{48*scale}" height="{43*scale}"></canvas>
    <div class="val"><span id="v"></span> 秒／幀</div>
    <div class="cyc">一個循環 <span id="cy"></span> 秒（每秒約 <span id="fps"></span> 幀）</div>
    <input id="s" type="range" min="{lo}" max="{hi}" step="5" value="{WALK_MS}">
    <div class="ticks"><span>{lo/1000:.2f}（較快）</span><span>{hi/1000:.2f}（較慢）</span></div>
    <div class="btns" id="b"></div>
  </div>
</main>
<script>
const SRC = {json.dumps(data)}, N = SRC.length, LO = {lo}, HI = {hi};
const c = document.getElementById("c"), g = c.getContext("2d"); g.imageSmoothingEnabled = false;
const s = document.getElementById("s"), b = document.getElementById("b");
const imgs = SRC.map(u => {{ const i = new Image(); i.src = u; return i; }});
let ms = {WALK_MS};
try {{ const saved = parseInt(localStorage.getItem("walk_ms")); if (saved >= LO && saved <= HI) ms = saved; }} catch (e) {{}}
function show() {{
  s.value = ms;
  document.getElementById("v").textContent = (ms / 1000).toFixed(3).replace(/0$/, "");
  document.getElementById("cy").textContent = (ms * N / 1000).toFixed(2);
  document.getElementById("fps").textContent = (1000 / ms).toFixed(1);
  [...b.children].forEach(x => x.classList.toggle("on", +x.dataset.ms === ms));
  try {{ localStorage.setItem("walk_ms", ms); }} catch (e) {{}}
}}
for (let v = LO; v <= HI; v += 10) {{
  const x = document.createElement("button"); x.textContent = (v / 1000).toFixed(2); x.dataset.ms = v;
  x.onclick = () => {{ ms = v; show(); }}; b.appendChild(x);
}}
s.oninput = () => {{ ms = +s.value; show(); }};
let f = 0, last = 0;
function tick(t) {{
  if (t - last >= ms) {{ last = t; g.clearRect(0, 0, c.width, c.height); g.drawImage(imgs[f], 0, 0, c.width, c.height); f = (f + 1) % N; }}
  requestAnimationFrame(tick);
}}
show(); requestAnimationFrame(tick);
</script></body></html>"""
    pathlib.Path(out).write_text(html, encoding="utf-8")

def stage2():
    """修掉階段 1 的兩個瑕疵（動作不變）：鞋子忽亮忽暗 → 腿和鞋直接搬移定稿的像素；
    身體抬高時踩地的腿和身體斷開一列 → 短褲最下面一列也可以拉長補上。"""
    return [render(o) for o in STEPS], [130] * len(STEPS)
