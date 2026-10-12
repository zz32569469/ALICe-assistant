"""pixelkit: 調色盤 + 字元矩陣 -> PNG（原尺寸）與放大預覽圖。

用法：
    from pixelkit import Sprite
    s = Sprite.mirrored(half_rows, width)   # 左半邊自動鏡射
    s.set(x, y, 'k')                         # 單點覆寫
    s.save('name', PALETTE, scale=8)
"""
from PIL import Image

MIRROR = {}  # 需要左右互換的字元可放這裡，例如 {'<': '>'}


class Sprite:
    def __init__(self, rows):
        w = len(rows[0])
        for i, r in enumerate(rows):
            if len(r) != w:
                raise ValueError(f"第 {i} 列長度 {len(r)}，應為 {w}：{r!r}")
        self.rows = [list(r) for r in rows]
        self.w, self.h = w, len(rows)

    @classmethod
    def mirrored(cls, half_rows, width):
        rows = []
        half = width // 2
        for i, r in enumerate(half_rows):
            if len(r) != half:
                raise ValueError(f"半列 {i} 長度 {len(r)}，應為 {half}：{r!r}")
            right = "".join(MIRROR.get(c, c) for c in reversed(r))
            rows.append(r + right)
        return cls(rows)

    def set(self, x, y, c):
        self.rows[y][x] = c
        return self

    def paint(self, points, c):
        for x, y in points:
            self.rows[y][x] = c
        return self

    def text(self):
        return "\n".join("".join(r) for r in self.rows)

    def image(self, palette):
        img = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        px = img.load()
        for y, row in enumerate(self.rows):
            for x, c in enumerate(row):
                if c == ".":
                    continue
                if c not in palette:
                    raise KeyError(f"調色盤沒有字元 {c!r}（x={x}, y={y}）")
                hx = palette[c].lstrip("#")
                px[x, y] = tuple(int(hx[i:i + 2], 16) for i in (0, 2, 4)) + (255,)
        return img

    def save(self, name, palette, scale=8, bg="#e9e6f0"):
        img = self.image(palette)
        img.save(f"{name}.png")
        big = img.resize((self.w * scale, self.h * scale), Image.NEAREST)
        canvas = Image.new("RGBA", big.size, bg)
        canvas.alpha_composite(big)
        canvas.convert("RGB").save(f"{name}_x{scale}.png")
        with open(f"{name}.txt", "w", encoding="utf-8") as f:
            f.write(self.text())
        return canvas


def sheet(images, out, gap=24, bg="#e9e6f0"):
    """把多張預覽圖底部對齊排成一張。"""
    w = sum(i.width for i in images) + gap * (len(images) + 1)
    h = max(i.height for i in images) + gap * 2
    s = Image.new("RGB", (w, h), bg)
    x = gap
    for i in images:
        s.paste(i.convert("RGB"), (x, h - gap - i.height))
        x += i.width + gap
    s.save(out)
