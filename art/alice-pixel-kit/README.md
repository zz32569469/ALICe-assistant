# 艾莉絲像素工具包

需要 Python 3 與 Pillow（`python -m pip install pillow`）。指令都在本資料夾執行；Windows 用 `python -X utf8`，macOS／Linux 用 `python3`。

## 檔案
| 檔案 | 內容 |
|---|---|
| final_front／side／side_right／back.png | 定稿（48×43）：正面、側面向左、側面向右、背面 |
| alice_design_sheet.png | 設計稿（四個視圖、對齊線、調色盤） |
| idle_out/final/、walk_out/final/ | 待機、走路（正面）目前成品：各幀 PNG、放大 GIF、並排圖 |
| idle_out/index.html、walk_out/index.html | 各階段比較頁 |
| walk_out/speed.html | 走路速度調整頁（0.16～0.20 秒） |
| walk_side_out/final/ | 側面走路成品：left_*（向左）、right_*（向右） |
| walk_side_out/index.html | 側面走路各階段比較頁 |
| walk_back_out/final/ | 背面走路成品 |
| idle_dirs_out/final/ | 側面（left_*、right_*）、背面（back_*）待機成品；正面在 idle_out/final/ |
| idle_dirs_out/index.html | 四方向待機比較頁 |
| sleep_out/final/ | 睡覺（站著睡）成品：down／left／right／back 各 51 幀角色圖＋疊上 zzz 的預覽 GIF（淺色、深色背景） |
| sleep_out/index.html | 睡覺動作的 zzz 特效比較頁（page_candidates_src.html 是動作候選頁的原稿） |
| sit_out/final/ | 打字（45 度坐在桌前，桌上有咖啡杯）20 幀、喝咖啡 11 幀＋預覽 GIF（淺色、深色背景） |
| sit_out/index.html | 打字、喝咖啡比較頁（45 度與第一版側面） |
| studio_export/ | 給 ALICE Web Studio 的匯出包：sprite sheet、manifest.json、頭像、調色盤、文件副本 |
| finals_v1/ | 舊定稿（鞋子外八、側面只有一張的版本） |
| finals_v2/ | 舊定稿（沒有半綁髮、亮綠眼、藍色外套的版本） |
| finals_v3/ | 舊背面定稿（頭髮上亮下暗、上下兩層的版本） |
| alice_three_view_spec.md、STYLE_RULES.md | 外觀規格、畫法規則 |

## 重新產生
```
python -X utf8 -c "import views, back_from_front as bf; views.draw('front').save('front.png'); bf.draw('AC').save('back.png')"
python -X utf8 -c "import views; views.side('left').save('side.png'); views.side('right').save('side_right.png')"
python -X utf8 design_sheet.py
python -X utf8 -c "import idle; fr, du = idle.final(); idle.save(fr, du, 'idle_out/final/idle')"
python -X utf8 -c "import idle, walk; fr, du = walk.final(); idle.save(fr, du, 'walk_out/final/walk'); walk.speed_page()"
python -X utf8 -c "import idle, walk_side as ws; [idle.save(*ws.final(f), f'walk_side_out/final/{f}') for f in ('left', 'right')]"
python -X utf8 -c "import idle, walk_back as wb; idle.save(*wb.final(), 'walk_back_out/final/walk')"
python -X utf8 -c "import idle, idle_dirs as I; [idle.save(*I.final(v), f'idle_dirs_out/final/{v}') for v in ('left', 'right', 'back')]"
python -X utf8 -c "import sleep; [sleep.save_final(v) for v in ('down', 'left', 'right', 'back')]"
python -X utf8 -c "import idle, sit34; idle.save(*sit34.final(), 'sit_out/final/type34'); idle.save(*sit34.final_drink(), 'sit_out/final/drink')"
python -X utf8 export_studio.py
python -X utf8 -c "import idle; idle.build_page(); idle.build_page('sleep_out/page_src.html', 'sleep_out/index.html'); idle.build_page('sit_out/page_src.html', 'sit_out/index.html'); idle.build_page('idle_dirs_out/page_src.html', 'idle_dirs_out/index.html'); idle.build_page('walk_out/page_src.html', 'walk_out/index.html'); idle.build_page('walk_side_out/page_src.html', 'walk_side_out/index.html')"
```
- 視圖輸出成 front／back／side／side_right.png，和定稿完全相同；不會覆蓋定稿
- export_studio.py 會先確認每一幀和存檔的成品逐像素相同才匯出；改了成品要先重新產生成品再匯出
- 走路速度：`walk.final(ms=180)`（每幀毫秒）
- 比較頁原稿是 page_src.html，`build_page()` 把圖片內嵌成單一檔案
- idle_out/stageN、walk_out/stageN 是各階段當時的輸出（舊鞋）；現在重跑會得到新鞋的版本
- 設計稿字型依序找 Noto Sans CJK（Linux）→ Noto Sans TC → 微軟正黑體，都沒有時在 design_sheet.py 的 `FONTS` 加路徑
