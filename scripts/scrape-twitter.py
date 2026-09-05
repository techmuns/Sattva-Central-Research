#!/usr/bin/env python3
"""scrape-twitter.py — collect posts from the monitored X/Twitter accounts.

    python3 scripts/scrape-twitter.py               read every handle in twitter-handles.json
    TWITTER_ADD=Reuters python3 scripts/scrape-twitter.py   also add that handle first

THE ONE PYTHON SCRIPT IN THIS REPOSITORY, AND WHY.
    Everything else under scripts/ is Node 22 with no dependencies, and that rule stands. This is
    the exception because the retrieval library asked for — vladkens/twscrape — is Python, and
    reimplementing X's internal API client in `scripts/lib/` is not a small version of anything.
    It runs on a GitHub runner only; the browser, the Worker and the rest of the build never touch
    Python, and nothing in `public/` depends on it. What it produces is an ordinary committed
    capture, exactly like scrape-mc-news.mjs produces.

WHAT IT WRITES
    public/data/twitter-handles.json   the monitored accounts (the list the UI reads back)
    public/data/twitter-posts.json     the posts, deduplicated by tweet id

FOUR RULES, ALL OF THEM ONES THIS CODEBASE ALREADY HOLDS ELSEWHERE:

  1. DEDUPLICATE BY THE TWEET ID, NEVER BY POSITION OR BY COUNT. The capture is capped, so a new
     post pushes the oldest off the end and the LENGTH DOES NOT MOVE — the same trap the market
     news Fetch button fell into. `changed` below compares id sets.
  2. A HANDLE THAT COULD NOT BE READ IS ABSENT, NOT EMPTY. It goes under `failed` with a reason, so
     the UI can say "account not found" rather than showing an account that simply never posts.
     Writing it as an account with zero posts would report an outage as silence.
  3. A RUN THAT READ NOTHING DOES NOT OVERWRITE A GOOD CAPTURE. If every handle failed and the
     existing file has posts, it exits 2 — the same "the upstream refused this runner" exit the
     market-news scraper uses, which the workflow turns into a warning rather than a red build.
  4. ONLY WHAT IS NEEDED IS STORED: id, handle, display name, text, time, url, one media url and
     the source url. No engagement counts, no replies, no followers, no search — see the scope
     limits in docs/DATA-CONTRACTS.md.

CREDENTIALS
    twscrape drives X as a logged-in user, so it needs at least one account. They are supplied as
    the `X_ACCOUNTS` secret, one account per line:
        username:password:email:email_password
    With none configured — OR when the configured ones cannot sign in — the script exits 3 and
    writes nothing: no capture is changed, and the UI goes on saying the accounts are being added
    rather than inventing a failure about them.

    OPTIONAL COVERAGE. The scheduled collector is disabled unless X_CAPTURE_ENABLED=true.
    A refused sign-in is a source outage, not a reason to rotate accounts or proxy around a block.
    The workflow records collection status separately while preserving all last-known posts.
"""

import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSTS_FILE = ROOT / "public" / "data" / "twitter-posts.json"
HANDLES_FILE = ROOT / "public" / "data" / "twitter-handles.json"

# X's own rule, and the same one js/core/twitter-handles.js and worker/index.js enforce.
HANDLE_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")

# Per handle, per run. Small on purpose: the job runs often, the walk stops at the first post
# already held, and a deep backfill is not what this feature is for.
PER_HANDLE = int(os.environ.get("TWITTER_LIMIT", "20"))
# The whole capture's ceiling, so the committed file cannot grow without bound. Same idea as
# MCNEWS's KEEP: a bytes limit, not an editorial one.
KEEP = int(os.environ.get("TWITTER_KEEP", "600"))


