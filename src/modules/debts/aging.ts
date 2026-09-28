/** DEBT-03 buckets: 0–30, 31–60, 61–90 and 90+ days since the credit sale. */
export const AGING_BUCKETS = ['days0to30', 'days31to60', 'days61to90', 'days90plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

const DAY_MS = 86_400_000;

export function ageInDays(createdAt: Date, asOf: Date): number {
  return Math.max(0, Math.floor((asOf.getTime() - createdAt.getTime()) / DAY_MS));
}

export function bucketFor(days: number): AgingBucket {
  if (days <= 30) return 'days0to30';
  if (days <= 60) return 'days31to60';
  if (days <= 90) return 'days61to90';
  return 'days90plus';
}

export type AgingTotals = Record<AgingBucket, number> & { totalKobo: number };

export function emptyTotals(): AgingTotals {
  return { days0to30: 0, days31to60: 0, days61to90: 0, days90plus: 0, totalKobo: 0 };
}

export function addToTotals(totals: AgingTotals, outstandingKobo: number, createdAt: Date, asOf: Date): void {
  totals[bucketFor(ageInDays(createdAt, asOf))] += outstandingKobo;
  totals.totalKobo += outstandingKobo;
}

export interface OpenDebt {
  id: string;
  outstandingKobo: number;
}

export interface Allocation {
  debtRecordId: string;
  amountKobo: number;
}

export class AllocationError extends Error {}

/**
 * DEBT-04: spread a repayment across open debts in the order given (callers pass oldest first,
 * so the oldest IOU is cleared first). Paying more than is owed is refused rather than silently
 * kept: the extra belongs in the customer's wallet, as a deliberate top-up.
 */
export function allocateRepayment(amountKobo: number, debts: OpenDebt[]): Allocation[] {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) throw new AllocationError('Repayment must be a whole kobo amount above zero');
  const owed = debts.reduce((s, d) => s + d.outstandingKobo, 0);
  if (owed === 0) throw new AllocationError('This customer has no outstanding debt');
  if (amountKobo > owed) {
    throw new AllocationError(`Repayment of ${amountKobo} kobo is more than the ${owed} kobo owed. Top up the wallet with the difference instead.`);
  }

  const allocations: Allocation[] = [];
  let remaining = amountKobo;
  for (const debt of debts) {
    if (remaining === 0) break;
    const take = Math.min(remaining, debt.outstandingKobo);
    if (take > 0) {
      allocations.push({ debtRecordId: debt.id, amountKobo: take });
      remaining -= take;
    }
  }
  return allocations;
}
