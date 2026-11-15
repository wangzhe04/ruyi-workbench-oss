"""Backend-independent OCR word/phrase matching and miss diagnostics."""

def _is_cjk(s: str) -> bool:
    """True if `s` contains CJK ideographs (used to decide no-space phrase joining)."""
    for ch in s:
        o = ord(ch)
        if 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF or 0x3040 <= o <= 0x30FF \
                or 0xAC00 <= o <= 0xD7AF or 0xFF00 <= o <= 0xFFEF:
            return True
    return False


def _line_groups(words: list[dict]) -> list[list[int]]:
    """Indices of `words` grouped by text line, in reading order.

    Uses the engine's own 'line' index when every word carries one; otherwise (hand-built lists, older
    callers) infers lines geometrically: a new line starts when the next word's vertical centre leaves
    the previous word's box band or it starts left of where the previous word ended.
    """
    if not words:
        return []
    if all("line" in w for w in words):
        groups: dict = {}
        for idx, w in enumerate(words):
            groups.setdefault(w["line"], []).append(idx)
        return [groups[k] for k in sorted(groups, key=lambda k: groups[k][0])]
    out: list[list[int]] = [[0]]
    for idx in range(1, len(words)):
        prev, cur = words[idx - 1], words[idx]
        prev_cy = prev["top"] + prev["height"] / 2.0
        cur_cy = cur["top"] + cur["height"] / 2.0
        band = max(1.0, 0.6 * max(prev["height"], cur["height"]))
        backwards = cur["left"] < prev["left"] + prev["width"] - max(2, 0.5 * min(prev["width"], cur["width"]))
        if abs(cur_cy - prev_cy) > band or backwards:
            out.append([idx])
        else:
            out[-1].append(idx)
    return out


def _stream_hits(stream: list[tuple[int, str]], needle: str, joiner: str) -> list[tuple[int, int]]:
    """Non-overlapping occurrences of `needle` in the words of `stream` joined by `joiner`.

    Returns (first_pos, last_pos) stream positions of the words each occurrence overlaps - exactly the
    words that carry the match, no unrelated neighbours.
    """
    spans, parts, cursor = [], [], 0
    for pos, (_idx, txt) in enumerate(stream):
        if parts:
            cursor += len(joiner)
        spans.append((cursor, cursor + len(txt)))
        parts.append(txt)
        cursor += len(txt)
    hay = joiner.join(parts)
    hits, start = [], 0
    while needle:
        at = hay.find(needle, start)
        if at < 0:
            break
        end = at + len(needle)
        covered = [pos for pos, (a, b) in enumerate(spans) if b > at and a < end and b > a]
        if covered:
            hits.append((covered[0], covered[-1]))
        start = end
    return hits


def _phrase_matches(words: list[dict], text: str) -> list[dict]:
    """Every match of `text` (case-insensitive) in reading order, each spanning exactly its own words.

    1. Single-word matches: `text` contained in one OCR word (CJK: also ignoring spaces).
    2. If there are none, phrase matches: consecutive words of ONE LINE whose joined text contains `text`
       (Latin: joined with a space; CJK: ALSO joined without, so "系统设置" matches ["系统","设置"]).
       Lines are never joined with each other unless `text` itself contains a line break.
    Each match is {rect, center, matched_text, match_type: 'word'|'phrase', word_count}; the rect is the
    union box of only the matched words and `center` is that box's centre (the click point).
    """
    raw = str(text or "")
    target = " ".join(raw.lower().split())
    if not target:
        return []
    cjk = _is_cjk(raw)
    target_ns = target.replace(" ", "") if cjk else None

    singles = []
    for w in words:
        wt = str(w.get("text", "")).lower()
        if target in wt or (target_ns and target_ns in wt.replace(" ", "")):
            singles.append(_span([w], w["text"], "word"))
    if singles:
        return singles

    if "\n" in raw or "\r" in raw:
        groups = [list(range(len(words)))]  # the phrase itself spans lines: one stream over the page
    else:
        groups = _line_groups(words)
    found: list[tuple[int, int]] = []  # (first_word_idx, last_word_idx)
    for grp in groups:
        stream = [(idx, str(words[idx].get("text", "")).lower()) for idx in grp
                  if str(words[idx].get("text", "")).strip()]
        if len(stream) < 2:
            continue
        hits = _stream_hits(stream, target, " ")
        if cjk:
            ns_stream = [(idx, t.replace(" ", "")) for idx, t in stream]
            hits += _stream_hits(ns_stream, target_ns, "")
        for a, b in hits:
            pair = (stream[a][0], stream[b][0])
            if pair[0] != pair[1] and pair not in found:
                found.append(pair)
    found.sort()
    out = []
    for first, last in found:
        grp_words = [words[k] for k in range(first, last + 1)
                     if str(words[k].get("text", "")).strip()]
        out.append(_span(grp_words, " ".join(str(x["text"]) for x in grp_words), "phrase"))
    return out


