"""Minimal FastMCP server — baseline to test whether stdio tool-serving works at all on this box."""
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("min-test")


@mcp.tool()
def ping() -> dict:
    """Return pong."""
    return {"ok": True, "pong": True}


@mcp.tool()
def echo(msg: str) -> dict:
    """Echo a message."""
    return {"ok": True, "echo": msg}


if __name__ == "__main__":
    mcp.run(transport="stdio")
