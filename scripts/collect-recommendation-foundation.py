#!/usr/bin/env python3
"""Actions-only public financial history and event-date groundwork. No UI or model calls."""
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from recommendation_foundation import Store, identities, iso_now
from recommendation_github import GithubState
from recommendation_sources import PublicReader, collect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["restore", "collect", "publish", "inspect"])
    parser.add_argument("--state", default=".cache/recommendation-foundation/state.sqlite")
    parser.add_argument("--data-dir", default="public/data")
    parser.add_argument("--report", default=".cache/recommendation-foundation/coverage.json")
    args = parser.parse_args()
    if args.action == "restore":
        restored = GithubState().restore(args.state)
        with Store(args.state).db as db:
            db.execute("INSERT OR REPLACE INTO meta VALUES('repository',?)", (json.dumps(os.environ["GITHUB_REPOSITORY"]),))
        print("Retained history restored" if restored else "First capture: no previous retained history")
        return
    if args.action == "publish":
        github = GithubState()
        asset = github.publish(args.state)
        print("Retained public evidence acknowledged: " + str(asset["id"]))
        models = Path(args.state).parent / "ai-recommendations.json"
        if models.exists():
            with sqlite3.connect('file:' + str(Path(args.state).resolve()) + '?mode=ro', uri=True) as db:
                row = db.execute("SELECT value FROM meta WHERE key='recommendationLatest'").fetchone()
            saved = json.loads(row[0]) if row else None
            value = json.loads(models.read_text())
            if value != saved:
                raise ValueError("Recommendation file does not match the retained decision ledger")
            reader = github.publish_recommendations(models, asset)
            print("Public recommendation reader acknowledged: " + str(reader["id"]))
        return
    store = Store(args.state)
    try:
        if args.action == "collect":
            GithubState().publisher_guard()
            directory, lookup = identities(args.data_dir)
            for isin, company in directory.items():
                store.db.execute("INSERT OR REPLACE INTO companies VALUES(?,?)", (isin, json.dumps(company)))
            store.set("directoryTargets", len(directory))
            store.db.commit()
            collect(store, args.data_dir, PublicReader(store, maximum=200, seconds=600), lookup, Path(args.state).parent)
        report = store.summary(iso_now())
        output = Path(args.report)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        message = ("## Financial-history and event-date foundation\n\n"
            "Status: **partial — background evidence, no recommendation score**.\n\n"
            + "\n".join("- " + k + ": " + str(v) for k, v in report["counts"].items())
            + "\n\nSource failures, unfinished windows and missing financial fields remain recorded. "
            "This job makes no UI changes, model calls or paid-provider calls.\n")
        if summary:
            with open(summary, "a") as file:
                file.write(message)
        print(json.dumps({"status": report["status"], "counts": report["counts"], "lastWalk": report["lastWalk"]}))
    finally:
        store.db.commit()
        store.db.close()


if __name__ == "__main__":
    main()
