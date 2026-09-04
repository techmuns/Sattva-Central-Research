#!/usr/bin/env python3
"""Offline collector regressions: real twscrape account storage, mocked X responses."""

import importlib.util
import io
import json
import os
import unittest
from contextlib import redirect_stderr
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["TWS_TELEMETRY"] = "0"
from twscrape import API, NoAccountError

spec = importlib.util.spec_from_file_location("twitter", Path(__file__).with_name("scrape-twitter.py"))
twitter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(twitter)

COOKIES = "auth_token=offline-token; ct0=offline-csrf"
LEGACY = "offline-user:offline-password:offline@example.test:offline-email-password"


def tweet(tweet_id):
    return SimpleNamespace(
        id=tweet_id, user=SimpleNamespace(username="moneycontrolcom", displayname="Moneycontrol"),
        rawContent="Offline test post", date=datetime(2026, 9, 4, tzinfo=timezone.utc), media=None,
    )


class CollectorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(prefix="verify-twitter-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.posts = self.root / "posts.json"
        self.handles = self.root / "handles.json"
        self.initial = {"capturedAt": None, "handles": [], "posts": [], "failed": []}
        self.posts.write_text(json.dumps(self.initial))
        self.handles.write_text(json.dumps({"handles": [{"handle": "moneycontrolcom"}]}))
        self.env = patch.dict(os.environ, {"X_COOKIES": COOKIES, "X_ACCOUNTS": LEGACY, "TWS_TELEMETRY": "0"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        for name, value in (("POSTS_FILE", self.posts), ("HANDLES_FILE", self.handles)):
            guard = patch.object(twitter, name, value)
            guard.start()
            self.addCleanup(guard.stop)
        self.api = API(str(self.root / "accounts.db"), raise_when_no_account=True)

    async def capture(self):
        body, handles = twitter.read_handles()
        return await twitter.capture(self.api, body, handles)

    def profile(self):
        self.api.user_by_login = AsyncMock(return_value=SimpleNamespace(id=123))

    def timeline(self, records, error=None, closed=None):
        async def stream(*args, **kwargs):
            try:
                for record in records:
                    yield record
                if error:
                    raise error
            finally:
                if closed is not None:
                    closed.append(True)
        self.api.user_tweets = stream

    async def test_cookies_activate_real_pool_without_password_login(self):
        self.api.pool.login_all = AsyncMock(side_effect=AssertionError("Password login called"))
        self.assertTrue(await twitter.add_accounts(self.api))
        accounts = await self.api.pool.get_all()
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0].cookies, {"auth_token": "offline-token", "ct0": "offline-csrf"})
        self.assertTrue(accounts[0].active)
        self.api.pool.login_all.assert_not_awaited()

    async def test_invalid_cookies_never_fall_back_or_expose_values(self):
        self.api.pool.login_all = AsyncMock()
        for value in ("auth_token=private-token", "ct0=private-token", "not-a-cookie", "auth_token=; ct0=private-token"):
            with self.subTest(value=value), patch.dict(os.environ, {"X_COOKIES": value}), redirect_stderr(io.StringIO()) as log:
                self.assertFalse(await twitter.add_accounts(self.api))
                self.assertNotIn("private-token", log.getvalue())
        self.api.pool.login_all.assert_not_awaited()
        self.assertEqual(await self.api.pool.get_all(), [])

    async def test_cookie_import_exception_does_not_echo_session(self):
        self.api.pool.add_account_cookies = AsyncMock(side_effect=RuntimeError(COOKIES))
        with redirect_stderr(io.StringIO()) as log:
            self.assertFalse(await twitter.add_accounts(self.api))
        self.assertNotIn("offline-token", log.getvalue())

    async def test_password_login_remains_available_without_cookies(self):
        self.api.pool.login_all = AsyncMock()
        with patch.dict(os.environ, {"X_COOKIES": ""}):
            self.assertTrue(await twitter.add_accounts(self.api))
        self.api.pool.login_all.assert_awaited_once()
        accounts = await self.api.pool.get_all()
        self.assertEqual(accounts[0].username, "offline-user")
        self.assertEqual(accounts[0].password, "offline-password")

    async def test_missing_credentials_preserve_both_files(self):
        before = (self.posts.read_bytes(), self.handles.read_bytes())
        with patch.dict(os.environ, {"X_COOKIES": "", "X_ACCOUNTS": "", "TWITTER_ADD": "Reuters"}):
            self.assertEqual(await twitter.main(), 3)
        self.assertEqual(before, (self.posts.read_bytes(), self.handles.read_bytes()))

    async def test_expired_session_preserves_capture(self):
        self.api.user_by_login = AsyncMock(side_effect=NoAccountError("expired"))
        before = self.posts.read_bytes()
        self.assertEqual(await self.capture(), 3)
        self.assertEqual(self.posts.read_bytes(), before)

    async def test_blocked_profile_is_not_reported_as_missing(self):
        self.api.user_by_login = AsyncMock(return_value=None)
        before = self.posts.read_bytes()
        self.assertEqual(await self.capture(), 2)
        self.assertEqual(self.posts.read_bytes(), before)

    async def test_aborted_or_empty_timeline_cannot_advance_freshness(self):
        self.profile()
        self.timeline([])
        self.initial.update(capturedAt="2026-09-03T00:00:00Z", posts=[twitter.shape(tweet(10), "moneycontrolcom")])
        self.posts.write_text(json.dumps(self.initial))
        before = self.posts.read_bytes()
        self.assertEqual(await self.capture(), 2)
        self.assertEqual(self.posts.read_bytes(), before)

    async def test_session_expiry_mid_timeline_discards_partial_capture(self):
        self.profile()
        self.timeline([tweet(11)], NoAccountError("expired"))
        before = self.posts.read_bytes()
        self.assertEqual(await self.capture(), 3)
        self.assertEqual(self.posts.read_bytes(), before)

    async def test_success_writes_posts_but_no_credentials(self):
        self.profile()
        self.timeline([tweet(11), tweet(11), tweet(10)])
        self.assertEqual(await self.capture(), 0)
        body = json.loads(self.posts.read_text())
        self.assertEqual([p["tweet_id"] for p in body["posts"]], ["11", "10"])
        self.assertTrue(body["capturedAt"])
        self.assertEqual(body["failed"], [])
        for value in ("offline-token", "offline-csrf", "offline-password"):
            self.assertNotIn(value, self.posts.read_text())

    async def test_known_post_closes_timeline_and_counts_as_success(self):
        self.profile()
        closed = []
        self.timeline([tweet(11), tweet(10)], closed=closed)
        self.initial["posts"] = [twitter.shape(tweet(11), "moneycontrolcom")]
        self.posts.write_text(json.dumps(self.initial))
        self.assertEqual(await self.capture(), 0)
        self.assertEqual(closed, [True])
        self.assertEqual(len(json.loads(self.posts.read_text())["posts"]), 1)

    async def test_main_removes_temporary_database_and_persists_added_handle(self):
        databases = []
        def make_api(database, **kwargs):
            databases.append(Path(database))
            api = API(database, **kwargs)
            api.user_by_login = AsyncMock(return_value=SimpleNamespace(id=123))
            async def stream(*args, **kwargs):
                yield tweet(11)
            api.user_tweets = stream
            return api
        with patch("twscrape.API", side_effect=make_api), patch.dict(os.environ, {"TWITTER_ADD": "Reuters"}):
            self.assertEqual(await twitter.main(), 0)
        self.assertEqual(len(databases), 1)
        self.assertFalse(databases[0].parent.exists())
        self.assertIn("Reuters", [h["handle"] for h in json.loads(self.handles.read_text())["handles"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
