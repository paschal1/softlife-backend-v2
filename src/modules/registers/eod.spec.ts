import { buildCashBreakdown, evaluateVariance } from './eod';

describe('buildCashBreakdown', () => {
  it('sums signed movements into expected cash and reports outflows as positive', () => {
    const b = buildCashBreakdown({
      opening_float: 500_000, // ₦5,000
      pay_in: 200_000,
      pay_out: -150_000, // generator fuel
      cash_sale: 2_300_000,
      cash_refund: -50_000,
    });
    expect(b.expectedCashKobo).toBe(500_000 + 200_000 - 150_000 + 2_300_000 - 50_000);
    expect(b.payOutsKobo).toBe(150_000);
    expect(b.cashRefundsKobo).toBe(50_000);
    expect(b.walletTopUpsKobo).toBe(0);
  });

  it('handles a session with only an opening float', () => {
    expect(buildCashBreakdown({ opening_float: 0 }).expectedCashKobo).toBe(0);
  });
});

describe('evaluateVariance', () => {
  it('reports a shortage as negative', () => {
    expect(evaluateVariance(1_000_000, 950_000, 100_000)).toEqual({ varianceKobo: -50_000, flagged: false });
  });

  it('flags a shortage above the threshold', () => {
    expect(evaluateVariance(1_000_000, 800_000, 100_000).flagged).toBe(true);
  });

  it('flags an overage above the threshold too', () => {
    expect(evaluateVariance(1_000_000, 1_200_000, 100_000).flagged).toBe(true);
  });

  it('does not flag a variance exactly at the threshold', () => {
    expect(evaluateVariance(1_000_000, 900_000, 100_000).flagged).toBe(false);
  });

  it('with a zero threshold, flags any non-zero variance', () => {
    expect(evaluateVariance(1_000_000, 999_999, 0).flagged).toBe(true);
    expect(evaluateVariance(1_000_000, 1_000_000, 0).flagged).toBe(false);
  });
});
