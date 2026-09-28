import { escapeHtml, formatAmount, ReceiptData, renderHtml, renderText } from './receipt-format';

const receipt: ReceiptData = {
  businessName: 'Aqua Pure Water',
  branchName: 'Rumuola Outlet',
  branchAddress: '12 Rumuola Road, Port Harcourt',
  branchPhone: '+2348031234567',
  saleNumber: 1024,
  occurredAt: new Date('2026-09-28T14:05:00Z'),
  timezone: 'Africa/Lagos',
  cashierName: 'Tolu',
  registerName: 'Till 1',
  customerName: 'Mama Nkechi',
  orderType: 'walk_in',
  items: [
    { name: 'Pure Water (Bag of 20 sachets)', quantity: 10, unit: 'bag', unitPriceKobo: 30_000, discountKobo: 0, lineTotalKobo: 300_000 },
    { name: 'Bottled Water 75cl (Pack of 12)', quantity: 1, unit: 'pack', unitPriceKobo: 250_000, discountKobo: 50_000, lineTotalKobo: 200_000 },
  ],
  subtotalKobo: 550_000,
  discountKobo: 50_000,
  totalKobo: 500_000,
  payments: [{ method: 'cash', amountKobo: 500_000, tenderedKobo: 1_000_000, reference: null }],
  changeKobo: 500_000,
  creditKobo: 0,
  delivery: null,
  status: 'completed',
  voidReason: null,
};

describe('formatAmount', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [100, '1.00'],
    [123_456, '1,234.56'],
    [100_000_000_00, '100,000,000.00'],
    [-2_550, '-25.50'],
  ])('%i kobo -> %s', (kobo, text) => {
    expect(formatAmount(kobo)).toBe(text);
  });
});

describe('renderText', () => {
  it.each([32, 48] as const)('never exceeds %i columns', (width) => {
    for (const line of renderText(receipt, width).split('\n')) expect(line.length).toBeLessThanOrEqual(width);
  });

  it('shows the essentials and uses NGN (printers often lack ₦)', () => {
    const text = renderText(receipt);
    expect(text).toContain('Receipt #1024');
    expect(text).toContain('TOTAL (NGN)');
    expect(text).toContain('5,000.00');
    expect(text).toContain('Change');
    expect(text).not.toContain('₦');
  });

  it('marks voided receipts', () => {
    expect(renderText({ ...receipt, status: 'voided', voidReason: 'Wrong item' })).toContain('*** VOID ***');
  });
});

describe('renderHtml', () => {
  it('escapes names so a customer called <script> cannot inject into the page', () => {
    const html = renderHtml({ ...receipt, customerName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes all five special characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
