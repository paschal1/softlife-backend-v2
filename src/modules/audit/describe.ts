import { formatAmount } from '../receipts/receipt-format';

/**
 * Turns an audit entry into one readable sentence for the viewer and exports. Pure: every
 * name it needs is either in the entry itself or passed in.
 */
export interface DescribableEntry {
  actionType: string;
  entityName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const money = (v: unknown) => (typeof v === 'number' ? `${v < 0 ? '-' : ''}₦${formatAmount(Math.abs(v))}` : String(v ?? ''));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const FIELD_LABELS: Record<string, string> = {
  name: 'name',
  sku: 'SKU',
  barcode: 'barcode',
  category: 'category',
  unit: 'unit',
  sellingPriceKobo: 'price',
  wholesalePriceKobo: 'wholesale price',
  costPriceKobo: 'cost price',
  reorderLevel: 'reorder level',
  isActive: 'active',
  is_active: 'active',
  credit_limit_kobo: 'credit limit',
  type: 'customer type',
  phone: 'phone',
  address: 'address',
  eodVarianceAlertKobo: 'EOD variance alert',
  creditLimitMode: 'credit limit mode',
  defaultCreditLimitKobo: 'default credit limit',
  enabledOrderTypes: 'order types',
  dailyDigestHour: 'digest hour',
};

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '(none)';
  if (/kobo$/i.test(field)) return money(value);
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/** "price ₦300.00 → ₦350.00; reorder level 20 → 30" */
export function describeChanges(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!before || !after) return '';
  return Object.keys(before)
    .filter((k) => k in after)
    .map((k) => `${FIELD_LABELS[k] ?? k.replace(/_/g, ' ')} ${show(k, before[k])} → ${show(k, after[k])}`)
    .join('; ');
}

export function describeEntry(e: DescribableEntry): string {
  const a = e.after ?? {};
  const b = e.before ?? {};
  const who = e.entityName ?? '';

  switch (e.actionType) {
    case 'sale.completed':
      return `Sale #${String(a.number)} (${String(a.orderType ?? '').replace(/_/g, ' ')}) for ${money(a.totalKobo)}${Number(a.creditKobo) > 0 ? `, ${money(a.creditKobo)} on credit` : ''}`;
    case 'sale.voided':
      return `Voided sale #${String(a.number ?? '')}${a.reason ? `: "${String(a.reason)}"` : ''}`;
    case 'product.created':
      return `Added product ${String(a.name)} at ${money(a.sellingPriceKobo)}`;
    case 'product.updated':
      return `Changed ${who || 'product'}: ${describeChanges(b, a)}`;
    case 'stock.received':
      return `Received stock: ${plural(Array.isArray(a.items) ? a.items.length : 0, 'product')}${a.supplierName ? ` from ${String(a.supplierName)}` : ''}`;
    case 'stock.adjusted':
      return `${String(a.kind ?? 'Adjusted').replace(/_/g, ' ')} ${who}: ${String(b.quantity ?? '?')} → ${String(a.quantity ?? '?')}${a.reason ? ` ("${String(a.reason)}")` : ''}`;
    case 'stock.transferred':
      return `Transferred ${plural(Array.isArray(a.items) ? a.items.length : 0, 'product')} between branches`;
    case 'register.opened':
      return `Clocked in to ${String(a.registerName ?? 'a till')} with a ${money(a.openingFloatKobo)} float`;
    case 'register.closed':
      return `Closed till: counted ${money(a.countedCashKobo)}, expected ${money(a.expectedCashKobo)}, variance ${money(a.varianceKobo)}${a.varianceFlagged ? ' (flagged)' : ''}`;
    case 'register.cash_moved':
      return `${a.kind === 'pay_out' ? 'Paid out' : 'Paid in'} ${money(Math.abs(Number(a.amountKobo)))}: ${String(a.reason ?? '')}`;
    case 'customer.created':
      return `Added customer ${String(a.name)}`;
    case 'customer.updated':
      return `Changed customer ${who}: ${describeChanges(b, a)}`;
    case 'wallet.topped_up':
      return `Wallet top-up ${money(a.amountKobo)} by ${String(a.method)} for ${who}`;
    case 'wallet.debited':
      return `Paid ${money(Math.abs(Number(a.amountKobo)))} from ${who}'s wallet`;
    case 'wallet.refunded':
      return `Refunded ${money(a.amountKobo)} to ${who}'s wallet`;
    case 'wallet.adjusted':
      return `Adjusted ${who}'s wallet by ${money(a.amountKobo)}: "${String(a.reason ?? '')}"`;
    case 'debt.created':
      return `${who} took ${money(a.amountKobo)} on credit`;
    case 'debt.voided':
      return `Cancelled ${money(a.amountKobo)} debt for ${who} (sale voided)`;
    case 'repayment.recorded':
      return `${who} repaid ${money(a.amountKobo)} by ${String(a.method)}`;
    case 'credit.limit_overridden':
      return `Credit limit exceeded for ${who}: owes ${money(a.projectedKobo)} against ${money(a.limitKobo)}`;
    case 'user.created':
      return `Added ${String(a.role ?? 'staff')} ${String(a.fullName ?? '')}`;
    case 'user.pin_changed':
      return `Changed PIN for ${who}`;
    case 'user.pin_locked':
      return `PIN locked for ${who} after too many wrong attempts`;
    case 'organization.settings_updated':
      return `Changed business settings: ${describeChanges(b, a)}`;
    case 'delivery.assigned':
      return `Assigned delivery to ${String(a.driverName ?? 'a driver')}`;
    case 'delivery.confirmed':
      return `Delivered${Number(a.collectedKobo) > 0 ? `, collected ${money(a.collectedKobo)}` : ''} (proof: ${String(a.proof ?? '').replace(/_/g, ' ')})`;
    case 'delivery.failed':
      return `Delivery failed: "${String(a.reason ?? '')}"`;
    case 'delivery.cash_remitted':
      return `Driver handed in ${money(a.countedKobo)} (expected ${money(a.expectedKobo)})`;
    case 'threshold.crossed':
      return `Alert: ${String(a.rule ?? '').replace(/_/g, ' ')}`;
    case 'sync.flagged':
      return `Offline sale #${String(a.number)} flagged: ${(Array.isArray(a.flags) ? a.flags : []).join(', ').replace(/_/g, ' ')}`;
    case 'audit.exported':
      return `Exported the audit log as ${String(a.format ?? '').toUpperCase()}`;
    default: {
      const [entity, verb] = e.actionType.split('.');
      return `${(entity ?? '').replace(/_/g, ' ')} ${(verb ?? '').replace(/_/g, ' ')}${who ? `: ${who}` : ''}`.trim();
    }
  }
}
