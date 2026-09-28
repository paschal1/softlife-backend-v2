import { addToTotals, ageInDays, allocateRepayment, AllocationError, bucketFor, emptyTotals } from './aging';

const asOf = new Date('2026-09-30T12:00:00Z');
const daysAgo = (n: number) => new Date(asOf.getTime() - n * 86_400_000);

describe('aging buckets (DEBT-03)', () => {
  it.each([
    [0, 'days0to30'],
    [30, 'days0to30'],
    [31, 'days31to60'],
    [60, 'days31to60'],
    [61, 'days61to90'],
    [90, 'days61to90'],
    [91, 'days90plus'],
    [400, 'days90plus'],
  ])('%i days -> %s', (days, bucket) => {
    expect(bucketFor(days)).toBe(bucket);
  });

  it('counts whole days and never goes negative', () => {
    expect(ageInDays(daysAgo(45), asOf)).toBe(45);
    expect(ageInDays(new Date(asOf.getTime() + 1000), asOf)).toBe(0);
  });

  it('totals outstanding amounts by bucket', () => {
    const t = emptyTotals();
    addToTotals(t, 10_000, daysAgo(5), asOf);
    addToTotals(t, 20_000, daysAgo(45), asOf);
    addToTotals(t, 30_000, daysAgo(120), asOf);
    expect(t).toEqual({ days0to30: 10_000, days31to60: 20_000, days61to90: 0, days90plus: 30_000, totalKobo: 60_000 });
  });
});

describe('allocateRepayment (DEBT-04)', () => {
  const debts = [
    { id: 'oldest', outstandingKobo: 50_000 },
    { id: 'middle', outstandingKobo: 30_000 },
    { id: 'newest', outstandingKobo: 20_000 },
  ];

  it('clears the oldest debt first', () => {
    expect(allocateRepayment(60_000, debts)).toEqual([
      { debtRecordId: 'oldest', amountKobo: 50_000 },
      { debtRecordId: 'middle', amountKobo: 10_000 },
    ]);
  });

  it('handles a partial payment on one debt', () => {
    expect(allocateRepayment(1_000, debts)).toEqual([{ debtRecordId: 'oldest', amountKobo: 1_000 }]);
  });

  it('pays everything off exactly', () => {
    expect(allocateRepayment(100_000, debts)).toHaveLength(3);
  });

  it('refuses overpayment and repayment with nothing owed', () => {
    expect(() => allocateRepayment(100_001, debts)).toThrow(AllocationError);
    expect(() => allocateRepayment(1, [])).toThrow(/no outstanding/);
  });
});
