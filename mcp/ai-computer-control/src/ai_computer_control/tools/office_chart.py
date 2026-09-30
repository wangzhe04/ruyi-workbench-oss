"""Standalone chart image rendering (chart_image) — v1.6 模板驱动.

matplotlib on the Agg (headless, no display) backend renders a .png chart styled from the design
tokens, with the CJK font chain wired into rcParams so 中文 labels/titles are real glyphs, not tofu.

matplotlib is an OPTIONAL offline dependency and a heavy import (~0.8 s). It is NOT imported at module
load: `_AVAILABLE` is a cheap importlib.util.find_spec probe (diagnostics reads it), and pyplot is loaded on
the first chart_image call, with the Agg (headless) backend forced BEFORE pyplot so it never tries to open
a GUI window on a headless/server box. A missing / broken matplotlib gives an install-hint envelope.

Chart styling: light-grey grid, no top/right spines, legend, value labels on bars, DPI 150. Layout adapts to
the data: the figure widens with category count, long category labels wrap -> rotate -> thin (measured with
the real renderer, not guessed), value labels are dropped or shrunk when they would collide, pie slices get
contrast-aware percent text and leader-lined outside labels, scatter takes a numeric x.
"""

import math
import os

from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason
from ai_computer_control.tools import office_style as style_tokens
from ai_computer_control.tools import office_io

try:
    import importlib.util as _ilu
    _AVAILABLE = _ilu.find_spec("matplotlib") is not None
except Exception:  # noqa: BLE001
    _AVAILABLE = False
_IMPORT_ERROR = "" if _AVAILABLE else "matplotlib not installed"

_PLT = None

# Wire the CJK font into matplotlib exactly once (font cache + rcParams). Done lazily on first render.
_FONT_READY = False


def _unavailable(detail: str = "") -> dict:
    return office_io.missing_dependency("matplotlib", detail or _IMPORT_ERROR)


def _load_pyplot():
    """Import pyplot lazily under Agg. Returns (plt, None) or (None, install-hint envelope)."""
    global _PLT
    if _PLT is not None:
        return _PLT, None
    try:
        import matplotlib  # type: ignore
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt  # type: ignore
        _PLT = plt
        return plt, None
    except Exception as e:  # noqa: BLE001 — optional dependency
        return None, _unavailable(str(e))


def _protected_write_guard(path: str, allow_protected: bool):
    reason = protected_path_reason(path)
    if reason and not allow_protected:
        return {"error": f"拒绝写入：目标 {reason}。如确需写入，请传 allow_protected=true。"}
    return None


