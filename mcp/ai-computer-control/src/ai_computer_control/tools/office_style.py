"""Design-token layer for the Office beautify/generate tools (v1.7 "Office 体系 2.0").

Rationale (用户拍板): being able to *drive* Word/Excel/PPT is not the same as producing something
that *looks good*. We do not bet on the model's on-the-spot aesthetics (especially flash-tier
models) — instead we ship pre-designed "模板" as programmatic design tokens (colour / font / spacing
constants) and let the AI fill in only the content. This module is that "template": every Office tool
(write_document, write_excel, excel_beautify, excel_chart, write_pptx, chart_image) pulls its colours,
fonts and chart palette from STYLES here. No binary template assets are introduced.

Colours are stored as 6-hex RGB strings WITHOUT a leading '#' (openpyxl wants 'FF'+RRGGBB or RRGGBB;
python-pptx wants an RGBColor; python-docx/lxml wants 'RRGGBB'; matplotlib wants '#RRGGBB'). Helpers
below adapt to each consumer so callers never juggle formats.

Three styles ship; 'business' is the default. v1.7 gives each a full **name & identity** matching the
把关人 定稿方向, and adds a complete Word token block (title/heading colour, underline线色, cover背景底):
  * business — 「青花商务」: 藏蓝 / 青花蓝 (2F5597 系) + **鎏金 C9A860** 强调. The 鎏金 呼应「如意」品牌.
               Conservative, corporate, the safe default.
  * minimal  — 「墨白极简」: 近墨黑 (222) 标题 + 单一强调青 (3B7C8C), hairline greys, 大留白. Editorial.
  * vibrant  — 「活力现代」: 靛蓝 (4F46E5) + 珊瑚 (F97066), 大色块. For pitches & marketing.

鎏金取舍 (WCAG 实测, 见 v1.7 交付报告):
  鎏金 C9A860 vs 白 = 2.27 对比度 —— 达不到 3.0 图形阈值，白底上金线/金字会发灰糊看不清.
  鎏金 C9A860 vs 藏蓝底 = 5.12 —— 深底上金色极佳.
  ∴ `accent` (鎏金) 只用在**深底**元素 (Word 封面题块金线 / PPT 封面·收尾金色下划线，背景是藏蓝→5.12);
    白底上要画线/字的元素 (Word 正文标题下 2.25pt 细横线) 改用 `accent_on_light` = 古铜金 A67B2E
    (vs 白 = 3.82，过 3.0 图形阈值，仍属「金」家族，与鎏金同调而更沉). minimal / vibrant 两色都够深,
    其 accent == accent_on_light. PPT content 标题栏下划线用 accent_on_light (画在白底正文区顶).

中文字体是生死线 (target machine is 中文 Windows): body/heading font names are Chinese-Windows font
family names ('微软雅黑' / '黑体' / '宋体') that python-docx / openpyxl / python-pptx write verbatim into
the file, so Office resolves the real CJK font at open time. python-docx additionally needs the
`w:eastAsia` rFonts attribute set by hand or CJK runs fall back to the theme's minor-EA font (see
document.py _set_style_font). matplotlib needs an actual font *file*, resolved separately via
font_chain() below (probing C:\\Windows\\Fonts at call time).
"""

import os

