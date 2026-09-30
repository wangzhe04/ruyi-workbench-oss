"""markdown-lite parser shared by write_document (docx) and write_pdf.

Pure stdlib, no MCP tools. It turns the text LLMs actually emit into a flat list of block tuples that the
two renderers walk; the renderers own all layout/typography.

Block tuples (first item is the kind):
    ("blank",)
    ("heading", level 1..3, text)                 '#'..'######' (4+ collapse to 3)
    ("bullet", level 0..2, text)                  '-', '*', '+' markers, indentation = nesting
    ("number", level 0..2, text, number, list_id, first)   numbered item; list_id is unique per list,
                                                  first=True on the first item of a (new) list, number is the
                                                  source number (the list's start is the first item's number)
    ("table", headers, rows, aligns)              legacy 'TABLE: a | b' block OR GFM pipe table
    ("quote", text)                               '> text'
    ("code", [lines])                             fenced ``` block
    ("rule",)                                     '---' / '***' / '___'
    ("para", text)

Inline markup is parsed separately by parse_inline() into (text, fmt) segments where fmt is a dict with
optional keys bold / italic / code / url.
"""

import re

_TAB = 4

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET = re.compile(r"^([-*+])\s+(.*)$")
_NUMBER = re.compile(r"^(\d+)[.)]\s+(.*)$")
_RULE = re.compile(r"^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$")   # ---, - - -, ***, * * *
_FENCE = re.compile(r"^(`{3,}|~{3,})")
_GFM_SEP_CELL = re.compile(r"^:?-+:?$")


def _indent_of(raw: str) -> int:
    n = 0
    for ch in raw:
        if ch == " ":
            n += 1
        elif ch == "\t":
            n += _TAB
        else:
            break
    return n


def split_row(stripped: str) -> list:
    """Split a pipe row into trimmed cells, honouring '\\|' escapes and dropping the outer pipes."""
    s = stripped.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    cells, cur, i = [], [], 0
    while i < len(s):
        ch = s[i]
        if ch == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            cur.append("|")
            i += 2
            continue
        if ch == "|":
            cells.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    cells.append("".join(cur).strip())
    return cells


def _gfm_aligns(sep_line: str):
    """Alignment list for a GFM separator row ('|---|:--:|--:|'), or None when it is not one."""
    s = sep_line.strip()
    if "-" not in s or "|" not in s:      # bare '---' is a rule, not a table separator
        return None
    cells = split_row(s)
    if not cells or not all(_GFM_SEP_CELL.match(c) for c in cells):
        return None
    out = []
    for c in cells:
        left, right = c.startswith(":"), c.endswith(":")
        out.append("center" if left and right else ("right" if right else "left"))
    return out


def parse_blocks(content: str) -> list:
    lines = str(content).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list = []

    indent_stack: list = []          # indentation widths of the currently open list nest
    list_serial = 0                  # unique id source for numbered lists
    open_lists: dict = {}            # level -> (list_id, last_number) for numbered lists
    state = {"blank": False}

    def _level_for(indent: int) -> int:
        while indent_stack and indent < indent_stack[-1]:
            indent_stack.pop()
        if not indent_stack:
            indent_stack.append(indent)
            return 0
        if indent >= indent_stack[-1] + 2:
            indent_stack.append(indent)
        return min(len(indent_stack) - 1, 2)

    def _break_lists():
        indent_stack.clear()
        open_lists.clear()

    i, n = 0, len(lines)
    while i < n:
        raw = lines[i]
        stripped = raw.strip()

        # fenced code block --------------------------------------------------
        if _FENCE.match(stripped):
            fence = _FENCE.match(stripped).group(1)   # 4+ backticks fence blocks that contain ``` lines
            body = []
            i += 1
            while i < n and not lines[i].strip().startswith(fence):
                body.append(lines[i])
                i += 1
            i += 1  # closing fence (or EOF)
            _break_lists()
            blocks.append(("code", body))
            state["blank"] = False
            continue

        # legacy TABLE: block ------------------------------------------------
        if stripped.upper().startswith("TABLE:"):
            headers = [c.strip() for c in stripped[6:].split("|") if c.strip()]
            rows = []
            i += 1
            while i < n:
                s2 = lines[i].strip()
                if not s2 or not s2.startswith("|"):
                    break
                rows.append([c.strip() for c in s2.strip("|").split("|")])
                i += 1
            if not headers and rows:          # 空表头时首行提升为表头,内容不丢
                headers, rows = rows[0], rows[1:]
            _break_lists()
            if headers:
                blocks.append(("table", headers, rows, None))
            state["blank"] = False
            continue

        if not stripped:
            blocks.append(("blank",))
            state["blank"] = True
            i += 1
            continue

        # GFM pipe table ------------------------------------------------------
        if "|" in stripped and i + 1 < n:
            aligns = _gfm_aligns(lines[i + 1])
            if aligns is not None:
                headers = split_row(stripped)
                rows = []
                j = i + 2
                while j < n and lines[j].strip() and "|" in lines[j]:
                    rows.append(split_row(lines[j]))
                    j += 1
                i = j
                _break_lists()
                blocks.append(("table", headers, rows, aligns))
                state["blank"] = False
                continue

        if _RULE.match(stripped):
            _break_lists()
            blocks.append(("rule",))
            state["blank"] = False
            i += 1
            continue

        m = _HEADING.match(stripped)
        if m:
            _break_lists()
            text = re.sub(r"\s+#+\s*$", "", m.group(2).strip())
            blocks.append(("heading", min(len(m.group(1)), 3), text))
            state["blank"] = False
            i += 1
            continue

        if stripped.startswith(">"):
            _break_lists()
            blocks.append(("quote", stripped.lstrip(">").strip()))
            state["blank"] = False
            i += 1
            continue

        indent = _indent_of(raw)

        m = _BULLET.match(stripped)
        if m and m.group(2).strip():
            level = _level_for(indent)
            for lv in [k for k in open_lists if k >= level]:
                del open_lists[lv]
            blocks.append(("bullet", level, m.group(2).strip()))
            state["blank"] = False
            i += 1
            continue

        m = _NUMBER.match(stripped)
        if m:
            level = _level_for(indent)
            num = int(m.group(1))
            for lv in [k for k in open_lists if k > level]:
                del open_lists[lv]
            cur = open_lists.get(level)
            new_list = cur is None or (state["blank"] and num == 1)
            if new_list:
                list_serial += 1
                cur = (list_serial, 0)
            blocks.append(("number", level, m.group(2).strip(), num, cur[0], new_list))
            open_lists[level] = (cur[0], num)
            state["blank"] = False
            i += 1
            continue

        # plain paragraph (also ends any list)
        _break_lists()
        blocks.append(("para", stripped))
        state["blank"] = False
        i += 1

    return blocks


