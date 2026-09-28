/**
 * Receipt rendering: plain text for thermal printers, HTML for screens and WhatsApp links.
 * Pure functions, no I/O.
 */

export interface ReceiptData {
  businessName: string;
  branchName: string;
  branchAddress: string | null;
  branchPhone: string | null;
  saleNumber: number;
  occurredAt: Date;
  timezone: string;
  cashierName: string;
  registerName: string;
  customerName: string | null;
  orderType: string;
  items: { name: string; quantity: number; unit: string; unitPriceKobo: number; discountKobo: number; lineTotalKobo: number }[];
  subtotalKobo: number;
  discountKobo: number;
  totalKobo: number;
  payments: { method: string; amountKobo: number; tenderedKobo: number | null; reference: string | null }[];
  changeKobo: number;
  creditKobo: number;
  delivery: { fulfilment: 'delivery' | 'pickup'; address: string | null; date: string; code: string | null; codKobo: number } | null;
  status: 'completed' | 'voided';
  voidReason: string | null;
}

/** 123456 kobo -> "1,234.56". Deterministic (no locale data needed). */
export function formatAmount(kobo: number): string {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const k = (abs % 100).toString().padStart(2, '0');
  return `${sign}${naira}.${k}`;
}

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  transfer: 'Transfer',
  card: 'POS/Card',
  wallet: 'Wallet',
  credit: 'Credit (owed)',
  pay_on_delivery: 'Pay on delivery',
};

const ORDER_LABELS: Record<string, string> = {
  walk_in: 'Walk-in',
  delivery: 'Delivery',
  credit: 'Credit',
  pre_order: 'Pre-order',
  wholesale: 'Wholesale',
};

function formatWhen(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  } catch {
    return at.toISOString();
  }
}

/**
 * Fixed-width text for 58mm (32 columns) or 80mm (48 columns) thermal printers.
 * Uses "NGN" rather than "₦": most cheap Bluetooth printers lack the naira glyph.
 */
