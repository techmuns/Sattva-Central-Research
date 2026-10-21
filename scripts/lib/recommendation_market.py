"""Official NSE end-of-day evidence. Raw prices; corporate actions are exclusion gates, not guessed adjustments."""
import csv
import datetime as dt
import io
import json
import re
import zipfile
import zlib
from decimal import Decimal
from urllib.parse import urlencode

from recommendation_foundation import canonical, digest, iso_now, day
from recommendation_sources import SourceFailure, BudgetExceeded

SERIES = {"EQ", "BE", "SM", "ST"}


def schema(store):
    store.db.executescript("""
      CREATE TABLE IF NOT EXISTS market_files(kind TEXT,session TEXT,hash TEXT,observed_at TEXT,body BLOB,
        PRIMARY KEY(kind,session,hash));
      CREATE TABLE IF NOT EXISTS market_prices(session TEXT,isin TEXT,symbol TEXT,series TEXT,
        open TEXT,high TEXT,low TEXT,close TEXT,volume TEXT,turnover TEXT,observed_at TEXT,hash TEXT,
        PRIMARY KEY(session,isin,series,hash));
      CREATE INDEX IF NOT EXISTS market_company ON market_prices(isin,session);
      CREATE TABLE IF NOT EXISTS market_indices(session TEXT,name TEXT,open TEXT,close TEXT,
        observed_at TEXT,hash TEXT,PRIMARY KEY(session,name,hash));
      CREATE TABLE IF NOT EXISTS market_actions(id TEXT PRIMARY KEY,isin TEXT,ex_date TEXT,subject TEXT,
        observed_at TEXT,raw TEXT);
      CREATE TABLE IF NOT EXISTS market_holidays(day TEXT,description TEXT,observed_at TEXT,hash TEXT,
        PRIMARY KEY(day,hash));
    """)


def number(value, positive=False):
    try:
        n = Decimal(str(value).strip())
        return format(n, "f") if n.is_finite() and n >= 0 and (not positive or n > 0) else None
    except Exception:
        return None


def parse_prices(body, session):
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        files = archive.infolist()
        if len(files) != 1 or not files[0].filename.endswith(".csv") or files[0].file_size > 16 * 1024 * 1024:
            raise ValueError("Unsupported bhavcopy archive")
        text = archive.read(files[0]).decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))
    required = {"TradDt", "ISIN", "TckrSymb", "SctySrs", "OpnPric", "HghPric", "LwPric", "ClsPric", "TtlTradgVol", "TtlTrfVal"}
    if not rows or len(rows) > 30000 or not required.issubset(rows[0]):
        raise ValueError("Bhavcopy schema changed or empty")
    result, seen = [], set()
    for row in rows:
        if row["TradDt"] != session:
            raise ValueError("Bhavcopy ignored requested session")
        if row["SctySrs"] not in SERIES:
            continue
        if not re.fullmatch(r"IN[A-Z0-9]{10}", row["ISIN"]):
            raise ValueError("Unresolved bhavcopy identity")
        key = (row["ISIN"], row["SctySrs"])
        if key in seen:
            raise ValueError("Duplicate ISIN/series in daily report")
        seen.add(key)
        values = [number(row[k]) for k in ["OpnPric", "HghPric", "LwPric", "ClsPric", "TtlTradgVol", "TtlTrfVal"]]
        if None in values:
            raise ValueError("Invalid daily price/volume")
        # No-trade rows are retained; they cannot supply a fill or a current quote.
        result.append((session, row["ISIN"], row["TckrSymb"], row["SctySrs"], *values))
    if not result:
        raise ValueError("No equity series in daily report")
    return result


def parse_indices(body, session):
    rows = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"))))
    found = []
    for row in rows:
        if row.get("Index Name", "").strip().casefold() != "nifty 500":
            continue
        date = dt.datetime.strptime(row["Index Date"], "%d-%m-%Y").date().isoformat()
        a, b = number(row["Open Index Value"], True), number(row["Closing Index Value"], True)
        if date != session or not a or not b:
            raise ValueError("Invalid benchmark session")
        found.append((session, "Nifty 500", a, b))
    if len(found) != 1:
        raise ValueError("Nifty 500 benchmark absent or ambiguous")
    return found


def parse_actions(body, beginning, end):
    rows = json.loads(body)
    if not isinstance(rows, list) or len(rows) >= 5000:
        raise ValueError("Corporate-action response incomplete")
    result = []
    for r in rows:
        date = day(r.get("exDate"))
        if not date or not beginning <= date <= end or not re.fullmatch(r"IN[A-Z0-9]{10}", r.get("isin", "")) or not r.get("subject"):
            raise ValueError("Corporate-action date/identity/filter unverified")
        result.append((digest(canonical(r)), r["isin"], date, r["subject"], r))
    return result


