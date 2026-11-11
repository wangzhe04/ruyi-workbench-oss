"""Rebuild the public 17-case M4 image input pack; no model, OCR or network calls.

Run with the already verified Full embedded Python, -I -B -X utf8, and an
absolute --output naming a new directory. This generator never changes inputs,
downloads libraries, or imports the application processor. Its independent
pixel oracles are geometry/colour facts fixed before production processing.
"""
import argparse
import hashlib
import importlib.metadata
import io
import json
import pathlib
import sys

from PIL import Image, ImageDraw
import cv2


PINNED = {"pillow": "12.3.0", "opencv-python-headless": "5.0.0.93", "numpy": "2.5.1"}
POLICY = [
    {"id": "fixture-secret", "kind": "literal", "value": "SECRET", "category": "INTERNAL"},
    {"id": "fixture-ean", "kind": "literal", "value": "5901234123457", "category": "INTERNAL"},
]
GLYPHS = {
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
}
BLUE = (96, 128, 208)
WORD = (72, 64, 352, 120)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def point(x, y, rgb):
    return {"x": x, "y": y, "rgb": list(rgb)}


def rectangle_points(box, rgb, step=8):
    left, top, right, bottom = box
    return [point(x, y, rgb) for y in range(top + 1, bottom, step) for x in range(left + 1, right, step)]


def public_image(size=(640, 240)):
    image = Image.new("RGB", size, "white")
    ImageDraw.Draw(image).rectangle((540, 180, 599, 219), fill=BLUE)
    return image


def draw_secret(image):
    draw = ImageDraw.Draw(image)
    for index, letter in enumerate("SECRET"):
        for row, cells in enumerate(GLYPHS[letter]):
            for column, ink in enumerate(cells):
                if ink == "1":
                    x, y = WORD[0] + index * 48 + column * 8, WORD[1] + row * 8
                    draw.rectangle((x, y, x + 7, y + 7), fill="black")


def ean13(value):
    # The checksum and 95-module geometry are derived from the public EAN-13
    # encoding definition, independently of the production detector/refiner.
    if len(value) != 13 or not value.isdecimal():
        raise ValueError("EAN-13 requires thirteen decimal digits")
    checksum = (-sum(int(digit) * (1 if index % 2 == 0 else 3) for index, digit in enumerate(value[:12]))) % 10
    if checksum != int(value[-1]):
        raise ValueError("invalid EAN-13 checksum")
    left = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"]
    parity = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]
    opposite = lambda bits: "".join("1" if bit == "0" else "0" for bit in bits)
    groups = [left[int(digit)] if kind == "L" else opposite(left[int(digit)])[::-1]
              for digit, kind in zip(value[1:7], parity[int(value[0])])]
    encoded = "101" + "".join(groups) + "01010" + "".join(opposite(left[int(digit)]) for digit in value[7:]) + "101"
    if len(encoded) != 95:
        raise AssertionError("invalid EAN module count")
    return encoded


def mapped(x, y, width, height, orientation):
    # Map a known source pixel, rather than asking the processor or ImageOps
    # where it ended up. EXIF dimensions swap only for orientations five-eight.
    return [(x, y), (width - 1 - x, y), (width - 1 - x, height - 1 - y),
            (x, height - 1 - y), (y, x), (height - 1 - y, x),
            (height - 1 - y, width - 1 - x), (y, width - 1 - x)][orientation - 1]


