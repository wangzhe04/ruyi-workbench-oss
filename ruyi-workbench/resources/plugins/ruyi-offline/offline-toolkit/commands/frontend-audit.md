---
name: 前端审计
description: 审计前端的离线就绪度与界面风险
---

# Frontend Audit

Audit the frontend for offline readiness and UI risks.

Steps:

1. Call `dependency_inventory`.
2. Call `frontend_audit`.
3. Inspect the app's main pages/components.
4. Start the local dev server if safe and verify the screen with browser/screenshot tools.
5. Report asset, layout, accessibility, and offline dependency issues.
