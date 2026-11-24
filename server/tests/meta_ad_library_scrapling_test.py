"""Run with python -B -m unittest discover -s tests -p '*scrapling_test.py'."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location(
    "meta_scrapling", Path(__file__).parents[1] / "scripts/meta_ad_library_scrapling.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

URL = "https://business.facebook.com/ads/library/"


class ScraplingAdapterTest(unittest.TestCase):
    def run_fetch(self, action, url, page):
        def browser_fetch(url, **options):
            self.assertEqual(options["locale"], "en-US")
            self.assertFalse(options["solve_cloudflare"])
            self.assertEqual(options["retries"], 1)
            self.assertTrue(options["additional_args"]["chromium_sandbox"])
            self.assertFalse(options["additional_args"]["ignore_https_errors"])
            try:
                options["page_action"](page)
            except Exception:
                # The real Scrapling fetcher also logs and swallows callback errors.
                pass
            return SimpleNamespace(status=200)

        module = SimpleNamespace(StealthyFetcher=SimpleNamespace(fetch=browser_fetch))
        with patch.dict(sys.modules, {"scrapling.fetchers": module}):
            return adapter.fetch(action, url)

    def test_public_host_and_library_id_validation(self):
        for url in ("https://localhost/ads/library/", "http://business.facebook.com/ads/library/",
                    "https://business.facebook.com:444/ads/library/", "https://business.facebook.com/private"):
            with self.assertRaises(ValueError):
                adapter.fetch("search", url)
        with self.assertRaises(ValueError):
            adapter.fetch("details", URL + "?id=bad")

    def test_search_captures_visible_body(self):
        page = MagicMock()
        page.locator.return_value.inner_text.return_value = "Library ID: 123456789\nExample\nSponsored\nOffer"
        result = self.run_fetch("search", URL + "?q=software", page)
        self.assertIsNone(result["error"])
        self.assertEqual(result["status"], 200)
        self.assertIn("Example", result["text"])
        page.screenshot.assert_not_called()

    def test_unknown_layout_attempts_diagnostic_screenshot(self):
        page = MagicMock()
        page.locator.return_value.inner_text.return_value = "Log in to continue"
        with patch.object(adapter.tempfile, "mkdtemp", return_value="/tmp/meta-ad-library-test"):
            result = self.run_fetch("search", URL, page)
        self.assertEqual(Path(result["screenshotPath"]), Path("/tmp/meta-ad-library-test") / "error.png")
        page.screenshot.assert_called_once()

    def test_mismatched_detail_remains_error_when_scrapling_swallows_exception(self):
        page = MagicMock()
        page.get_by_role.return_value.inner_text.return_value = "Library ID: 987654321\nAbout the advertiser"
        with patch.object(adapter.tempfile, "mkdtemp", return_value="/tmp/meta-ad-library-test"):
            result = self.run_fetch("details", URL + "?id=123456789", page)
        self.assertEqual(result["error"], "fetch_failed")
        self.assertEqual(result["regions"], [])

    def test_detail_without_transparency_preserves_missing_reach(self):
        page = MagicMock()
        dialog = page.get_by_role.return_value
        dialog.inner_text.return_value = "Library ID: 123456789\nAbout the advertiser"
        dialog.get_by_text.return_value.count.return_value = 0
        result = self.run_fetch("details", URL + "?id=123456789", page)
        self.assertIsNone(result["error"])
        self.assertEqual(result["regions"], [])

    def test_detail_collects_each_public_region(self):
        page = MagicMock()
        dialog = page.get_by_role.return_value
        dialog.inner_text.return_value = "Library ID: 123456789\nTransparency by location\nAbout the advertiser"
        dialog.get_by_text.return_value.count.return_value = 1
        dialog.get_by_role.return_value.count.return_value = 2
        result = self.run_fetch("details", URL + "?id=123456789", page)
        self.assertIsNone(result["error"])
        self.assertEqual(len(result["regions"]), 2)


if __name__ == "__main__":
    unittest.main()
