"""Scrapling browser adapter. stdout is reserved for the Node JSON protocol."""
import contextlib
import json
import logging
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import parse_qs, urlparse


def fetch(action, url):
    parsed = urlparse(url)
    if (action not in {"search", "details"} or parsed.scheme != "https"
            or parsed.hostname != "business.facebook.com" or parsed.username
            or parsed.password or parsed.port not in (None, 443)
            or parsed.path != "/ads/library/"):
        raise ValueError("Invalid public Meta Library request")
    ad_id = parse_qs(parsed.query).get("id", [""])[0]
    if action == "details" and not re.fullmatch(r"\d{6,40}", ad_id):
        raise ValueError("Invalid Library ID")

    result = {"status": None, "text": "", "regions": [], "screenshotPath": None, "error": None}
    try:
        from scrapling.fetchers import StealthyFetcher
    except ImportError:
        result["error"] = "dependency_missing"
        return result

    def screenshot(page):
        try:
            path = str(Path(tempfile.mkdtemp(prefix="meta-ad-library-")) / "error.png")
            page.screenshot(path=path, full_page=True, timeout=5000)
            result["screenshotPath"] = path
        except Exception:
            pass

    def inspect(page):
        try:
            if action == "search":
                try:
                    page.get_by_text(re.compile(r"Library ID:\s*\d+", re.I)).first.wait_for(timeout=8000)
                except Exception:
                    pass
                result["text"] = page.locator("body").inner_text(timeout=5000)[:2_000_000]
                if not re.search(r"Library ID:\s*\d+|no ads found|no results found|0 results", result["text"], re.I):
                    screenshot(page)
                return

            linked_ad = page.get_by_role("dialog", name="Link to ad")
            linked_ad.get_by_text(f"Library ID: {ad_id}", exact=True).wait_for(timeout=10000)
            linked_ad.get_by_text(re.compile(r"See (ad|summary) details", re.I)).first.click(timeout=7000)
            dialog = page.get_by_role("dialog", name="Ad details")
            dialog.get_by_text("About the advertiser", exact=True).wait_for(timeout=7000)
            result["text"] = dialog.inner_text()[:2_000_000]
            if f"Library ID: {ad_id}" not in result["text"]:
                raise ValueError("Ad detail did not match requested Library ID")
            transparency = dialog.get_by_text("Transparency by location", exact=True)
            if not transparency.count():
                return
            transparency.click(timeout=7000)
            tabs = dialog.get_by_role("tab")
            count = tabs.count()
            for index in range(max(1, min(count, 20))):
                if count:
                    tabs.nth(index).click(timeout=7000)
                dialog.get_by_text(re.compile(r"^(?:EU )?Ad delivery$", re.I)).wait_for(timeout=7000)
                result["regions"].append(dialog.inner_text()[:500_000])
        except Exception:
            screenshot(page)
            # Scrapling logs page_action exceptions and continues; retain failure
            # explicitly so partial or mismatched details never become success.
            result["error"] = "fetch_failed"
            raise

    try:
        options = dict(headless=True, locale="en-US", timeout=20000,
                       network_idle=False, page_action=inspect,
                       solve_cloudflare=False, retries=1,
                       additional_args={
                           "viewport": {"width": 1440, "height": 900},
                           "chromium_sandbox": True,
                           "ignore_https_errors": False,
                       })
        chrome_path = os.environ.get("META_AD_LIBRARY_CHROME_PATH")
        if chrome_path:
            options["executable_path"] = chrome_path
        else:
            options["real_chrome"] = True
        response = StealthyFetcher.fetch(url, **options)
        result["status"] = response.status
    except Exception:
        logging.exception("Scrapling public Meta fetch failed")
        result["error"] = "fetch_failed"
    return result


if __name__ == "__main__":
    # Scrapling and browser diagnostics must not corrupt the JSON response.
    with contextlib.redirect_stdout(sys.stderr):
        output = fetch(*sys.argv[1:])
    print(json.dumps(output))
