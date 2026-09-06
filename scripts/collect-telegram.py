#!/usr/bin/env python3
"""Read only @researchreportss using a user-authorized MTProto session.
No joins, sent messages, read receipts, contact reads or attachment downloads.
"""
import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path

CHANNEL = 'researchreportss'

def stamp(value=None):
    return (value or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def normalize(message, old=None):
    old = old or {}
    text = getattr(message, 'message', None) or None
    file = getattr(message, 'file', None)
    attachments = []
    if file and getattr(file, 'name', None):
        attachments = [{'type': 'document', 'name': file.name,
                        'size': f'{file.size} bytes' if file.size is not None else None}]
    media = 'photo' if getattr(message, 'photo', None) else 'video' if getattr(message, 'video', None) else 'document' if getattr(message, 'document', None) else None
    return {'id': message.id, 'text': text, 'publishedAt': stamp(message.date),
            'editedAt': stamp(message.edit_date) if getattr(message, 'edit_date', None) else None,
            'url': f'https://t.me/{CHANNEL}/{message.id}', 'firstSeenAt': old.get('firstSeenAt') or stamp(),
            'attachments': attachments, 'mediaType': media,
            'contentStatus': 'available' if text or attachments or media in ('photo', 'video') else 'telegram-only'}

async def collect(client, entity, prior, history_limit=180, forward_limit=1000):
    if getattr(entity, 'username', '').lower() != CHANNEL or not getattr(entity, 'broadcast', False):
        raise ValueError('Configured source is not the expected public channel')
    posts = {p['id']: p for p in prior.get('posts', [])}
    before = dict(posts)
    api = dict(prior.get('apiState') or {})
    latest_verified = None
    history_done = api.get('historyComplete', False)
    history_offset = api.get('historyOffsetId', 0)
    synced = api.get('newestSyncedId', 0)
    count = 0
    failure = None
    def keep(m):
        nonlocal count
        if not isinstance(m.id, int) or m.id <= 0 or not getattr(m, 'date', None):
            raise ValueError('Telegram returned an invalid message')
        posts[m.id] = normalize(m, posts.get(m.id))
        count += 1
    try:
        # Always ask Telegram for the actual head, including on quiet weekends.
        recent = await client.get_messages(entity, limit=100)
        if not recent:
            raise ValueError('Telegram returned empty history; archive retained')
        for message in recent:
            keep(message)
        newest = max(m.id for m in recent)
        if not synced:
            # First API connection establishes the head; independent history starts at the top.
            synced = newest
        elif synced < newest:
            # Oldest-first catch-up advances only through messages actually read. A burst larger
            # than the run limit (or a flood wait mid-page) cannot skip the middle on the next run.
            async for message in client.iter_messages(entity, min_id=synced, max_id=newest + 1,
                                                       reverse=True, limit=forward_limit):
                keep(message)
                synced = max(synced, message.id)
        if synced >= newest:
            latest_verified = stamp()
        if history_limit and not history_done:
            received = 0
            async for message in client.iter_messages(entity, offset_id=history_offset, limit=history_limit):
                keep(message)
                history_offset = message.id
                received += 1
            history_done = received < history_limit
    except Exception as error:
        # Log the class only: RPC exception strings/session objects can contain account details.
        failure = type(error).__name__
    at = stamp()
    rows = sorted(posts.values(), key=lambda p: p['id'], reverse=True)
    status = 'failed' if failure else 'ok' if latest_verified else 'partial'
    result = {**prior, 'schemaVersion': 2, 'source': 'Telegram API', 'channel': CHANNEL,
              'channelUrl': f'https://t.me/{CHANNEL}', 'route': 'mtproto', 'publishesTime': True,
              'headId': rows[0]['id'] if rows else 0, 'posts': rows,
              'capturedAt': at if before != posts else prior.get('capturedAt'),
              'lastCheckedAt': latest_verified or prior.get('lastCheckedAt'),
              'latestVerifiedAt': latest_verified,
              'historyNextId': max(0, history_offset - 1), 'historyComplete': history_done,
              'retryIds': [], 'apiState': {'newestSyncedId': synced, 'historyOffsetId': history_offset, 'historyComplete': history_done},
              'lastRun': {'at': at, 'status': status, 'posts': count, 'error': failure}}
    return result

def write_atomic(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False) + '\n')
    tmp.replace(path)

async def main():
    path = Path(os.environ.get('TELEGRAM_OUT', 'public/data/telegram-posts.json'))
    prior = json.loads(path.read_text())
    if prior.get('channel') != CHANNEL or not isinstance(prior.get('posts'), list):
        raise ValueError('Invalid existing public archive')
    client = None
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
        credentials = json.loads(os.environ['TELEGRAM_CREDENTIALS'])
        client = TelegramClient(StringSession(credentials['session']), int(credentials['api_id']), credentials['api_hash'],
                                flood_sleep_threshold=0, request_retries=1, connection_retries=2,
                                timeout=20, receive_updates=False)
        await client.connect()
        if not await client.is_user_authorized():
            raise ValueError('Telegram session requires reconnecting')
        limit = int(os.environ.get('TELEGRAM_BACKFILL', '180'))
        if not 0 <= limit <= 100000:
            raise ValueError('Invalid history limit')
        entity = await client.get_entity(CHANNEL)
        result = await asyncio.wait_for(collect(client, entity, prior, limit), timeout=540)
        write_atomic(path, result)
        print(f"Telegram API: {len(result['posts'])} public posts retained; {result['lastRun']['status']}.")
        return 1 if result['lastRun']['status'] == 'failed' else 0
    except Exception as error:
        # Preserve the entire previous archive on connection/timeout errors.
        write_atomic(path, {**prior, 'latestVerifiedAt': None,
                           'lastRun': {'at': stamp(), 'status': 'failed', 'error': type(error).__name__}})
        print(f'Telegram API connection failed ({type(error).__name__}); prior archive retained.')
        return 1
    finally:
        if client:
            await client.disconnect()

if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
