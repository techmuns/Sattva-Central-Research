"""No X login or capture writes: unknown/failed authentication stops before reading handles."""
import asyncio
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location("twitter_capture", Path(__file__).with_name("scrape-twitter.py"))
scraper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scraper)

for live in [0, None]:
    collect = AsyncMock(side_effect=AssertionError("Must not read handles without a confirmed login"))
    with patch.dict(sys.modules, {"twscrape": SimpleNamespace(API=lambda **kwargs: object())}), \
         patch.dict(scraper.os.environ, {"TWITTER_ADD": ""}), \
         patch.object(scraper, "read_handles", return_value=({}, [{"handle": "fixture"}])), \
         patch.object(scraper, "add_accounts", AsyncMock(return_value=True)), \
         patch.object(scraper, "active_accounts", AsyncMock(return_value=live)), \
         patch.object(scraper, "collect", collect):
        assert asyncio.run(scraper.main()) == 3
        collect.assert_not_awaited()

for response, expected in [([], 0), ([{"active": False}], 0), ([{"active": True}], 1), ([{}], None), ({}, None)]:
    api = SimpleNamespace(pool=SimpleNamespace(accounts_info=AsyncMock(return_value=response)))
    assert asyncio.run(scraper.active_accounts(api)) == expected
print("PASS blocked/unknown X login stops before collection; no monitored handle is labelled missing.")
