#!/usr/bin/env python3
"""make-icons.py — the icon set, drawn rather than borrowed.

House standard: every site ships `favicon.svg`, a 32x32 `favicon.png`, a
`favicon.ico` (16/32/48) and an **opaque** 180x180 `apple-touch-icon.png` — iOS
paints transparency black, so a transparent apple icon arrives on a home screen
with black wedges, which is a real fault this family has already had once.

The mark is a bearing tick ring: the same drawing the page paints as its
background abstract, which is the point — the tab, the home screen and the page
agree about what this site is.

Run: python3 tools/make-icons.py   (needs Pillow; the workspace .venv has it)
"""

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "site")

THEME = (56, 189, 248)
GROUND = (4, 16, 26)


def draw(size, opaque_background=False):
    """A ring of bearing ticks with one of them lit: 4x supersampled, then reduced."""
    scale = 4
    big = size * scale
    image = Image.new("RGBA", (big, big), GROUND + (255,) if opaque_background else (0, 0, 0, 0))
    draw_ctx = ImageDraw.Draw(image)

    centre = big / 2
    outer = big * 0.46
    inner = big * 0.30
    width = max(1, int(big * 0.035))

    # 24 ticks, like the bearing scale on a chart. One of them is longer, which
    # is what makes it read as a bearing rather than as a wheel.
    for index in range(24):
        angle = index * 15
        start_from = inner
        if index % 6 == 0:
            colour = THEME + (255,)
        elif index % 2 == 0:
            colour = THEME + (170,)
        else:
            colour = THEME + (95,)
        if index == 3:
            start_from = inner * 0.72  # the lit bearing
            colour = THEME + (255,)
        draw_ctx.line(
            [
                (
                    centre + start_from * __import__("math").sin(__import__("math").radians(angle)),
                    centre - start_from * __import__("math").cos(__import__("math").radians(angle)),
                ),
                (
                    centre + outer * __import__("math").sin(__import__("math").radians(angle)),
                    centre - outer * __import__("math").cos(__import__("math").radians(angle)),
                ),
            ],
            fill=colour,
            width=width,
        )

    # The hub: the aircraft, and the thing the eye lands on at 16 pixels.
    hub = big * 0.115
    draw_ctx.ellipse(
        [centre - hub, centre - hub, centre + hub, centre + hub], fill=THEME + (255,)
    )

    return image.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)

    draw(180, opaque_background=True).convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"))
    draw(512, opaque_background=True).convert("RGB").save(os.path.join(OUT, "android-chrome-512x512.png"))
    draw(192, opaque_background=True).convert("RGB").save(os.path.join(OUT, "android-chrome-192x192.png"))
    draw(32).save(os.path.join(OUT, "favicon-32.png"))

    # The .ico carries 16, 32 and 48 — a single-size ico is a blurred tab icon.
    draw(48).save(
        os.path.join(OUT, "favicon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48)],
    )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="aircraft-demo">
  <rect width="32" height="32" rx="7" fill="#{GROUND[0]:02x}{GROUND[1]:02x}{GROUND[2]:02x}"/>
  <g stroke="#{THEME[0]:02x}{THEME[1]:02x}{THEME[2]:02x}" stroke-linecap="round">
    <path d="M16 5.2V9.4M16 22.6v4.2M5.2 16h4.2M22.6 16h4.2M8.4 8.4l3 3M20.6 20.6l3 3M23.6 8.4l-3 3M11.4 20.6l-3 3" stroke-width="1.6"/>
    <path d="M18.6 6.6l-2.6 4.2" stroke-width="2"/>
    <circle cx="16" cy="16" r="3.1" fill="#{THEME[0]:02x}{THEME[1]:02x}{THEME[2]:02x}" stroke="none"/>
  </g>
</svg>
"""
    with open(os.path.join(OUT, "favicon.svg"), "w", encoding="utf-8") as handle:
        handle.write(svg)

    print("wrote favicon.svg, favicon-32.png, favicon.ico, apple-touch-icon.png, 192 and 512")


if __name__ == "__main__":
    main()
