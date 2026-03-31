"""
email_payments.py — IMAP-based payment verification.
Supports Cash App, Venmo, Zelle, and PayPal notification emails.
Mirrors email-payments.ts exactly.
"""
import re
import html
from datetime import datetime, timezone, timedelta
from typing import Optional, Literal, TypedDict
from dataclasses import dataclass, field

from imapclient import IMAPClient

PaymentProvider = Literal["cashapp", "venmo", "zelle", "paypal"]

FETCH_TIMEOUT_S = 15

KNOWN_HOSTS: dict[str, str] = {
    "gmail.com":      "imap.gmail.com",
    "googlemail.com": "imap.gmail.com",
    "outlook.com":    "outlook.office365.com",
    "hotmail.com":    "outlook.office365.com",
    "live.com":       "outlook.office365.com",
    "yahoo.com":      "imap.mail.yahoo.com",
    "ymail.com":      "imap.mail.yahoo.com",
    "icloud.com":     "imap.mail.me.com",
    "me.com":         "imap.mail.me.com",
}


@dataclass
class PaymentEmailConfig:
    email: str
    password: str
    host: Optional[str] = None
    port: int = 993


def _infer_host(email: str) -> str:
    domain = email.split("@")[-1].lower() if "@" in email else ""
    return KNOWN_HOSTS.get(domain, "imap.gmail.com")


PROVIDER_PATTERNS: dict[str, dict] = {
    "cashapp": {
        "from": [re.compile(r"cash@square\.com", re.I), re.compile(r"no-?reply@cash\.app", re.I), re.compile(r"@cashapp\.com", re.I), re.compile(r"cash@cashapp\.com", re.I)],
        "subject": [re.compile(r"sent you \$", re.I), re.compile(r"you received \$", re.I), re.compile(r"cash app.*payment", re.I), re.compile(r"payment.*cash app", re.I), re.compile(r"you've got cash", re.I)],
    },
    "venmo": {
        "from": [re.compile(r"venmo@venmo\.com", re.I), re.compile(r"no-?reply@venmo\.com", re.I)],
        "subject": [re.compile(r"paid you", re.I), re.compile(r"sent you \$", re.I), re.compile(r"you've got money", re.I), re.compile(r"payment.*received", re.I), re.compile(r"venmo.*payment", re.I)],
    },
    "zelle": {
        "from": [re.compile(r"zelle", re.I), re.compile(r"noreply@chase\.com", re.I), re.compile(r"alerts@bankofamerica\.com", re.I), re.compile(r"alerts@.*wellsfargo\.com", re.I), re.compile(r"alerts@.*usbank\.com", re.I), re.compile(r"alerts@.*capitalone\.com", re.I), re.compile(r"notify@.*zellepay\.com", re.I)],
        "subject": [re.compile(r"you received.*zelle", re.I), re.compile(r"received money with zelle", re.I), re.compile(r"zelle.*payment received", re.I), re.compile(r"payment.*received.*zelle", re.I), re.compile(r"you have received", re.I), re.compile(r"zelle.*you.*received", re.I)],
    },
    "paypal": {
        "from": [re.compile(r"service@paypal\.com", re.I), re.compile(r"service@intl\.paypal\.com", re.I), re.compile(r"paypal@e\.paypal\.com", re.I), re.compile(r"noreply@paypal\.com", re.I)],
        "subject": [re.compile(r"you've got money", re.I), re.compile(r"you received \$", re.I), re.compile(r"payment.*received", re.I), re.compile(r"sent you \$", re.I), re.compile(r"paypal.*payment", re.I), re.compile(r"money.*received", re.I)],
    },
}


def _is_provider_email(provider: str, subject: str, from_addr: str) -> bool:
    p = PROVIDER_PATTERNS[provider]
    from_match = any(r.search(from_addr) for r in p["from"])
    subject_match = any(r.search(subject) for r in p["subject"])
    if provider == "cashapp":
        return from_match and subject_match
    return from_match or subject_match


