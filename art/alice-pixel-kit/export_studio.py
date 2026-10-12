"""匯出給 ALICE Web Studio 用的素材包（studio_export/）：sprite sheet、manifest.json、頭像、調色盤、文件副本。
只讀已定案的成品，不改設計；每一幀都先和存檔的成品逐像素比對，不同就停下來（避免匯出和定稿不一致）。"""
import json, shutil, pathlib
from PIL import Image
import idle, walk, walk_side, walk_back, idle_dirs, sleep, sit34, jp_big, shade

OUT = pathlib.Path("studio_export")
W, H = 48, 43
DIRS = ["down", "left", "right", "up"]          # down＝正面（面向畫面）、up＝背面
SHADOW = (0xd2, 0xcd, 0xe2)                       # 地面陰影（不透明，配合淺色背景 #ebe8f2 設計）

def same(frames, saved):
    for i, im in enumerate(frames):
        ref = Image.open(saved.format(i)).convert("RGBA")
        assert im.convert("RGBA").tobytes() == ref.tobytes(), f"和存檔的成品不同：{saved.format(i)}"

def animations():
    fr, du = idle.final();               same(fr, "idle_out/final/idle_f{}.png");         idle_d = {"down": (fr, du)}
    for v, d in (("left", "left"), ("right", "right"), ("back", "up")):
        f, t = idle_dirs.final(v);       same(f, f"idle_dirs_out/final/{v}_f{{}}.png");   idle_d[d] = (f, t)
    walk_d = {}
    f, t = walk.final();                 same(f, "walk_out/final/walk_f{}.png");          walk_d["down"] = (f, t)
    for v in ("left", "right"):
        f, t = walk_side.final(v);       same(f, f"walk_side_out/final/{v}_f{{}}.png");   walk_d[v] = (f, t)
    f, t = walk_back.final();            same(f, "walk_back_out/final/walk_f{}.png");     walk_d["up"] = (f, t)
    sleep_d, fx_d = {}, {}
    for v, d in (("down", "down"), ("left", "left"), ("right", "right"), ("back", "up")):
        f, fx, t = sleep.final(v);       same(f, f"sleep_out/final/{v}_f{{}}.png");       sleep_d[d] = (f, t); fx_d[d] = (fx, t)
    f, t = sit34.final();                same(f, "sit_out/final/type34_f{}.png")
    f2, t2 = sit34.final_drink();        same(f2, "sit_out/final/drink_f{}.png")
    return {"idle": idle_d, "walk": walk_d, "sleep": sleep_d, "sleep_fx": fx_d, "typing": {"front_right": (f, t)}, "drink": {"front_right": (f2, t2)}}

def no_shadow(im):
    im = im.convert("RGBA").copy(); px = im.load()
    for y in range(H):
        for x in range(W):
            if px[x, y][3] and px[x, y][:3] == SHADOW: px[x, y] = (0, 0, 0, 0)
    return im

def sheet(rows, strip=False):
    cols = max(len(f) for f, _ in rows)
    out = Image.new("RGBA", (cols * W, len(rows) * H), (0, 0, 0, 0))
    for r, (frames, _) in enumerate(rows):
        for c, im in enumerate(frames):
            out.paste(no_shadow(im) if strip else im.convert("RGBA"), (c * W, r * H))
    return out

