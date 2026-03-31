"""
firebase_client.py — Firebase Admin SDK wrapper
Supports 3 auth modes:
  1. SERVICE_ACCOUNT_JSON env var (JSON string)
  2. GOOGLE_APPLICATION_CREDENTIALS env var (path to key file)
  3. local service-account.json in project root
Has 30-second guild config cache.
Mirrors firebase.ts exactly (guilds/{guildId}/config/bot path, named database).
"""
import os
import json
import time
import threading
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

# ── Load applet config ────────────────────────────────────────────────────────
print("🔥 Initializing Firebase Admin SDK...")
_applet_config: dict = {}
_config_path = Path(__file__).parent / "firebase-applet-config.json"
try:
    if _config_path.exists():
        _applet_config = json.loads(_config_path.read_text())
        print("✅ Firebase applet config loaded.")
    else:
        print(f"⚠️ firebase-applet-config.json not found at {_config_path}")
except Exception as _e:
    print(f"❌ Error parsing firebase-applet-config.json: {_e}")

_project_id = _applet_config.get("projectId")
_database_id = _applet_config.get("firestoreDatabaseId", "(default)")

# ── Initialize Firebase Admin ─────────────────────────────────────────────────
_init_lock = threading.Lock()

def _init_firebase():
    with _init_lock:
        if firebase_admin._apps:
            pass
        else:
            sa_json = os.environ.get("SERVICE_ACCOUNT_JSON")
            gac = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
            local_file = Path(__file__).parent / "service-account.json"
            opts = {"projectId": _project_id} if _project_id else {}

            if sa_json:
                sa_dict = json.loads(sa_json)
                cred = credentials.Certificate(sa_dict)
                firebase_admin.initialize_app(cred, opts)
                print("✅ Firebase Admin initialized via SERVICE_ACCOUNT_JSON env var")
            elif gac:
                cred = credentials.ApplicationDefault()
                firebase_admin.initialize_app(cred, opts)
                print("✅ Firebase Admin initialized via GOOGLE_APPLICATION_CREDENTIALS")
            elif local_file.exists():
                cred = credentials.Certificate(str(local_file))
                firebase_admin.initialize_app(cred, opts)
                print("✅ Firebase Admin initialized via service-account.json")
            else:
                firebase_admin.initialize_app(options=opts)
                print("✅ Firebase Admin initialized via Application Default Credentials")

        print(f"🔍 Initializing Firestore with databaseId: {_database_id}")
        if _database_id and _database_id != "(default)":
            client = firestore.Client(
                project=_project_id,
                database=_database_id,
            )
        else:
            client = firestore.client()
        print("✅ Firestore Admin DB initialized.")
        return client

db = _init_firebase()
SERVER_TIMESTAMP = firestore.SERVER_TIMESTAMP


# ── Bot config ────────────────────────────────────────────────────────────────

async def get_bot_config() -> dict:
    try:
        doc = db.collection("config").document("bot").get()
        return doc.to_dict() or {} if doc.exists else {}
    except Exception as e:
        print(f"get_bot_config error: {e}")
        return {}


async def update_bot_config(data: dict) -> bool:
    try:
        db.collection("config").document("bot").set(data, merge=True)
        return True
    except Exception as e:
        print(f"update_bot_config error: {e}")
        return False


# ── Guild config with 30-second cache ────────────────────────────────────────
_guild_cache: dict[str, tuple[dict, float]] = {}
_guild_cache_ttl = 30.0
_guild_cache_lock = threading.Lock()


async def get_guild_config(guild_id: str) -> dict:
    now = time.monotonic()
    with _guild_cache_lock:
        entry = _guild_cache.get(guild_id)
        if entry and now - entry[1] < _guild_cache_ttl:
            return entry[0]
    try:
        doc = (
            db.collection("guilds")
            .document(guild_id)
            .collection("config")
            .document("bot")
            .get()
        )
        cfg = doc.to_dict() or {} if doc.exists else {}
        with _guild_cache_lock:
            _guild_cache[guild_id] = (cfg, time.monotonic())
        return cfg
    except Exception as e:
        print(f"get_guild_config({guild_id}) error: {e}")
        return {}


async def update_guild_config(guild_id: str, data: dict) -> bool:
    try:
        (
            db.collection("guilds")
            .document(guild_id)
            .collection("config")
            .document("bot")
            .set(data, merge=True)
        )
        with _guild_cache_lock:
            _guild_cache[guild_id] = (data, time.monotonic())
        return True
    except Exception as e:
        print(f"update_guild_config({guild_id}) error: {e}")
        return False
