#!/usr/bin/env python3
"""Interactive local connection; never print credentials or session strings.
Install Telethon in an external virtual environment before running this helper.
"""
import asyncio
import getpass
import json
import os
from pathlib import Path

# Keep authentication interactive and hidden, including the phone number, OTP and 2FA password.
async def connect():
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from collect_telegram import CHANNEL
    os.umask(0o077)
    directory = Path.home() / '.config' / 'sattva-telegram'
    target = directory / 'credentials.json'
    if target.exists():
        raise ValueError('A connection file already exists. Move it aside before reconnecting.')
    print('Create your API application at https://my.telegram.org/apps.')
    print('This helper saves a revocable account session locally; it does not upload or activate it.')
    api_id = int(getpass.getpass('API ID (hidden): '))
    api_hash = getpass.getpass('API hash (hidden): ').strip()
    client = TelegramClient(StringSession(), api_id, api_hash, receive_updates=False)
    try:
        await client.start(phone=lambda: getpass.getpass('Phone with country code (hidden): '),
                           code_callback=lambda: getpass.getpass('Telegram login code (hidden): '),
                           password=lambda: getpass.getpass('Telegram 2FA password (hidden): '))
        entity = await client.get_entity(CHANNEL)
        if entity.username.lower() != CHANNEL or not entity.broadcast:
            raise ValueError('Expected public channel unavailable')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Exclusive creation: a retry cannot silently overwrite another session.
        with target.open('x') as file:
            json.dump({'api_id': api_id, 'api_hash': api_hash, 'session': client.session.save()}, file)
        target.chmod(0o600)
        print(f'Connection saved privately to {target}. No production settings changed.')
    finally:
        await client.disconnect()

if __name__ == '__main__':
    # The collector uses a hyphenated CLI filename; import it explicitly without installing a package.
    import importlib.util
    import sys
    spec = importlib.util.spec_from_file_location('collect_telegram', Path(__file__).with_name('collect-telegram.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules['collect_telegram'] = module
    spec.loader.exec_module(module)
    try:
        asyncio.run(connect())
    except (Exception, KeyboardInterrupt) as error:
        print(f'Connection did not complete ({type(error).__name__}). No credentials printed.')
        raise SystemExit(1)