def _extract_memo(text: str) -> str:
    patterns = [
        re.compile(r"\bFor:?\s+([A-Z0-9][A-Z0-9\-_]{1,40})\b", re.I),
        re.compile(r"\bFor\s*[\r\n]+\s*([A-Z0-9][A-Z0-9\-_]{1,40})\b", re.I),
        re.compile(r"\bNote:\s*([^\n\r<]{2,100})", re.I),
        re.compile(r"\bNote\s*[\r\n]+\s*([^\n\r<]{2,100})", re.I),
        re.compile(r"\bMemo:\s*([^\n\r<]{2,100})", re.I),
        re.compile(r"\bMessage:\s*([^\n\r<]{2,100})", re.I),
        re.compile(r"\bDescription:\s*([^\n\r<]{2,100})", re.I),
        re.compile(r"\bReference:\s*([^\n\r<]{2,100})", re.I),
        re.compile(r'note:?\s+"([^"]{2,100})"', re.I),
        re.compile(r"note:?\s+'([^']{2,100})'", re.I),
    ]
    for pattern in patterns:
        m = pattern.search(text)
        if not m:
            continue
        val = " ".join(m.group(1).split()).strip()
        if len(val) < 2:
            continue
        if re.search(r"https?://", val, re.I):
            continue
        if re.search(r"version=|cipher|bits\d|sha\d{3}", val, re.I):
            continue
        if re.search(r"[0-9a-f]{20,}", val, re.I):
            continue
        if re.search(r"@\w+\.\w+", val):
            continue
        if re.match(r"^(more information|questions|your account|any questions|details|security|help|click|view|manage|update|visit)\b", val, re.I):
            continue
        return val
    return ""


def _strip_rfc822_headers(raw: str) -> str:
    idx = raw.find("\r\n\r\n")
    if idx != -1:
        return raw[idx + 4:]
    idx = raw.find("\n\n")
    if idx != -1:
        return raw[idx + 2:]
    return raw


def _decode_quoted_printable(s: str) -> str:
    s = re.sub(r"=\r?\n", "", s)
    s = re.sub(r"=([0-9A-Fa-f]{2})", lambda m: chr(int(m.group(1), 16)), s)
    return s


def _decode_html_entities(s: str) -> str:
    return (
        s.replace("&amp;", "&")
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&#x2F;", "/")
    )
    # Also handle numeric HTML entities
    result = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), s)
    return result


def _extract_plain_text(raw: str) -> str:
    body = _strip_rfc822_headers(raw)
    decoded = _decode_quoted_printable(body)
    no_tags = re.sub(r"<[^>]+>", " ", decoded)
    return _decode_html_entities(no_tags)


def _extract_amounts(text: str) -> list[float]:
    amounts = []
    for m in re.finditer(r"[+\-]?\$\s*([\d]{1,6}(?:,\d{3})*(?:\.\d{1,2})?)", text, re.I):
        try:
            v = float(m.group(1).replace(",", ""))
            if not (0 < v < 10000):
                continue
            amounts.append(v)
        except ValueError:
            pass
    return list(dict.fromkeys(amounts))  # deduplicate preserving order


def _friendly_error(err: Exception, host: str, port: int) -> Exception:
    msg = str(err)
    if re.search(r"AUTHENTICATIONFAILED|Invalid credentials|Authentication failed", msg, re.I):
        return ValueError("Authentication failed. For Gmail, use an App Password (myaccount.google.com/apppasswords).")
    if re.search(r"ETIMEDOUT|ECONNREFUSED|ENOTFOUND|timed out|refused|Name or service not known", msg, re.I):
        return ConnectionError(f"Cannot connect to IMAP server ({host}:{port}). Check your host settings.")
    return err


def _make_client(config: PaymentEmailConfig) -> IMAPClient:
    host = config.host or _infer_host(config.email)
    return IMAPClient(host, port=config.port, ssl=True, timeout=FETCH_TIMEOUT_S)