def _ensure_font() -> dict:
    """Register the CJK font file with matplotlib and set it as the default family. Returns the
    font_chain() dict (carries a 'warning' if no CJK font file was found)."""
    global _FONT_READY
    import matplotlib
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

    何时用: 需要 bar/line/pie/scatter 之外的形态 —— 类目多/标签长用 hbar 横排更好读；一个类目下多个
    分量的构成用 stacked_bar；随时间的量级趋势(强调"填满到 0"的体量感)用 area。
    何时别用: 单纯要精确数值对比用 bar/line 即可,area 的堆叠/透明度会让精确读数变难;分量总和无意义
    (如互不相关的独立指标)时别用 stacked_bar,改用 bar 分组。

    109c — 出图补型 (工具版本不变，仅补 chart_type): 新增 hbar(横向条形图)、stacked_bar(堆叠柱状图)、
    area(面积图)。三者复用同一份 data 形状与坐标轴标题/CJK 字体/style 链路,不新增参数：
      * hbar: labels 落在纵轴(自上而下与 labels 顺序一致)，数值落在横轴；多系列并列成组。
        坐标轴语义与 bar 相反 —— 若沿用自动推导的 y_title(取单系列 name)会挂在类目轴上，横向图建议
        显式传 x_title/y_title。
      * stacked_bar: 同一 x 类目下的多系列纵向堆叠求和；柱顶标注堆叠总和(不逐段标数值，避免拥挤)。
      * area: 多系列各自画折线 + 半透明填充(alpha=0.35，与 matplotlib fill_between 独立叠放，不是
        累积堆叠面积图) —— 系列间可直接互相对照，重叠处靠透明度分辨。

    v1.7.1 — 坐标轴标题 (用户反馈图表缺 X/Y 轴单位)。命名与 excel_chart 对齐 (x_title / y_title):
      * x_title / y_title 设横 / 纵轴标题 (matplotlib ax.set_xlabel / set_ylabel)，字体走既有 CJK 链。
      * 也可写在 data 里 (data['x_title'] / data['y_title'])；顶层参数优先。
      * 缺省自动推导 (仅当该参数为 None 且 data 里也没给)：
          - y_title ← 单系列时取该系列的 name；多系列留空 (由图例承担)。
          - x_title ← 无表头来源，缺省留空 (类别名已在刻度上)。
        传空字符串 '' 可显式关闭。饼图无坐标轴，两者忽略。

    v2 出图质量 (布局按数据自适应, 不新增必填参数):
      * 图宽随类目数增长(最大 20in); 长类目标签自动 换行 -> 旋转 40° -> 抽稀, 实测渲染后不重叠。
      * 数值标签密集时自动缩小/竖排, 仍碰撞则只标每系列峰值。
      * pie: 大扇区内百分比按底色对比度取白/深字, 小扇区(<6%)带引线在外侧标注且互不重叠。
      * scatter: 数值 x 轴 —— data['x'] 或 series[i]['x'] (与 labels 等长的数值), 或 labels 本身全为数字;
        否则退化为按类目序号排布。line/area 用整数位置, 重复的类目名不会叠到同一刻度。

    Args:
        path: Output .png path.
        chart_type: 'bar' | 'line' | 'pie' | 'scatter' | 'hbar' | 'stacked_bar' | 'area'.
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
    if ctype not in ("bar", "line", "pie", "scatter", "hbar", "stacked_bar", "area"):
        return {"error": f"chart_type 非法：{chart_type!r}，"
                          f"仅支持 bar | line | pie | scatter | hbar | stacked_bar | area"}
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
    # b3-P2: 不就地改写调用方传入的 data dict —— 归一化结果存局部副本,入参保持原样
    # (原实现 s["values"]=coerced 会污染调用方的 data,同一 dict 复用/重试时会带出副作用)。
    norm_series = []
    for i, s in enumerate(series):
        if not isinstance(s, dict) or "values" not in s:
            return {"error": f"第 {i + 1} 个系列格式错误，应为 {{'name':..., 'values':[...]}}"}
        vals = s.get("values")
        if not isinstance(vals, list) or len(vals) != len(labels):
            return {"error": f"系列 {s.get('name', i + 1)} 的 values 长度({len(vals) if isinstance(vals, list) else '?'}) "
                             f"必须等于 labels 长度({len(labels)})"}
        # 强制数值：非数值(如字符串)会被 matplotlib 当分类轴静默画错，这里直接拒绝。
        # 合法 int/float/数字字符串照常 float 化后回写，供下方各图路径使用。
        coerced = []
        for j, v in enumerate(vals):
            if isinstance(v, bool) or v is None:
                return {"error": f"series '{s.get('name', i + 1)}' 的第 {j + 1} 个值 {v!r} 不是数值，无法绘图"}
            try:
                fv = float(v)
                if not math.isfinite(fv):
                    return {"error": "series 第 " + str(j + 1) + " 个值 " + repr(v) + " 不是有限数值(NaN/inf),无法绘图"}
                coerced.append(fv)
            except (TypeError, ValueError):
                return {"error": f"series '{s.get('name', i + 1)}' 的第 {j + 1} 个值 {v!r} 不是数值，无法绘图"}
        norm_series.append({**s, "values": coerced})
    series = norm_series
    if ctype == "pie" and len(series) != 1:
        return {"error": "饼图只能有一个系列（single series），当前有 " + str(len(series)) + " 个"}
    if ctype == "pie":
        pvals = series[0]["values"]
        if any(v < 0 for v in pvals):
            return {"error": "饼图的数值不能为负（各扇区占比之和才有意义）"}
        if sum(pvals) <= 0:
            return {"error": "饼图的数值之和必须大于 0"}

    # scatter: numeric x from series['x'] / data['x'] / numeric category labels; else categorical index.
    scatter_x = [None] * len(series)
    if ctype == "scatter":
        for i, s in enumerate(series):
            raw = s.get("x", data.get("x"))
            explicit = raw is not None
            if raw is None:
                raw = labels
            xs = _numeric_list(raw, len(labels))
            if xs is None and explicit:
                return {"error": f"scatter 的 x 必须是与 labels 等长({len(labels)})的有限数值列表"}
            scatter_x[i] = xs

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

    plt, mpl_err = _load_pyplot()
    if mpl_err:
        return mpl_err
    font_info = _ensure_font()

    fig = None
    try:
        import numpy as np

        n = len(labels)
        ns = len(series)
        # figure size adapts to the data so categories / bars have room instead of being squeezed.
        if ctype == "pie":
            figsize = (9, 6.4)
        elif ctype == "hbar":
            figsize = (9.5, min(18.0, max(5.5, 0.30 * n * max(1.0, ns * 0.85) + 2.2)))
        else:
            figsize = (min(20.0, max(9.0, 0.42 * n * max(1.0, ns * 0.55) + 3.0)), 5.8)
        fig, ax = plt.subplots(figsize=figsize)

        multi_legend_kw = ({"loc": "center left", "bbox_to_anchor": (1.01, 0.5), "fontsize": 9}
                           if ns > 6 else {})
        x = np.arange(n)
        value_label_items = []   # (x, y, text, kind) -> placed collision-aware after the geometry is final

        if ctype == "bar":
            group_w = 0.8
            bar_w = group_w / ns
            for i, s in enumerate(series):
                offset = (i - (ns - 1) / 2) * bar_w
                bars = ax.bar(x + offset, s["values"], bar_w, label=s.get("name", f"系列{i+1}"),
                              color=palette[i % len(palette)])
                for rect in bars:
                    h = rect.get_height()
                    value_label_items.append((rect.get_x() + rect.get_width() / 2, h, _fmt(h), "v"))
            ax.set_xticks(x)
            ax.set_xticklabels(labels)
            ax.legend(**multi_legend_kw)

        elif ctype == "line":
            for i, s in enumerate(series):
                # integer x positions: duplicate category labels must not collapse onto one tick.
                ax.plot(x, s["values"], marker="o", linewidth=2,
                        label=s.get("name", f"系列{i+1}"), color=palette[i % len(palette)])
            ax.set_xticks(x)
            ax.set_xticklabels(labels)
            ax.legend(**multi_legend_kw)

        elif ctype == "scatter":
            for i, s in enumerate(series):
                xs = scatter_x[i]
                ax.scatter(xs if xs is not None else x, s["values"], label=s.get("name", f"系列{i+1}"),
                           color=palette[i % len(palette)], s=60, alpha=0.8)
            if all(sx is None for sx in scatter_x):
                ax.set_xticks(x)
                ax.set_xticklabels(labels)
            else:
                from matplotlib.ticker import MaxNLocator
                if all(float(v).is_integer() for sx in scatter_x if sx is not None for v in sx):
                    ax.xaxis.set_major_locator(MaxNLocator(integer=True))
            ax.legend(**multi_legend_kw)

        elif ctype == "hbar":
            y = list(range(n))
            group_w = 0.8
            bar_w = group_w / ns
            for i, s in enumerate(series):
                offset = (i - (ns - 1) / 2) * bar_w
                ypos = [yy + offset for yy in y]
                bars = ax.barh(ypos, s["values"], bar_w, label=s.get("name", f"系列{i+1}"),
                               color=palette[i % len(palette)])
                for rect in bars:
                    w = rect.get_width()
                    value_label_items.append((w, rect.get_y() + rect.get_height() / 2, _fmt(w), "h"))
            ax.set_yticks(y)
            ax.set_yticklabels([_wrap_units(str(lb), 30) for lb in labels])
            ax.invert_yaxis()  # first label reads top-to-bottom, matching labels 的顺序
            ax.legend(**multi_legend_kw)

        elif ctype == "stacked_bar":
            bottom = [0.0] * n
            for i, s in enumerate(series):
                vals = s["values"]
                ax.bar(x, vals, 0.6, bottom=bottom, label=s.get("name", f"系列{i+1}"),
                       color=palette[i % len(palette)])
                bottom = [b + v for b, v in zip(bottom, vals)]
            # 柱顶标注堆叠总和 (逐段标数值在窄段/深色底上易读不清，故只标总量)。
            for j, total in enumerate(bottom):
                value_label_items.append((j, total, _fmt(total), "v"))
            ax.set_xticks(x)
            ax.set_xticklabels(labels)
            ax.legend(**multi_legend_kw)

        elif ctype == "area":
            for i, s in enumerate(series):
                color = palette[i % len(palette)]
                ax.plot(x, s["values"], linewidth=2, label=s.get("name", f"系列{i+1}"), color=color)
                # 叠放而非累积堆叠：各系列独立填充到 0，靠 alpha=0.35 分辨重叠区域。
                ax.fill_between(x, s["values"], 0, color=color, alpha=0.35)
            ax.set_xticks(x)
            ax.set_xticklabels(labels)
            ax.legend(**multi_legend_kw)

        elif ctype == "pie":
            _draw_pie(ax, labels, series[0]["values"], palette, text_color)

        ax.set_title(str(title), fontsize=15, color=text_color, pad=12)

        if ctype != "pie":
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)
            ax.spines["left"].set_color(grid_color)
            ax.spines["bottom"].set_color(grid_color)
            ax.grid(axis=("x" if ctype == "hbar" else "y"), color=grid_color, linewidth=0.6, alpha=0.6)
            ax.set_axisbelow(True)
            ax.tick_params(colors=text_color)
            if value_label_items:
                # headroom so a label above the tallest bar is not clipped by the title/frame
                if ctype == "hbar":
                    ax.margins(x=0.12)
                else:
                    ax.margins(y=0.12)
            # v1.7.1 axis titles — font follows the CJK rcParams chain wired by _ensure_font.
            if axis_x:
                ax.set_xlabel(axis_x, fontsize=11, color=text_color, labelpad=8)
            if axis_y:
                ax.set_ylabel(axis_y, fontsize=11, color=text_color, labelpad=8)

            fig.tight_layout()
            label_fit = None
            if ctype != "hbar" and not (ctype == "scatter" and any(sx is not None for sx in scatter_x)):
                label_fit = _fit_category_labels(fig, ax, labels)
            if value_label_items:
                _place_value_labels(fig, ax, value_label_items, text_color, series)
        else:
            label_fit = None
            fig.tight_layout()

        office_io.atomic_save(
            path, lambda tmp: fig.savefig(tmp, format="png", dpi=150, bbox_inches="tight"), suffix=".png")
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
        if label_fit and label_fit != "as_is":
            out["label_layout"] = label_fit
        if font_info.get("warning"):
            out["warning"] = font_info["warning"]
        return out
    except Exception as e:  # noqa: BLE001
        if fig is not None:
            try:
                plt.close(fig)
            except Exception:
                pass
        return office_io.io_failure(e, path, prefix="制图失败：")


