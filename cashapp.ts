// Cash App payment verification using the bot owner's own session cookie.
// Set CASHAPP_COOKIE in .env to enable automatic payment detection.

const FETCH_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;

function findBetween(s: string, first: string, last: string): string {
  const start = s.indexOf(first);
  if (start === -1) return '';
  const actualStart = start + first.length;
  const end = s.indexOf(last, actualStart);
  if (end === -1) return '';
  return s.slice(actualStart, end);
}

function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Strip leading/trailing whitespace and the "cash_web_session=" prefix if accidentally included. */
function sanitizeCookie(raw: string): string {
  let c = raw.trim();
  // Strip full header format: "cash_web_session=VALUE"
  if (c.toLowerCase().startsWith('cash_web_session=')) {
    c = c.slice('cash_web_session='.length).trim();
  }
  return c;
}

async function getTransactions(cookie: string): Promise<string> {
  const cleanCookie = sanitizeCookie(cookie);

  const headers1: Record<string, string> = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'cookie': `cash_web_session=${cleanCookie}`,
    'referer': 'https://cash.app/',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };

  const resp1 = await fetchWithTimeout('https://cash.app/account/activity', { headers: headers1 });
  const html = await resp1.text();

  // Try multiple CSRF token extraction patterns
  let csrfToken =
    findBetween(html, "var csrfToken = '", "';") ||
    findBetween(html, '"csrf_token":"', '"') ||
    findBetween(html, 'csrfToken:"', '"') ||
    findBetween(html, "csrfToken: '", "'") ||
    findBetween(html, 'name="csrf-token" content="', '"') ||
    findBetween(html, '"X-CSRF-Token":"', '"');

  if (!csrfToken) {
    throw new Error('Could not extract CSRF token — Cash App cookie may be expired or the page structure changed.');
  }

  const headers2: Record<string, string> = {
    'accept': 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'cookie': `cash_web_session=${cleanCookie}`,
    'origin': 'https://cash.app',
    'referer': 'https://cash.app/account/activity',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-csrf-token': csrfToken,
    'x-requested-with': 'XMLHttpRequest',
  };

  const resp2 = await fetchWithTimeout('https://cash.app/2.0/cash/get-paged-sync-entities', {
    method: 'POST',
    headers: headers2,
    body: JSON.stringify({
      limit: 100,
      order: 'DESC',
      show_completed: true,
      show_in_flight: true,
      show_failed_transfers: false,
      show_sent: false,
      show_received: true,
    }),
  });

  return resp2.text();
}

async function getTransactionsWithRetry(cookie: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await getTransactions(cookie);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        // Brief back-off before retry: 1s, 2s
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Walk a deeply-nested object and collect all matching payment transactions.
 * Cash App has changed its response shape several times; this handles all known variants.
 */
function extractEntities(data: any): any[] {
  const results: any[] = [];

  function walk(node: any, depth = 0): void {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    // Known entity wrapper keys
    for (const key of ['entities', 'payments', 'transaction_list', 'transactions', 'items']) {
      if (Array.isArray(node[key])) {
        results.push(...node[key]);
      }
    }

    // Recurse into data/payload wrappers
    for (const key of ['data', 'payload', 'result', 'response']) {
      if (node[key] && typeof node[key] === 'object') walk(node[key], depth + 1);
    }
  }

  walk(data);
  return results;
}

/**
 * Checks whether a Cash App account received a payment matching the given
 * amount and containing the order ID in the note.
 *
 * @param amount   Numeric total, e.g. 12.50
 * @param orderId  The order ID that the customer should include in the note
 * @param cookie   The guild's cash_web_session cookie value
 * @returns true if a matching received payment is found, false otherwise
 */
export async function checkCashAppPayment(amount: number, orderId: string, cookie: string): Promise<boolean> {
  if (!cookie) return false;

  const raw = await getTransactionsWithRetry(cookie);
  const orderIdLower = orderId.toLowerCase();
  const amountStr = amount.toFixed(2);
  const [whole, decimal] = amountStr.split('.');
  const displayAmount = decimal === '00' ? whole : amountStr;

  // ── Structured JSON matching ───────────────────────────────────────────────
  try {
    const data = JSON.parse(raw);
    const entities = extractEntities(data);

    for (const entity of entities) {
      // Handle wrapper shapes
      const txn = entity?.payment ?? entity?.transaction ?? entity;

      const action: string = (txn?.action ?? txn?.type ?? txn?.kind ?? '').toLowerCase();
      // Accept receive/charge/payment actions; skip sent/debit
      const isReceived = action === 'receive' || action === 'received' || action === 'charge' ||
        action === 'payment' || action === '' || action === 'p2p_receive';
      const isSent = action === 'send' || action === 'sent' || action === 'debit' || action === 'p2p_send';
      if (isSent) continue;
      if (!isReceived && action !== '') continue;

      // Amount: Cash App stores in cents (integer) or as decimal string
      let amountDollars: number | null = null;
      const rawAmount = txn?.amount ?? txn?.amount_in_cents ?? txn?.total_amount ?? txn?.display_amount;
      if (typeof rawAmount === 'number') {
        // Could be cents (large int) or dollars (small float)
        amountDollars = rawAmount > 1000 && Number.isInteger(rawAmount)
          ? rawAmount / 100
          : rawAmount;
      } else if (typeof rawAmount === 'string') {
        const parsed = parseFloat(rawAmount.replace(/[$,]/g, ''));
        if (!isNaN(parsed)) amountDollars = parsed > 1000 ? parsed / 100 : parsed;
      }

      if (amountDollars === null) continue;
      if (Math.abs(amountDollars - amount) > 0.02) continue;

      // Note / memo field
      const note: string = (
        txn?.note ?? txn?.comment ?? txn?.memo ?? txn?.message ??
        txn?.display_string ?? txn?.notes ?? ''
      ).toLowerCase();

      if (note.includes(orderIdLower)) return true;
    }
  } catch {
    // JSON parse failed — fall through to text search
  }

  // ── Fallback: plain-text search ────────────────────────────────────────────
  const rawLower = raw.toLowerCase();

  // Multiple amount patterns to catch different display formats
  const amountPatterns = [
    `$${displayAmount}`,
    `$${amountStr}`,
    `+$${displayAmount}`,
    `+$${amountStr}`,
    `"${displayAmount}"`,
    `"${amountStr}"`,
  ];

  for (const pattern of amountPatterns) {
    const idx = rawLower.indexOf(pattern.toLowerCase());
    if (idx === -1) continue;
    // Check if orderId appears within ±500 chars
    const windowStart = Math.max(0, idx - 500);
    const windowEnd   = Math.min(rawLower.length, idx + 500);
    const window = rawLower.slice(windowStart, windowEnd);
    if (window.includes(orderIdLower)) return true;
  }

  // Very last resort: sentence-style patterns
  const sentencePatterns = [
    `sent you $${displayAmount} for ${orderIdLower}`,
    `sent you $${amountStr} for ${orderIdLower}`,
    `received $${displayAmount}`,
    `received $${amountStr}`,
  ];
  return sentencePatterns.some(p => rawLower.includes(p));
}
