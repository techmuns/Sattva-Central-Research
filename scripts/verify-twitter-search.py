"""Local fake X generators only: cookies, all-author search, caps, checkpoints and append-only IDs."""
import asyncio
import importlib.util
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location("twitter_capture", Path(__file__).with_name("scrape-twitter.py"))
scraper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scraper)
now = datetime(2026, 9, 5, 8, tzinfo=timezone.utc)

for raw in ["auth_token=test; ct0=csrf", '{"auth_token":"test","ct0":"csrf"}',
            '[{"name":"auth_token","value":"test"},{"name":"ct0","value":"csrf"}]']:
    assert scraper.cookie_header(raw) == "auth_token=test; ct0=csrf"
assert scraper.cookie_header("not credentials") is None
assert scraper.cookie_header('{"auth_token":"test"}') is None
pool = SimpleNamespace(add_account_cookies=AsyncMock(), add_account=AsyncMock(), login_all=AsyncMock())
with patch.dict(scraper.os.environ, {"X_COOKIES": "auth_token=test; ct0=csrf", "X_ACCOUNTS": "unused:unused:unused:unused"}):
    assert asyncio.run(scraper.add_accounts(SimpleNamespace(pool=pool)))
    pool.add_account_cookies.assert_awaited_once()
    pool.add_account.assert_not_awaited()
    pool.login_all.assert_not_awaited()

def tweet(id, text="Datasel arbitration"):
    return SimpleNamespace(id=id, rawContent=text, date=now, user=SimpleNamespace(username="UnlistedAuthor", displayname="Author"))

class API:
    def __init__(self, rows, fail=False):
        self.rows, self.fail, self.calls, self.closed = rows, fail, [], 0

    async def search(self, query, limit):
        self.calls.append(query)
        try:
            for row in self.rows:
                yield row
            if self.fail:
                raise RuntimeError("refused")
        finally:
            self.closed += 1

jobs = [{"key": "neco|Datasel", "entityId": "isin:NECO", "query": '"Datasel"'},
        {"key": "private|Acme", "entityId": "isin:PRIVATE", "query": '"Private Acme"'}]
state = {}
api = API([tweet(1)])
posts = asyncio.run(scraper.collect_searches(api, jobs, state, now=now))
assert len(posts) == 2
assert all("from:" not in query for query in api.calls), "company search is across authors, not a monitored-handle filter"
assert posts[0]["handle"] == "UnlistedAuthor"
assert state["coverage"]["incomplete"] == 0
assert state["queries"][jobs[1]["key"]]["lastSuccessAt"]
assert api.closed == 2
merged = scraper.merge_posts(posts[:1], posts[1:])
assert len(merged) == 1 and len(merged[0]["matchedQueries"]) == 2

capped_state = {}
capped = API([tweet(1), tweet(2)])
asyncio.run(scraper.collect_searches(capped, jobs[:1], capped_state, now=now, limit=2))
checkpoint = capped_state["queries"][jobs[0]["key"]]
assert checkpoint["error"] == "result-cap-incomplete"
assert len(checkpoint["pending"]) == 2 and not checkpoint.get("lastSuccessAt")
saved = json.dumps(checkpoint["pending"])
failed = API([tweet(3)], fail=True)
partial = asyncio.run(scraper.collect_searches(failed, jobs[:1], capped_state, now=now))
assert partial, "keep posts received before a source failure"
assert len(failed.calls) == 1, "refusal stops collection rather than switching accounts or continuing a walk"
assert json.dumps(checkpoint["pending"]) == saved, "failure never consumes an unfinished partition"
assert not checkpoint.get("lastSuccessAt")

async def timeline(*args, **kwargs):
    yield tweet(1, "Pinned existing post")
    yield tweet(2, "New post below a pinned item")
api = SimpleNamespace(user_by_login=AsyncMock(return_value=SimpleNamespace(id=1)), user_tweets=timeline)
fresh, failed = asyncio.run(scraper.collect(api, [{"handle": "Fixture"}], {"1"}))
assert [p["tweet_id"] for p in fresh] == ["2"] and not failed
with tempfile.TemporaryDirectory(prefix="sattva-twitter-test-") as scratch, patch.object(scraper, "ARCHIVE_DIR", Path(scratch)):
    manifest = scraper.archive_posts(merged)
    scraper.archive_posts([])
    archived = json.loads((Path(scratch) / "2026-09.json").read_text())
    assert len(archived["posts"]) == 1
    assert manifest[0]["file"] == "twitter-archive/2026-09.json"
print("PASS own-session cookies, all-author tickerless search, cap/failure checkpoints, pinned timelines and permanent post retention.")