def _numeric_list(raw, n):
    """raw -> list of n finite floats, or None if it is not one (bools / non-numeric strings rejected)."""
    if not isinstance(raw, list) or len(raw) != n:
        return None
    out = []
    for v in raw:
        if isinstance(v, bool) or v is None:
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(f):
            return None
        out.append(f)
    return out


def _fmt(v) -> str:
    """Compact numeric label: drop the trailing .0 on integers."""
    try:
        f = float(v)
        if f == int(f):
            return str(int(f))
        return f"{f:.2f}".rstrip("0").rstrip(".")
    except Exception:
        return str(v)


# --------------------------------------------------------------------------------------------
# layout helpers (all measure with the real Agg renderer)
# --------------------------------------------------------------------------------------------
def _units(s) -> int:
    """Display width in half-em units (CJK / full-width = 2)."""
    return sum(2 if ord(ch) > 0x2E7F else 1 for ch in str(s))


def _wrap_units(s: str, max_units: int) -> str:
    """Insert newlines so no line is wider than max_units (CJK char = 2). Latin text with spaces breaks
    at spaces; unbroken text (CJK, IDs) breaks per character."""
    s = str(s)
    if _units(s) <= max_units:
        return s
    if " " in s.strip():
        import textwrap
        return "\n".join(textwrap.wrap(s, width=max(4, max_units), break_long_words=True))
    lines, cur, w = [], "", 0
    for ch in s:
        cw = 2 if ord(ch) > 0x2E7F else 1
        if w + cw > max_units and cur:
            lines.append(cur)
            cur, w = "", 0
        cur += ch
        w += cw
    if cur:
        lines.append(cur)
    return "\n".join(lines)