# ---------------------------------------------------------------------------------------------
# The token tables. Each style is a flat dict so consumers can read keys directly.
#
#   --- shared / brand ---
#   name           风格中文名     — 「青花商务」/「墨白极简」/「活力现代」(for docs & samples)
#   primary        主色           — header fills, title text, chart series #1
#   accent         强调色 (深底)  — emphasis drawn ON DARK backgrounds (cover lines). business=鎏金.
#   accent_on_light 强调色 (白底) — emphasis drawn ON WHITE (body title underlines). business=古铜金.
#   header_font_color            表头字色 (text drawn on the primary fill; white for dark primaries)
#   header_fill    表头填充       — usually == primary
#   body_font      正文字体       — CJK family name written verbatim into the Office file
#   title_font     标题字体       — may differ from body for hierarchy
#   zebra_fill     斑马纹         — the tint used on alternating rows (very light)
#   border_color   边框灰         — hairline table/grid borders
#   text_color     正文字色       — default body text
#   subtle_color   次要字色       — captions, footers, page numbers
#   chart_palette  图表配色序列 (>=6) — series colours, cycled in order
#
#   --- cover / stats (PPT & Word 封面) ---
#   title_bg       封面/收尾整版满铺底色 — the full-bleed dark cover background (Word cover + PPT
#                  title & closing). Usually == primary; white/light text drawn on top.
#   on_dark_subtle 深底上的次要字色 — light approximating "white @ ~75%" for subtitles / dates on the
#                  dark title_bg (subtle_color is for LIGHT backgrounds).
#   card_fill      数字卡片底色 — a very light tint of primary (~8% over white) for stats cards.
#
#   --- Word 专用 (v1.7 new) ---
#   word_title_color   Title 样式字色 (封面/正文大标题主色，== primary 深色)
#   word_heading_color H1-H3 标题字色 (== primary)
#   word_rule_color    标题下 2.25pt 细横线色 (白底 → accent_on_light)
#   word_cover_bg      封面题块满铺底色 (== title_bg 深底)
#   word_cover_fg      封面题块上的主字色 (白)
#   word_cover_sub     封面副题/日期字色 (深底上 → on_dark_subtle)
#
#   --- 版式个性选择器 (v1.7.1 new) —— 让三套设计系统各有独立设计语言，不是「换色的方案一」---
#   pptx_cover   PPT 封面/收尾版式:
#                  'dark_center' business — 深底满铺 + 居中白大字 + 金短线 (v1.6.1 原样，不动)
#                  'light_left'  minimal  — 纯白底 + 左对齐超大墨黑标题 + 左侧 4pt 青竖线贯穿题区 + 右下极小页脚
#                  'dark_deco'   vibrant  — 深靛底 + 右下角珊瑚/浅靛几何装饰 + 居中白粗标题
#   pptx_content_title  内容页标题栏版式:
#                  'bar'      business/vibrant — 主色满铺横幅 (+ vibrant 右端珊瑚小圆点收尾)
#                  'bigtext'  minimal — 无色块，墨黑大字 + 其下细青线
#   pptx_stats   数字卡片版式:
#                  'top_bar'   business — 卡片顶部主色细条 + 大数字 (v1.6.1 原样)
#                  'top_rule'  minimal  — 无填充卡片，仅顶部 2pt 青线 + 大数字墨黑
#                  'rounded'   vibrant  — 真圆角卡片 (roundRect adj≈0.12) + 主色顶条
#   excel_header 表头版式:
#                  'fill'      business/vibrant — 主色满底 + 白粗字
#                  'underline' minimal — 白底墨黑粗字 + 底部 2pt 青色下边框
#   word_cover   Word 封面版式:
#                  'dark_block' business/vibrant — 深底满铺题块 (v1.7 原样)
#                  'light_top'  minimal — 白底，墨黑特大字置于页面上 1/3，下方细青线，副题灰
#   word_heading_rule  Word 正文标题强调线方位:
#                  'bottom' business/vibrant — 标题下 2.25pt 细横线 (v1.7 原样)
#                  'left'   minimal — 无底纹，仅左侧青色细竖线 (段落左边框)
#   word_cover_bar   vibrant 专用: Word 封面题块下沿的珊瑚粗条 (0.3in) 的 6-hex 色；无此键 = 不画。
#   deco_1 / deco_2  vibrant 封面几何装饰色 (珊瑚 / 浅靛)；其它风格用不到 (给合理缺省)。
# All colours are 6-hex RRGGBB (no '#').
# ---------------------------------------------------------------------------------------------
STYLES: dict[str, dict] = {
    "business": {
        "name": "青花商务",
        "primary": "2F5597",          # 青花藏蓝 — deep porcelain-blue
        "accent": "C9A860",           # 鎏金 — gilt (ON DARK only; 5.12 vs navy)
        "accent_on_light": "A67B2E",  # 古铜金 — antique bronze-gold for white backgrounds (3.82 vs 白)
        "header_font_color": "FFFFFF",
        "header_fill": "2F5597",
        "body_font": "微软雅黑",
        "title_font": "微软雅黑",
        "zebra_fill": "EAF0F9",       # very light 青花 tint
        "border_color": "BFBFBF",
        "text_color": "1F1F1F",
        "subtle_color": "7F7F7F",
        "chart_palette": ["2F5597", "C9A860", "548235", "1F6F86",
                          "7030A0", "BF9000", "A6A6A6", "843C0C"],
        "title_bg": "1F3864",         # deeper navy full-bleed cover (gold 鎏金 pops on it: 5.12)
        "on_dark_subtle": "C5CFE2",   # light blue-grey subtitle on the dark cover
        "card_fill": "EEF1F7",        # ~8% primary tint for stats cards
        # Word
        "word_title_color": "1F3864", # cover big-title & Title style = deep navy
        "word_heading_color": "2F5597",
        "word_rule_color": "A67B2E",  # 古铜金 hairline under headings (on white)
        "word_cover_bg": "1F3864",
        "word_cover_fg": "FFFFFF",
        "word_cover_sub": "C5CFE2",
        # v1.7.1 版式个性选择器 — business 全走 v1.6.1 原版式 (定稿默认，一字不动)
        "pptx_cover": "dark_center",
        "pptx_content_title": "bar",
        "pptx_stats": "top_bar",
        "excel_header": "fill",
        "word_cover": "dark_block",
        "word_heading_rule": "bottom",
        "deco_1": "C9A860",
        "deco_2": "2F5597",
    },
    "minimal": {
        "name": "墨白极简",
        "primary": "222222",          # 近墨黑 — near-black
        "accent": "3B7C8C",           # 强调青 — single restrained teal accent
        "accent_on_light": "3B7C8C",  # same (teal is dark enough on white: 4.72)
        "header_font_color": "FFFFFF",
        "header_fill": "222222",
        "body_font": "微软雅黑",
        "title_font": "微软雅黑",
        "zebra_fill": "F4F4F4",       # faint grey tint
        "border_color": "D9D9D9",
        "text_color": "222222",
        "subtle_color": "8C8C8C",
        "chart_palette": ["222222", "3B7C8C", "9E9E9E", "6B6B6B",
                          "B5651D", "3A7D44", "C0C0C0", "555555"],
        "title_bg": "222222",         # near-black full-bleed cover
        "on_dark_subtle": "C1C1C1",   # light grey subtitle on the dark cover
        "card_fill": "EDEDED",        # ~8% primary tint for stats cards
        # Word
        "word_title_color": "222222",
        "word_heading_color": "222222",
        "word_rule_color": "3B7C8C",  # thin teal rule under headings
        "word_cover_bg": "222222",
        "word_cover_fg": "FFFFFF",
        "word_cover_sub": "C1C1C1",
        # v1.7.1 墨白极简 — 高级文印/咨询装帧: 反转成白底大字 + 青色 hairline，去色块
        "pptx_cover": "light_left",
        "pptx_content_title": "bigtext",
        "pptx_stats": "top_rule",
        "excel_header": "underline",
        "word_cover": "light_top",
        "word_heading_rule": "left",
        "deco_1": "3B7C8C",
        "deco_2": "9E9E9E",
    },
    "vibrant": {
        "name": "活力现代",
        "primary": "4F46E5",          # 靛蓝 — energetic indigo
        "accent": "F97066",           # 珊瑚 — coral (ON DARK only; 2.79 vs 白 fails)
        "accent_on_light": "E14B3F",  # deeper coral-red for white backgrounds (3.98 vs 白)
        "header_font_color": "FFFFFF",
        "header_fill": "4F46E5",
        "body_font": "微软雅黑",
        "title_font": "微软雅黑",
        "zebra_fill": "EEEDFC",       # light indigo tint
        "border_color": "D6D3F0",
        "text_color": "1E1B34",
        "subtle_color": "6E6A8F",
        "chart_palette": ["4F46E5", "F97066", "F2B134", "10B981",
                          "3B7DD8", "9B5DE5", "00BBF9", "E85D8A"],
        "title_bg": "3730A3",         # deep indigo full-bleed cover (coral pops on it)
        "on_dark_subtle": "C9C6F2",   # pale indigo subtitle on the dark cover
        "card_fill": "EEEDFC",        # ~8% primary tint for stats cards
        # Word
        "word_title_color": "3730A3", # deep indigo cover title
        "word_heading_color": "4F46E5",
        "word_rule_color": "E14B3F",  # deeper coral rule under headings (on white)
        "word_cover_bg": "3730A3",
        "word_cover_fg": "FFFFFF",
        "word_cover_sub": "C9C6F2",
        # v1.7.1 活力现代 — 新锐发布会: 深底几何装饰 + 真圆角卡 + 珊瑚收尾点
        "pptx_cover": "dark_deco",
        "pptx_content_title": "bar",       # 保留色块横幅，右端加珊瑚小圆点收尾 (由 pptx_accent_dot 触发)
        "pptx_stats": "rounded",
        "excel_header": "fill",
        "word_cover": "dark_block",
        "word_heading_rule": "bottom",
        "word_cover_bar": "F97066",        # 封面题块下沿 0.3in 珊瑚粗条
        "pptx_accent_dot": True,           # content 标题栏右端珊瑚小圆点
        "deco_1": "F97066",                # 珊瑚
        "deco_2": "6366F1",                # 浅靛 (比 primary 4F46E5 稍亮的一档)
    },
}

