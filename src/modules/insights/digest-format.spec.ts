import { DailySummary, formatDigest } from './digest-format';

const quiet: DailySummary = {
  date: '2026-09-30',
  sales: { count: 0, totalKobo: 0, voidedCount: 0, byMethod: {} },
  topProducts: [],
  registers: { flaggedClosings: 0, netVarianceKobo: 0, stillOpen: [] },
  debt: { newCreditKobo: 0, repaidKobo: 0, outstandingKobo: 0, over90DaysKobo: 0 },
  wallets: { toppedUpKobo: 0 },
  stock: { lowCount: 0, lowItems: [] },
  deliveries: { delivered: 0, pending: 0, failed: 0, cashWithDriversKobo: 0 },
};

const busy: DailySummary = {
  ...quiet,
  sales: { count: 42, totalKobo: 18_450_000, voidedCount: 1, byMethod: { cash: 10_000_000, transfer: 8_450_000, card: 0 } },
  topProducts: [{ productId: 'p', name: 'Pure Water (Bag)', quantity: 310, revenueKobo: 9_300_000 }],
  registers: { flaggedClosings: 1, netVarianceKobo: -250_000, stillOpen: [{ registerName: 'Till 2', staffName: 'Bola', openedAt: new Date() }] },
  debt: { newCreditKobo: 500_000, repaidKobo: 200_000, outstandingKobo: 3_000_000, over90DaysKobo: 400_000 },
  stock: { lowCount: 4, lowItems: [{ name: 'Nylon rolls', quantity: 2 }] },
  deliveries: { delivered: 9, pending: 2, failed: 1, cashWithDriversKobo: 1_200_000 },
};

describe('formatDigest', () => {
  it('headlines the day', () => {
    expect(formatDigest(busy, 'Aqua Pure').title).toBe('Today at Aqua Pure: ₦184,500.00 from 42 sales');
    expect(formatDigest(quiet, 'Aqua Pure').title).toBe('Today at Aqua Pure: ₦0.00 from 0 sales');
  });

  it('calls out what needs attention', () => {
    const body = formatDigest(busy, 'Aqua Pure').body;
    expect(body).toContain('1 till(s) closed with a flagged variance (net −₦2,500.00)');
    expect(body).toContain('Still open: Till 2 (Bola)');
    expect(body).toContain('(₦4,000.00 over 90 days)');
    expect(body).toContain('₦12,000.00 cash still with drivers');
    expect(body).not.toContain('card');
  });

  it('keeps SMS short and free of the ₦ sign', () => {
    const { sms } = formatDigest(busy, 'Aqua Pure');
    expect(sms).not.toContain('₦');
    expect(sms.length).toBeLessThanOrEqual(300);
    expect(sms).toContain('42 sales NGN184,500');
  });
});
