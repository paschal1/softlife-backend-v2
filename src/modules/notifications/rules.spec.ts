import type { DomainEvent } from '../../events/domain-event';
import { draftForEvent, idsToName } from './rules';

const names: Record<string, string> = { u1: 'Tolu', u2: 'Mrs Ade', r1: 'Till 1', l1: 'Rumuola Outlet', c1: 'Alhaji Musa', d1: 'Emeka' };
const name = (id: unknown) => names[String(id)] ?? 'someone';

const event = (type: string, payload: Record<string, unknown>, aggregateId = 'x', actorId: string | null = 'u1'): DomainEvent =>
  ({ id: 'e', type, organizationId: 'o', locationId: null, actorId, aggregateType: 'a', aggregateId, occurredAt: new Date(), payload }) as DomainEvent;

describe('draftForEvent', () => {
  it('low stock names the product and branch', () => {
    const d = draftForEvent(event('threshold.crossed', { rule: 'low_stock', productName: 'Pure Water (Bag)', quantity: 8, reorderLevel: 20, locationId: 'l1' }), name);
    expect(d).toMatchObject({ kind: 'low_stock', severity: 'warning', title: 'Low stock: Pure Water (Bag)' });
    expect(d!.body).toBe('8 left at Rumuola Outlet (reorder level 20).');
  });

  it('a short till is critical and reads plainly', () => {
    const d = draftForEvent(event('threshold.crossed', { rule: 'register_variance', staffId: 'u1', registerId: 'r1', varianceKobo: -250_000, thresholdKobo: 100_000 }), name);
    expect(d).toMatchObject({ kind: 'register_variance', severity: 'critical', title: 'Till short by ₦2,500.00' });
    expect(d!.body).toContain('Tolu closed Till 1 ₦2,500.00 short');
  });

  it('driver cash shortfall names the driver', () => {
    const d = draftForEvent(event('threshold.crossed', { rule: 'driver_cash_variance', varianceKobo: -50_000 }, 'd1'), name);
    expect(d!.body).toContain('Emeka handed in ₦500.00 less');
  });

  it('flags on offline sales are written as plain words', () => {
    const d = draftForEvent(event('sync.flagged', { number: 1044, flags: ['price_differs_from_catalogue', 'unapproved_discount'] }), name);
    expect(d!.body).toBe('Recorded by Tolu while offline: sold at an old price, discount without manager approval.');
  });

  it('credit overrides, voids, PIN locks and failed deliveries become alerts', () => {
    expect(draftForEvent(event('credit.limit_overridden', { projectedKobo: 600_000, limitKobo: 500_000, approvedBy: 'u2', saleId: 's' }, 'c1'), name)!.title).toBe(
      'Credit limit exceeded: Alhaji Musa',
    );
    expect(draftForEvent(event('sale.voided', { number: 7, reason: 'Wrong item', approvedBy: 'u2' }), name)!.body).toBe(
      'By Tolu, approved by Mrs Ade: "Wrong item".',
    );
    expect(draftForEvent(event('user.pin_locked', { lockedForMinutes: 15 }, 'u2'), name)!.title).toBe('PIN locked: Mrs Ade');
    expect(draftForEvent(event('delivery.failed', { driverId: 'd1', reason: 'Not home', attempt: 2 }), name)!.body).toContain('Emeka: "Not home" (attempt 2)');
  });

  it('ignores routine events', () => {
    expect(draftForEvent(event('sale.completed', {}), name)).toBeNull();
    expect(draftForEvent(event('threshold.crossed', { rule: 'something_new' }), name)).toBeNull();
  });
});

describe('idsToName', () => {
  it('collects every id a message may mention, once', () => {
    expect(idsToName(event('x', { staffId: 'u1', registerId: 'r1', approvedBy: 'u1' }, 'agg', 'u1')).sort()).toEqual(['agg', 'r1', 'u1']);
  });
});
