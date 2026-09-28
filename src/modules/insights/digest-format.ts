import { formatAmount } from '../receipts/receipt-format';

/** Everything in the daily summary (INS-01) — the digest message and the dashboard API share it. */
export interface DailySummary {
  date: string;
  sales: { count: number; totalKobo: number; voidedCount: number; byMethod: Record<string, number> };
  topProducts: { productId: string; name: string; quantity: number; revenueKobo: number }[];
  registers: { flaggedClosings: number; netVarianceKobo: number; stillOpen: { registerName: string; staffName: string; openedAt: Date }[] };
  debt: { newCreditKobo: number; repaidKobo: number; outstandingKobo: number; over90DaysKobo: number };
  wallets: { toppedUpKobo: number };
  stock: { lowCount: number; lowItems: { name: string; quantity: number }[] };
  deliveries: { delivered: number; pending: number; failed: number; cashWithDriversKobo: number };
}

const n = (kobo: number) => `₦${formatAmount(kobo)}`;
const plain = (kobo: number) => `NGN${formatAmount(kobo).replace(/\.00$/, '')}`;

/**
 * The evening message to owners. Push/in-app gets the full picture; SMS gets a compact
 * version in plain characters (₦ would force the costly Unicode SMS encoding).
 */
export function formatDigest(s: DailySummary, businessName: string): { title: string; body: string; sms: string } {
  const lines: string[] = [];
  lines.push(`${s.sales.count} sales, ${n(s.sales.totalKobo)}${s.sales.voidedCount ? ` (${s.sales.voidedCount} voided)` : ''}.`);

  const mix = Object.entries(s.sales.byMethod)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${n(v)}`);
  if (mix.length) lines.push(`Paid by ${mix.join(', ')}.`);

  if (s.topProducts.length) {
    lines.push(`Top: ${s.topProducts.slice(0, 3).map((p) => `${p.name} (${p.quantity})`).join(', ')}.`);
  }
  if (s.registers.flaggedClosings > 0) {
    lines.push(`⚠ ${s.registers.flaggedClosings} till(s) closed with a flagged variance (net ${s.registers.netVarianceKobo < 0 ? '−' : '+'}${n(Math.abs(s.registers.netVarianceKobo))}).`);
  }
  if (s.registers.stillOpen.length > 0) {
    lines.push(`⚠ Still open: ${s.registers.stillOpen.map((r) => `${r.registerName} (${r.staffName})`).join(', ')}.`);
  }
  if (s.debt.newCreditKobo > 0 || s.debt.repaidKobo > 0) {
    lines.push(`Credit given ${n(s.debt.newCreditKobo)}, repaid ${n(s.debt.repaidKobo)}. Owed to you: ${n(s.debt.outstandingKobo)}${s.debt.over90DaysKobo ? ` (${n(s.debt.over90DaysKobo)} over 90 days)` : ''}.`);
  } else if (s.debt.outstandingKobo > 0) {
    lines.push(`Owed to you: ${n(s.debt.outstandingKobo)}.`);
  }
  if (s.wallets.toppedUpKobo > 0) lines.push(`Wallet top-ups ${n(s.wallets.toppedUpKobo)}.`);
  if (s.stock.lowCount > 0) {
    lines.push(`Low stock: ${s.stock.lowItems.slice(0, 3).map((i) => `${i.name} (${i.quantity})`).join(', ')}${s.stock.lowCount > 3 ? ` +${s.stock.lowCount - 3} more` : ''}.`);
  }
  if (s.deliveries.delivered + s.deliveries.pending + s.deliveries.failed > 0) {
    lines.push(`Deliveries: ${s.deliveries.delivered} done, ${s.deliveries.pending} pending, ${s.deliveries.failed} failed.`);
  }
  if (s.deliveries.cashWithDriversKobo > 0) lines.push(`${n(s.deliveries.cashWithDriversKobo)} cash still with drivers.`);

  const smsParts = [
    `${businessName} ${s.date}: ${s.sales.count} sales ${plain(s.sales.totalKobo)}`,
    s.registers.flaggedClosings ? `${s.registers.flaggedClosings} till variance` : '',
    s.registers.stillOpen.length ? `${s.registers.stillOpen.length} till still open` : '',
    s.debt.outstandingKobo ? `owed ${plain(s.debt.outstandingKobo)}` : '',
    s.stock.lowCount ? `${s.stock.lowCount} low stock` : '',
    s.deliveries.cashWithDriversKobo ? `${plain(s.deliveries.cashWithDriversKobo)} with drivers` : '',
  ].filter(Boolean);

  return {
    title: `Today at ${businessName}: ${n(s.sales.totalKobo)} from ${s.sales.count} sale${s.sales.count === 1 ? '' : 's'}`,
    body: lines.join('\n'),
    sms: smsParts.join('; ').slice(0, 300),
  };
}
