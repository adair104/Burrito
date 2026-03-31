// Email-based payment verification via IMAP.
// Supports Cash App, Venmo, Zelle, and PayPal notification emails.
// All providers share one IMAP inbox (one set of credentials per guild).

import { ImapFlow } from 'imapflow';

export type PaymentProvider = 'cashapp' | 'venmo' | 'zelle' | 'paypal';

export interface PaymentEmailConfig {
  email: string;
  password: string;
  host?: string;
  port?: number;
}

const FETCH_TIMEOUT_MS = 15000;

const KNOWN_HOSTS: Record<string, string> = {
  'gmail.com':      'imap.gmail.com',
  'googlemail.com': 'imap.gmail.com',
  'outlook.com':    'outlook.office365.com',
  'hotmail.com':    'outlook.office365.com',
  'live.com':       'outlook.office365.com',
  'yahoo.com':      'imap.mail.yahoo.com',
  'ymail.com':      'imap.mail.yahoo.com',
  'icloud.com':     'imap.mail.me.com',
  'me.com':         'imap.mail.me.com',
};

function inferHost(email: string): string {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return KNOWN_HOSTS[domain] ?? 'imap.gmail.com';
}

// ── Per-provider email detection patterns ─────────────────────────────────────

const PROVIDER_PATTERNS: Record<PaymentProvider, { from: RegExp[]; subject: RegExp[] }> = {
  cashapp: {
    from: [
      /cash@square\.com/i,
      /no-?reply@cash\.app/i,
      /@cashapp\.com/i,
      /cash@cashapp\.com/i,
    ],
    subject: [
      /sent you \$/i,
      /you received \$/i,
      /cash app.*payment/i,
      /payment.*cash app/i,
      /you've got cash/i,
    ],
  },
  venmo: {
    from: [
      /venmo@venmo\.com/i,
      /no-?reply@venmo\.com/i,
    ],
    subject: [
      /paid you/i,
      /sent you \$/i,
      /you've got money/i,
      /payment.*received/i,
      /venmo.*payment/i,
    ],
  },
  zelle: {
    from: [
      /zelle/i,
      /noreply@chase\.com/i,
      /alerts@bankofamerica\.com/i,
      /alerts@.*wellsfargo\.com/i,
      /alerts@.*usbank\.com/i,
      /alerts@.*capitalone\.com/i,
      /notify@.*zellepay\.com/i,
    ],
    subject: [
      /you received.*zelle/i,
      /received money with zelle/i,
      /zelle.*payment received/i,
      /payment.*received.*zelle/i,
      /you have received/i,
      /zelle.*you.*received/i,
    ],
  },
  paypal: {
    from: [
      /service@paypal\.com/i,
      /service@intl\.paypal\.com/i,
      /paypal@e\.paypal\.com/i,
      /noreply@paypal\.com/i,
    ],
    subject: [
      /you've got money/i,
      /you received \$/i,
      /payment.*received/i,
      /sent you \$/i,
      /paypal.*payment/i,
      /money.*received/i,
    ],
  },
};

function isProviderEmail(provider: PaymentProvider, subject: string, from: string): boolean {
  const p = PROVIDER_PATTERNS[provider];
  const fromMatch    = p.from.some(r => r.test(from));
  const subjectMatch = p.subject.some(r => r.test(subject));
  // Cash App: require BOTH correct sender AND a payment-received subject to exclude billing/overdue emails
  if (provider === 'cashapp') return fromMatch && subjectMatch;
  return fromMatch || subjectMatch;
}

function extractMemo(text: string): string {
  // Cash App email format: "For XMO4917H" — "For" followed by a space and the order ID on the same line.
  // Also handle "Note: <text>", "Memo: <text>" for other providers.
  // We intentionally reject long generic phrases and technical strings.
  const patterns: RegExp[] = [
    // Cash App: "For <order-id>" — short alphanumeric token, with or without colon
    /\bFor:?\s+([A-Z0-9][A-Z0-9\-_]{1,40})\b/i,
    // If the word "For" is on its own line followed by value on next line
    /\bFor\s*[\r\n]+\s*([A-Z0-9][A-Z0-9\-_]{1,40})\b/i,
    // Generic labeled fields
    /\bNote:\s*([^\n\r<]{2,100})/i,
    /\bNote\s*[\r\n]+\s*([^\n\r<]{2,100})/i,
    /\bMemo:\s*([^\n\r<]{2,100})/i,
    /\bMessage:\s*([^\n\r<]{2,100})/i,
    /\bDescription:\s*([^\n\r<]{2,100})/i,
    /\bReference:\s*([^\n\r<]{2,100})/i,
    // Venmo payment note: "paid you with note: ..."
    /note:?\s+"([^"]{2,100})"/i,
    /note:?\s+'([^']{2,100})'/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const val = m[1].trim().replace(/\s+/g, ' ');
    if (val.length < 2) continue;
    // Reject technical/garbage strings
    if (/https?:\/\//i.test(val)) continue;
    if (/version=|cipher|bits\d|sha\d{3}/i.test(val)) continue;
    if (/[0-9a-f]{20,}/i.test(val)) continue;
    if (/@\w+\.\w+/.test(val)) continue;
    // Reject common generic phrases that aren't memos
    if (/^(more information|questions|your account|any questions|details|security|help|click|view|manage|update|visit)\b/i.test(val)) continue;
    return val;
  }
  return '';
}