# ---------------------------------------------------------------------------------------------
# inline
# ---------------------------------------------------------------------------------------------
_INLINE = re.compile(
    r"(?P<esc>\\[\\`*_{}\[\]()#+\-.!|>~])"
    r"|(?<!`)(?P<tick>`+)(?!`)(?P<codetext>.+?)(?<!`)(?P=tick)(?!`)"
    r"|\[(?P<ltext>[^\]\n]+)\]\((?P<lurl>[^)\s]+)(?:\s+\"[^\"]*\")?\)"
    r"|\*\*\*(?P<bi>[^\s*](?:[^*]*?[^\s*])?)\*\*\*"
    r"|\*\*(?P<b1>[^\s*](?:.*?[^\s*])??)\*\*"
    r"|(?<![\w])__(?P<b2>[^\s_](?:.*?[^\s_])??)__(?![\w])"
    r"|\*(?P<i1>[^\s*](?:[^*]*?[^\s*])?)\*"
    r"|(?<![\w])_(?P<i2>[^\s_](?:[^_]*?[^\s_])?)_(?![\w])"
)


def parse_inline(text: str, _fmt: dict | None = None) -> list:
    """Parse **bold** / *italic* / `code` / [text](url) into [(text, fmt)] segments. Unmatched markers
    stay literal. Nesting (bold inside a link, italic inside bold, ...) is handled by recursion."""
    base = dict(_fmt or {})
    out: list = []
    pos = 0
    s = str(text)

    def _emit(t, f):
        if not t:
            return
        if out and out[-1][1] == f:
            out[-1] = (out[-1][0] + t, f)
        else:
            out.append((t, f))

    for m in _INLINE.finditer(s):
        if m.start() > pos:
            _emit(s[pos:m.start()], base)
        pos = m.end()
        if m.group("esc"):
            _emit(m.group("esc")[1:], base)
        elif m.group("codetext") is not None:
            _emit(m.group("codetext"), {**base, "code": True})
        elif m.group("lurl") is not None:
            for t, f in parse_inline(m.group("ltext"), {**base, "url": m.group("lurl")}):
                _emit(t, f)
        elif m.group("bi") is not None:
            for t, f in parse_inline(m.group("bi"), {**base, "bold": True, "italic": True}):
                _emit(t, f)
        elif m.group("b1") is not None or m.group("b2") is not None:
            inner = m.group("b1") if m.group("b1") is not None else m.group("b2")
            for t, f in parse_inline(inner, {**base, "bold": True}):
                _emit(t, f)
        else:
            inner = m.group("i1") if m.group("i1") is not None else m.group("i2")
            for t, f in parse_inline(inner, {**base, "italic": True}):
                _emit(t, f)
    if pos < len(s):
        _emit(s[pos:], base)
    return out


def plain_text(text: str) -> str:
    """Inline markup stripped (for width estimates / plain fallbacks)."""
    return "".join(t for t, _ in parse_inline(text))


_SAFE_URL = re.compile(r"^(https?://|mailto:)", re.I)


def is_safe_url(url: str) -> bool:
    return bool(_SAFE_URL.match(str(url or "")))
