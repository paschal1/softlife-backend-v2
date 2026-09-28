import type { NotificationSeverity } from '../../database/database.types';
import type { DomainEvent } from '../../events/domain-event';
import { formatAmount } from '../receipts/receipt-format';

export const NOTIFICATION_KINDS = [
  'low_stock',
  'register_variance',
  'driver_cash_variance',
  'credit_override',
  'sale_voided',
  'pin_locked',
  'sync_flagged',
  'delivery_failed',
  'debt_overdue',
  'daily_digest',
  'export_ready',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationDraft {
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

/** Human names for ids mentioned in an event (staff, tills, customers, branches). */
export type NameLookup = (id: unknown) => string;

const naira = (kobo: unknown) => `₦${formatAmount(Math.abs(Number(kobo ?? 0)))}`;

const FLAG_TEXT: Record<string, string> = {
  price_differs_from_catalogue: 'sold at an old price',
  wallet_shortfall_moved_to_credit: 'wallet shortfall moved to debt',
  credit_limit_exceeded: 'over the credit limit',
  unapproved_discount: 'discount without manager approval',
  unapproved_credit_limit: 'credit override without manager approval',
};

/**
 * INS-02: which events become alerts for owners and managers, and how they read.
 * Returns null for events nobody needs to be told about.
 */
export function draftForEvent(event: DomainEvent, name: NameLookup): NotificationDraft | null {
  const p = event.payload as Record<string, unknown>;

  switch (event.type) {
    case 'threshold.crossed': {
      if (p.rule === 'low_stock') {
        return {
          kind: 'low_stock',
          severity: 'warning',
          title: `Low stock: ${String(p.productName)}`,
          body: `${String(p.quantity)} left at ${name(p.locationId)} (reorder level ${String(p.reorderLevel)}).`,
          data: { productId: event.aggregateId, locationId: p.locationId },
        };
      }
      if (p.rule === 'register_variance') {
        const short = Number(p.varianceKobo) < 0;
        return {
          kind: 'register_variance',
          severity: short ? 'critical' : 'warning',
          title: `Till ${short ? 'short' : 'over'} by ${naira(p.varianceKobo)}`,
          body: `${name(p.staffId)} closed ${name(p.registerId)} ${naira(p.varianceKobo)} ${short ? 'short' : 'over'}. You're alerted above ${naira(p.thresholdKobo)}.`,
          data: { registerSessionId: event.aggregateId },
        };
      }
      if (p.rule === 'driver_cash_variance') {
        const short = Number(p.varianceKobo) < 0;
        return {
          kind: 'driver_cash_variance',
          severity: short ? 'critical' : 'warning',
          title: `Driver cash ${short ? 'short' : 'over'} by ${naira(p.varianceKobo)}`,
          body: `${name(event.aggregateId)} handed in ${naira(p.varianceKobo)} ${short ? 'less' : 'more'} than they collected on deliveries.`,
          data: { remittanceId: p.remittanceId, driverId: event.aggregateId },
        };
      }
      return null;
    }

    case 'credit.limit_overridden':
      return {
        kind: 'credit_override',
        severity: 'warning',
        title: `Credit limit exceeded: ${name(event.aggregateId)}`,
        body: `Now owes ${naira(p.projectedKobo)} against a ${naira(p.limitKobo)} limit. Approved by ${name(p.approvedBy)}.`,
        data: { customerId: event.aggregateId, saleId: p.saleId },
      };

    case 'sale.voided':
      return {
        kind: 'sale_voided',
        severity: 'info',
        title: `Sale #${String(p.number)} voided`,
        body: `By ${name(event.actorId)}${p.approvedBy ? `, approved by ${name(p.approvedBy)}` : ''}: "${String(p.reason)}".`,
        data: { saleId: event.aggregateId },
      };

    case 'user.pin_locked':
      return {
        kind: 'pin_locked',
        severity: 'warning',
        title: `PIN locked: ${name(event.aggregateId)}`,
        body: `Too many wrong PIN attempts on ${name(event.actorId)}'s till. Locked for ${String(p.lockedForMinutes ?? 15)} minutes.`,
        data: { userId: event.aggregateId },
      };

    case 'sync.flagged': {
      const flags = Array.isArray(p.flags) ? (p.flags as string[]) : [];
      return {
        kind: 'sync_flagged',
        severity: 'warning',
        title: `Offline sale #${String(p.number)} needs a look`,
        body: `Recorded by ${name(event.actorId)} while offline: ${flags.map((f) => FLAG_TEXT[f] ?? f.replace(/_/g, ' ')).join(', ')}.`,
        data: { saleId: event.aggregateId },
      };
    }

    case 'delivery.failed':
      return {
        kind: 'delivery_failed',
        severity: 'info',
        title: 'Delivery failed',
        body: `${name(p.driverId)}: "${String(p.reason)}" (attempt ${String(p.attempt ?? 1)}). Reassign it from the delivery queue.`,
        data: { deliveryId: event.aggregateId },
      };

    default:
      return null;
  }
}

/** Every id a draft might need a name for. */
export function idsToName(event: DomainEvent): string[] {
  const p = event.payload as Record<string, unknown>;
  const candidates = [event.aggregateId, event.actorId, p.locationId, p.staffId, p.registerId, p.approvedBy, p.driverId];
  return [...new Set(candidates.filter((v): v is string => typeof v === 'string'))];
}
