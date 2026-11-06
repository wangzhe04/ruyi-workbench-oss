"""P3-03 browser ownership, handoff, failure and real startup-cancellation regression.

Real cancellation cases run only on macOS with prepared Playwright, never a user
browser. All other cases use explicit fake resources, no display or network.
"""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


class BrowserRuntime(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ruyi-browser-contract-")
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {"ACC_TOOLSETS": "browser,filesystem", "ACC_BROWSER_MODE": "system",
            "HOME": str(self.root), "USERPROFILE": str(self.root), "WCW_DATA_DIR": str(self.root / "data")})
        self.env.start()
        from ai_computer_control.tools import browser
        self.browser = browser
        await browser.shutdown_browser()

    async def asyncTearDown(self):
        await self.browser.shutdown_browser()
        self.env.stop(); self.tmp.cleanup()

    async def test_system_handoff_does_not_claim_dom_or_mac_desktop_control(self):
        b = self.browser
        opened = []
        with patch.object(b, "_AVAILABLE", False), patch.object(b, "_system_open", side_effect=lambda u, n: opened.append((u, n))):
            result = await b.browser_open("http://127.0.0.1/fixture", mode="system")
            self.assertTrue(result["ok"])
            self.assertFalse(result["navigationVerified"])
            self.assertEqual(opened, [("http://127.0.0.1/fixture", True)])
            status = await b.browser_backend_status()
            self.assertFalse(status["supported"])
            self.assertFalse(status["ready"])
            self.assertIsNone(b._playwright)
            if sys.platform == "darwin":
                self.assertEqual(result["control"], "system-handoff")
                self.assertIn("not implemented", result["hint"])

    async def test_cdp_closes_all_owned_pages_but_not_the_selected_user_page(self):
        b = self.browser
        class Page:
            closed = False
            def is_closed(self): return self.closed
            async def close(self): self.closed = True
        class Browser:
            closed = False
            def is_connected(self): return True
            async def close(self): self.closed = True
        class Driver:
            stopped = False
            async def stop(self): self.stopped = True
        user, own1, own2 = Page(), Page(), Page()
        browser, driver = Browser(), Driver()
        b._browser, b._playwright, b._page, b._backend = browser, driver, user, "cdp"
        b._owned_pages.update((own1, own2))
        result = await b.browser_close()
        self.assertTrue(result["ok"])
        self.assertFalse(result["closed"])
        self.assertFalse(user.closed)
        self.assertTrue(own1.closed and own2.closed and driver.stopped)
        self.assertFalse(browser.closed)

    async def test_close_failures_still_stop_driver_and_report_incomplete_cleanup(self):
        b = self.browser
        class Browser:
            def is_connected(self): return True
            async def close(self): raise RuntimeError("injected browser close failure")
        class Driver:
            stopped = False
            async def stop(self):
                self.stopped = True
                raise RuntimeError("injected driver stop failure")
        driver = Driver()
        b._browser, b._playwright, b._backend = Browser(), driver, "bundled"
        result = await b.browser_close()
        self.assertFalse(result["ok"])
        self.assertTrue(result["cleanupIncomplete"] and driver.stopped)
        self.assertIn("browser close", result["error"])
        self.assertIn("driver stop", result["error"])
        self.assertIsNone(b._browser)
        self.assertIsNone(b._playwright)

    async def test_installed_mac_browser_detection_retains_windows_resolver(self):
        b = self.browser
        mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        with patch.dict(os.environ, {"ACC_BROWSER_EXECUTABLE": ""}), patch.object(b.sys, "platform", "darwin"), \
             patch.object(b.os.path, "isfile", side_effect=lambda p: p == mac), patch.object(b.os, "access", return_value=True):
            self.assertEqual(b._managed_executable("managed"), mac)
        with patch.dict(os.environ, {"ACC_BROWSER_EXECUTABLE": ""}), patch.object(b.sys, "platform", "win32"), \
             patch.object(b, "_windows_default_browser_executable", return_value="C:/fixture/chrome.exe"):
            self.assertEqual(b._managed_executable("managed"), "C:/fixture/chrome.exe")

    async def test_actual_launcher_is_gone_when_launch_request_is_cancelled(self):
        b = self.browser
        if sys.platform != "darwin" or not b._AVAILABLE:
            self.skipTest("real Mac Playwright launch cancellation")
        pidfile, launcher = self.root / "launcher.pid", self.root / "controlled-browser"
        launcher.write_text(f"#!{sys.executable}\nimport os,time\nopen({str(pidfile)!r},'w').write(str(os.getpid()))\ntime.sleep(60)\n")
        launcher.chmod(0o700)
        with patch.dict(os.environ, {"ACC_BROWSER_EXECUTABLE": str(launcher)}):
            task = asyncio.create_task(b.browser_open("http://127.0.0.1/fixture", mode="custom"))
            for _ in range(100):
                if pidfile.exists(): break
                await asyncio.sleep(.05)
            self.assertTrue(pidfile.exists(), "controlled launcher entered actual Playwright launch")
            pid = int(pidfile.read_text())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 12)
            for _ in range(100):
                try: os.kill(pid, 0)
                except ProcessLookupError: break
                await asyncio.sleep(.02)
            with self.assertRaises(ProcessLookupError): os.kill(pid, 0)
            self.assertIsNone(b._playwright)
            self.assertIsNone(b._playwright_manager)

    async def check_allocated_driver(self, operation, cancel=True):
        b = self.browser
        if sys.platform != "darwin" or not b._AVAILABLE:
            self.skipTest("real Mac Playwright startup cancellation")
        from playwright.async_api import async_playwright
        real = async_playwright(); entered, release = asyncio.Event(), asyncio.Event()
        state = {}
        class DelayedManager:
            async def start(self):
                runtime = await real.start()
                state["pid"] = real._connection._transport._proc.pid  # observe only the owned test driver
                entered.set()
                await release.wait()
                return runtime
            async def __aenter__(self): return await self.start()
            async def __aexit__(self, *args):
                release.set()
                await real.__aexit__(*args)
        manager = DelayedManager()
        with patch.object(b, "async_playwright", return_value=manager), \
             patch("playwright.async_api.async_playwright", return_value=manager):
            task = asyncio.create_task(operation())
            try:
                await asyncio.wait_for(entered.wait(), 5)
                if cancel:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError): await asyncio.wait_for(task, 12)
                else:
                    status = await asyncio.wait_for(task, 15)
                    self.assertFalse(status["ready"])
                    self.assertIn("TimeoutError", status["probeError"])
                with self.assertRaises(ProcessLookupError): os.kill(state["pid"], 0)
                self.assertIsNone(b._start_task)
                self.assertIsNone(b._playwright_manager)
            finally:
                release.set()
                await real.__aexit__(None, None, None)

    async def test_actual_driver_is_owned_before_start_returns(self):
        await self.check_allocated_driver(lambda: self.browser.browser_open("http://127.0.0.1/fixture", mode="bundled"))

    async def test_status_probe_cancel_keeps_driver_owned_until_cleanup(self):
        with patch.dict(os.environ, {"ACC_BROWSER_MODE": "bundled", "ACC_BROWSER_EXECUTABLE": ""}):
            await self.check_allocated_driver(self.browser.browser_backend_status)

    async def test_status_probe_own_timeout_cleans_its_driver(self):
        with patch.dict(os.environ, {"ACC_BROWSER_MODE": "bundled", "ACC_BROWSER_EXECUTABLE": ""}):
            await self.check_allocated_driver(self.browser.browser_backend_status, cancel=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
