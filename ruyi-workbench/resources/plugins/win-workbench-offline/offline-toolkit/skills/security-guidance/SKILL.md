# Security Guidance

Use this skill for local security review and hardening in an offline environment.

Workflow:

1. Run `code_review_scan` and `dependency_inventory` for quick signals.
2. Inspect matching code before treating a signal as a finding.
3. Prioritize exploitable issues: secrets, injection, unsafe shell execution, XSS, broad CORS, disabled TLS, unsafe file writes, and permission boundaries.
4. Recommend patches that work without cloud scanners or package downloads.
5. Separate confirmed findings from hardening suggestions.

Output expectations:

- Include file and line references for confirmed issues.
- Explain impact and the minimal fix.
- Mention scanners or dependency advisories that could not run because the environment is offline.