async def check_email_payment(
    provider: str,
    amount: float,
    order_id: str,
    config: PaymentEmailConfig,
    lookback_minutes: int = 45,
    already_used_uids: Optional[set] = None,
) -> Optional[str]:
    """
    Returns UID string if a matching payment email is found, else None.
    """
    if already_used_uids is None:
        already_used_uids = set()

    host = config.host or _infer_host(config.email)
    port = config.port

    import asyncio
    loop = asyncio.get_event_loop()

    def _sync_check():
        client = _make_client(config)
        try:
            client.login(config.email, config.password)
            client.select_folder("INBOX")
            since = datetime.now(timezone.utc) - timedelta(minutes=lookback_minutes)
            uids = client.search(["SINCE", since.date()])
            if not uids:
                return None

            for uid in reversed(uids):
                uid_str = str(uid)
                if uid_str in already_used_uids:
                    continue
                msgs = client.fetch([uid], ["ENVELOPE", "RFC822"])
                if uid not in msgs:
                    continue
                data = msgs[uid]
                envelope = data.get(b"ENVELOPE")
                raw_bytes = data.get(b"RFC822", b"")

                subject = ""
                from_addr = ""
                msg_date = None

                if envelope:
                    if envelope.subject:
                        try:
                            subj_raw = envelope.subject
                            if isinstance(subj_raw, bytes):
                                subject = subj_raw.decode("utf-8", errors="replace")
                            else:
                                subject = str(subj_raw)
                        except Exception:
                            subject = ""
                    if envelope.from_:
                        f = envelope.from_[0]
                        mb = (f.mailbox or b"").decode("utf-8", errors="replace") if isinstance(f.mailbox, bytes) else str(f.mailbox or "")
                        host_part = (f.host or b"").decode("utf-8", errors="replace") if isinstance(f.host, bytes) else str(f.host or "")
                        from_addr = f"{mb}@{host_part}"
                    if envelope.date:
                        msg_date = envelope.date

                if not _is_provider_email(provider, subject, from_addr):
                    continue

                if msg_date:
                    cutoff = datetime.now(timezone.utc) - timedelta(minutes=lookback_minutes)
                    if isinstance(msg_date, datetime):
                        dt = msg_date if msg_date.tzinfo else msg_date.replace(tzinfo=timezone.utc)
                        if dt < cutoff:
                            continue

                raw_text = raw_bytes.decode("utf-8", errors="replace") if isinstance(raw_bytes, bytes) else str(raw_bytes)
                plain_text = _extract_plain_text(raw_text)
                combined = (subject + " " + plain_text).lower()

                amount_matches = any(abs(a - amount) < 0.015 for a in _extract_amounts(combined))

                if provider == "cashapp":
                    strict_sender = bool(re.search(r"cash@square\.com", from_addr, re.I))
                    if not strict_sender:
                        continue
                    if not amount_matches:
                        continue
                    memo = _extract_memo(plain_text)
                    has_order_id = (
                        order_id.lower() in memo.lower() or order_id.lower() in combined
                    ) if order_id else True
                    if has_order_id:
                        return uid_str
                    continue

                has_order_id = order_id.lower() in combined if order_id else True
                if amount_matches and has_order_id:
                    return uid_str

            return None
        except Exception as e:
            raise _friendly_error(e, host, port)
        finally:
            try:
                client.logout()
            except Exception:
                pass

    return await loop.run_in_executor(None, _sync_check)


