import { collectionError, newConfirmationCode, transitionError } from './delivery-rules';

describe('delivery state machine', () => {
  it('follows queued -> assigned -> out -> delivered', () => {
    expect(transitionError('assign', 'queued', 'delivery')).toBeNull();
    expect(transitionError('dispatch', 'assigned', 'delivery')).toBeNull();
    expect(transitionError('confirm', 'out_for_delivery', 'delivery')).toBeNull();
  });

  it('allows confirming straight from assigned, and reassigning after a failure', () => {
    expect(transitionError('confirm', 'assigned', 'delivery')).toBeNull();
    expect(transitionError('assign', 'failed', 'delivery')).toBeNull();
  });

  it('refuses to skip steps or reopen finished deliveries', () => {
    expect(transitionError('confirm', 'queued', 'delivery')).toMatch(/queued/);
    expect(transitionError('dispatch', 'queued', 'delivery')).not.toBeNull();
    expect(transitionError('assign', 'delivered', 'delivery')).not.toBeNull();
    expect(transitionError('cancel', 'delivered', 'delivery')).not.toBeNull();
  });

  it('pickups are confirmed at the shop, with no driver', () => {
    expect(transitionError('confirm', 'queued', 'pickup')).toBeNull();
    expect(transitionError('assign', 'queued', 'pickup')).toMatch(/no driver/);
  });
});

describe('collectionError', () => {
  it('accepts exact collection across methods', () => {
    expect(collectionError(500_000, [{ method: 'cash', amountKobo: 300_000 }, { method: 'transfer', amountKobo: 200_000, reference: 'T1' }])).toBeNull();
  });

  it('accepts nothing when nothing is due', () => {
    expect(collectionError(0, [])).toBeNull();
  });

  it('refuses short, over, or unreferenced collections', () => {
    expect(collectionError(500_000, [{ method: 'cash', amountKobo: 400_000 }])).toMatch(/still to collect/);
    expect(collectionError(500_000, [{ method: 'cash', amountKobo: 600_000 }])).toMatch(/more than/);
    expect(collectionError(100, [{ method: 'transfer', amountKobo: 100 }])).toMatch(/reference/);
  });
});

describe('newConfirmationCode', () => {
  it('always gives 4 digits, zero-padded', () => {
    expect(newConfirmationCode(() => 7)).toBe('0007');
    expect(newConfirmationCode(() => 9999)).toBe('9999');
  });
});
