
import io
import re
import struct
from pathlib import Path

import cairosvg
from PIL import Image

ICONS = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
SMALL_MAX = 48
ICO_SIZES = [256, 128, 64, 48, 40, 32, 24, 20, 16]
TARGET_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256]
LOGOS = {"Square44x44Logo.png": 44, "Square30x30Logo.png": 30, "StoreLogo.png": 50}

def full_bleed(svg: str) -> bytes:
    svg = re.sub(r'viewBox="0 0 1024 1024"', 'viewBox="64 64 896 896"', svg, count=1)
    return svg.encode()

SOURCES = {
    small: full_bleed((ICONS / name).read_text(encoding="utf-8"))
    for small, name in ((True, "icon-small.svg"), (False, "icon.svg"))
}

def png(size: int) -> bytes:
    data = cairosvg.svg2png(bytestring=SOURCES[size <= SMALL_MAX], output_width=size, output_height=size)
    out = io.BytesIO()
    Image.open(io.BytesIO(data)).convert("RGBA").save(out, "PNG", optimize=True)
    return out.getvalue()

def write_ico(path: Path) -> None:
    images = [png(s) for s in ICO_SIZES]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries = b""
    for size, data in zip(ICO_SIZES, images):
        side = 0 if size == 256 else size
        entries += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    path.write_bytes(header + entries + b"".join(images))

def main() -> None:
    write_ico(ICONS / "icon.ico")
    for name, size in LOGOS.items():
        (ICONS / name).write_bytes(png(size))
    for size in TARGET_SIZES:
        data = png(size)
        for suffix in ("", "_altform-unplated", "_altform-lightunplated"):
            (ICONS / "msix" / f"Square44x44Logo.targetsize-{size}{suffix}.png").write_bytes(data)

if __name__ == "__main__":
    main()