DEFAULT_STYLE = "business"


def get_style(style: str | None) -> dict:
    """Return the token dict for `style`, falling back to the 'business' default for None/unknown.

    Never raises — an unknown style silently yields the default so a bad style name never breaks a
    document generation. Returns a *copy* so callers can't mutate the shared table.
    """
    key = (style or DEFAULT_STYLE)
    if not isinstance(key, str) or key not in STYLES:
        key = DEFAULT_STYLE
    return dict(STYLES[key])


def style_names() -> list[str]:
    """The available style names, default first."""
    return [DEFAULT_STYLE] + [k for k in STYLES if k != DEFAULT_STYLE]


# --- colour adapters ---------------------------------------------------------------------------
def hex_hash(color: str) -> str:
    """'2F5597' -> '#2F5597' (for matplotlib). Idempotent if a '#' is already present."""
    c = str(color).lstrip("#")
    return "#" + c


def argb(color: str) -> str:
    """'2F5597' -> 'FF2F5597' (openpyxl PatternFill/Font/Color want an 8-hex ARGB, opaque)."""
    c = str(color).lstrip("#").upper()
    if len(c) == 8:
        return c
    return "FF" + c


def rgb_tuple(color: str) -> tuple[int, int, int]:
    """'2F5597' -> (47, 85, 151) for python-pptx RGBColor(*tuple)."""
    c = str(color).lstrip("#")
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


