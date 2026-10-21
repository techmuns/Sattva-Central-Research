"""Durable public evidence on GitHub Releases; no expiring Actions storage or cloud database."""
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

TAG = re.compile(r"recommendation-foundation-\d{4}-\d{2}$")
ASSET = re.compile(r"foundation-\d+-\d+-([a-f0-9]{64})\.sqlite\.gz$")
MAX_STATE = 4 * 1024 * 1024 * 1024
MAX_ARCHIVE = 1024 * 1024 * 1024  # Below GitHub's per-asset ceiling; no memory-sized database copies.


class GithubState:
    def __init__(self, env=None, opener=None):
        self.env = os.environ if env is None else env
        self.repo = self.env.get("GITHUB_REPOSITORY", "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", self.repo):
            raise ValueError("Invalid GitHub repository")
        self.token = self.env.get("GITHUB_TOKEN")
        if not self.token:
            raise ValueError("GitHub Actions token required for retained state")
        self.root = "https://api.github.com/repos/" + self.repo
        self.opener = opener or urllib.request.build_opener()
        self.last_write = 0

    def request(self, suffix, method="GET", payload=None, missing=False, upload=False):
        if method != "GET":
            self.publisher_guard()
            time.sleep(max(0, 1 - (time.monotonic() - self.last_write)))
            self.last_write = time.monotonic()
        url = ("https://uploads.github.com/repos/" + self.repo if upload else self.root) + suffix
        upload_file = payload.open("rb") if upload and isinstance(payload, Path) else None
        data = upload_file or (payload if isinstance(payload, bytes) else json.dumps(payload).encode() if payload is not None else None)
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
            "User-Agent": "SattvaPublicEvidenceState", "X-GitHub-Api-Version": "2022-11-28"}
        if data is not None:
            headers["Content-Type"] = "application/octet-stream" if upload else "application/json"
        if upload_file:
            headers["Content-Length"] = str(payload.stat().st_size)
        try:
            with self.opener.open(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=120) as r:
                body = r.read(4 * 1024 * 1024 + 1)
                if len(body) > 4 * 1024 * 1024:
                    raise ValueError("GitHub metadata exceeds byte ceiling")
                return json.loads(body)
        except urllib.error.HTTPError as e:
            if missing and e.code == 404:
                return None
            raise RuntimeError("GitHub state request failed (HTTP " + str(e.code) + ")") from e
        finally:
            if upload_file:
                upload_file.close()

    def publisher_guard(self):
        if (self.env.get("GITHUB_ACTIONS") != "true" or self.env.get("GITHUB_REF") != "refs/heads/main" or
                not re.fullmatch(r"\d+", self.env.get("GITHUB_RUN_ID", "")) or
                not re.fullmatch(r"\d+", self.env.get("GITHUB_RUN_ATTEMPT", ""))):
            raise ValueError("State publication requires this public repository's main-branch Actions runner")
        sha = self.env.get("GITHUB_SHA", "")
        if not re.fullmatch(r"[a-f0-9]{40}", sha) or subprocess.check_output(
                ["git", "rev-parse", "HEAD"], text=True).strip() != sha:
            raise ValueError("Runner checkout does not match the verified workflow revision")

    def public_guard(self):
        metadata = self.request("")
        if metadata.get("private") is not False or metadata.get("full_name", "").lower() != self.repo.lower():
            raise ValueError("Collector requires a public repository and standard free Actions runner")

    def releases(self):
        found = []
        for page in range(1, 11):
            batch = self.request("/releases?per_page=100&page=" + str(page))
            if not isinstance(batch, list):
                raise ValueError("Invalid release inventory")
            found.extend(r for r in batch if TAG.fullmatch(r.get("tag_name", "")))
            if len(batch) < 100:
                return found
        raise ValueError("Release inventory incomplete; refusing a state reset")

    def assets(self, release):
        result = []
        for page in range(1, 11):
            batch = self.request("/releases/" + str(release["id"]) + "/assets?per_page=100&page=" + str(page))
            if not isinstance(batch, list):
                raise ValueError("Invalid state asset inventory")
            result.extend(batch)
            if len(batch) < 100:
                return result
        raise ValueError("Asset inventory incomplete; refusing a state reset")

    def restore(self, path):
        self.public_guard()
        releases = self.releases()
        candidates = []
        for release in releases:
            for asset in self.assets(release):
                if ASSET.fullmatch(asset.get("name", "")) and asset.get("state") == "uploaded":
                    candidates.append((asset, release["tag_name"]))
        if not candidates:
            if releases:
                raise ValueError("A retained release exists without usable state; refusing an empty restart")
            return False
        asset, tag = max(candidates, key=lambda x: x[0]["id"])
        url = "https://github.com/" + self.repo + "/releases/download/" + tag + "/" + asset["name"]
        if asset.get("browser_download_url") != url or not 0 < asset.get("size", 0) <= MAX_ARCHIVE:
            raise ValueError("Invalid retained state destination or size")
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        archive = destination.with_suffix(".restoring.gz")
        temporary = destination.with_suffix(".restoring.sqlite")
        # Public download only: the repository token is never forwarded to an asset/CDN host.
        checksum, received = hashlib.sha256(), 0
        with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as out:
            while True:
                part = response.read(1024 * 1024)
                if not part:
                    break
                received += len(part)
                if received > asset["size"] or received > MAX_ARCHIVE:
                    raise ValueError("Restart download exceeds its declared size")
                checksum.update(part)
                out.write(part)
        if received != asset["size"] or checksum.hexdigest() != ASSET.fullmatch(asset["name"])[1]:
            raise ValueError("Retained state hash or size mismatch; refusing a reset")
        with gzip.open(archive, "rb") as src, temporary.open("wb") as dst:
            size = 0
            while True:
                part = src.read(1024 * 1024)
                if not part:
                    break
                size += len(part)
                if size > MAX_STATE:
                    raise ValueError("Restart database exceeds retained-state ceiling")
                dst.write(part)
        with sqlite3.connect(temporary) as db:
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Retained state is corrupt")
            row = db.execute("SELECT value FROM meta WHERE key='repository'").fetchone()
            if not row or json.loads(row[0]).lower() != self.repo.lower():
                raise ValueError("Retained state belongs to a different repository")
        temporary.replace(destination)
        return True

    def publish(self, path):
        self.publisher_guard()
        self.public_guard()
        source = Path(path)
        if source.stat().st_size > MAX_STATE:
            raise ValueError("State budget reached; preserve history and narrow the next walk")
        with sqlite3.connect(source) as db:
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Refusing to publish an invalid restart database")
            row = db.execute("SELECT value FROM meta WHERE key='repository'").fetchone()
            if not row or json.loads(row[0]).lower() != self.repo.lower():
                raise ValueError("Restart repository does not match publisher")
        # Stream a fixed-timestamp gzip. Larger history never requires a larger/paid runner.
        archive = source.with_suffix(".publication.gz")
        with source.open("rb") as original, archive.open("wb") as target:
            with gzip.GzipFile(filename="", fileobj=target, mode="wb", compresslevel=6, mtime=0) as compressed:
                shutil.copyfileobj(original, compressed, 1024 * 1024)
        size = archive.stat().st_size
        if size > MAX_ARCHIVE:
            raise ValueError("Compressed state ceiling reached; retained history is not deleted")
        hashed = hashlib.sha256()
        with archive.open("rb") as original:
            for chunk in iter(lambda: original.read(1024 * 1024), b""):
                hashed.update(chunk)
        checksum = hashed.hexdigest()
        name = "foundation-" + self.env["GITHUB_RUN_ID"] + "-" + self.env["GITHUB_RUN_ATTEMPT"] + "-" + checksum + ".sqlite.gz"
        tag = "recommendation-foundation-" + dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")
        release = self.request("/releases/tags/" + tag, missing=True)
        if release is None:
            release = self.request("/releases", "POST", {"tag_name": tag, "target_commitish": self.env["GITHUB_SHA"],
                "name": "Public recommendation evidence " + tag[-7:], "make_latest": "false",
                "body": "Public original exchange evidence and SQLite restart state. No portfolio membership, paid inputs or AI outputs. All observations and corrections retained."})
        assets = self.assets(release)
        existing = next((a for a in assets if a.get("name") == name), None)
        if existing:
            return existing
        if len(assets) >= 990:
            raise ValueError("Monthly release capacity reached; history retained, no automatic deletion")
        asset = self.request("/releases/" + str(release["id"]) + "/assets?name=" + name,
            "POST", archive, upload=True)
        if (asset.get("name") != name or asset.get("state") != "uploaded" or asset.get("size") != size or
                asset.get("digest") not in (None, "sha256:" + checksum)):
            raise ValueError("GitHub did not acknowledge the complete retained state")
        return asset
