import { toGsm } from './termii.channel';

describe('toGsm', () => {
  it('replaces characters that would force expensive Unicode SMS', () => {
    expect(toGsm('Till short by ₦2,500.00 — “check it”')).toBe('Till short by NGN2,500.00 - "check it"');
    expect(toGsm('⚠ Still open: Till 2')).toBe('! Still open: Till 2');
  });

  it('keeps ordinary text and line breaks', () => {
    expect(toGsm('42 sales\nOwed: NGN30,000')).toBe('42 sales\nOwed: NGN30,000');
  });
});
