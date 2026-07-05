"""Allow running as: python -m ai_computer_control

This entry point imports the canonical `ai_computer_control.server` module (never executing server.py
as __main__), so the FastMCP instance that all tool modules register on is the same one main() runs.
This avoids the double-import trap that `python -m ai_computer_control.server` hits.
"""

from ai_computer_control.server import main

main()
