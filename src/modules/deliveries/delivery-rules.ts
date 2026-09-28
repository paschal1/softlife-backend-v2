import type { CollectionMethod, DeliveryStatus, Fulfilment } from '../../database/database.types';

/**
 * The delivery state machine, as pure functions.
 *
 *   delivery:  queued -> assigned -> out_for_delivery -> delivered
 *                  \          \             \-> failed -> assigned (retry)
 *   pickup:    queued -> delivered (collected at the shop)
 *   any open state -> cancelled (the sale was voided)
 */
export type DeliveryAction = 'assign' | 'dispatch' | 'confirm' | 'fail' | 'cancel';

const ALLOWED: Record<DeliveryAction, Record<Fulfilment, DeliveryStatus[]>> = {
  assign: { delivery: ['queued', 'assigned', 'failed'], pickup: [] },
  dispatch: { delivery: ['assigned'], pickup: [] },
  confirm: { delivery: ['assigned', 'out_for_delivery'], pickup: ['queued'] },
  fail: { delivery: ['assigned', 'out_for_delivery'], pickup: [] },
  cancel: { delivery: ['queued', 'assigned', 'out_for_delivery', 'failed'], pickup: ['queued'] },
};

export function transitionError(action: DeliveryAction, status: DeliveryStatus, fulfilment: Fulfilment): string | null {
  if (ALLOWED[action][fulfilment].includes(status)) return null;
  if (fulfilment === 'pickup' && ['assign', 'dispatch', 'fail'].includes(action)) {
    return 'Pickup orders have no driver: confirm them when the customer collects';
  }
  return `Cannot ${action} a delivery that is ${status.replace(/_/g, ' ')}`;
}

/** Wrong delivery codes before a manager must confirm instead (stops guessing all 10,000). */
export const MAX_CODE_ATTEMPTS = 5;

export interface CollectionInput {
  method: CollectionMethod;
  amountKobo: number;
  reference?: string;
}

/** What's owed at the door must be collected in full to mark the order delivered. */
export function collectionError(codKobo: number, collections: CollectionInput[]): string | null {
  for (const c of collections) {
    if (!Number.isInteger(c.amountKobo) || c.amountKobo <= 0) return 'Each collection must be a whole kobo amount above zero';
    if (c.method === 'transfer' && !c.reference?.trim()) return 'A transfer collection needs its reference';
  }
  const total = collections.reduce((s, c) => s + c.amountKobo, 0);
  if (total === codKobo) return null;
  if (codKobo === 0) return 'Nothing is due on this order; remove the collections';
  return total < codKobo
    ? `${codKobo - total} kobo still to collect (${codKobo} due). If the customer can't pay, mark the delivery failed instead.`
    : `Collected ${total - codKobo} kobo more than the ${codKobo} due`;
}

/** 4-digit code the customer gives the driver at the door. */
export function newConfirmationCode(randomInt: (min: number, max: number) => number): string {
  return randomInt(0, 10_000).toString().padStart(4, '0');
}
