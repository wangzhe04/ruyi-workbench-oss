"""Shared text routing and clipboard-consumption timing for desktop backends."""

# type_text routing: key-by-key typing is 20ms/char (200 chars = 4s of loop-blocking typing), and every
# "\n" is a real Enter that editors answer with auto-indent / auto-closing brackets (corrupting pasted
# code). So long or multi-line text goes through the clipboard, which pastes verbatim.
_CLIPBOARD_MIN_CHARS = 200


def _route_clipboard(text: str, use_clipboard: bool | None) -> tuple[bool, str]:
    """(use_clipboard, reason) — the auto-routing decision, kept pure so it can be unit-tested."""
    if use_clipboard is not None:
        return bool(use_clipboard), "explicit"
    if not text.isascii():
        return True, "non_ascii"
    # A trailing newline alone ("ls\n" = type it, then press Enter) is not multi-line content.
    if "\n" in text.rstrip("\r\n") or "\r" in text.rstrip("\r\n"):
        return True, "multiline"
    if len(text) > _CLIPBOARD_MIN_CHARS:
        return True, "long"
    return False, "short_ascii"


def _split_trailing_enter(text: str, reason: str) -> tuple[str, int]:
    """(body, enters): a single-line text that ends in newline(s) means "type it, then press Enter".

    A pasted trailing newline is dropped by a one-line field (search box, address bar), so the body is pasted
    and Enter pressed instead. Applies to the two routes that paste single-line text: "long" and "non_ascii"
    (ASCII "ls\\n" already gets this by being typed key by key). Multi-line text keeps its newlines verbatim
    (pasted code ends in a newline on purpose), as do explicit use_clipboard=True calls. Kept pure for tests.
    """
    if reason not in ("long", "non_ascii"):
        return text, 0
    body = text.rstrip("\r\n")
    if len(body) == len(text) or not body:
        return text, 0
    if "\n" in body or "\r" in body:
        return text, 0
    return body, text[len(body):].count("\n") or 1


def _paste_wait_s(text: str) -> float:
    """How long to let the target read the clipboard before restoring it (slow/remote/Electron targets
    read it late and would otherwise paste the OLD text): 0.4s, growing with size, capped at 2s."""
    return min(2.0, 0.4 + len(text) / 20000.0)
