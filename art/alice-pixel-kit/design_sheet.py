"""艾莉絲三視圖設計稿：三視圖＋對齊線＋調色盤＋規格。"""
from PIL import Image, ImageDraw, ImageFont
import jp_big, shade
FONTS = [("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 3),   # Linux：Noto Sans CJK 繁中
         ("C:/Windows/Fonts/NotoSansTC-VF.ttf", 0),                      # Windows：同系列字型（可變字重）
         ("C:/Windows/Fonts/msjh.ttc", 0)]                                # Windows：微軟正黑體
def font(size):
    for path, idx in FONTS:
        try: f = ImageFont.truetype(path, size, index=idx)
        except OSError: continue
        try: f.set_variation_by_name("Regular")
        except Exception: pass
        return f
    raise OSError("找不到中文字型，請在 FONTS 加上本機字型路徑")
f_title = font(30); f_h = font(20); f_s = font(15)
views = [("正面", "final_front.png"), ("側面（向左）", "final_side.png"), ("側面（向右）", "final_side_right.png"), ("背面", "final_back.png")]
N = len(views)
S, gap = 7, 28
vw, vh = 48*S, 43*S
W = gap + N*(vw + gap) + 360
H = 90 + vh + 70 + 330
c = Image.new("RGB", (W, H), "#f4f2f8"); d = ImageDraw.Draw(c)
d.text((gap, 22), "艾莉絲 Alice・Q 版像素設計稿", font=f_title, fill="#23263a")
d.text((gap, 60), "48×43 px・約 2 頭身・俯視比例・光源左上", font=f_s, fill="#5c5e7a")
top = 100
guides = [(3, "#e05a5a", "頭頂／蝴蝶結"), (17, "#3a8a6a", "眼睛"), (22, "#c0605e", "嘴巴"), (32, "#3a6ad0", "袖子綁帶"), (40, "#555555", "鞋底")]
for i, (name, f) in enumerate(views):
    x = gap + i*(vw + gap)
    im = Image.open(f).convert("RGBA").resize((vw, vh), Image.NEAREST)
    bg = Image.new("RGBA", (vw, vh), "#ebe8f2"); bg.alpha_composite(im); c.paste(bg.convert("RGB"), (x, top))
    d.text((x + vw//2 - 20, top + vh + 8), name, font=f_h, fill="#23263a")
    o = Image.open(f).convert("RGBA"); c.paste(Image.alpha_composite(Image.new("RGBA", o.size, "#ebe8f2"), o).convert("RGB"), (x + vw - 52, top + vh + 8))
for row, col, label in guides:
    y = top + row*S
    for xx in range(gap - 6, gap + N*(vw + gap) - gap + 6, 6): d.line([(xx, y), (xx + 3, y)], fill=col)
    d.text((gap + N*(vw + gap) - gap + 10, y - 9), f"{label}（第 {row} 列）", font=f_s, fill=col)
# 調色盤
py = top + vh + 70
d.text((gap, py), "調色盤（由暗到亮：外框・深影・陰影・底色・亮面）", font=f_h, fill="#23263a")
names = [("h", "頭髮（銀青）"), ("s", "皮膚"), ("j", "外套"), ("t", "高領內搭"), ("k", "短褲／過膝襪"), ("b", "藍色點綴"), ("w", "鞋子"), ("r", "蝴蝶結")]
ramps = dict(jp_big.BASE); ramps.update(jp_big.HUE)
for n, (key, label) in enumerate(names):
    yy = py + 36 + n*34
    d.text((gap, yy + 4), label, font=f_s, fill="#23263a")
    for k, hexc in enumerate(ramps[key]):
        d.rectangle((gap + 140 + k*58, yy, gap + 140 + k*58 + 52, yy + 26), fill=hexc)
        d.text((gap + 140 + k*58 + 2, yy + 27 - 2), "", font=f_s)
    d.text((gap + 140 + 5*58 + 8, yy + 4), "  ".join(ramps[key]), font=f_s, fill="#5c5e7a")
fx = gap + 140 + 5*58 + 8 + 470
d.text((fx, py), "五官固定色", font=f_h, fill="#23263a")
fixed = [(n, shade.FIXED[k]) for n, k in (("眼線", "e"), ("瞳孔", "E"), ("腮紅", "P"), ("嘴巴", "m"), ("地面陰影", "V"))]   # 直接讀程式裡的顏色
for n, (label, hexc) in enumerate(fixed):
    yy = py + 36 + n*34
    d.rectangle((fx, yy, fx + 52, yy + 26), fill=hexc); d.text((fx + 62, yy + 4), f"{label}  {hexc}", font=f_s, fill="#23263a")
c.save("alice_design_sheet.png")
print(c.size)