def main():
    OUT.mkdir(exist_ok=True)
    anims = animations()
    for name in ("idle", "walk", "sleep", "sleep_fx"):
        for d in DIRS: assert len(anims[name][d][0]) == len(anims[name]["down"][0])
        assert all(anims[name][d][1] == anims[name]["down"][1] for d in DIRS), "四個方向的節奏應該相同"
    manifest = {
        "name": "alice_pixel",
        "frame_width": W, "frame_height": H, "scale": 1,
        "rendering": "放大時用 nearest-neighbor（CSS image-rendering: pixelated），不要平滑",
        "directions": DIRS,
        "direction_notes": {"down": "正面（面向畫面）", "left": "側面，臉朝畫面左", "right": "側面，臉朝畫面右", "up": "背面（背對畫面）"},
        "layout": "每個動作一張 sheet；一列是一個方向（順序同 directions），一欄是一幀，從左上角 (0,0) 開始每格 48×43",
        "anchor": {"x": 24, "y": 41,
                   "note": "站立基準點：畫布水平中央、鞋底（第 40 列）正下方的那條線。把這一點對到地面就好；四個方向、每一幀都用同一個基準點，"
                           "動畫裡腳的起落已經畫在格子裡（走路時著地的腳可能往下到第 41 列），播放時不要再另外移動圖片。"},
        "ground_shadow": {"included_in": "<動作>.png", "color": "#d2cde2", "opaque": True,
                          "no_shadow_variant": "<動作>_noshadow.png（只把陰影色改成透明，其他像素相同）",
                          "note": "陰影是不透明的淡紫色，配合淺色背景 #ebe8f2 設計；深色背景建議用 _noshadow 版，自己畫半透明橢圓（約 x 16–31、y 37–41）"},
        "animations": {},
        "avatar": {},
    }
    for name, desc in (("idle", "待機：呼吸（一次約 2.9 秒）＋每兩次呼吸眨一次眼；背面看不到臉，眨眼那幾幀只是停住"),
                       ("walk", "走路：6 幀、左右各一步；上半身穩、晃動小"),
                       ("sleep", "睡覺（站著睡）：閉眼、低頭（只在臉上表現：瀏海蓋下來、眼睛和嘴巴往下）、呼吸比待機慢；"
                                 "一輪內越睡越低，最後頭慢慢浮回，不驚醒（一輪約 8.6 秒）")):
        rows = [anims[name][d] for d in DIRS]
        sheet(rows).save(OUT / f"{name}.png")
        sheet(rows, strip=True).save(OUT / f"{name}_noshadow.png")
        du = anims[name]["down"][1]
        a = {"file": f"{name}.png", "file_noshadow": f"{name}_noshadow.png", "description": desc,
             "rows": {d: i for i, d in enumerate(DIRS)}, "frames": len(du), "loop": True,
             "durations_ms": du, "total_ms": sum(du)}
        if name == "idle":
            a["frame_notes"] = {"0": "站好（最高點）", "4": "最低點", "10": "閉眼（正面、側面）"}
        elif name == "sleep":
            fx = [anims["sleep_fx"][d] for d in DIRS]
            sheet(fx).save(OUT / "sleep_fx.png")
            a["overlay"] = {"file": "sleep_fx.png", "description": "zzz 特效（蝴蝶結緞帶的藍色）：z 從頭旁邊冒出、越飄越大後消失",
                            "note": "和 sleep.png 同樣排法、同樣的幀數與時間，一格對一格畫在角色上面；z 不會蓋到角色，可以不用（Studio 自己畫 z 也行）。"
                                    "z 的位置：正面右上、側面在臉那一側、背面左上（避開蝴蝶結）"}
            a["note"] = "停很久的姿勢被切成不超過 250 毫秒的小格（姿勢相同），讓 z 每一小格都能往上飄；只播角色時也照 durations_ms 播即可"
        else:
            a["ms_per_frame"] = du[0]; a["ms_range"] = [walk.SPEED_RANGE[0], walk.SPEED_RANGE[1]]
            a["frame_notes"] = {"0": "一腳經過（抬起）", "1": "著地", "2": "下沉", "3": "另一腳經過", "4": "著地", "5": "下沉"}
        manifest["animations"][name] = a
    # 打字：一個場景（桌子、椅子、筆電），只有 45 度斜前方一個角度，所以只有一列
    f, du = anims["typing"]["front_right"]
    sheet([(f, du)]).save(OUT / "typing.png")
    sheet([(f, du)], strip=True).save(OUT / "typing_noshadow.png")
    manifest["animations"]["typing"] = {
        "file": "typing.png", "file_noshadow": "typing_noshadow.png",
        "description": "坐在桌前用筆電打字（45 度斜前方，臉朝畫面右）：手上下敲、偶爾移到鍵盤另一邊，停下來時眨眼",
        "rows": {"front_right": 0}, "frames": len(du), "loop": True, "durations_ms": du, "total_ms": sum(du),
        "note": "這是一個場景（含桌子、白色椅背、筆電），不是四方向動作：只有 front_right 一列。"
                "桌板下緣在第 40 列，基準點和其他動作相同；角色比站姿靠右、畫面左右都有家具，播放時不要再另外移動或翻轉（翻轉會讓光源和蝴蝶結跑到另一邊）。",
        "frame_notes": {"0": "手放在鍵盤上", "10": "停下來看螢幕", "11": "眨眼"}}
    f, du = anims["drink"]["front_right"]
    sheet([(f, du)]).save(OUT / "drink.png")
    sheet([(f, du)], strip=True).save(OUT / "drink_noshadow.png")
    manifest["animations"]["drink"] = {
        "file": "drink.png", "file_noshadow": "drink_noshadow.png",
        "description": "喝一口咖啡（打字場景，45 度斜前方）：手從鍵盤伸到桌上的馬克杯、舉到嘴前、閉眼喝一口、放回去",
        "rows": {"front_right": 0}, "frames": len(du), "loop": False, "durations_ms": du, "total_ms": sum(du),
        "note": "和 typing 同一個場景，播一次就回到 typing。第一格和最後一格就是 typing 的第 0 格：在 typing 播到第 0 格時切過來、播完再接回 typing 第 0 格，畫面不會跳。",
        "frame_notes": {"1": "手伸到杯子", "3": "拿到胸前", "4": "杯子到嘴前", "5": "閉眼喝一口", "9": "放回桌上"}}
    manifest["directions_note"] = "待機、走路、睡覺有四個方向；打字（typing）和喝咖啡（drink）只有 front_right 一個角度"
    # 頭像：從正面待機第一格裁切（不放大）
    first = anims["idle"]["down"][0][0].convert("RGBA")
    for size, box, note in ((32, (7, 1), "頭部＋肩膀（整個頭和蝴蝶結都在框內）"), (24, (11, 7), "臉部特寫（瀏海、眼睛、腮紅、嘴巴）")):
        x, y = box
        first.crop((x, y, x + size, y + size)).save(OUT / f"avatar_{size}.png")
        manifest["avatar"][f"avatar_{size}"] = {"file": f"avatar_{size}.png", "source": "idle.png 的 down 第 0 格",
                                                "crop": {"x": x, "y": y, "w": size, "h": size}, "note": note}
    # 調色盤：所有 sheet 實際用到的顏色＋各材質的色階（暗 → 亮）
    used = set()
    for name in ("idle", "walk", "sleep", "sleep_fx", "typing", "drink"):
        used |= {c[:3] for _, c in Image.open(OUT / f"{name}.png").convert("RGBA").getcolors(1 << 16) if c[3]}
    hexes = sorted(("#%02x%02x%02x" % c for c in used), key=lambda h: sum(int(h[i:i+2], 16) for i in (1, 3, 5)))
    palette = {"used_colors": hexes, "count": len(hexes),
               "ramps": {**jp_big.HUE}, "fixed": dict(shade.FIXED), "ground_shadow": "#d2cde2",
               "ramp_names": {"h": "頭髮", "s": "皮膚", "j": "外套（炭灰）", "t": "內搭（高領）", "k": "短褲／襪子",
                              "w": "鞋子（白）", "b": "藍色緞帶／袖口綁帶", "a": "椅子（白色辦公椅，打字場景）", "d": "桌子（木頭，打字場景）", "c": "筆電（銀色，打字場景）", "u": "馬克杯（白，打字場景）", "f": "咖啡", "x": "熱氣", "e": "眼線", "E": "瞳孔（深綠）", "m": "嘴巴"},
               "note": "used_colors 是圖裡實際出現的全部顏色（含外框等規則算出來的顏色）；ramps 是各材質的基礎色階"}
    (OUT / "palette.json").write_text(json.dumps(palette, ensure_ascii=False, indent=2), encoding="utf-8")
    manifest["palette"] = "palette.json"
    manifest["docs"] = ["README.md", "STYLE_RULES.md", "alice_three_view_spec.md"]
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    for f in manifest["docs"]: shutil.copy(f, OUT / f)

if __name__ == "__main__":
    main()