def _text_px(fig, text: str, fontsize: float) -> tuple:
    """(width_px, height_px) of `text` at fontsize on this figure's renderer."""
    from matplotlib.font_manager import FontProperties
    r = fig.canvas.get_renderer()
    prop = FontProperties(size=fontsize)
    w = h = 0.0
    lines = str(text).split("\n")
    for ln in lines:
        lw, lh, _d = r.get_text_width_height_descent(ln or " ", prop, False)
        w = max(w, lw)
        h = max(h, lh)
    return w, h * len(lines) * 1.15


def _fit_category_labels(fig, ax, labels, fontsize: float = 10.0):
    """Make the x category labels legible. Ladder: as-is -> wrap -> rotate 40 deg -> rotate + thin.

    Returns which step was needed ('as_is' | 'wrapped' | 'rotated' | 'thinned')."""
    import math as _m
    n = len(labels)
    if n == 0:
        return "as_is"
    str_labels = [str(lb) for lb in labels]
    fig.canvas.draw()
    slot = ax.get_window_extent().width / max(n, 1) if n > 1 else ax.get_window_extent().width
    pad = 6.0

    def widest(ls):
        return max(_text_px(fig, lb, fontsize)[0] for lb in ls)

    if widest(str_labels) + pad <= slot:
        return "as_is"

    # 1) wrap: derive chars/line from the slot width, keep to <= 3 lines
    unit_px = fontsize * fig.dpi / 72.0 * 0.5
    max_units = max(4, int((slot - pad) / unit_px))
    wrapped = [_wrap_units(lb, max_units) for lb in str_labels]
    if max(len(w.split("\n")) for w in wrapped) <= 3 and widest(wrapped) + pad <= slot:
        ax.set_xticklabels(wrapped, fontsize=fontsize)
        fig.tight_layout()
        return "wrapped"

    # 2) rotate 40 deg (right edge anchored at the tick): texts clear each other when the slot's
    #    perpendicular extent exceeds the line height.
    theta = _m.radians(40)
    line_h = _text_px(fig, "国Ag", fontsize)[1]
    step = 1
    while slot * step * _m.sin(theta) < line_h * 1.1 and step < n:
        step += 1
    shown = [lb if (i % step == 0) else "" for i, lb in enumerate(str_labels)]
    ax.set_xticklabels(shown, rotation=40, ha="right", rotation_mode="anchor", fontsize=fontsize)
    fig.tight_layout()
    return "rotated" if step == 1 else "thinned"


