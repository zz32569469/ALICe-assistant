import jp_big, views
SIDE = dict(nar=0.92, hdx=4.4, hb=1.0, hw=1.0, light=1, ts="slope", flat=True, bk=0.7, bhw=0.65)
def rows_of(view):
    if view == "front":
        kw = {k: v for k, v in views.FINAL.items() if k in ("persp","front","foot","body","neckk","legk","headk","hd","hs","hair2","clumps","tidy","polish")}
        return jp_big.build(**kw)[0]
    b = views.make_builder(view, "A", **(SIDE if view == "side" else {}))
    return b()[0]
def marks(rows):
    def first(ch, y0=0, y1=None):
        for y, r in enumerate(rows[:y1]):
            if y >= y0 and any(c in ch for c in r): return y
    def last(ch, y0=0):
        out = None
        for y, r in enumerate(rows):
            if y >= y0 and any(c in ch for c in r): out = y
        return out
    return dict(hair_top=first("hHL"), bow_top=first("r"), eye=first("e", 10), mouth=first("m"), blush=first("P"),
                band=first("b", 24), hand=first("s", 26), feet=last("w"))
if __name__ == "__main__":
    for v in ("front", "side", "back"):
        print(v, marks(rows_of(v)))
