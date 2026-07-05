"""Standalone chart image rendering (chart_image) — v1.6 模板驱动.

matplotlib on the Agg (headless, no display) backend renders a .png chart styled from the design
tokens, with the CJK font chain wired into rcParams so 中文 labels/titles are real glyphs, not tofu.

matplotlib is an OPTIONAL offline dependency. The import is guarded at MODULE TOP: an absent matplotlib
must not stop the whole MCP from starting (v1.4 P0 lesson). We also force the Agg backend BEFORE
importing pyplot so it never tries to open a GUI window on a headless/server box.

Chart styling: light-grey grid, no top/right spines, legend, value labels on bars, DPI 150.
"""

import os

from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason
from ai_computer_control.tools import office_style as style_tokens

# Guarded optional import (module top). Force Agg BEFORE pyplot so no display is ever needed.
try:
    import matplotlib  # type: ignore
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt  # type: ignore  # noqa: F401
    _AVAILABLE = True
    _IMPORT_ERROR = ""
except Exception as e:  # noqa: BLE001 — optional dependency
    _AVAILABLE = False
    _IMPORT_ERROR = str(e)

# Wire the CJK font into matplotlib exactly once (font cache + rcParams). Done lazily on first render.
_FONT_READY = False


def _unavailable() -> dict:
    return {"error": "制图需要 matplotlib。离线包已含，可运行 installer 重装；或 pip install matplotlib",
            "detail": _IMPORT_ERROR}


def _protected_write_guard(path: str, allow_protected: bool):
    reason = protected_path_reason(path)
    if reason and not allow_protected:
        return {"error": f"拒绝写入：目标 {reason}。如确需写入，请传 allow_protected=true。"}
    return None


def _ensure_font() -> dict:
    """Register the CJK font file with matplotlib and set it as the default family. Returns the
    font_chain() dict (carries a 'warning' if no CJK font file was found)."""
    global _FONT_READY
    info = style_tokens.font_chain()
    if _FONT_READY:
        return info
    if info.get("path"):
        try:
            import matplotlib.font_manager as fm
            fm.fontManager.addfont(info["path"])
            family = fm.FontProperties(fname=info["path"]).get_name()
            matplotlib.rcParams["font.sans-serif"] = [family, info["family"], "Microsoft YaHei",
                                                      "SimHei", "SimSun", "DejaVu Sans"]
            matplotlib.rcParams["font.family"] = "sans-serif"
        except Exception:
            # Best-effort: fall back to family-name-only hint.
            matplotlib.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "SimSun", "DejaVu Sans"]
    # ASCII minus sign renders fine; disable the unicode minus that some CJK fonts lack a glyph for.
    matplotlib.rcParams["axes.unicode_minus"] = False
    _FONT_READY = True
    return info


