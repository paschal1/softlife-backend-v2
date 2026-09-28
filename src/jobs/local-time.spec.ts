import { localParts } from './local-time';

describe('localParts', () => {
  it('uses the business timezone, not UTC', () => {
    // 23:30 UTC is already 00:30 the next day in Lagos (UTC+1).
    expect(localParts(new Date('2026-09-30T23:30:00Z'), 'Africa/Lagos')).toEqual({ date: '2026-10-01', hour: 0 });
  });

  it('reports hours 0–23', () => {
    expect(localParts(new Date('2026-09-30T19:05:00Z'), 'Africa/Lagos')).toEqual({ date: '2026-09-30', hour: 20 });
    expect(localParts(new Date('2026-09-30T19:05:00Z'), 'UTC').hour).toBe(19);
  });
});
