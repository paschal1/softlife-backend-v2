import type { CashMovementKind } from '../../database/database.types';

/**
 * What passed through the till in one session. Outflows are reported as positive
 * magnitudes for display; expectedCashKobo is the signed total (in minus out).
 */
export interface CashBreakdown {
  openingFloatKobo: number;
  payInsKobo: number;
  payOutsKobo: number;
  cashSalesKobo: number;
  cashRefundsKobo: number;
  walletTopUpsKobo: number;
  debtRepaymentsKobo: number;
  /** Cash collected at doors and handed in by drivers at this till. */
  deliveryCashKobo: number;
  expectedCashKobo: number;
}

/** @param signedTotals sum of signed amount_kobo per movement kind (missing kinds = 0) */
export function buildCashBreakdown(signedTotals: Partial<Record<CashMovementKind, number>>): CashBreakdown {
  const t = (kind: CashMovementKind) => signedTotals[kind] ?? 0;
  const expected = Object.values(signedTotals).reduce<number>((sum, v) => sum + (v ?? 0), 0);
  return {
    openingFloatKobo: t('opening_float'),
    payInsKobo: t('pay_in'),
    payOutsKobo: Math.abs(t('pay_out')),
    cashSalesKobo: t('cash_sale'),
    cashRefundsKobo: Math.abs(t('cash_refund')),
    walletTopUpsKobo: t('wallet_top_up'),
    debtRepaymentsKobo: t('debt_repayment'),
    deliveryCashKobo: t('delivery_cash'),
    expectedCashKobo: expected,
  };
}

export interface VarianceResult {
  /** counted − expected. Positive = over (more cash than expected), negative = short. */
  varianceKobo: number;
  flagged: boolean;
}

/**
 * EOD-02: flag when the variance, in either direction, is ABOVE the organization's threshold.
 * A threshold of 0 therefore flags any non-zero variance. Being over is flagged too:
 * unexplained extra cash usually means a sale wasn't recorded.
 */
export function evaluateVariance(expectedKobo: number, countedKobo: number, thresholdKobo: number): VarianceResult {
  const varianceKobo = countedKobo - expectedKobo;
  return { varianceKobo, flagged: Math.abs(varianceKobo) > thresholdKobo };
}
