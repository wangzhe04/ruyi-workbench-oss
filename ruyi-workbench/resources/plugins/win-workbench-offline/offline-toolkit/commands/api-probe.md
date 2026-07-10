---
name: 探测 API
description: 探测本地或内网 HTTP 接口
---

# API Probe

Probe a local or intranet HTTP API.

Steps:

1. Identify URL, method, headers, and body.
2. Call `http_request`.
3. Summarize status, headers, and a compact response excerpt.
4. Suggest the next local log/source file to inspect.
