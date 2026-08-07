"""图片信息读取 + 等比缩放 (Pillow) —— 让 AI 在处理图片前先看清尺寸/格式，缩放时不必盲猜 (v1.8.0).

  * image_info   —— 读类: 宽/高/格式/模式/文件大小/DPI。零副作用，先看清再动手。
  * image_resize —— 写类: 等比 (只给一边按比例) / scale 缩放，LANCZOS 高质量；output_path 契约 +
                     protected 护栏 + 进 workbench 快照表 (可撤销)。

Pillow 是核心依赖 (requirements_offline.txt / pyproject)，正常都在。仍加 import 守护: 万一某机器缺失，
返回人话提示而非炸服务器启动。
"""

import os

from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason


def _protected_write_guard(path: str, allow_protected: bool):
    """写前对目标路径过受保护系统树护栏，带 allow_protected 逃生阀 (与 write_document / delete 一致)。"""
    reason = protected_path_reason(path)
    if reason and not allow_protected:
        return {"error": f"refused: destination {reason}. Pass allow_protected=true to override."}
    return None


@mcp.tool()
def image_info(path: str) -> dict:
    """读取图片的基本信息 (宽/高/格式/模式/文件大小/DPI) —— 处理图片前先看清，别盲操作。

    纯读，零副作用。配合 image_resize: 先 image_info 拿到原始尺寸，再决定缩到多大。

    Args:
        path: 图片文件路径 (PNG/JPG/BMP/GIF/WEBP/TIFF 等 Pillow 支持的格式)。

    Returns:
        dict with ok, path, width, height, format (如 'PNG'), mode (如 'RGB'/'RGBA'/'L'),
        file_size (字节), file_size_human, dpi ([x,y] 若图内嵌了 DPI，否则不含此键)。
        文件不存在 / 非图片 / 缺 Pillow → {'error': 人话说明}。
    """
    if not os.path.exists(path):
        return {"error": f"文件不存在: {path}"}
    try:
        from PIL import Image
    except Exception:
        return {"error": "图片工具需要 Pillow。离线包已含 (核心依赖)，可运行 installer 重装；或 pip install Pillow"}

    try:
        size_bytes = os.path.getsize(path)
        with Image.open(path) as im:
            info = {
                "ok": True,
                "path": os.path.abspath(path),
                "width": im.width,
                "height": im.height,
                "format": im.format,
                "mode": im.mode,
                "file_size": size_bytes,
                "file_size_human": _human_size(size_bytes),
            }
            dpi = im.info.get("dpi")
            if dpi:
                try:
                    info["dpi"] = [round(float(dpi[0]), 2), round(float(dpi[1]), 2)]
                except Exception:
                    pass
            return info
    except Exception as e:
        return {"error": f"读不了这张图 (可能不是图片或已损坏): {type(e).__name__}: {e}"}