function stripRFC822Headers(raw: string): string {
  // RFC822: blank line separates headers from body
  const crlf = raw.indexOf('\r\n\r\n');
  if (crlf !== -1) return raw.slice(crlf + 4);
  const lf = raw.indexOf('\n\n');
  if (lf !== -1) return raw.slice(lf + 2);
  return raw;
}

function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function extractPlainText(raw: string): string {
  return decodeHtmlEntities(
    decodeQuotedPrintable(stripRFC822Headers(raw))
      .replace(/<[^>]+>/g, ' ')
  );
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g,   '&')
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#160;/g,  ' ')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/&#x27;/g,  "'")
    .replace(/&#x2F;/g,  '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function extractAmounts(text: string): number[] {
  const amounts: number[] = [];
  // Match $1.00, +$1.00, $1,234.50, $ 12.50 (Cash App uses + prefix for received payments)
  const re = /[+\-]?\$\s*([\d]{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(v) && v > 0 && v < 10000) amounts.push(v);
  }
  return [...new Set(amounts)]; // deduplicate
}

function makeClient(config: PaymentEmailConfig): ImapFlow {
  const host = config.host || inferHost(config.email);
  const port = config.port || 993;
  return new ImapFlow({
    host, port, secure: true,
    auth: { user: config.email, pass: config.password },
    logger: false,
    connectionTimeout: FETCH_TIMEOUT_MS,
    greetingTimeout:   FETCH_TIMEOUT_MS,
    socketTimeout:     FETCH_TIMEOUT_MS,
  });
}

function friendlyError(err: unknown, host: string, port: number): Error {
  const msg = (err as Error).message ?? String(err);
  if (/AUTHENTICATIONFAILED|Invalid credentials|Authentication failed/i.test(msg))
    return new Error('Authentication failed. For Gmail, use an App Password (myaccount.google.com/apppasswords).');
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(msg))
    return new Error(`Cannot connect to IMAP server (${host}:${port}). Check your host settings.`);
  return err as Error;
}

/**
 * Check inbox for a payment notification matching `amount` from `provider`.
 * Returns the message UID string on match, or null if not found.
 * Pass `alreadyUsedUids` to prevent the same email confirming two orders.
 */
export async function checkEmailPayment(
  provider: PaymentProvider,
  amount: number,
  orderId: string,
  config: PaymentEmailConfig,
  lookbackMinutes = 45,
  alreadyUsedUids: Set<string> = new Set(),
): Promise<string | null> {
  const host = config.host || inferHost(config.email);
  const port = config.port || 993;
  const client = makeClient(config);

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
      const uids  = await client.search({ since }, { uid: true }) as unknown as number[];
      if (!uids || uids.length === 0) return null;

      for await (const msg of client.fetch([...uids].reverse(), { uid: true, envelope: true, source: true }, { uid: true }) as AsyncIterable<any>) {
        const uid     = String(msg.uid);
        if (alreadyUsedUids.has(uid)) continue;

        const subject = msg.envelope?.subject ?? '';
        const from    = msg.envelope?.from?.[0]?.address ?? '';
        const date    = msg.envelope?.date;

        if (!isProviderEmail(provider, subject, from)) continue;

        // Time gate
        if (date) {
          const cutoff = Date.now() - lookbackMinutes * 60 * 1000;
          if (new Date(date).getTime() < cutoff) continue;
        }

        const rawText   = (msg.source ?? Buffer.alloc(0)).toString('utf8');
        const plainText = extractPlainText(rawText);
        const combined  = (subject + ' ' + plainText).toLowerCase();

        const amountMatches = extractAmounts(combined).some(a => Math.abs(a - amount) < 0.015);

        if (provider === 'cashapp') {
          // Cash App: require strict sender, amount match, and memo/body contains orderId
          const strictSender = /^cash@square\.com$/i.test(from) || /cash@square\.com/i.test(from);
          if (!strictSender) continue;
          if (!amountMatches) continue;
          const memo = extractMemo(plainText);
          const memoHasOrderId = orderId
            ? (memo.toLowerCase().includes(orderId.toLowerCase()) || combined.includes(orderId.toLowerCase()))
            : true;
          if (memoHasOrderId) return uid;
          continue;
        }

        // All other providers: require amount match AND (orderId found OR no orderId given).
        // Requiring both prevents false positives when multiple payments arrive for different orders.
        const hasOrderId = orderId ? combined.includes(orderId.toLowerCase()) : true;
        if (amountMatches && hasOrderId) return uid;
      }

      return null;
    } finally {
      lock.release();
    }
  } catch (err) {
    throw friendlyError(err, host, port);
  } finally {
    try { client.close(); } catch {}
  }
}

