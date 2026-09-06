#!/usr/bin/env python3
"""Offline API history tests. No credentials or network access."""
import asyncio
import importlib.util
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace as Obj
spec = importlib.util.spec_from_file_location('collector', Path(__file__).with_name('collect-telegram.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def message(id, text='Report'):
    return Obj(id=id, message=text, date=datetime(2026, 9, 4, tzinfo=timezone.utc), edit_date=None, file=None)

class Client:
    def __init__(self, newest, fail_after=None, unavailable=False):
        self.messages = [message(i) for i in range(1, newest + 1)]
        self.fail_after = fail_after
        self.unavailable = unavailable
    async def get_messages(self, entity, limit):
        if self.unavailable:
            raise ConnectionError('private error must not escape')
        return list(reversed(self.messages))[:limit]
    async def iter_messages(self, entity, limit, offset_id=0, min_id=0, max_id=0, reverse=False, wait_time=None):
        assert wait_time == 2
        items = [x for x in self.messages if x.id > min_id and (not offset_id or x.id < offset_id) and (not max_id or x.id < max_id)]
        for i, row in enumerate(sorted(items, key=lambda x:x.id, reverse=not reverse)[:limit]):
            if self.fail_after == i:
                raise ConnectionError('temporary failure')
            yield row

async def run_due(client, entity, prior, **kwargs):
    at = datetime.now(timezone.utc)
    until = (prior.get('apiSafety') or {}).get('nextAttemptAt')
    if until:
        at = max(at, datetime.fromisoformat(until.replace('Z', '+00:00')) + timedelta(seconds=1))
    return await m.collect(client, entity, prior, now=lambda: at, **kwargs)

async def test():
    entity = Obj(username='researchreportss', broadcast=True)
    prior = {'channel': 'researchreportss', 'posts': []}
    first = await run_due(Client(300), entity, prior, history_limit=120)
    assert first['latestVerifiedAt'] and not first['historyComplete']
    assert first['apiState']['historyOffsetId'] == 181
    next = await run_due(Client(300), entity, first, history_limit=120)
    last = await run_due(Client(300), entity, next, history_limit=120)
    assert len(last['posts']) == 300 and last['historyComplete']
    # A burst larger than one run cannot skip the middle, despite retaining the head already.
    burst = await run_due(Client(1400), entity, last, history_limit=0, forward_limit=200)
    assert burst['lastRun']['status'] == 'partial' and burst['latestVerifiedAt'] is None
    assert burst['apiState']['newestSyncedId'] == 500
    for _ in range(5):
        burst = await run_due(Client(1400), entity, burst, history_limit=0, forward_limit=200)
    assert burst['latestVerifiedAt'] and len(burst['posts']) == 1400
    quiet = await run_due(Client(1400), entity, burst, history_limit=0)
    assert quiet['capturedAt'] == burst['capturedAt'] and quiet['latestVerifiedAt']
    failure = await run_due(Client(1500, fail_after=12), entity, quiet, history_limit=0)
    assert failure['lastRun']['status'] == 'failed'
    assert failure['apiState']['newestSyncedId'] == 1412
    recovery = await run_due(Client(1500), entity, failure, history_limit=0)
    assert len(recovery['posts']) == 1500 and recovery['latestVerifiedAt']
    offline = await run_due(Client(0, unavailable=True), entity, recovery)
    assert offline['posts'] == recovery['posts'] and offline['lastCheckedAt'] == recovery['lastCheckedAt']
    assert offline['lastRun']['error'] == 'ConnectionError'
    try:
        await run_due(Client(1), Obj(username='private_channel', broadcast=True), prior)
        raise AssertionError('wrong channel accepted')
    except ValueError:
        pass
    document = message(1, None)
    document.file = Obj(name='Research.pdf', size=120)
    document.document = True
    row = m.normalize(document)
    assert row['attachments'][0]['name'] == 'Research.pdf' and row['publishedAt'].startswith('2026-09-04')
    assert set(row) == {'id','text','publishedAt','editedAt','url','firstSeenAt','attachments','mediaType','contentStatus'}
    # Future waits survive process/artifact boundaries; a blocked run makes zero API reads.
    FloodWaitError = type('FloodWaitError', (Exception,), {'seconds': 7200})
    at = datetime.now(timezone.utc)
    safety = m.safety_after_error(FloodWaitError(), now=at)
    assert datetime.fromisoformat(safety['nextAttemptAt'].replace('Z', '+00:00')) >= at + timedelta(seconds=7200)
    blocked = {**recovery, 'apiSafety': safety}
    class NoNetwork:
        def __getattr__(self, name):
            raise AssertionError('A paused account must not be contacted')
    held = await m.collect(NoNetwork(), entity, blocked, now=lambda: at)
    assert held['posts'] == recovery['posts'] and held['lastCheckedAt'] == recovery['lastCheckedAt']
    assert m.held_capture(blocked, at + timedelta(hours=3)) is None
    revoked = m.safety_after_error(type('SessionRevokedError', (Exception,), {})(), now=at)
    assert revoked['paused'] and m.held_capture({**recovery, 'apiSafety': revoked}, at + timedelta(days=30))
    retry = m.safety_after_error(ConnectionError(), now=at)
    retry2 = m.safety_after_error(ConnectionError(), retry, at)
    assert retry2['nextAttemptAt'] > retry['nextAttemptAt']
    try:
        await run_due(NoNetwork(), entity, prior, history_limit=201)
        raise AssertionError('Unbounded history accepted')
    except ValueError:
        pass
    # The CLI also gates before reading credentials or importing the Telegram runtime.
    import tempfile, subprocess, sys, os, json
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory) / 'capture.json'
        target.write_text(json.dumps(blocked))
        env = {**os.environ, 'TELEGRAM_OUT': str(target), 'TELEGRAM_CREDENTIALS': 'deliberately invalid'}
        env.pop('TELEGRAM_API_REVIEWED_RESUME', None)
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('collect-telegram.py'))], env=env, capture_output=True, text=True)
        assert result.returncode == 0 and 'no connection attempted' in result.stdout
        assert json.loads(target.read_text())['apiSafety'] == safety
        env['TELEGRAM_API_REVIEWED_RESUME'] = '1'
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('collect-telegram.py'))], env=env, capture_output=True, text=True)
        assert result.returncode == 0 and 'no connection attempted' in result.stdout, 'Operator resume cannot bypass a flood wait'
        assert json.loads(target.read_text())['apiSafety'] == safety
    print('PASS Telegram API: authoritative latest read, resumable history/bursts, quiet checks, failure recovery, public channel boundary, documents')
asyncio.run(test())
