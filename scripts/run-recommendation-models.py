#!/usr/bin/env python3
"""Actions-only scoring/backtesting. Original evidence and all decisions remain in the foundation archive."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from recommendation_foundation import Store, iso_now, canonical
from recommendation_github import GithubState
from recommendation_sources import PublicReader
from recommendation_market import collect_market
from recommendation_models import MODEL_VERSION, MODEL_NAMES, POLICY, assess, extract_documents, schema
from recommendation_backtest import backtest


def analyze(store, scratch, at=None, extract=True):
    schema(store)
    if extract:
        extract_documents(store, scratch)
    # The decision clock follows extraction. No extracted field can be backdated to its source date.
    at = at or iso_now()
    scored = assess(store, at)
    tested = backtest(store, at)
    coverage = store.summary(at)
    failed_docs = store.db.execute("SELECT count(*) FROM documents WHERE status='failed'").fetchone()[0]
    pending_docs = store.db.execute("SELECT count(*) FROM documents WHERE status='pending'").fetchone()[0]
    report = {"version": 1, "modelVersion": MODEL_VERSION, "generatedAt": at, "repository": os.environ.get("GITHUB_REPOSITORY"),
        "status": "partial", "stage": "research-candidates", "rows": scored["rows"], "rowCount": len(scored["rows"]),
        "policy": POLICY, "models": MODEL_NAMES, "backtest": tested,
        "coverage": {"captureStartedAt": store.get("recommendationCaptureStart"), "financialCompanies": len({r['company'] for r in coverage['financialCoverage']}),
            "assessments": scored["assessments"], "missingRequirements": scored["missing"], "pendingDocuments": pending_docs, "failedDocuments": failed_docs,
            "sourceChecks": coverage["sourceChecks"], "history": coverage["lastWalk"],
            "limitations": ["Research evidence scores have not established an investment edge.", "Historical financial, contract and capacity coverage is incomplete.",
                "PDF annexure adapter reads up to twelve pages and cannot certify a complete contract or project history.", "Quotes are official end-of-day closes, with their actual session dates."]}}
    store.set("recommendationLatest", report)
    store.db.commit()
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=["market", "analyze"])
    p.add_argument("--state", default=".cache/recommendation-foundation/state.sqlite")
    p.add_argument("--output", default=".cache/recommendation-foundation/ai-recommendations.json")
    args = p.parse_args()
    GithubState().publisher_guard()
    store = Store(args.state)
    try:
        if args.action == "market":
            collect_market(store, PublicReader(store, maximum=100, seconds=360))
        else:
            value = analyze(store, Path(args.state).parent)
            Path(args.output).write_text(canonical(value) + "\n")
            print(json.dumps({"status": value["status"], "modelVersion": MODEL_VERSION, "qualifiedCompanies": value["rowCount"],
                "assessments": value["coverage"]["assessments"], "backtestValidation": value["backtest"]["strategyValidation"]}))
            if os.environ.get("GITHUB_STEP_SUMMARY"):
                with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as file:
                    file.write("\n## Recommendation models\n\n" + str(value["rowCount"]) + " research candidates. Three fixed catalyst rules; investment edge not established. Historical outcomes remain pending until actual observations mature. No model or paid-provider calls.\n")
    finally:
        store.db.commit()
        store.db.close()


if __name__ == "__main__":
    main()
