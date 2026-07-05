# API Debugger

Use this skill to inspect local or intranet HTTP services without cloud tools.

Workflow:

1. Identify the service URL, method, headers, and body from local config or docs.
2. Use `http_request` for simple GET/POST/PUT/PATCH/DELETE checks.
3. Use `powershell_run` for richer tools already present on the machine, such as `curl.exe` or project scripts.
4. Correlate responses with local logs, config files, and source code.
5. Report status code, key headers, compact response snippets, and the likely failing layer.

Do not:

- Send secrets to public endpoints.
- Assume localhost, staging, or production are equivalent.
- Run destructive API calls unless the user asks and the target is clearly non-production.
