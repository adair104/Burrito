"""
cashapp.py — Cash App payment verification using session cookie.
Set CASHAPP_COOKIE in .env to enable automatic payment detection.
Mirrors cashapp.ts exactly.
"""
import asyncio
import re
import httpx

FETCH_TIMEOUT_S = 12
MAX_RETRIES = 2


def _find_between(s: str, first: str, last: str) -> str:
    start = s.find(first)
    if start == -1:
        return ""
    actual_start = start + len(first)
    end = s.find(last, actual_start)
    if end == -1:
        return ""
    return s[actual_start:end]


def _sanitize_cookie(raw: str) -> str:
    c = raw.strip()
    if c.lower().startswith("cash_web_session="):
        c = c[len("cash_web_session="):].strip()
    return c


async def _get_transactions(cookie: str) -> str:
    clean = _sanitize_cookie(cookie)
    headers1 = {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "cookie": f"cash_web_session={clean}",
        "referer": "https://cash.app/",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    }
    async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_S, follow_redirects=True) as client:
        resp1 = await client.get("https://cash.app/account/activity", headers=headers1)
        html = resp1.text

    csrf_token = (
        _find_between(html, "var csrfToken = '", "';")
        or _find_between(html, '"csrf_token":"', '"')
        or _find_between(html, 'csrfToken:"', '"')
        or _find_between(html, "csrfToken: '", "'")
        or _find_between(html, 'name="csrf-token" content="', '"')
        or _find_between(html, '"X-CSRF-Token":"', '"')
    )
    if not csrf_token:
        raise ValueError("Could not extract CSRF token — Cash App cookie may be expired.")

    headers2 = {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
        "cookie": f"cash_web_session={clean}",
        "origin": "https://cash.app",
        "referer": "https://cash.app/account/activity",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "x-csrf-token": csrf_token,
        "x-requested-with": "XMLHttpRequest",
    }
    payload = {
        "limit": 100,
        "order": "DESC",
        "show_completed": True,
        "show_in_flight": True,
        "show_failed_transfers": False,
        "show_sent": False,
        "show_received": True,
    }
    async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_S) as client:
        resp2 = await client.post(
            "https://cash.app/2.0/cash/get-paged-sync-entities",
            headers=headers2,
            json=payload,
        )
        return resp2.text


async def _get_transactions_with_retry(cookie: str) -> str:
    last_err = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            return await _get_transactions(cookie)
        except Exception as e:
            last_err = e
            if attempt < MAX_RETRIES:
                await asyncio.sleep(1.0 * (attempt + 1))
    raise last_err


def _extract_entities(data) -> list:
    results = []

    def walk(node, depth=0):
        if node is None or depth > 6:
            return
        if isinstance(node, list):
            for item in node:
                walk(item, depth + 1)
            return
        if not isinstance(node, dict):
            return
        for key in ["entities", "payments", "transaction_list", "transactions", "items"]:
            if isinstance(node.get(key), list):
                results.extend(node[key])
        for key in ["data", "payload", "result", "response"]:
            if node.get(key) and isinstance(node[key], (dict, list)):
                walk(node[key], depth + 1)

    walk(data)
    return results


async def check_cashapp_payment(amount: float, order_id: str, cookie: str) -> bool:
    """
    Returns True if a matching received Cash App payment is found.
    amount: numeric total (e.g. 12.50)
    order_id: order ID that should appear in the payment note
    cookie: cash_web_session cookie value
    """
    if not cookie:
        return False

    raw = await _get_transactions_with_retry(cookie)
    order_id_lower = order_id.lower()
    amount_str = f"{amount:.2f}"
    whole, decimal = amount_str.split(".")
    display_amount = whole if decimal == "00" else amount_str

    # Structured JSON matching
    try:
        import json as _json
        data = _json.loads(raw)
        entities = _extract_entities(data)

        for entity in entities:
            txn = entity.get("payment") or entity.get("transaction") or entity

            action = str(txn.get("action") or txn.get("type") or txn.get("kind") or "").lower()
            is_sent = action in ("send", "sent", "debit", "p2p_send")
            if is_sent:
                continue
            is_received = action in ("receive", "received", "charge", "payment", "", "p2p_receive")
            if not is_received and action:
                continue

            amount_dollars = None
            raw_amount = txn.get("amount") or txn.get("amount_in_cents") or txn.get("total_amount") or txn.get("display_amount")
            if isinstance(raw_amount, (int, float)):
                amount_dollars = raw_amount / 100 if raw_amount > 1000 and isinstance(raw_amount, int) else float(raw_amount)
            elif isinstance(raw_amount, str):
                cleaned = re.sub(r"[$,]", "", raw_amount)
                try:
                    parsed = float(cleaned)
                    amount_dollars = parsed / 100 if parsed > 1000 else parsed
                except ValueError:
                    pass

            if amount_dollars is None:
                continue
            if abs(amount_dollars - amount) > 0.02:
                continue

            note = str(
                txn.get("note") or txn.get("comment") or txn.get("memo") or
                txn.get("message") or txn.get("display_string") or txn.get("notes") or ""
            ).lower()

            if order_id_lower in note:
                return True
    except Exception:
        pass

    # Fallback: plain-text search
    raw_lower = raw.lower()
    amount_patterns = [
        f"${display_amount}", f"${amount_str}",
        f"+${display_amount}", f"+${amount_str}",
        f'"{display_amount}"', f'"{amount_str}"',
    ]
    for pattern in amount_patterns:
        idx = raw_lower.find(pattern.lower())
        if idx == -1:
            continue
        window_start = max(0, idx - 500)
        window_end = min(len(raw_lower), idx + 500)
        window = raw_lower[window_start:window_end]
        if order_id_lower in window:
            return True

    sentence_patterns = [
        f"sent you ${display_amount} for {order_id_lower}",
        f"sent you ${amount_str} for {order_id_lower}",
        f"received ${display_amount}",
        f"received ${amount_str}",
    ]
    return any(p in raw_lower for p in sentence_patterns)