@mcp.tool(audit=True)
def image_resize(
    path: str,
    output_path: str,
    width: int | None = None,
    height: int | None = None,
    scale: float | None = None,
    quality: int = 85,
    allow_protected: bool = False,
) -> dict:
    """等比 (或按 scale) 缩放图片，高质量 LANCZOS 重采样，写到 output_path。

    尺寸给法 (三选一，等比缺省):
      * 只给 width → 按原图宽高比自动算 height (反之亦然) —— 最常用，不变形。
      * 同时给 width + height → 精确到该尺寸 (可能变形，调用方自负)。
      * 给 scale (如 0.5 = 半尺寸) → 忽略 width/height，整体按比例缩放。
    三者都不给 → 报错 (没有「不缩放的缩放」)。

    Args:
        path: 源图片路径。
        output_path: 输出路径 (必填；决定格式，如 .jpg → JPEG、.png → PNG)。可与 path 相同 (原地覆盖)。
        width: 目标宽 (像素)。只给它则等比算高。
        height: 目标高 (像素)。只给它则等比算宽。
        scale: 整体缩放系数 (>0)；给了它就忽略 width/height。
        quality: JPEG 保存质量 1-100 (仅对 .jpg/.jpeg 输出生效)，默认 85。
        allow_protected: 覆盖「受保护系统树」护栏 (默认关)。

    Returns:
        dict with ok, path (源), output_path (== 落盘绝对路径，供 workbench 产物收割/撤销),
        original_size [w,h], new_size [w,h], format。
        缺尺寸参数 / 源不存在 / 目标受保护 / 缺 Pillow → {'error': 人话说明}。
    """
    if not os.path.exists(path):
        return {"error": f"源文件不存在: {path}"}
    guard = _protected_write_guard(output_path, allow_protected)
    if guard:
        return guard

    try:
        from PIL import Image
    except Exception:
        return {"error": "图片工具需要 Pillow。离线包已含 (核心依赖)，可运行 installer 重装；或 pip install Pillow"}

    if width is None and height is None and scale is None:
        return {"error": "至少给一个尺寸: width= 或 height= (等比) 或 scale= (整体比例)。"}

    try:
        with Image.open(path) as im:
            ow, oh = im.width, im.height
            if ow <= 0 or oh <= 0:
                return {"error": f"源图尺寸异常 ({ow}x{oh})，无法缩放。"}
            # b3-P2: 保留源图 DPI(和可用的 EXIF) —— 原实现缩放后 DPI 丢失,打印/排版时按 72dpi 出图会变大

            if scale is not None:
                try:
                    s = float(scale)
                except Exception:
                    return {"error": f"scale 必须是数字，收到 {scale!r}。"}
                if s <= 0:
                    return {"error": f"scale 必须 > 0，收到 {s}。"}
                nw = max(1, int(round(ow * s)))
                nh = max(1, int(round(oh * s)))
            elif width is not None and height is not None:
                nw, nh = max(1, int(width)), max(1, int(height))
            elif width is not None:
                nw = max(1, int(width))
                nh = max(1, int(round(oh * (nw / float(ow)))))  # 等比算高
            else:  # 只给 height
                nh = max(1, int(height))
                nw = max(1, int(round(ow * (nh / float(oh)))))  # 等比算宽
            # b2-P2: 输出像素上限(防超大 scale 撑爆服务器内存)
            if nw * nh > 100_000_000:  # 1 亿像素 ≈ 400MB RGBA
                return {"error": f"输出尺寸过大({nw}x{nh} = {nw*nh} 像素,超过 1 亿像素上限);请缩小 scale / width / height"}

            resized = im.resize((nw, nh), Image.LANCZOS)
            # 源图 DPI 透传(有则带,无则不加),避免缩放产物丢失打印/排版元数据。
            dpi = im.info.get("dpi")
            save_kwargs = {}
            if isinstance(dpi, (tuple, list)) and len(dpi) == 2:
                try:
                    save_kwargs["dpi"] = (int(round(float(dpi[0]))), int(round(float(dpi[1]))))
                except Exception:
                    pass
            # EXIF: JPEG 输出时把源图 EXIF 一并带上(orientation 等),避免缩放后图片旋转/元数据丢失。
            exif = None
            try:
                exif = im.getexif()
                if not exif:
                    exif = None
            except Exception:
                exif = None

            os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
            ext = os.path.splitext(output_path)[1].lower()
            if ext in (".jpg", ".jpeg"):
                # JPEG 不支持 alpha —— RGBA/P 先转 RGB，否则 save 会炸。
                if resized.mode in ("RGBA", "P", "LA"):
                    resized = resized.convert("RGB")
                save_kwargs["quality"] = max(1, min(100, int(quality)))
                if exif is not None:
                    save_kwargs["exif"] = exif
                resized.save(output_path, "JPEG", **save_kwargs)
                fmt = "JPEG"
            else:
                if exif is not None:
                    save_kwargs["exif"] = exif
                resized.save(output_path, **save_kwargs)  # 让 Pillow 按扩展名推格式 (PNG/BMP/WEBP/…)
                fmt = (resized.format or ext.lstrip(".").upper() or "PNG")

        return {
            "ok": True,
            "path": os.path.abspath(path),
            "output_path": os.path.abspath(output_path),
            "original_size": [ow, oh],
            "new_size": [nw, nh],
            "format": fmt,
        }
    except Exception as e:
        return {"error": f"缩放失败: {type(e).__name__}: {e}"}


def _human_size(size: int) -> str:
    s = float(size)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if s < 1024:
            return f"{s:.1f} {unit}"
        s /= 1024
    return f"{s:.1f} PB"