def generate(root):
    rows = []

    def save(case_id, image=None, *, extension="png", pixels=None, expected="success", code=None, raw=None, **options):
        file = root / (case_id + "." + extension)
        if raw is None:
            data = io.BytesIO()
            image.save(data, format={"jpg": "JPEG"}.get(extension, extension.upper()), **options)
            raw = data.getvalue()
        file.write_bytes(raw)
        row = {"id": case_id, "file": str(file), "sha256": sha(raw), "expected": expected, "extension": extension}
        if expected == "success":
            row.update({"width": image.width, "height": image.height, "pixels": pixels})
        else:
            row["code"] = code
        rows.append(row)
        return row

    save("blank", Image.new("RGB", (640, 240), "white"), pixels=[point(300, 100, (255, 255, 255))])
    image = public_image()
    draw_secret(image)
    row = save("sensitive-text", image, extension="bmp",
               pixels=rectangle_points(WORD, (0, 0, 0)) + [point(580, 200, BLUE)])
    row["maskedRectangle"] = list(WORD)

    # OpenCV's encoder is a fixture generator only; production decoding is still
    # checked by the real worker and exact mask/public pixel oracles.
    qr = cv2.QRCodeEncoder_create().encode("SECRET")
    code = Image.fromarray(qr).convert("RGB")
    code = code.resize((code.width * 8, code.height * 8), Image.Resampling.NEAREST)
    image = public_image((640, 360))
    image.paste(code, (120, 48))
    center = qr.shape[0] // 2
    whites = [(x, y) for y in range(5, qr.shape[0] - 5) for x in range(5, qr.shape[1] - 5) if int(qr[y, x]) == 255]
    x, y = min(whites, key=lambda xy: abs(xy[0] - center) + abs(xy[1] - center))
    save("sensitive-qr", image, pixels=[point(120 + x * 8 + 4, 48 + y * 8 + 4, (0, 0, 0)), point(580, 200, BLUE)])

    bits = ean13("5901234123457")
    image = Image.new("RGB", (640, 320), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((560, 260, 619, 299), fill=BLUE)
    for index, bit in enumerate(bits):
        if bit == "1":
            draw.rectangle((68 + index * 4, 90, 68 + index * 4 + 3, 229), fill="black")
    row = save("sensitive-linear", image,
               pixels=rectangle_points((68, 90, 448, 230), (0, 0, 0), step=12) + [point(580, 280, BLUE)])
    row["encodedValue"] = "5901234123457"
    row["moduleBitsSha256"] = sha(bits.encode("ascii"))
    row["maskedRectangle"] = [68, 90, 448, 230]

    image = public_image().convert("RGBA")
    ImageDraw.Draw(image).rectangle((72, 64, 351, 119), fill=(200, 0, 0, 0))
    save("transparent-hidden-rgb", image, pixels=[point(100, 90, (255, 255, 255)), point(580, 200, BLUE)])

    image = public_image()
    exif = Image.Exif()
    exif[274] = 1
    exif[270] = "UNEXPOSED EXIF PRIVATE METADATA"
    save("metadata", image, extension="webp", lossless=True, method=6, exif=exif.tobytes(),
         xmp=b'<x:xmpmeta xmlns:x="adobe:ns:meta/">UNEXPOSED XMP METADATA</x:xmpmeta>', pixels=[point(580, 200, BLUE), point(100, 90, (255, 255, 255))])

    image = public_image()
    ImageDraw.Draw(image).rectangle((96, 64, 191, 143), fill=BLUE)
    row = save("explicit-regions", image, extension="bmp",
               pixels=rectangle_points((96, 64, 192, 144), (0, 0, 0)) + [point(580, 200, BLUE)])
    row["boxes"] = [[96, 64, 192, 144]]

    source = Image.new("RGB", (320, 192), "white")
    draw = ImageDraw.Draw(source)
    markers = [(32, 40, (255, 0, 0)), (280, 32, (0, 255, 0)), (288, 152, (0, 0, 255)), (40, 160, (255, 255, 0))]
    for x, y, rgb in markers:
        draw.rectangle((x - 12, y - 12, x + 11, y + 11), fill=rgb)
    for orientation in range(1, 9):
        exif = Image.Exif()
        exif[274] = orientation
        exif[270] = "UNEXPOSED ORIENTATION METADATA"
        data = io.BytesIO()
        source.save(data, format="JPEG", quality=100, subsampling=0, optimize=False, exif=exif.tobytes())
        encoded = data.getvalue()
        # JPEG colours are read independently from the encoded source at known
        # marker centres; this avoids assuming lossless primary-colour encoding.
        with Image.open(io.BytesIO(encoded)) as decoded:
            rgb = decoded.convert("RGB")
            pixels = [point(*mapped(x, y, 320, 192, orientation), rgb.getpixel((x, y))) for x, y, _ in markers]
        row = save("orientation-" + str(orientation), source, extension="jpg", raw=encoded, pixels=pixels)
        if orientation >= 5:
            row.update({"width": 192, "height": 320})
        row["exifOrientation"] = orientation

    save("bad-input", expected="refusal", raw=b"\x89PNG\r\n\x1a\nbroken synthetic image",
         code="privacy.image_processor_worker_component_failed")
    first, second = public_image(), public_image()
    ImageDraw.Draw(second).rectangle((8, 8, 31, 31), fill=BLUE)
    save("animation", first, extension="webp", save_all=True, append_images=[second], duration=100, loop=0,
         lossless=True, expected="refusal", code="privacy.image_processor_worker_animation_unsupported")
    if len(rows) != 17 or len({row["id"] for row in rows}) != 17:
        raise AssertionError("fixture matrix must contain exactly seventeen cases")
    manifest = {"schema": 1, "kind": "public-synthetic-media-image-oracles", "policyRules": POLICY,
                "recipe": {"id": "m4-public-image-pack-v1", "generatorSha256": sha(pathlib.Path(__file__).read_bytes()),
                           "python": sys.version.split()[0], "distributions": PINNED, "font": "fixed-5x7-SECRET-scale8-no-font-file",
                           "opencvBuildSha256": sha(cv2.getBuildInformation().encode("utf-8")),
                           "publicSyntheticOnly": True, "ocrOrModelUsedDuringGeneration": False}, "cases": rows}
    (root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(str(root / "manifest.json"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if sys.version_info[:3] != (3, 12, 10):
        raise RuntimeError("use the verified CPython 3.12.10 Full runtime")
    for distribution, version in PINNED.items():
        if importlib.metadata.version(distribution) != version:
            raise RuntimeError("fixture dependency version differs: " + distribution)
    if not args.output.is_absolute():
        raise ValueError("--output must be an absolute new directory")
    root = args.output.resolve(strict=False)
    # No overwrites, cleanups, fixture downloads or discovery of user media.
    root.mkdir(parents=False, exist_ok=False)
    cv2.setNumThreads(1)
    generate(root)


if __name__ == "__main__":
    main()
