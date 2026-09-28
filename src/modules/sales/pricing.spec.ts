import { decideCredit, planPayments, priceSale, PricedProduct, PricingError } from './pricing';

const water: PricedProduct = { id: 'w', name: 'Pure Water (Bag)', unit: 'bag', sellingPriceKobo: 30_000, wholesalePriceKobo: 25_000 };
const soap: PricedProduct = { id: 's', name: 'Soap', unit: 'piece', sellingPriceKobo: 50_000, wholesalePriceKobo: null };
const catalog = new Map([water, soap].map((p) => [p.id, p]));

describe('priceSale', () => {
  it('prices a retail sale', () => {
    const s = priceSale([{ productId: 'w', quantity: 10 }, { productId: 's', quantity: 2 }], catalog, 'walk_in');
    expect(s.subtotalKobo).toBe(300_000 + 100_000);
    expect(s.totalKobo).toBe(400_000);
    expect(s.lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });

  it('uses wholesale prices on wholesale orders, falling back to retail where none is set', () => {
    const s = priceSale([{ productId: 'w', quantity: 100 }, { productId: 's', quantity: 1 }], catalog, 'wholesale');
    expect(s.lines[0]!.unitPriceKobo).toBe(25_000);
    expect(s.lines[1]!.unitPriceKobo).toBe(50_000);
  });

  it('applies line discounts', () => {
    const s = priceSale([{ productId: 'w', quantity: 10, discountKobo: 20_000 }], catalog, 'walk_in');
    expect(s.discountKobo).toBe(20_000);
    expect(s.totalKobo).toBe(280_000);
    expect(s.lines[0]!.lineTotalKobo).toBe(280_000);
  });

  it('honours the price an offline till charged, keeping the catalogue price for comparison', () => {
    const s = priceSale([{ productId: 'w', quantity: 2, unitPriceKobo: 28_000 }], catalog, 'walk_in');
    expect(s.lines[0]).toMatchObject({ unitPriceKobo: 28_000, catalogPriceKobo: 30_000, lineTotalKobo: 56_000 });
  });

  it('rejects a discount bigger than the line, unknown products and bad quantities', () => {
    expect(() => priceSale([{ productId: 'w', quantity: 1, discountKobo: 30_001 }], catalog, 'walk_in')).toThrow(PricingError);
    expect(() => priceSale([{ productId: 'x', quantity: 1 }], catalog, 'walk_in')).toThrow(PricingError);
    expect(() => priceSale([{ productId: 'w', quantity: 0 }], catalog, 'walk_in')).toThrow(PricingError);
    expect(() => priceSale([], catalog, 'walk_in')).toThrow(PricingError);
  });
});

describe('planPayments', () => {
  it('splits across methods (POS-03)', () => {
    const plan = planPayments(1_000_000, [
      { method: 'cash', amountKobo: 300_000 },
      { method: 'transfer', amountKobo: 200_000, reference: 'TRF1' },
      { method: 'wallet', amountKobo: 100_000 },
      { method: 'credit', amountKobo: 400_000 },
    ]);
    expect(plan).toEqual({ paidKobo: 600_000, creditKobo: 400_000, codKobo: 0, cashKobo: 300_000, walletKobo: 100_000, changeKobo: 0 });
  });

  it('computes change from cash tendered', () => {
    expect(planPayments(450_000, [{ method: 'cash', amountKobo: 450_000, tenderedKobo: 500_000 }]).changeKobo).toBe(50_000);
  });

  it('requires payments to equal the total exactly', () => {
    expect(() => planPayments(100_000, [{ method: 'cash', amountKobo: 90_000 }])).toThrow(/short/);
    expect(() => planPayments(100_000, [{ method: 'cash', amountKobo: 110_000 }])).toThrow(/tenderedKobo/);
  });

  it('requires a transfer reference and rejects tendered amounts on non-cash', () => {
    expect(() => planPayments(100, [{ method: 'transfer', amountKobo: 100 }])).toThrow(/reference/);
    expect(() => planPayments(100, [{ method: 'card', amountKobo: 100, tenderedKobo: 200 }])).toThrow(/cash/);
  });

  it('allows several transfers or card payments but only one cash, wallet or credit line', () => {
    expect(() =>
      planPayments(300, [
        { method: 'transfer', amountKobo: 100, reference: 'A' },
        { method: 'transfer', amountKobo: 200, reference: 'B' },
      ]),
    ).not.toThrow();
    expect(() => planPayments(300, [{ method: 'cash', amountKobo: 100 }, { method: 'cash', amountKobo: 200 }])).toThrow(/Combine/);
  });

  it('separates pay-on-delivery from what is paid now', () => {
    const plan = planPayments(500_000, [
      { method: 'transfer', amountKobo: 100_000, reference: 'DEPOSIT' },
      { method: 'pay_on_delivery', amountKobo: 400_000 },
    ]);
    expect(plan.paidKobo).toBe(100_000);
    expect(plan.codKobo).toBe(400_000);
  });

  it('accepts a free (zero-total) sale with no payments', () => {
    expect(planPayments(0, []).paidKobo).toBe(0);
  });
});

describe('decideCredit (DEBT-02)', () => {
  it('allows credit within the limit, or with no limit', () => {
    expect(decideCredit(200_000, 300_000, 500_000, 'hard')).toEqual({ outcome: 'ok' });
    expect(decideCredit(9_999_999, 1, null, 'hard')).toEqual({ outcome: 'ok' });
  });

  it('asks for a manager in soft mode and blocks in hard mode', () => {
    expect(decideCredit(400_000, 200_000, 500_000, 'soft')).toEqual({ outcome: 'needs_approval', limitKobo: 500_000, projectedKobo: 600_000 });
    expect(decideCredit(400_000, 200_000, 500_000, 'hard').outcome).toBe('blocked');
  });

  it('ignores the limit when no credit is used', () => {
    expect(decideCredit(9_999_999, 0, 100, 'hard')).toEqual({ outcome: 'ok' });
  });
});