export function renderText(r: ReceiptData, width: 32 | 48 = 32): string {
  const lines: string[] = [];
  const center = (s: string) => {
    const t = s.slice(0, width);
    return ' '.repeat(Math.max(0, Math.floor((width - t.length) / 2))) + t;
  };
  const pair = (left: string, right: string) => {
    const room = width - right.length - 1;
    const l = left.length > room ? left.slice(0, Math.max(0, room)) : left;
    return l + ' '.repeat(Math.max(1, width - l.length - right.length)) + right;
  };
  const rule = '-'.repeat(width);

  if (r.status === 'voided') lines.push(center('*** VOID ***'));
  lines.push(center(r.businessName.toUpperCase()));
  lines.push(center(r.branchName));
  if (r.branchAddress) lines.push(...wrap(r.branchAddress, width).map(center));
  if (r.branchPhone) lines.push(center(`Tel: ${r.branchPhone}`));
  lines.push(rule);
  lines.push(pair(`Receipt #${r.saleNumber}`, ORDER_LABELS[r.orderType] ?? r.orderType));
  lines.push(formatWhen(r.occurredAt, r.timezone));
  lines.push(`Served by: ${r.cashierName} (${r.registerName})`.slice(0, width));
  if (r.customerName) lines.push(`Customer: ${r.customerName}`.slice(0, width));
  lines.push(rule);

  for (const item of r.items) {
    lines.push(...wrap(item.name, width));
    lines.push(pair(`  ${item.quantity} ${item.unit} x ${formatAmount(item.unitPriceKobo)}`, formatAmount(item.quantity * item.unitPriceKobo)));
    if (item.discountKobo > 0) lines.push(pair('  Discount', `-${formatAmount(item.discountKobo)}`));
  }

  lines.push(rule);
  if (r.discountKobo > 0) {
    lines.push(pair('Subtotal', formatAmount(r.subtotalKobo)));
    lines.push(pair('Discount', `-${formatAmount(r.discountKobo)}`));
  }
  lines.push(pair('TOTAL (NGN)', formatAmount(r.totalKobo)));
  for (const p of r.payments) {
    lines.push(pair(METHOD_LABELS[p.method] ?? p.method, formatAmount(p.amountKobo)));
    if (p.tenderedKobo !== null) lines.push(pair('  Tendered', formatAmount(p.tenderedKobo)));
    if (p.reference) lines.push(`  Ref: ${p.reference}`.slice(0, width));
  }
  if (r.changeKobo > 0) lines.push(pair('Change', formatAmount(r.changeKobo)));
  if (r.creditKobo > 0) lines.push(pair('Balance owed', formatAmount(r.creditKobo)));

  if (r.delivery) {
    const pickup = r.delivery.fulfilment === 'pickup';
    lines.push(rule);
    lines.push(pickup ? `Collect on ${r.delivery.date}` : `Delivery on ${r.delivery.date}`);
    if (r.delivery.address) lines.push(...wrap(r.delivery.address, width));
    if (r.delivery.code) {
      lines.push(center(`${pickup ? 'COLLECTION' : 'DELIVERY'} CODE: ${r.delivery.code}`));
      lines.push(...wrap(pickup ? 'Show this code when you collect.' : 'Give this code to the driver only when you receive your goods.', width).map(center));
    }
  }
  if (r.status === 'voided' && r.voidReason) {
    lines.push(rule);
    lines.push(...wrap(`VOIDED: ${r.voidReason}`, width));
  }
  lines.push(rule);
  lines.push(center('Thank you for your patronage!'));
  lines.push(center('Powered by SoftLife'));
  return lines.join('\n') + '\n';
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    const w = word.length > width ? word.slice(0, width) : word;
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A self-contained, mobile-friendly receipt page (opens from a WhatsApp link, prints on A4 or 80mm). */
export function renderHtml(r: ReceiptData): string {
  const e = escapeHtml;
  const money = (k: number) => `₦${formatAmount(k)}`;
  const itemRows = r.items
    .map(
      (i) => `<tr><td>${e(i.name)}<div class="sub">${i.quantity} ${e(i.unit)} × ${money(i.unitPriceKobo)}${
        i.discountKobo > 0 ? ` · discount −${money(i.discountKobo)}` : ''
      }</div></td><td class="num">${money(i.lineTotalKobo)}</td></tr>`,
    )
    .join('');
  const paymentRows = r.payments
    .map(
      (p) => `<tr><td>${e(METHOD_LABELS[p.method] ?? p.method)}${p.reference ? `<div class="sub">Ref: ${e(p.reference)}</div>` : ''}${
        p.tenderedKobo !== null ? `<div class="sub">Tendered ${money(p.tenderedKobo)}</div>` : ''
      }</td><td class="num">${money(p.amountKobo)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Receipt #${r.saleNumber} · ${e(r.businessName)}</title>
<style>
  :root { --ink:#14171A; --muted:#5f6b76; --line:#e3e6e8; --accent:#0F6B47; --bg:#f4f5f4; --paper:#fff; }
  @media (prefers-color-scheme: dark) { :root { --ink:#eef1ef; --muted:#9aa5ad; --line:#2c3236; --bg:#111416; --paper:#1a1e21; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font: 15px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
         padding: env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0); }
  .receipt { max-width: 420px; margin: 16px auto; background:var(--paper); border:1px solid var(--line); border-radius:12px; padding:20px; }
  h1 { font-size:18px; margin:0; text-align:center; }
  .center { text-align:center; } .muted, .sub { color:var(--muted); font-size:13px; }
  .meta { display:flex; justify-content:space-between; margin:12px 0 4px; font-weight:600; }
  table { width:100%; border-collapse:collapse; } td { padding:6px 0; border-top:1px solid var(--line); vertical-align:top; }
  .num { text-align:right; white-space:nowrap; padding-left:12px; }
  .total td { font-weight:700; font-size:17px; border-top:2px solid var(--ink); }
  .void { color:#b3261e; border:2px solid #b3261e; border-radius:8px; text-align:center; font-weight:700; padding:6px; margin-bottom:12px; }
  .code { margin-top:12px; padding:10px; border:1px dashed var(--accent); border-radius:8px; text-align:center; }
  .code b { font-size:22px; letter-spacing:4px; color:var(--accent); }
  .foot { margin-top:16px; text-align:center; color:var(--muted); font-size:12px; }
  .foot b { color:var(--accent); }
  @media print { body { background:#fff; } .receipt { border:none; margin:0; max-width:none; } }
</style></head>
<body><main class="receipt">
  ${r.status === 'voided' ? `<div class="void">VOIDED${r.voidReason ? ` — ${e(r.voidReason)}` : ''}</div>` : ''}
  <h1>${e(r.businessName)}</h1>
  <div class="center muted">${e(r.branchName)}${r.branchAddress ? ` · ${e(r.branchAddress)}` : ''}${r.branchPhone ? ` · ${e(r.branchPhone)}` : ''}</div>
  <div class="meta"><span>Receipt #${r.saleNumber}</span><span>${e(ORDER_LABELS[r.orderType] ?? r.orderType)}</span></div>
  <div class="muted">${e(formatWhen(r.occurredAt, r.timezone))} · ${e(r.cashierName)} · ${e(r.registerName)}</div>
  ${r.customerName ? `<div class="muted">Customer: ${e(r.customerName)}</div>` : ''}
  <table style="margin-top:12px">${itemRows}
    ${r.discountKobo > 0 ? `<tr><td>Subtotal</td><td class="num">${money(r.subtotalKobo)}</td></tr><tr><td>Discount</td><td class="num">−${money(r.discountKobo)}</td></tr>` : ''}
    <tr class="total"><td>Total</td><td class="num">${money(r.totalKobo)}</td></tr>
    ${paymentRows}
    ${r.changeKobo > 0 ? `<tr><td>Change</td><td class="num">${money(r.changeKobo)}</td></tr>` : ''}
    ${r.creditKobo > 0 ? `<tr><td><b>Balance owed</b></td><td class="num"><b>${money(r.creditKobo)}</b></td></tr>` : ''}
  </table>
  ${
    r.delivery
      ? `<p class="muted">${r.delivery.fulfilment === 'pickup' ? `Collect on ${e(r.delivery.date)}` : `Delivery on ${e(r.delivery.date)}${r.delivery.address ? ` to ${e(r.delivery.address)}` : ''}`}</p>${
          r.delivery.code
            ? `<div class="code">${r.delivery.fulfilment === 'pickup' ? 'Collection' : 'Delivery'} code <b>${e(r.delivery.code)}</b><div class="sub">${
                r.delivery.fulfilment === 'pickup' ? 'Show this when you collect.' : 'Give it to the driver only when you receive your goods.'
              }</div></div>`
            : ''
        }`
      : ''
  }
  <div class="foot">Thank you for your patronage!<br>Powered by <b>SoftLife</b></div>
</main></body></html>`;
}