def _find_phrase(words: list[dict], text: str) -> dict | None:
    """First match of `text` in reading order (see _phrase_matches), or None.

    The returned rect/center cover exactly the matched words (never unrelated leading words), so the
    centre is a safe click point; a phrase never spans two text lines unless `text` has a line break.
    """
    hits = _phrase_matches(words, text)
    return hits[0] if hits else None


def _span(group: list[dict], matched: str, match_type: str = "phrase") -> dict:
    left = min(w["left"] for w in group)
    top = min(w["top"] for w in group)
    right = max(w["left"] + w["width"] for w in group)
    bottom = max(w["top"] + w["height"] for w in group)
    if len(group) == 1 and group[0].get("center"):
        center = list(group[0]["center"])
    else:
        center = [int((left + right) / 2), int((top + bottom) / 2)]
    return {"rect": {"left": left, "top": top, "width": right - left, "height": bottom - top},
            "center": center, "matched_text": matched, "match_type": match_type,
            "word_count": len(group)}


def _near_matches(words: list[dict], text: str, limit: int = 5, min_score: float = 0.6) -> list[dict]:
    """Closest OCR candidates for a missed query: single words plus 2-3 word joins within a line."""
    import difflib
    target = " ".join(str(text or "").lower().split())
    if not target:
        return []
    cands = []
    for grp in _line_groups(words):
        ws = [words[i] for i in grp if str(words[i].get("text", "")).strip()]
        for n in (1, 2, 3):
            for k in range(0, len(ws) - n + 1):
                chunk = ws[k:k + n]
                cands.append((" ".join(str(c["text"]) for c in chunk), chunk))
    scored = []
    sm = difflib.SequenceMatcher(autojunk=False)
    sm.set_seq2(target)
    for label, chunk in cands:
        sm.set_seq1(label.lower())
        if sm.real_quick_ratio() < min_score or sm.quick_ratio() < min_score:
            continue
        score = sm.ratio()
        if score >= min_score:
            scored.append((score, label, chunk))
    scored.sort(key=lambda t: -t[0])
    out, seen = [], set()
    for score, label, chunk in scored:
        m = _span(chunk, label, "fuzzy")
        key = (label.lower(), tuple(m["center"]))
        if key in seen:
            continue
        seen.add(key)
        out.append({"text": label, "center": m["center"], "rect": m["rect"], "score": round(score, 3)})
        if len(out) >= limit:
            break
    return out


def _miss_details(res: dict, text: str) -> dict:
    """Diagnostics for an OCR search miss: what OCR saw, near matches, and what to try next."""
    words = res.get("words", [])
    out = {"words_seen": len(words)}
    if res.get("lang_used"):
        out["lang_used"] = res["lang_used"]
    if res.get("truncated"):
        out["truncated"] = True
        out["words_total"] = res.get("words_total")
    if res.get("blank"):
        out["blank"] = True
    near = _near_matches(words, text)
    if near:
        out["near_matches"] = near
    if not words:
        out["hint"] = ("OCR read no text at all: the captured area may be blank/black or on another "
                       "monitor (check screenshot / get_screen_info), or the OCR language pack does not "
                       "match the text (try lang=).")
    else:
        out["hint"] = ("Text not found. Try lang= for the screen's language, a smaller region, ocr_screen "
                       "to read what OCR actually sees, or ui_find for UI Automation controls."
                       + (" 'near_matches' lists the closest candidates." if near else ""))
    return out