export interface PaymentEmailInspectResult {
  uid: string;
  from: string;
  subject: string;
  date: string;
  provider: PaymentProvider | 'unknown';
  amountsFound: number[];
  memo: string;
  bodySnippet: string;
  matched: boolean;
  matchReason: string;
}

/**
 * Scan the inbox and return detailed info about the most recent payment-looking email.
 * If provider/amount are given, also reports whether it would match.
 */
export async function inspectLatestPaymentEmail(
  config: PaymentEmailConfig,
  provider?: PaymentProvider,
  amount?: number,
  lookbackMinutes = 45,
): Promise<PaymentEmailInspectResult | null> {
  const host = config.host || inferHost(config.email);
  const port = config.port || 993;
  const client = makeClient(config);

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
      const uids = await client.search({ since }, { uid: true }) as unknown as number[];
      if (!uids || uids.length === 0) return null;

      const allProviders: PaymentProvider[] = ['cashapp', 'venmo', 'zelle', 'paypal'];

      for await (const msg of client.fetch([...uids].reverse(), { uid: true, envelope: true, source: true }, { uid: true }) as AsyncIterable<any>) {
        const subject   = msg.envelope?.subject ?? '';
        const from      = msg.envelope?.from?.[0]?.address ?? '';
        const date      = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : 'unknown';
        const rawText   = (msg.source ?? Buffer.alloc(0)).toString('utf8');
        const plainText = extractPlainText(rawText);
        const combined  = (subject + ' ' + plainText).toLowerCase();
        const amountsFound = extractAmounts(combined);
        const memo      = extractMemo(plainText);

        // For inspect: match Cash App by sender only (so we can see what's in the inbox and report the subject).
        // For all other providers, use the full isProviderEmail check.
        const senderOnlyMatch = (p: PaymentProvider) => {
          const pat = PROVIDER_PATTERNS[p];
          return p === 'cashapp'
            ? pat.from.some(r => r.test(from))
            : pat.from.some(r => r.test(from)) || pat.subject.some(r => r.test(subject));
        };
        const detectedProvider = provider
          ? (senderOnlyMatch(provider) ? provider : undefined)
          : allProviders.find(p => senderOnlyMatch(p));

        if (!detectedProvider) continue;

        const resolvedProvider: PaymentProvider | 'unknown' = detectedProvider ?? 'unknown';

        let matched = false;
        let matchReason = 'No match criteria given';

        if (provider && amount !== undefined) {
          const amountMatch   = amountsFound.some(a => Math.abs(a - amount) < 0.015);
          const providerMatch = isProviderEmail(provider, subject, from);
          matched = amountMatch && providerMatch;
          if (matched) {
            matchReason = `Provider matched + amount $${amount} found`;
          } else if (amountMatch) {
            matchReason = `Amount $${amount} found but subject did not match payment patterns (subject: "${subject}")`;
          } else if (providerMatch) {
            matchReason = `Provider matched but amount $${amount} not found (saw: ${amountsFound.map(a => '$' + a).join(', ') || 'none'})`;
          } else {
            matchReason = `Subject did not match payment patterns (subject: "${subject}") and amount $${amount} not found`;
          }
        }

        // First 400 chars of decoded plain text for debugging
        const bodySnippet = plainText.replace(/\s+/g, ' ').trim().slice(0, 400);
        return { uid: String(msg.uid), from, subject, date, provider: resolvedProvider, amountsFound, memo, bodySnippet, matched, matchReason };
      }

      return null;
    } finally {
      lock.release();
    }
  } catch (err) {
    throw friendlyError(err, host, port);
  } finally {
    try { client.close(); } catch {}
  }
}

/**
 * Verify IMAP credentials without searching for any payment.
 * Throws a descriptive error on failure.
 */
export async function testPaymentEmail(config: PaymentEmailConfig): Promise<true> {
  const host = config.host || inferHost(config.email);
  const port = config.port || 993;
  const client = makeClient(config);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    lock.release();
    return true;
  } catch (err) {
    throw friendlyError(err, host, port);
  } finally {
    try { client.close(); } catch {}
  }
}
