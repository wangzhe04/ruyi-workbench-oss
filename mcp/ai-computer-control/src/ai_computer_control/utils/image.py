"""Image encoding utilities."""

import base64
import io
from PIL import Image


def pil_to_base64(image: Image.Image, format: str = "PNG", quality: int = 85) -> str:
    """Convert a PIL Image to a base64-encoded string."""
    buffer = io.BytesIO()
    if format.upper() == "JPEG":
        image = image.convert("RGB")
        image.save(buffer, format=format, quality=quality)
    else:
        image.save(buffer, format=format)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def encode_with_budget(image: Image.Image, max_width: int = 0, fmt: str = "png",
                       quality: int = 80) -> dict:
    """Encode a PIL image under a size budget, returning payload + the scale that was applied.

    Downscaling is what shrinks the base64 an agent must read; the returned `scale` lets a caller
    map a coordinate found in the *scaled* image back to physical screen pixels (x_screen = x/scale).

    IMPORTANT coordinate contract: `scale` describes the RETURNED IMAGE only. Any rect/center this
    server reports elsewhere (observe's uia_elements/ocr_words, ocr_find_text, ui_find …) is always
    in UNSCALED physical screen coordinates and is directly clickable — it is NOT multiplied by scale.

    Args:
        image: source PIL image (physical pixels).
        max_width: if >0 and narrower than the image, the image is proportionally resized to this
            width; 0 keeps the original size (scale=1.0).
        fmt: 'png' (lossless) or 'jpeg' (uses `quality`).
        quality: JPEG quality 1-100 (ignored for PNG).

    Returns:
        dict with 'image' (base64), 'width'/'height' (of the returned image), 'scale'
        (returned_width / original_width; <1.0 means downscaled), and 'format'.
    """
    fmt = (fmt or "png").lower()
    orig_w, orig_h = image.width, image.height
    scale = 1.0
    out_img = image
    try:
        mw = int(max_width or 0)
    except Exception:
        mw = 0
    if mw > 0 and orig_w > 0 and mw < orig_w:
        scale = mw / float(orig_w)
        new_h = max(1, int(round(orig_h * scale)))
        out_img = image.resize((mw, new_h), Image.LANCZOS)
    pil_fmt = "JPEG" if fmt in ("jpeg", "jpg") else "PNG"
    buffer = io.BytesIO()
    if pil_fmt == "JPEG":
        rgb = out_img.convert("RGB")
        rgb.save(buffer, format="JPEG", quality=max(1, min(100, int(quality))))
    else:
        out_img.save(buffer, format="PNG")
    return {
        "image": base64.b64encode(buffer.getvalue()).decode("utf-8"),
        "width": out_img.width,
        "height": out_img.height,
        "scale": round(scale, 4),
        "format": "jpeg" if pil_fmt == "JPEG" else "png",
    }


def pil_to_bytes(image: Image.Image, format: str = "PNG") -> bytes:
    """Convert a PIL Image to bytes."""
    buffer = io.BytesIO()
    image.save(buffer, format=format)
    return buffer.getvalue()