async def inspect_latest_payment_email(
    config: PaymentEmailConfig,
    provider: Optional[str] = None,
    amount: Optional[float] = None,
    lookback_minutes: int = 45,
) -> Optional[dict]:
    host = config.host or _infer_host(config.email)
    port = config.port
    import asyncio
    loop = asyncio.get_event_loop()

    def _sync_inspect():
        client = _make_client(config)
        try:
            client.login(config.email, config.password)
            client.select_folder("INBOX")
            since = datetime.now(timezone.utc) - timedelta(minutes=lookback_minutes)
            uids = client.search(["SINCE", since.date()])
            if not uids:
                return None

            all_providers = ["cashapp", "venmo", "zelle", "paypal"]

            for uid in reversed(uids):
                msgs = client.fetch([uid], ["ENVELOPE", "RFC822"])
                if uid not in msgs:
                    continue
                data = msgs[uid]
                envelope = data.get(b"ENVELOPE")
                raw_bytes = data.get(b"RFC822", b"")

                subject = ""
                from_addr = ""
                msg_date = "unknown"

                if envelope:
                    if envelope.subject:
                        try:
                            sb = envelope.subject
                            subject = sb.decode("utf-8", errors="replace") if isinstance(sb, bytes) else str(sb)
                        except Exception:
                            pass
                    if envelope.from_:
                        f = envelope.from_[0]
                        mb = (f.mailbox or b"").decode("utf-8", errors="replace") if isinstance(f.mailbox, bytes) else str(f.mailbox or "")
                        hp = (f.host or b"").decode("utf-8", errors="replace") if isinstance(f.host, bytes) else str(f.host or "")
                        from_addr = f"{mb}@{hp}"
                    if envelope.date:
                        dt = envelope.date
                        if isinstance(dt, datetime):
                            msg_date = dt.isoformat()

                def sender_only_match(p: str) -> bool:
                    pats = PROVIDER_PATTERNS[p]
                    if p == "cashapp":
                        return any(r.search(from_addr) for r in pats["from"])
                    return any(r.search(from_addr) for r in pats["from"]) or any(r.search(subject) for r in pats["subject"])

                if provider:
                    detected = provider if sender_only_match(provider) else None
                else:
                    detected = next((p for p in all_providers if sender_only_match(p)), None)

                if not detected:
                    continue

                raw_text = raw_bytes.decode("utf-8", errors="replace") if isinstance(raw_bytes, bytes) else str(raw_bytes)
                plain_text = _extract_plain_text(raw_text)
                combined = (subject + " " + plain_text).lower()
                amounts_found = _extract_amounts(combined)
                memo = _extract_memo(plain_text)

                matched = False
                match_reason = "No match criteria given"
                if provider and amount is not None:
                    amount_match = any(abs(a - amount) < 0.015 for a in amounts_found)
                    provider_match = _is_provider_email(provider, subject, from_addr)
                    matched = amount_match and provider_match
                    if matched:
                        match_reason = f"Provider matched + amount ${amount} found"
                    elif amount_match:
                        match_reason = f"Amount ${amount} found but subject did not match payment patterns (subject: \"{subject}\")"
                    elif provider_match:
                        match_reason = f"Provider matched but amount ${amount} not found (saw: {', '.join('$'+str(a) for a in amounts_found) or 'none'})"
                    else:
                        match_reason = f"Subject did not match and amount ${amount} not found"

                body_snippet = " ".join(plain_text.split())[:400]
                return {
                    "uid": str(uid),
                    "from": from_addr,
                    "subject": subject,
                    "date": msg_date,
                    "provider": detected,
                    "amountsFound": amounts_found,
                    "memo": memo,
                    "bodySnippet": body_snippet,
                    "matched": matched,
                    "matchReason": match_reason,
                }
            return None
        except Exception as e:
            raise _friendly_error(e, host, port)
        finally:
            try:
                client.logout()
            except Exception:
                pass

    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _sync_inspect)


async def test_payment_email(config: PaymentEmailConfig) -> bool:
    host = config.host or _infer_host(config.email)
    port = config.port
    import asyncio
    loop = asyncio.get_event_loop()

    def _sync_test():
        client = _make_client(config)
        try:
            client.login(config.email, config.password)
            client.select_folder("INBOX")
            return True
        except Exception as e:
            raise _friendly_error(e, host, port)
        finally:
            try:
                client.logout()
            except Exception:
                pass

    return await loop.run_in_executor(None, _sync_test)


# Zelle shim — same as TypeScript's zelle.ts re-export
check_zelle_payment = check_email_payment
test_zelle_connection = test_payment_email
