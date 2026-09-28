import { crossedReorderLevel, directionError } from './movement-rules';

describe('directionError', () => {
  it('accepts correct directions', () => {
    expect(directionError('purchase', 10)).toBeNull();
    expect(directionError('sale', -2)).toBeNull();
    expect(directionError('correction', -3)).toBeNull();
    expect(directionError('correction', 3)).toBeNull();
  });

  it('rejects wrong directions, zero and fractions', () => {
    expect(directionError('purchase', -10)).not.toBeNull();
    expect(directionError('wastage', 5)).not.toBeNull();
    expect(directionError('correction', 0)).not.toBeNull();
    expect(directionError('purchase', 1.5)).not.toBeNull();
  });
});

describe('crossedReorderLevel', () => {
  it('fires when stock falls to the reorder level', () => {
    expect(crossedReorderLevel(12, 10, 10)).toBe(true);
  });

  it('fires when stock jumps from above to below', () => {
    expect(crossedReorderLevel(50, 3, 10)).toBe(true);
  });

  it('does not fire again while already low', () => {
    expect(crossedReorderLevel(9, 7, 10)).toBe(false);
  });

  it('does not fire on restock or without a reorder level', () => {
    expect(crossedReorderLevel(5, 40, 10)).toBe(false);
    expect(crossedReorderLevel(50, 0, null)).toBe(false);
  });
});
