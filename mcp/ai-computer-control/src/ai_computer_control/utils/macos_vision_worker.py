"""Bounded, observation-only OpenCV subprocess. Never imports the MCP server or posts input."""
import base64
import io
import json
import math
import os
import stat
import sys
import time

import cv2
import numpy as np
from PIL import Image

from ai_computer_control.utils.template_match import match_templates, dedupe_hits


def read_file(path, limit):
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > limit:
            raise ValueError("Image requires a nonempty regular file inside the byte limit")
        data = source.read(limit + 1)
        after = os.fstat(source.fileno())
        if (len(data) != info.st_size or len(data) > limit or
                (info.st_size, info.st_mtime_ns, info.st_ctime_ns) !=
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise ValueError("Image changed during its bounded read")
        return data


def grayscale(data, pixels):
    with Image.open(io.BytesIO(data)) as image:
        if image.width < 1 or image.height < 1 or image.width > 16384 or image.height > 16384 or image.width * image.height > pixels:
            raise ValueError("Image exceeds its pixel capacity")
        return cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2GRAY)


def run(payload):
    cv2.setNumThreads(1)
    screen = grayscale(read_file(payload["screen_path"], 100000000), 32000000)
    encoded = payload.get("template_b64")
    if encoded:
        if not isinstance(encoded, str) or len(encoded) > 12000000:
            raise ValueError("Encoded template exceeds its byte capacity")
        raw = base64.b64decode(encoded.rsplit(",", 1)[-1], validate=True)
    else:
        raw = read_file(payload["template_path"], 8000000)
    if len(raw) > 8000000:
        raise ValueError("Template exceeds 8MB")
    template = grayscale(raw, 4000000)
    if float(np.std(template)) < 0.000001:
        raise ValueError("A flat template has no distinguishing grayscale pattern")
    deadline = time.monotonic() + 6
    hits, best = match_templates(screen, template, payload["confidence"], payload["scales"], True,
                                cv_backend=cv2, np_backend=np, max_hits=4096, deadline=deadline)
    hits = dedupe_hits(hits)
    if time.monotonic() >= deadline:
        raise TimeoutError("Template deduplication exceeded its deadline")
    if best is not None and not math.isfinite(best[0]):
        best = None
    return {"ok": True, "hits": hits, "best": best, "width": screen.shape[1], "height": screen.shape[0],
            "backend": "OpenCV", "opencv_version": cv2.__version__}


def main():
    try:
        data = sys.stdin.buffer.read(16000001)
        if len(data) > 16000000:
            raise ValueError("Template request exceeds its byte capacity")
        result = run(json.loads(data))
    except TimeoutError as error:
        result = {"ok": False, "code": "vision_timeout", "error": str(error)}
    except OverflowError as error:
        result = {"ok": False, "code": "vision_capacity", "error": str(error)}
    except (ValueError, TypeError, KeyError, OSError) as error:
        result = {"ok": False, "code": "vision_template_invalid", "error": str(error)}
    except Exception as error:
        result = {"ok": False, "code": "vision_failed", "error": type(error).__name__}
    sys.stdout.write(json.dumps(result, allow_nan=False) + "\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