def collect_market(store, reader, today=None, days_per_walk=42):
    schema(store)
    today = today or dt.datetime.now(dt.timezone(dt.timedelta(minutes=330))).date()
    # Never request an unfinished session. Reconcile the recent week each walk, then resume older days.
    local_now = dt.datetime.now(dt.timezone(dt.timedelta(minutes=330)))
    last = today if (local_now.hour, local_now.minute) >= (19, 30) else today - dt.timedelta(days=1)
    start = store.get("marketHistoryStart") or (today - dt.timedelta(days=100)).isoformat()
    store.set("marketHistoryStart", start)
    cursor = store.get("marketDiscoveryCursor") or last.isoformat()
    pending = [(last - dt.timedelta(days=i)).isoformat() for i in range(7)]
    retries = store.db.execute("SELECT key FROM checks WHERE (key LIKE 'market:prices:%' OR key LIKE 'market:indices:%') AND error IS NOT NULL AND (cooldown_until IS NULL OR cooldown_until<=?) ORDER BY attempted_at LIMIT 4", (iso_now(),)).fetchall()
    pending.extend(r[0].split(":")[-1] for r in retries if r[0].split(":")[-1] not in pending)
    discovered = []
    while len(pending) < days_per_walk:
        if cursor < start:
            break
        if cursor not in pending:
            pending.append(cursor)
            discovered.append(cursor)
        cursor = (dt.date.fromisoformat(cursor) - dt.timedelta(days=1)).isoformat()
    try:
        # A successful empty list is not a history guarantee outside this exact requested interval.
        action_from = min((today - dt.timedelta(days=550)).isoformat(), store.get("recommendationCaptureStart", start)[:10])
        query = urlencode({"index": "equities", "from_date": dt.date.fromisoformat(action_from).strftime("%d-%m-%Y"),
            "to_date": today.strftime("%d-%m-%Y")})
        try:
            body = reader.read("https://www.nseindia.com/api/corporates-corporateActions?" + query)
            at = iso_now()
            rows = parse_actions(body, action_from, today.isoformat())
            for key, isin, ex, subject, raw in rows:
                store.db.execute("INSERT OR IGNORE INTO market_actions VALUES(?,?,?,?,?,?)", (key, isin, ex, subject, at, canonical(raw)))
            store.check("market:actions", at, detail={"from": action_from, "to": today.isoformat(), "rows": len(rows)})
        except (SourceFailure, ValueError, KeyError) as error:
            store.check("market:actions", iso_now(), str(error)[:250])
        try:
            body = reader.read("https://www.nseindia.com/api/holiday-master?type=trading")
            data, at = json.loads(body), iso_now()
            if not isinstance(data, dict) or not isinstance(data.get("CM"), list) or not data["CM"]:
                raise ValueError("Trading holiday calendar unverified")
            holidays = [(day(r.get("tradingDate")), r.get("description")) for r in data["CM"]]
            if any(not d or not description for d, description in holidays):
                raise ValueError("Holiday calendar schema changed")
            for d, description in holidays:
                store.db.execute("INSERT OR IGNORE INTO market_holidays VALUES(?,?,?,?)", (d, description, at, digest(body)))
            store.check("market:holidays", at, detail={"dates": len(holidays), "hash": digest(body)})
        except (SourceFailure, ValueError, KeyError) as error:
            store.check("market:holidays", iso_now(), str(error)[:250])
        for session in pending:
            d = dt.date.fromisoformat(session)
            for kind in ["prices", "indices"]:
                key = "market:" + kind + ":" + session
                check = store.db.execute("SELECT * FROM checks WHERE key=?", (key,)).fetchone()
                # Completed historical data is immutable evidence. Recent reports reconcile once a day.
                if check and check["success_at"] and (session < (last - dt.timedelta(days=6)).isoformat() or check["success_at"][:10] == iso_now()[:10]):
                    continue
                if check and check["cooldown_until"] and check["cooldown_until"] > iso_now():
                    continue
                url = ("https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_" + d.strftime("%Y%m%d") + "_F_0000.csv.zip"
                    if kind == "prices" else "https://nsearchives.nseindia.com/content/indices/ind_close_all_" + d.strftime("%d%m%Y") + ".csv")
                try:
                    body = reader.read(url)
                    at, hashed = iso_now(), digest(body)
                    rows = parse_prices(body, session) if kind == "prices" else parse_indices(body, session)
                    store.db.execute("INSERT OR IGNORE INTO market_files VALUES(?,?,?,?,?)", (kind, session, hashed, at, zlib.compress(body)))
                    for row in rows:
                        table = "market_prices" if kind == "prices" else "market_indices"
                        store.db.execute("INSERT OR IGNORE INTO " + table + " VALUES(" + ",".join("?" for _ in range(len(row) + 2)) + ")", (*row, at, hashed))
                    store.check(key, at, detail={"rows": len(rows), "source": url, "hash": hashed})
                except (SourceFailure, ValueError, KeyError, zipfile.BadZipFile) as error:
                    # A missing file is unavailable, never evidence that a day was a holiday.
                    retry = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=24)).isoformat(timespec="seconds")
                    store.check(key, iso_now(), str(error)[:250], cooldown=retry)
            store.db.commit()
            if session in discovered:
                store.set("marketDiscoveryCursor", (dt.date.fromisoformat(session) - dt.timedelta(days=1)).isoformat())
                store.db.commit()
    except BudgetExceeded:
        pass
    store.db.commit()
