from pathlib import Path
import struct
import zlib

output = Path(__file__).resolve().parents[1] / "frontend" / "icons"
output.mkdir(parents=True, exist_ok=True)

def chunk(kind, data):
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    )

def write_icon(size):
    rows = bytearray()

    for y in range(size):
        rows.append(0)

        for x in range(size):
            color = (31, 58, 52)
            nx, ny = x / size, y / size

            # A simple classroom-plaque C mark.
            outer = 0.23 < nx < 0.77 and 0.23 < ny < 0.77
            inner = 0.36 < nx < 0.78 and 0.36 < ny < 0.64

            if outer and not inner:
                color = (245, 246, 242)

            if 0.70 < nx < 0.80 and 0.69 < ny < 0.79:
                color = (255, 200, 69)

            rows.extend(color)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    png += chunk(b"IEND", b"")

    (output / f"icon-{size}.png").write_bytes(png)

for size in (192, 512):
    write_icon(size)

print("Generated PWA icons.")
