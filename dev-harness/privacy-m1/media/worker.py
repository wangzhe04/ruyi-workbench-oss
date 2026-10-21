"""Synthetic-only M1 worker. Uses the already bundled Pillow and Windows OCR.

Private JSON transport is stdin/stdout; the runner never includes OCR text or paths in evidence.
No install, download, cloud inference, desktop capture, or user-media discovery occurs here.
"""
import asyncio
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import math
import os
import pathlib
import shutil
import sys
import time

VERSION = "m1-media-0.1.0"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(data):
    from PIL import Image, ImageOps
    image = Image.open(io.BytesIO(data))
    if image.width * image.height > 8_000_000 or getattr(image, "n_frames", 1) != 1:
        raise ValueError("unsupported-image")
    image.load()
    return ImageOps.exif_transpose(image).convert("RGB")


async def recognize(data):
    from winsdk.windows.media.ocr import OcrEngine
    from winsdk.windows.globalization import Language
    from winsdk.windows.graphics.imaging import BitmapDecoder
    from winsdk.windows.storage.streams import InMemoryRandomAccessStream, DataWriter
    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream.get_output_stream_at(0))
    writer.write_bytes(data)
    await writer.store_async()
    await writer.flush_async()
    writer.detach_stream()
    stream.seek(0)
    decoder = await BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()
    engine = OcrEngine.try_create_from_language(Language("en-US"))
    if engine is None:
        raise ValueError("missing-component")
    result = await engine.recognize_async(bitmap)
    words = []
    for line_id, line in enumerate(result.lines):
        for word in line.words:
            r = word.bounding_rect
            words.append({"text": word.text, "line": line_id,
                          "box": [math.floor(r.x), math.floor(r.y),
                                  math.ceil(r.x + r.width), math.ceil(r.y + r.height)]})
    return words


def encode(image):
    # A fresh image owns no EXIF, XMP, text chunks, ICC profile, or source thumbnail.
    from PIL import Image
    fresh = Image.new("RGB", image.size)
    fresh.paste(image)
    out = io.BytesIO()
    fresh.save(out, "PNG")
    return out.getvalue()


def fixture(root):
    from PIL import Image, ImageDraw, ImageFont, PngImagePlugin
    image = Image.new("RGB", (1500, 620), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(pathlib.Path(os.environ["WINDIR"]) / "Fonts" / "arial.ttf"), 48)
    for n, text in enumerate(["PUBLIC REPORT 2026", "Phone: 13800138000",
                              "Contact: local.fixture@example.test", "Private code: ALPHA BRAVO CHARLIE",
                              "Order count 42"]):
        draw.text((55, 35 + n * 105), text, font=font, fill="black")
    outputs = []
    for name, transformed, orientation in [
        ("plain", image, 1),
        ("scaled", image.resize((1800, 744)), 1),
        ("oriented", image.transpose(Image.Transpose.ROTATE_90), 6),
    ]:
        meta = PngImagePlugin.PngInfo()
        meta.add_text("Comment", "SYNTHETIC_METADATA_SECRET local.fixture@example.test")
        meta.add_itxt("XML:com.adobe.xmp", "SYNTHETIC_XMP_SECRET")
        exif = Image.Exif()
        exif[274] = orientation
        exif[37510] = b"SYNTHETIC_EXIF_SECRET"
        target = root / (name + ".png")
        transformed.save(target, "PNG", pnginfo=meta, exif=exif)
        outputs.append({"name": name, "file": str(target)})
    blank = root / "blank.png"
    Image.new("RGB", (600, 400), "white").save(blank)
    return {"fixtures": outputs, "blank": str(blank)}


def probe():
    return {"python": sys.version.split()[0],
            "asrPackages": {name: bool(importlib.util.find_spec(name)) for name in
                            ["whisper", "faster_whisper", "vosk", "sherpa_onnx", "torch", "transformers", "onnxruntime"]},
            "videoOnPath": {name: bool(shutil.which(name)) for name in ["ffmpeg", "ffprobe"]}}


def inventory():
    from winsdk.windows.media.ocr import OcrEngine
    packages = {}
    for name in ["Pillow", "winsdk"]:
        meta = importlib.metadata.metadata(name)
        packages[name] = {"version": meta["Version"],
                          "license": meta.get("License-Expression") or meta.get("License")}
    native_hashes = {name: digest(pathlib.Path(importlib.util.find_spec(name).origin).read_bytes())
                     for name in ["winsdk._winrt", "PIL._imaging"]}
    windows = sys.getwindowsversion()
    return {**probe(), "packages": packages, "nativeRuntimeHashes": native_hashes,
            "windowsVersion": {"major": windows.major, "minor": windows.minor, "build": windows.build},
            "ocrLanguages": [x.language_tag for x in OcrEngine.available_recognizer_languages]}


def main(request):
    mode = request["mode"]
    if mode == "probe":
        return probe()
    from PIL import Image, ImageDraw
    if mode == "inventory":
        return inventory()
    if mode == "fixture":
        return fixture(pathlib.Path(request["root"]))
    if mode == "wait":
        time.sleep(30)
        return {}
    if mode == "audio":
        # No adapter/model has been frozen or implemented: presence alone would not enable upload.
        raise ValueError("missing-component")
    data = pathlib.Path(request["source"]).read_bytes()
    if digest(data) != request["sourceHash"]:
        raise ValueError("source-changed")
    image = canonical(data)
    normalized = encode(image)
    if mode == "ocr":
        return {"words": asyncio.run(asyncio.wait_for(recognize(normalized), 20)),
                "width": image.width, "height": image.height}
    if mode == "redact":
        draw = ImageDraw.Draw(image)
        boxes = request["boxes"]
        if not boxes:
            raise ValueError("unrecognized")
        for box in boxes:
            if (len(box) != 4 or any(type(x) is not int for x in box)
                    or not 0 <= box[0] < box[2] <= image.width
                    or not 0 <= box[1] < box[3] <= image.height):
                raise ValueError("invalid-box")
            draw.rectangle((box[0], box[1], box[2] - 1, box[3] - 1), fill="black")
        derived = encode(image)
        pathlib.Path(request["target"]).write_bytes(derived)
        check = Image.open(io.BytesIO(derived))
        assert not check.info and not check.getexif()
        assert b"SYNTHETIC_" not in derived
        assert all(set(check.crop(box).getdata()) == {(0, 0, 0)} for box in boxes)
        # The fixture's public title region is outside private rows, including scaled fixtures.
        title = (0, 0, image.width, round(image.height * 0.20))
        before = canonical(data)
        assert check.crop(title).tobytes() == before.crop(title).tobytes()
        return {"derivedHash": digest(derived), "metadataStripped": True,
                "coveredPixelsBlack": True, "publicTitlePixelsIdentical": True,
                "wordsAfter": asyncio.run(asyncio.wait_for(recognize(derived), 20))}
    raise ValueError("unsupported-mode")


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, **main(json.load(sys.stdin))}))
    except Exception as exc:
        code = str(exc) if isinstance(exc, ValueError) else "processor-failed"
        print(json.dumps({"ok": False, "code": code}))
        sys.exit(2)
