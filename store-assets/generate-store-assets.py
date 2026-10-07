#!/usr/bin/env python3
"""Generate Chrome Web Store graphic assets for the Bolt Chrome Extension.

Brand (see scripts/build-browser-extension-brand-assets.mjs): a lightning-bolt
drawn as an OUTLINE in Bolt brand blue (#4d7cff) on a WHITE background. No
gradient, no filled square. Dark text (#111), muted subtext (#666).

Run:  python3 store-assets/generate-store-assets.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))

# --- Brand tokens ---
BLUE = (77, 124, 255)     # #4d7cff — Bolt brand blue (resting bolt outline)
WHITE = (255, 255, 255)
TEXT = (17, 17, 17)       # #111
MUTED = (102, 102, 102)   # #666
CHIP_BG = (240, 242, 246)
CHIP_BORDER = (223, 226, 233)
CHIP_TEXT = (60, 60, 66)

# Exact brand bolt path (24x24 viewBox) — bbox x:3..18 (15), y:2..22 (20).
BOLT_PTS = [(13, 2), (3, 14), (10, 14), (8, 22), (18, 10), (11, 10), (13, 2)]
VB_W, VB_H = 15, 20

def draw_bolt(height, color=BLUE):
    """Return an RGBA image of the blue bolt outline (transparent bg)."""
    scale = height / VB_H
    stroke = max(3, round(2 * scale))   # matches svg stroke-width=2
    pad = stroke
    w = round(VB_W * scale) + pad * 2
    h = round(VB_H * scale) + pad * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    sp = [((x - 3) * scale + pad, (y - 2) * scale + pad) for x, y in BOLT_PTS]
    d.line(sp, fill=color, width=stroke, joint="curve")
    r = stroke / 2                      # round caps/joins
    for x, y in sp:
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)
    return img

# --- Fonts ---
BOLD = ["/System/Library/Fonts/SFNSDisplay.ttf", "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc"]
REG = ["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf",
       "/Library/Fonts/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"]

def font(size, bold=False):
    for p in (BOLD if bold else REG):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def tw(d, s, f):
    bb = d.textbbox((0, 0), s, font=f)
    return bb[2] - bb[0]

def fit_font(d, s, max_w, start, bold=True, floor=24):
    size = start
    while size > floor and tw(d, s, font(size, bold)) > max_w:
        size -= 2
    return font(size, bold)

def wrap(d, s, f, max_w):
    words, lines, cur = s.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if tw(d, t, f) <= max_w:
            cur = t
        else:
            lines.append(cur); cur = w
    if cur:
        lines.append(cur)
    return lines

# ============================================================
# 1) STORE ICON — 128x128 (white bg, blue bolt outline)
# ============================================================
icon = Image.new("RGB", (128, 128), WHITE)
b = draw_bolt(84)
icon.paste(b, ((128 - b.width) // 2, (128 - b.height) // 2), b)
icon.save(os.path.join(OUT, "store-icon-128.png"))
print("store-icon-128.png")

# ============================================================
# 2) MARQUEE PROMO TILE — 1400x560 (white bg, blue bolt, dark text)
# ============================================================
W, H = 1400, 560
m = Image.new("RGB", (W, H), WHITE)
d = ImageDraw.Draw(m)
bolt = draw_bolt(300)
bx, RIGHT_PAD = 150, 120
m.paste(bolt, (bx, (H - bolt.height) // 2), bolt)
tx = bx + bolt.width + 120
avail = W - tx - RIGHT_PAD                      # enforce right padding
title_f = fit_font(d, "Bolt Chrome Extension", avail, 84, bold=True, floor=44)
tag_f = font(38, bold=False)
tag_lines = wrap(d, "Your own Chrome \u2014 logins, cookies, and extensions, already there.",
                 tag_f, avail)
th = (title_f.size + 30) + len(tag_lines) * 50
y0 = (H - th) // 2
d.text((tx, y0), "Bolt Chrome Extension", font=title_f, fill=TEXT)
for i, ln in enumerate(tag_lines):
    d.text((tx, y0 + title_f.size + 34 + i * 50), ln, font=tag_f, fill=MUTED)
m.save(os.path.join(OUT, "promo-marquee-1400x560.png"))
print("promo-marquee-1400x560.png  (title=%dpx, avail=%dpx, right_pad=%dpx)" % (title_f.size, avail, RIGHT_PAD))

# ============================================================
# 3) SMALL PROMO TILE — 440x280 (white bg, blue bolt, dark text)
# ============================================================
W, H = 440, 280
s = Image.new("RGB", (W, H), WHITE)
d = ImageDraw.Draw(s)
bolt = draw_bolt(112)
s.paste(bolt, ((W - bolt.width) // 2, 34), bolt)
tf = font(30, bold=True)
gf = font(18, bold=False)
t = "Bolt Chrome Extension"
d.text(((W - tw(d, t, tf)) // 2, 182), t, font=tf, fill=TEXT)
g = "Automate your own Chrome"
d.text(((W - tw(d, g, gf)) // 2, 224), g, font=gf, fill=MUTED)
s.save(os.path.join(OUT, "promo-small-440x280.png"))
print("promo-small-440x280.png")

# ============================================================
# 4) SCREENSHOT — 1280x800 (white bg, blue bolt, dark text)
# ============================================================
W, H = 1280, 800
sc = Image.new("RGB", (W, H), WHITE)
d = ImageDraw.Draw(sc)
bolt = draw_bolt(196)
sc.paste(bolt, ((W - bolt.width) // 2, 108), bolt)
title_f = font(62, bold=True)
sub_f = font(31, bold=False)
chip_f = font(24, bold=False)
t = "Bolt works in your own Chrome"
d.text(((W - tw(d, t, title_f)) // 2, 360), t, font=title_f, fill=TEXT)
sub = "Your logins, cookies, and extensions \u2014 already there. Click the icon to connect a tab."
for i, ln in enumerate(wrap(d, sub, sub_f, 920)):
    d.text(((W - tw(d, ln, sub_f)) // 2, 450 + i * 44), ln, font=sub_f, fill=MUTED)
chips = ["Read the page", "Click & type", "Fill forms"]
pad, gap, ch_h = 26, 20, 56
widths = [tw(d, c, chip_f) + pad * 2 for c in chips]
x = (W - (sum(widths) + gap * (len(chips) - 1))) // 2
y = 610
for c, cw in zip(chips, widths):
    d.rounded_rectangle([x, y, x + cw, y + ch_h], radius=ch_h // 2,
                        fill=CHIP_BG, outline=CHIP_BORDER, width=1)
    d.text((x + pad, y + (ch_h - 30) // 2), c, font=chip_f, fill=CHIP_TEXT)
    x += cw + gap
sc.save(os.path.join(OUT, "screenshot-1280x800.png"))
print("screenshot-1280x800.png")
print("DONE ->", OUT)