# --- CJK font-file chain for matplotlib --------------------------------------------------------
# matplotlib does NOT accept a bare family name reliably on a fresh box (its font cache may not know
# '微软雅黑'); it needs a real .ttf/.ttc file. We probe the known Windows font files in preference
# order — Microsoft YaHei -> SimHei -> SimSun — and hand matplotlib the first that exists. Mirrors the
# write_pdf font chain in document.py. Cached after first resolution.
_FONT_CHAIN_CACHE: dict | None = None

# (family-name-for-matplotlib, absolute font file). family-name is what we set into rcParams AND what
# FontProperties uses; we register the file under that name so the two always agree.
_FONT_CANDIDATES = [
    ("Microsoft YaHei", r"C:\Windows\Fonts\msyh.ttc"),
    ("SimHei", r"C:\Windows\Fonts\simhei.ttf"),
    ("SimSun", r"C:\Windows\Fonts\simsun.ttc"),
]


def font_chain() -> dict:
    """Resolve a CJK font FILE for matplotlib. Returns a dict:

        {"family": <name>, "path": <abs font file>}                 on success
        {"family": None,   "path": None, "warning": <中文人话>}      when no CJK font file is found

    Probes C:\\Windows\\Fonts for msyh.ttc -> simhei.ttf -> simsun.ttc at call time (existence check).
    Cached after the first call.
    """
    global _FONT_CHAIN_CACHE
    if _FONT_CHAIN_CACHE is not None:
        return _FONT_CHAIN_CACHE
    for family, path in _FONT_CANDIDATES:
        if os.path.exists(path):
            _FONT_CHAIN_CACHE = {"family": family, "path": path}
            return _FONT_CHAIN_CACHE
    _FONT_CHAIN_CACHE = {
        "family": None,
        "path": None,
        "warning": "未找到中文字体（msyh/simhei/simsun），图中中文可能显示为方块",
    }
    return _FONT_CHAIN_CACHE
