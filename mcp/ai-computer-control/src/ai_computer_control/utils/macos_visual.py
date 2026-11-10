"""Native visual frames and guarded dispatch shared by Mac OCR and template matching."""
from dataclasses import dataclass
import asyncio
import json
import math
import time

from PIL import Image

from ai_computer_control.utils import macos
from ai_computer_control.utils.macos_session import request as input_request


def select_match(candidates, nth=None, nearest_to=None, *, code="visual_ambiguous"):
    """Choose from the full match list. No implicit selection among ambiguous results."""
    if nth is not None and nearest_to is not None:
        raise macos.DesktopError("invalid_args", "Specify only one match disambiguation method")
    if nth is not None:
        if type(nth) is not int or not 0 <= nth < len(candidates):
            raise macos.DesktopError("invalid_args", "nth is outside the actual match range")
        return nth
    if nearest_to is not None:
        if not isinstance(nearest_to, dict) or set(nearest_to) != {"x", "y"} or any(
                type(value) not in (int, float) or not math.isfinite(value) for value in nearest_to.values()):
            raise macos.DesktopError("invalid_args", "nearest_to requires finite global x and y")
        distances = [math.hypot(item["center"][0] - nearest_to["x"], item["center"][1] - nearest_to["y"])
                     for item in candidates]
        smallest = min(distances)
        if distances.count(smallest) == 1:
            return distances.index(smallest)
        raise macos.DesktopError(code, "Nearest matches are tied")
    if len(candidates) != 1:
        raise macos.DesktopError(code, "Select nth or nearest_to for multiple matches",
                                {"count": len(candidates), "candidates": candidates[:100]})
    return 0


def require_active(target):
    if not isinstance(target, dict):
        raise macos.DesktopError("target_invalid", "Pass the complete current window target")
    current = input_request({"op": "window.active"})["window"]["target"]
    try:
        equal = json.dumps(current, sort_keys=True, allow_nan=False) == json.dumps(target, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError):
        raise macos.DesktopError("target_invalid", "Window target is not valid JSON") from None
    if not equal:
        raise macos.DesktopError("target_changed", "The exact observed target must still be the active window")
    return current


def parse_region(region):
    if region is None or region == "":
        return None
    try:
        parts = tuple(int(value.strip()) for value in region.split(",")) if isinstance(region, str) else tuple(region)
    except (TypeError, ValueError, AttributeError):
        raise macos.DesktopError("invalid_args", "region must contain x,y,width,height integers") from None
    if len(parts) != 4 or any(type(value) is not int for value in parts) or parts[2] <= 0 or parts[3] <= 0:
        raise macos.DesktopError("invalid_args", "region must contain x,y and positive width,height integers")
    return parts


@dataclass
class VisualFrame:
    image: Image.Image
    info: dict
    region: tuple | None
    started: float
    target: dict | None

    def screen_box(self, box):
        values = [box.get(key) for key in ("left", "top", "width", "height")]
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in values):
            raise macos.DesktopError("visual_geometry_invalid", "Match geometry must be finite")
        left, top, width, height = values
        if left < 0 or top < 0 or width <= 0 or height <= 0 or left + width > self.image.width or top + height > self.image.height:
            raise macos.DesktopError("visual_geometry_invalid", "Match must lie completely inside the captured image")
        bounds = self.info["logical_bounds"]
        sx, sy = self.image.width / bounds["width"], self.image.height / bounds["height"]
        x, y = bounds["x"] + left / sx, bounds["y"] + top / sy
        w, h = width / sx, height / sy
        return {"left": x, "top": y, "width": w, "height": h, "center": [x + w / 2, y + h / 2]}

    def prepare_click(self, box):
        if self.target is None:
            raise macos.DesktopError("target_required", "Visual clicks require a complete current window target")
        mapped = self.screen_box(box)
        require_active(self.target)
        if time.monotonic() - self.started > 10:
            raise macos.DesktopError("observation_stale", "Visual observation exceeds the ten-second dispatch budget")
        current = capture_frame(self.region, self.target)
        if current.image.size != self.image.size or current.info["logical_bounds"] != self.info["logical_bounds"]:
            raise macos.DesktopError("observation_changed", "Capture geometry changed before the click")
        # Clamp only padding. The complete match was checked before constructing this crop.
        crop = (max(0, math.floor(box["left"]) - 3), max(0, math.floor(box["top"]) - 3),
                min(self.image.width, math.ceil(box["left"] + box["width"]) + 3),
                min(self.image.height, math.ceil(box["top"] + box["height"]) + 3))
        if self.image.crop(crop).tobytes() != current.image.crop(crop).tobytes():
            raise macos.DesktopError("observation_changed", "The matched pixels changed before the click")
        return mapped

    def dispatch_click(self, mapped):
        require_active(self.target)
        age = time.monotonic() - self.started
        if age > 10:
            raise macos.DesktopError("observation_stale", "Visual observation expired before input dispatch")
        bounds = self.target["bounds"]
        x, y = mapped["center"]
        if not (bounds["x"] <= mapped["left"] and bounds["y"] <= mapped["top"]
                and mapped["left"] + mapped["width"] <= bounds["x"] + bounds["width"]
                and mapped["top"] + mapped["height"] <= bounds["y"] + bounds["height"]):
            raise macos.DesktopError("visual_geometry_invalid", "Match leaves the bound window")
        sent = input_request({"op": "mouse.click", "target": self.target, "x": x, "y": y,
                              "button": "left", "clicks": 1, "interval": 0.1})
        return {**sent, "confirmed": None, "outcome": "unconfirmed", "verification": "native_events_posted",
                "observation_age_ms": round(age * 1000)}

    def click(self, box):
        return self.dispatch_click(self.prepare_click(box))

    async def click_async(self, box):
        # Background work only observes. Cancelled callers cannot leave a thread posting input.
        mapped = await asyncio.to_thread(self.prepare_click, box)
        await asyncio.sleep(0)
        return self.dispatch_click(mapped)


def capture_frame(region=None, target=None):
    bound = require_active(target) if target is not None else None
    parsed = parse_region(region)
    if bound is not None:
        bounds = bound["bounds"]
        left, top = math.ceil(bounds["x"]), math.ceil(bounds["y"])
        right, bottom = math.floor(bounds["x"] + bounds["width"]), math.floor(bounds["y"] + bounds["height"])
        if parsed is not None:
            x, y, w, h = parsed
            left, top, right, bottom = max(left, x), max(top, y), min(right, x + w), min(bottom, y + h)
        if right <= left or bottom <= top:
            raise macos.DesktopError("region_outside_target", "Region does not intersect the bound window")
        parsed = (left, top, right - left, bottom - top)
    started = time.monotonic()
    image, info = macos.capture(region=parsed)
    return VisualFrame(image.convert("RGB"), info, parsed, started, bound)
