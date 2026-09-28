import type { StockMovementType } from '../../database/database.types';

const INBOUND: ReadonlySet<StockMovementType> = new Set(['opening', 'purchase', 'sale_reversal', 'transfer_in', 'delivery_return']);
const OUTBOUND: ReadonlySet<StockMovementType> = new Set(['sale', 'wastage', 'transfer_out']);

/** Mirrors the database CHECK so bad input fails with a clear message instead of a constraint error. */
export function directionError(type: StockMovementType, delta: number): string | null {
  if (!Number.isInteger(delta) || delta === 0) return 'Quantity must be a non-zero whole number';
  if (INBOUND.has(type) && delta < 0) return `${type} must increase stock`;
  if (OUTBOUND.has(type) && delta > 0) return `${type} must decrease stock`;
  return null;
}

/**
 * True when stock falls to or below the reorder level in this change, having been above it.
 * Alerting only on the crossing (not on every sale while already low) avoids alert spam.
 */
export function crossedReorderLevel(before: number, after: number, reorderLevel: number | null): boolean {
  return reorderLevel !== null && before > reorderLevel && after <= reorderLevel;
}
