import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { PG_FOREIGN_KEY_VIOLATION, pgErrorCode } from '../../common/db/pg-errors';
import { uuidv7 } from '../../common/ids/uuidv7';
import type { DB, StockMovementType } from '../../database/database.types';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import { crossedReorderLevel, directionError } from './movement-rules';

export interface LedgerEntry {
  productId: string;
  locationId: string;
  type: StockMovementType;
  /** Signed. */
  quantityDelta: number;
  unitCostKobo?: number | null;
  reason?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
}

export interface LedgerOptions {
  organizationId: string;
  actorId: string | null;
  /** Groups the rows of one operation; retrying with the same batchId is a no-op. */
  batchId: string;
  /** Sales may drive stock below zero (records are imperfect; never block a paying customer). Manual operations may not. */
  allowNegative?: boolean;
}

export interface LedgerResult {
  productId: string;
  productName: string;
  unit: string;
  locationId: string;
  type: StockMovementType;
  quantityDelta: number;
  quantityAfter: number;
}

/**
 * The ONLY way any module changes stock. Call it inside your own transaction:
 * the movements commit or roll back together with whatever caused them.
 */
@Injectable()
export class StockLedger {
  constructor(private readonly events: EventPublisher) {}

  async batchExists(trx: Transaction<DB>, batchId: string): Promise<boolean> {
    const row = await trx.selectFrom('stock_movements').select('id').where('batch_id', '=', batchId).limit(1).executeTakeFirst();
    return row !== undefined;
  }

  async record(trx: Transaction<DB>, entries: LedgerEntry[], options: LedgerOptions): Promise<LedgerResult[]> {
    const merged = mergeEntries(entries);
    if (merged.length === 0) return [];

    for (const e of merged) {
      const problem = directionError(e.type, e.quantityDelta);
      if (problem) throw new BadRequestException(problem);
    }

    const productIds = [...new Set(merged.map((e) => e.productId))];
    const products = await trx
      .selectFrom('products')
      .select(['id', 'name', 'unit', 'tracks_stock', 'reorder_level'])
      .where('id', 'in', productIds)
      .execute();
    const productById = new Map(products.map((p) => [p.id, p]));
    for (const id of productIds) {
      const product = productById.get(id);
      if (!product) throw new NotFoundException(`Product ${id} not found`);
      if (!product.tracks_stock) throw new BadRequestException(`${product.name} does not track stock`);
    }

    try {
      await trx
        .insertInto('stock_movements')
        .values(
          merged.map((e) => ({
            id: uuidv7(),
            organization_id: options.organizationId,
            batch_id: options.batchId,
            product_id: e.productId,
            location_id: e.locationId,
            type: e.type,
            quantity_delta: e.quantityDelta,
            unit_cost_kobo: e.unitCostKobo ?? null,
            reason: e.reason?.trim() || null,
            reference_type: e.referenceType ?? null,
            reference_id: e.referenceId ?? null,
            created_by: options.actorId,
          })),
        )
        .execute();
    } catch (err) {
      if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) throw new BadRequestException('Unknown location');
      throw err;
    }

    // The trigger has applied every row; our upserts hold the row locks until commit,
    // so "after − this batch's net change" is exactly the quantity before this batch.
    const pairs = new Map<string, { productId: string; locationId: string; net: number }>();
    for (const e of merged) {
      const key = `${e.locationId}:${e.productId}`;
      const pair = pairs.get(key) ?? { productId: e.productId, locationId: e.locationId, net: 0 };
      pair.net += e.quantityDelta;
      pairs.set(key, pair);
    }

    const levels = await trx
      .selectFrom('stock_levels')
      .select(['location_id', 'product_id', 'quantity'])
      .where('product_id', 'in', productIds)
      .where('location_id', 'in', [...new Set(merged.map((e) => e.locationId))])
      .execute();
    const quantityAfter = new Map(levels.map((l) => [`${l.location_id}:${l.product_id}`, l.quantity]));

    for (const [key, pair] of pairs) {
      const after = quantityAfter.get(key) ?? 0;
      const before = after - pair.net;
      const product = productById.get(pair.productId)!;

      if (after < 0 && !options.allowNegative) {
        throw new BadRequestException(
          `Not enough ${product.name} in stock: this would leave ${after} ${product.unit}. Current stock is ${before}.`,
        );
      }

      if (crossedReorderLevel(before, after, product.reorder_level)) {
        await this.events.record(trx, {
          organizationId: options.organizationId,
          actorId: options.actorId,
          locationId: pair.locationId,
          type: EventTypes.ThresholdCrossed,
          aggregateType: 'product',
          aggregateId: pair.productId,
          payload: {
            rule: 'low_stock',
            productName: product.name,
            locationId: pair.locationId,
            quantity: after,
            reorderLevel: product.reorder_level,
          },
        });
      }
    }

    return merged.map((e) => {
      const product = productById.get(e.productId)!;
      return {
        productId: e.productId,
        productName: product.name,
        unit: product.unit,
        locationId: e.locationId,
        type: e.type,
        quantityDelta: e.quantityDelta,
        quantityAfter: quantityAfter.get(`${e.locationId}:${e.productId}`) ?? 0,
      };
    });
  }

  newBatchId(): string {
    return uuidv7();
  }
}

/** One row per (product, location, type) per batch: the database's idempotency key. */
function mergeEntries(entries: LedgerEntry[]): LedgerEntry[] {
  const byKey = new Map<string, LedgerEntry>();
  for (const e of entries) {
    const key = `${e.productId}:${e.locationId}:${e.type}`;
    const existing = byKey.get(key);
    if (existing) existing.quantityDelta += e.quantityDelta;
    else byKey.set(key, { ...e });
  }
  return [...byKey.values()].filter((e) => e.quantityDelta !== 0);
}