@mcp.tool(audit=True)
def chart_image(
    path: str,
    chart_type: str,
    data: dict,
    title: str,
    style: str = "business",
    x_title: str | None = None,
    y_title: str | None = None,
    allow_protected: bool = False,
) -> dict:
    """Render a standalone chart image (.png) with matplotlib, styled from design tokens (模板驱动).

    data shape:
        {'labels': [str, ...],
         'series': [{'name': str, 'values': [num, ...]}, ...]}
    labels are the x categories (or pie slice labels); each series is one line/bar-group. For 'pie'
    exactly one series is required (its values map to the labels).

    Styling: token chart palette, light-grey grid, no top/right spines, a legend, value labels on
    bar charts, and DPI 150. 中文 titles/labels render via the CJK font chain (Microsoft YaHei ->
    SimHei -> SimSun, probed at call time).

    v1.7.1 — 坐标轴标题 (用户反馈图表缺 X/Y 轴单位)。命名与 excel_chart 对齐 (x_title / y_title):
      * x_title / y_title 设横 / 纵轴标题 (matplotlib ax.set_xlabel / set_ylabel)，字体走既有 CJK 链。
      * 也可写在 data 里 (data['x_title'] / data['y_title'])；顶层参数优先。
      * 缺省自动推导 (仅当该参数为 None 且 data 里也没给)：
          - y_title ← 单系列时取该系列的 name；多系列留空 (由图例承担)。
          - x_title ← 无表头来源，缺省留空 (类别名已在刻度上)。
        传空字符串 '' 可显式关闭。饼图无坐标轴，两者忽略。

    Args:
        path: Output .png path.
        chart_type: 'bar' | 'line' | 'pie' | 'scatter'.
        data: {'labels': [...], 'series': [{'name', 'values'}, ...]} (see above). May also carry
              optional 'x_title' / 'y_title' keys (top-level params take precedence).
        title: Chart title (中文 OK).
        style: 'business' (default) | 'minimal' | 'vibrant'. Unknown -> 'business'.
        x_title: 横轴标题。None = data['x_title'] 或留空；'' = 不加。饼图忽略。
        y_title: 纵轴标题。None = data['y_title'] 或自动 (单系列取 name)；'' = 不加。饼图忽略。
        allow_protected: Override the protected-system-root guard on the destination (default off).

    Returns:
        dict with 'success', 'path', 'output_path', 'chart_type', 'style', 'font', 'bytes',
        'x_title', 'y_title' (axis titles actually drawn — '' when none / pie). Missing matplotlib ->
        {'error': install guidance}. Bad input -> {'error': <中文人话>}. Carries a 'warning' when no
        CJK font file was found.
    """
    if not _AVAILABLE:
        return _unavailable()
    if not str(path).lower().endswith(".png"):
        return {"error": "path 必须以 .png 结尾"}
    ctype = str(chart_type).strip().lower()
    if ctype not in ("bar", "line", "pie", "scatter"):
        return {"error": f"chart_type 非法：{chart_type!r}，仅支持 bar | line | pie | scatter"}
    if not isinstance(data, dict):
        return {"error": "data 必须是 dict：{'labels':[...], 'series':[{'name','values'}, ...]}"}
    guard = _protected_write_guard(path, allow_protected)
    if guard:
        return guard

    labels = data.get("labels") or []
    series = data.get("series") or []
    if not isinstance(labels, list) or not labels:
        return {"error": "data.labels 不能为空（类别/横轴标签列表）"}
    if not isinstance(series, list) or not series:
        return {"error": "data.series 不能为空（至少一个 {'name','values'} 系列）"}
    for i, s in enumerate(series):
        if not isinstance(s, dict) or "values" not in s:
            return {"error": f"第 {i + 1} 个系列格式错误，应为 {{'name':..., 'values':[...]}}"}
        vals = s.get("values")
        if not isinstance(vals, list) or len(vals) != len(labels):
            return {"error": f"系列 {s.get('name', i + 1)} 的 values 长度({len(vals) if isinstance(vals, list) else '?'}) "
                             f"必须等于 labels 长度({len(labels)})"}
    if ctype == "pie" and len(series) != 1:
        return {"error": "饼图只能有一个系列（single series），当前有 " + str(len(series)) + " 个"}

    # --- v1.7.1 坐标轴标题解析 (饼图无轴 → 强制空) ---
    if ctype == "pie":
        axis_x, axis_y = "", ""
    else:
        # top-level param wins; else data dict; else auto. '' explicitly disables.
        if x_title is not None:
            axis_x = str(x_title)
        elif isinstance(data.get("x_title"), str):
            axis_x = data["x_title"]
        else:
            axis_x = ""   # no header source for the category axis
        if y_title is not None:
            axis_y = str(y_title)
        elif isinstance(data.get("y_title"), str):
            axis_y = data["y_title"]
        else:
            # auto: single series → its name; multi-series → blank (legend carries it).
            axis_y = str(series[0].get("name", "")) if len(series) == 1 else ""

    tokens = style_tokens.get_style(style)
    resolved_style = style if style in style_tokens.STYLES else style_tokens.DEFAULT_STYLE
    palette = [style_tokens.hex_hash(c) for c in tokens["chart_palette"]]
    grid_color = style_tokens.hex_hash(tokens["border_color"])
    text_color = style_tokens.hex_hash(tokens["text_color"])

    font_info = _ensure_font()

    import matplotlib.pyplot as plt

    fig = None
    try:
        fig, ax = plt.subplots(figsize=(9, 5.5))

        if ctype == "bar":
            import numpy as np
            n = len(series)
            x = np.arange(len(labels))
            group_w = 0.8
            bar_w = group_w / n
            for i, s in enumerate(series):
                offset = (i - (n - 1) / 2) * bar_w
                bars = ax.bar(x + offset, s["values"], bar_w, label=s.get("name", f"系列{i+1}"),
                              color=palette[i % len(palette)])
                # value labels on top of each bar
                for rect in bars:
                    h = rect.get_height()
                    ax.annotate(_fmt(h), xy=(rect.get_x() + rect.get_width() / 2, h),
                                xytext=(0, 3), textcoords="offset points",
                                ha="center", va="bottom", fontsize=8, color=text_color)
            ax.set_xticks(x)
            ax.set_xticklabels(labels)
            ax.legend()

        elif ctype == "line":
            for i, s in enumerate(series):
                ax.plot(labels, s["values"], marker="o", linewidth=2,
                        label=s.get("name", f"系列{i+1}"), color=palette[i % len(palette)])
            ax.legend()

        elif ctype == "scatter":
            for i, s in enumerate(series):
                ax.scatter(range(len(labels)), s["values"], label=s.get("name", f"系列{i+1}"),
                           color=palette[i % len(palette)], s=60, alpha=0.8)
            ax.set_xticks(range(len(labels)))
            ax.set_xticklabels(labels)
            ax.legend()

        elif ctype == "pie":
            values = series[0]["values"]
            colors = [palette[i % len(palette)] for i in range(len(labels))]
            ax.pie(values, labels=labels, colors=colors, autopct="%1.1f%%",
                   startangle=90, textprops={"color": text_color})
            ax.axis("equal")

        ax.set_title(str(title), fontsize=15, color=text_color, pad=12)

        if ctype != "pie":
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)
            ax.spines["left"].set_color(grid_color)
            ax.spines["bottom"].set_color(grid_color)
            ax.grid(axis="y", color=grid_color, linewidth=0.6, alpha=0.6)
            ax.set_axisbelow(True)
            ax.tick_params(colors=text_color)
            # v1.7.1 axis titles — font follows the CJK rcParams chain wired by _ensure_font.
            if axis_x:
                ax.set_xlabel(axis_x, fontsize=11, color=text_color, labelpad=8)
            if axis_y:
                ax.set_ylabel(axis_y, fontsize=11, color=text_color, labelpad=8)

        fig.tight_layout()
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        fig.savefig(path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        fig = None

        size = os.path.getsize(path) if os.path.exists(path) else 0
        out = {
            "success": True,
            "path": os.path.abspath(path),
            "output_path": os.path.abspath(path),
            "chart_type": ctype,
            "style": resolved_style,
            "font": font_info.get("family"),
            "bytes": size,
            "x_title": axis_x,
            "y_title": axis_y,
        }
        if font_info.get("warning"):
            out["warning"] = font_info["warning"]
        return out
    except Exception as e:  # noqa: BLE001
        if fig is not None:
            try:
                plt.close(fig)
            except Exception:
                pass
        return {"error": f"制图失败：{e}"}


def _fmt(v) -> str:
    """Compact numeric label: drop the trailing .0 on integers."""
    try:
        f = float(v)
        if f == int(f):
            return str(int(f))
        return f"{f:.2f}".rstrip("0").rstrip(".")
    except Exception:
        return str(v)