def _bboxes_overlap(boxes) -> bool:
    boxes = sorted(boxes, key=lambda b: b.x0)
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            if b.x0 >= a.x1:
                break
            if a.overlaps(b):
                return True
    return False


def _place_value_labels(fig, ax, items, color, series):
    """Draw value labels; if they collide shrink+rotate them, and if that still collides keep only the
    per-series peak. items: (x, y, text, 'v'|'h') with data coordinates."""
    def draw(fontsize, rotation):
        texts = []
        for (px, py, txt, kind) in items:
            if kind == "v":
                t = ax.annotate(txt, xy=(px, py), xytext=(0, 3), textcoords="offset points",
                                ha="center", va="bottom", fontsize=fontsize, color=color,
                                rotation=rotation)
            else:
                t = ax.annotate(txt, xy=(px, py), xytext=(3, 0), textcoords="offset points",
                                ha="left", va="center", fontsize=fontsize, color=color)
            texts.append(t)
        return texts

    def collide(texts):
        fig.canvas.draw()
        r = fig.canvas.get_renderer()
        return _bboxes_overlap([t.get_window_extent(r) for t in texts])

    texts = draw(8, 0)
    if not collide(texts):
        return "all"
    for t in texts:
        t.remove()
    if items and items[0][3] == "v":
        texts = draw(7, 90)
        if not collide(texts):
            return "rotated"
        for t in texts:
            t.remove()
    if len(items) <= 12:
        texts = draw(7, 0)
        if not collide(texts):
            return "small"
        for t in texts:
            t.remove()
    # dense: label only the tallest item (at most one per series' worth of items)
    keep = max(1, len(series))
    ranked = sorted(range(len(items)), key=lambda k: -abs(items[k][1] if items[k][3] == "v" else items[k][0]))
    subset = [items[k] for k in ranked[:keep]]
    for (px, py, txt, kind) in subset:
        if kind == "v":
            ax.annotate(txt, xy=(px, py), xytext=(0, 3), textcoords="offset points",
                        ha="center", va="bottom", fontsize=8, color=color)
        else:
            ax.annotate(txt, xy=(px, py), xytext=(3, 0), textcoords="offset points",
                        ha="left", va="center", fontsize=8, color=color)
    return "peaks"


