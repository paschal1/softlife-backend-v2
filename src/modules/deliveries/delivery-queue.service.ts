import { BadRequestException, Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { randomInt } from 'node:crypto';
import { uuidv7 } from '../../common/ids/uuidv7';
import type { DB, Fulfilment } from '../../database/database.types';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import { newConfirmationCode } from './delivery-rules';

export interface EnqueueInput {
  organizationId: string;
  actorId: string;
  saleId: string;
  locationId: string;
  customerId: string | null;
  fulfilment: Fulfilment;
  address: string | null;
  scheduledDate: string;
  driverId: string | null;
  codKobo: number;
}

/**
 * What Sales uses, inside its own transaction: DEL-01 (a delivery sale joins the queue
 * atomically with the sale) and cancelling a delivery when its sale is voided.
 */
@Injectable()
export class DeliveryQueue {
  constructor(private readonly events: EventPublisher) {}

  async enqueue(trx: Transaction<DB>, input: EnqueueInput): Promise<{ deliveryId: string; confirmationCode: string }> {
    if (input.driverId) {
      if (input.fulfilment === 'pickup') throw new BadRequestException('Pickup orders have no driver');
      const driver = await trx.selectFrom('users').select('role').where('id', '=', input.driverId).where('is_active', '=', true).executeTakeFirst();
      if (driver?.role !== 'driver') throw new BadRequestException('That user is not an active driver');
    }

    const deliveryId = uuidv7();
    const confirmationCode = newConfirmationCode(randomInt);
    await trx
      .insertInto('deliveries')
      .values({
        id: deliveryId,
        organization_id: input.organizationId,
        sale_id: input.saleId,
        location_id: input.locationId,
        customer_id: input.customerId,
        fulfilment: input.fulfilment,
        address: input.address,
        scheduled_date: input.scheduledDate,
        driver_id: input.driverId,
        status: input.driverId ? 'assigned' : 'queued',
        confirmation_code: confirmationCode,
        cod_kobo: input.codKobo,
      })
      .execute();

    await this.events.record(trx, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      locationId: input.locationId,
      type: EventTypes.DeliveryQueued,
      aggregateType: 'delivery',
      aggregateId: deliveryId,
      payload: {
        saleId: input.saleId,
        fulfilment: input.fulfilment,
        scheduledDate: input.scheduledDate,
        driverId: input.driverId,
        codKobo: input.codKobo,
      },
    });
    return { deliveryId, confirmationCode };
  }

  /**
   * Called when a sale is voided. Open deliveries are cancelled. A delivered order whose
   * payment was collected at the door can't be voided: that money is already with a driver or till.
   */
  async cancelForSale(trx: Transaction<DB>, saleId: string, actor: { organizationId: string; userId: string }, reason: string): Promise<void> {
    const delivery = await trx
      .selectFrom('deliveries')
      .select(['id', 'status', 'collected_kobo', 'location_id'])
      .where('sale_id', '=', saleId)
      .forUpdate()
      .executeTakeFirst();
    if (!delivery || delivery.status === 'cancelled') return;
    if (delivery.status === 'delivered') {
      if (delivery.collected_kobo > 0) {
        throw new BadRequestException(
          'This order was delivered and paid for at the door, so it cannot be voided. Refund the customer directly and adjust stock.',
        );
      }
      return;
    }

    await trx.updateTable('deliveries').set({ status: 'cancelled', failure_reason: reason }).where('id', '=', delivery.id).execute();
    await this.events.record(trx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      locationId: delivery.location_id,
      type: EventTypes.DeliveryCancelled,
      aggregateType: 'delivery',
      aggregateId: delivery.id,
      payload: { saleId, reason, before: { status: delivery.status }, after: { status: 'cancelled' } },
    });
  }
}
