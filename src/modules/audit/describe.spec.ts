import { describeChanges, describeEntry } from './describe';

describe('describeEntry', () => {
  it('reads price changes plainly', () => {
    expect(
      describeEntry({
        actionType: 'product.updated',
        entityName: 'Pure Water (Bag)',
        before: { sellingPriceKobo: 30_000 },
        after: { sellingPriceKobo: 35_000 },
      }),
    ).toBe('Changed Pure Water (Bag): price ₦300.00 → ₦350.00');
  });

  it('keeps the context of a void', () => {
    expect(describeEntry({ actionType: 'sale.voided', entityName: null, before: { status: 'completed' }, after: { number: 1024, reason: 'Wrong item', status: 'voided' } })).toBe(
      'Voided sale #1024: "Wrong item"',
    );
  });

  it('describes sales, tills and wallets', () => {
    expect(describeEntry({ actionType: 'sale.completed', entityName: null, before: null, after: { number: 7, orderType: 'walk_in', totalKobo: 450_000, creditKobo: 0 } })).toBe(
      'Sale #7 (walk in) for ₦4,500.00',
    );
    expect(
      describeEntry({ actionType: 'register.closed', entityName: null, before: null, after: { countedCashKobo: 95_000, expectedCashKobo: 100_000, varianceKobo: -5_000, varianceFlagged: true } }),
    ).toBe('Closed till: counted ₦950.00, expected ₦1,000.00, variance -₦50.00 (flagged)');
    expect(describeEntry({ actionType: 'wallet.topped_up', entityName: 'Mama Nkechi', before: null, after: { amountKobo: 500_000, method: 'transfer' } })).toBe(
      'Wallet top-up ₦5,000.00 by transfer for Mama Nkechi',
    );
  });

  it('falls back to something readable for new event types', () => {
    expect(describeEntry({ actionType: 'supplier.created', entityName: 'Dangote', before: null, after: {} })).toBe('supplier created: Dangote');
  });
});

describe('describeChanges', () => {
  it('lists only fields present on both sides, with friendly values', () => {
    expect(describeChanges({ credit_limit_kobo: null, is_active: true }, { credit_limit_kobo: 5_000_000, is_active: false })).toBe(
      'credit limit (none) → ₦50,000.00; active yes → no',
    );
  });
});