def _rel_luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    chans = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        chans.append(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * chans[0] + 0.7152 * chans[1] + 0.0722 * chans[2]


def _contrast_text_color(bg_hex: str) -> str:
    """White or near-black, whichever reads better on `bg_hex` (WCAG contrast ratio)."""
    lum = _rel_luminance(bg_hex)
    dark, dark_lum = "#1F2937", _rel_luminance("#1F2937")
    white_ratio = 1.05 / (lum + 0.05)
    dark_ratio = (lum + 0.05) / (dark_lum + 0.05)
    return "#FFFFFF" if white_ratio >= dark_ratio else dark


def _draw_pie(ax, labels, values, palette, text_color):
    """Pie with contrast-aware percent text inside big slices and leader-lined, collision-free outside
    labels (small slices carry their percent in the outside label)."""
    import math as _m
    total = float(sum(values))
    colors = [palette[i % len(palette)] for i in range(len(labels))]
    wedges, _ = ax.pie(values, colors=colors, startangle=90, counterclock=False,
                       wedgeprops={"edgecolor": "white", "linewidth": 1.2})
    ax.axis("equal")
    ax.set_xlim(-1.75, 1.75)
    ax.set_ylim(-1.45, 1.45)

    entries = []   # (side, y_target, text, edge_xy, index)
    for i, w in enumerate(wedges):
        pct = float(values[i]) / total * 100.0
        ang = _m.radians((w.theta1 + w.theta2) / 2.0)
        ex, ey = _m.cos(ang), _m.sin(ang)
        if pct >= 6.0:
            ax.text(0.62 * ex, 0.62 * ey, f"{pct:.1f}%", ha="center", va="center", fontsize=10,
                    fontweight="bold", color=_contrast_text_color(colors[i]))
            txt = str(labels[i])
        else:
            txt = f"{labels[i]}  {pct:.1f}%"
        entries.append(("r" if ex >= 0 else "l", 1.22 * ey, txt, (ex, ey), i))

    for side in ("r", "l"):
        group = sorted([e for e in entries if e[0] == side], key=lambda e: -e[1])
        # forward pass from the top: keep a minimum vertical gap, then pull back up from the bottom
        gap = 0.16
        ys = []
        for e in group:
            y = e[1] if not ys else min(e[1], ys[-1] - gap)
            ys.append(y)
        floor = -1.35
        if ys and ys[-1] < floor:
            ys[-1] = floor
            for k in range(len(ys) - 2, -1, -1):
                ys[k] = max(ys[k], ys[k + 1] + gap)
        for e, y in zip(group, ys):
            _, _, txt, (ex, ey), _i = e
            sx = 1.0 if side == "r" else -1.0
            ax.plot([ex, 1.08 * ex, sx * 1.30], [ey, 1.08 * ey, y], color="#9AA0A6", linewidth=0.8,
                    solid_capstyle="round", clip_on=False)
            ax.text(sx * 1.34, y, txt, ha="left" if side == "r" else "right", va="center",
                    fontsize=10, color=text_color)