def load_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def normalise(raw):
    """'@Reuters' | 'Reuters' | 'https://x.com/Reuters?s=20' -> 'Reuters', or None."""
    value = str(raw or "").strip()
    if not value:
        return None
    # The scheme and the leading slashes are all optional, so `x.com/Reuters` normalises the same
    # way `https://x.com/Reuters?s=20` does. A link to any OTHER host falls through and is refused
    # rather than having its last path segment taken as a handle.
    m = re.match(r"^(?:(?:https?:)?//)?(?:www\.)?(?:x|twitter)\.com/([^/?#]+)", value, re.I)
    if m:
        value = m.group(1)
    value = value.lstrip("@").split("/")[0].split("?")[0].strip()
    return value if HANDLE_RE.match(value) else None


def read_handles():
    body = load_json(HANDLES_FILE, {})
    out = []
    for entry in body.get("handles") or []:
        h = normalise(entry.get("handle") if isinstance(entry, dict) else entry)
        if h and not any(x["handle"].lower() == h.lower() for x in out):
            added = entry.get("addedAt") if isinstance(entry, dict) else None
            out.append({"handle": h, "addedAt": added})
    return body, out


def write_handles(body, handles):
    body["handles"] = handles
    body["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    HANDLES_FILE.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def media_url(tweet):
    """The first image on the post, if it carried one. Videos are not downloaded or linked."""
    media = getattr(tweet, "media", None)
    photos = getattr(media, "photos", None) if media else None
    if photos:
        url = getattr(photos[0], "url", None)
        if isinstance(url, str) and url.startswith("http"):
            return url
    return None


def shape(tweet, handle):
    """One tweet -> the small record the dashboard reads. Nothing derived, nothing scored."""
    user = getattr(tweet, "user", None)
    created = getattr(tweet, "date", None)
    return {
        "tweet_id": str(getattr(tweet, "id", "") or ""),
        "handle": getattr(user, "username", None) or handle,
        "display_name": getattr(user, "displayname", None) or f"@{handle}",
        "text": getattr(tweet, "rawContent", None) or "",
        "created_at": created.isoformat() if hasattr(created, "isoformat") else None,
        "url": getattr(tweet, "url", None) or f"https://x.com/{handle}/status/{getattr(tweet, 'id', '')}",
        "image": media_url(tweet),
        "source_url": f"https://x.com/{handle}",
    }


async def add_accounts(api):
    """Log the pool in. Returns False when nothing is configured, which is not a scrape failure."""
    raw = os.environ.get("X_ACCOUNTS", "").strip()
    if not raw:
        return False
    for line in raw.splitlines():
        parts = [p.strip() for p in line.split(":")]
        if len(parts) < 4 or not parts[0]:
            continue
        try:
            await api.pool.add_account(parts[0], parts[1], parts[2], parts[3])
        except Exception as err:  # already present, or malformed — neither stops the run
            print(f"  Account setup failed: {type(err).__name__}", file=sys.stderr)
    await api.pool.login_all()
    return True


async def active_accounts(api):
    """
    How many accounts actually SIGNED IN, or None when that cannot be determined.

    A CONFIGURED ACCOUNT IS NOT A WORKING ONE, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS
    FUNCTION. Measured on a real run: X's Cloudflare answered the runner's login with
    "403 — Sorry, you have been blocked. You are unable to access x.com", twscrape logged
    "No active accounts. Stopping...", and every single handle then came back from
    `user_by_login` as None. Without this check the walk reads that as "account not found" and
    writes it into the capture, so the dashboard tells the reader their perfectly good account
    does not exist — an outage reported as an absence, about somebody else's account, which is
    the error class this repository closes everywhere else.

    So a run with no live account stops before the walk and says the credential could not sign
    in. That is a fact about THIS DEPLOYMENT, and it is never spent on a handle.

    None means twscrape did not expose the pool in a shape this understands — a version change
    rather than a confirmed login. Stop instead of mislabelling monitored handles as missing.
    """
    try:
        info = await api.pool.accounts_info()
    except Exception:
        return None
    if not isinstance(info, list):
        return None
    live = 0
    for entry in info:
        got = entry.get("active") if isinstance(entry, dict) else getattr(entry, "active", None)
        if got is None:
            return None
        if got:
            live += 1
    return live


async def collect(api, handles, held_ids):
    posts, failed = [], []
    for entry in handles:
        handle = entry["handle"]
        try:
            user = await api.user_by_login(handle)
            if not user:
                failed.append({"handle": handle, "reason": "account not found"})
                print(f"  @{handle}: not found")
                continue
            got = 0
            async for tweet in api.user_tweets(user.id, limit=PER_HANDLE):
                record = shape(tweet, handle)
                if not record["tweet_id"]:
                    continue
                # The timeline is newest-first, so the first post already held means the rest are
                # too. Stopping there is what makes a top-up run cheap.
                if record["tweet_id"] in held_ids:
                    break
                posts.append(record)
                got += 1
            print(f"  @{handle}: {got} new")
        except Exception as err:
            failed.append({"handle": handle, "reason": "could not be read"})
            print(f"  @{handle}: {type(err).__name__}: {err}", file=sys.stderr)
    return posts, failed


async def main():
    body, handles = read_handles()

    # A handle the dashboard asked for, added before the walk so this run covers it.
    wanted = normalise(os.environ.get("TWITTER_ADD", ""))
    if wanted and not any(h["handle"].lower() == wanted.lower() for h in handles):
        handles.append({"handle": wanted, "addedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        write_handles(body, handles)
        print(f"Added @{wanted} to the monitored list.")

    if not handles:
        print("No handles are monitored; nothing to collect.")
        return 0

    try:
        from twscrape import API
    except ImportError:
        print("twscrape is not installed (pip install twscrape).", file=sys.stderr)
        return 3

    api = API()
    if not await add_accounts(api):
        print("No X_ACCOUNTS secret is configured, so no account could be read.", file=sys.stderr)
        return 3

    # THE CREDENTIAL EXISTS; DID IT WORK? See `active_accounts` for why these are different
    # questions and why answering only the first one slanders the handles.
    live = await active_accounts(api)
    if live is None or live == 0:
        print(
            "The configured X account(s) could not sign in, so nothing could be read. "
            "The committed capture is unchanged and no handle has been marked unreadable — "
            "this is a fact about this deployment, not about the accounts being monitored.",
            file=sys.stderr,
        )
        return 3

    existing = load_json(POSTS_FILE, {})
    held = {p.get("tweet_id"): p for p in (existing.get("posts") or []) if p.get("tweet_id")}
    before = set(held)

    print(f"Reading {len(handles)} account(s)...")
    fresh, failed = await collect(api, handles, before)

    for record in fresh:
        held[record["tweet_id"]] = record

    # DEDUPLICATED BY ID, THEN CAPPED. Newest first by post time, with the id as the tie-break so
    # a post with no readable time still lands somewhere stable rather than moving between runs.
    merged = sorted(held.values(), key=lambda p: (p.get("created_at") or "", p.get("tweet_id") or ""), reverse=True)[:KEEP]
    after = {p["tweet_id"] for p in merged}

    # Every handle failed and we already had posts: keep what we have rather than replacing a good
    # capture with a record of one bad run.
    if failed and len(failed) == len(handles) and before:
        print(f"Every account failed; the existing capture of {len(before)} posts is unchanged.", file=sys.stderr)
        return 2

    POSTS_FILE.write_text(
        json.dumps(
            {
                "note": existing.get("note")
                or "Posts captured from the handles in twitter-handles.json, written by scripts/scrape-twitter.py.",
                "capturedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "handles": [h["handle"] for h in handles],
                "posts": merged,
                "failed": failed,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    # Compared, never counted: the cap makes the length a constant once the capture is full.
    print(f"{len(after - before)} new post(s); {len(merged)} held; {len(failed)} account(s) could not be read.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
