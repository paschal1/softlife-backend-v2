import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, Transaction } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { decodeCursor, encodeCursor, likeEscape } from '../../common/pagination';
import type { DB } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import type {
  AdjustStockDto,
  ReceiveStockDto,
  StockLevelDto,
  StockLevelsQueryDto,
  StockMovementPageDto,
  StockMovementsQueryDto,
  StockOperationResultDto,
  TransferStockDto,
} from './dto/inventory.dto';
import { LedgerEntry, StockLedger } from './stock-ledger.service';

type Trx = Transaction<DB>;

@Injectable()
export class InventoryService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly ledger: StockLedger,
    private readonly events: EventPublisher,
  ) {}

  /** Stock arriving at a branch: supplier delivery or own production. */
  async receive(auth: AuthContext, dto: ReceiveStockDto): Promise<StockOperationResultDto> {
    return this.tenantDb.transaction(async (trx) => {
      if (dto.id && (await this.ledger.batchExists(trx, dto.id))) return this.replay(trx, dto.id);
      const batchId = dto.id ?? this.ledger.newBatchId();

      const items = await this.ledger.record(
        trx,
        dto.items.map<LedgerEntry>((i) => ({
          productId: i.productId,
          locationId: dto.locationId,
          type: 'purchase',
          quantityDelta: i.quantity,
          unitCostKobo: i.unitCostKobo ?? null,
          reason: dto.note ?? null,
        })),
        { organizationId: auth.organizationId, actorId: auth.userId, batchId },
      );

      await this.events.record(trx, {
        type: EventTypes.StockReceived,
        aggregateType: 'stock_batch',
        aggregateId: batchId,
        locationId: dto.locationId,
        payload: {
          supplierName: dto.supplierName?.trim() || null,
          note: dto.note?.trim() || null,
          items: dto.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitCostKobo: i.unitCostKobo ?? null })),
        },
      });

      return { batchId, replayed: false, items };
    });
  }

  /** Wastage, corrections and physical stock counts. */
  async adjust(auth: AuthContext, dto: AdjustStockDto): Promise<StockOperationResultDto> {
    return this.tenantDb.transaction(async (trx) => {
      if (dto.id && (await this.ledger.batchExists(trx, dto.id))) return this.replay(trx, dto.id);
      const batchId = dto.id ?? this.ledger.newBatchId();

      const product = await trx
        .selectFrom('products')
        .select(['id', 'name', 'unit', 'tracks_stock'])
        .where('id', '=', dto.productId)
        .executeTakeFirst();
      if (!product) throw new NotFoundException('Product not found');
      if (!product.tracks_stock) throw new BadRequestException(`${product.name} does not track stock`);

      const current = await this.currentQuantity(trx, dto.locationId, dto.productId);
      const delta =
        dto.kind === 'wastage' ? -dto.quantity! : dto.kind === 'correction' ? dto.quantityDelta! : dto.countedQuantity! - current;

      const items =
        delta === 0
          ? [{ productId: product.id, productName: product.name, unit: product.unit, locationId: dto.locationId, type: 'stock_count' as const, quantityDelta: 0, quantityAfter: current }]
          : await this.ledger.record(
              trx,
              [{ productId: dto.productId, locationId: dto.locationId, type: dto.kind, quantityDelta: delta, reason: dto.reason }],
              { organizationId: auth.organizationId, actorId: auth.userId, batchId },
            );

      // Recorded even when a count matched: "counted, no difference" is worth having in the audit trail.
      await this.events.record(trx, {
        type: EventTypes.StockAdjusted,
        aggregateType: 'product',
        aggregateId: dto.productId,
        locationId: dto.locationId,
        payload: {
          kind: dto.kind,
          reason: dto.reason.trim(),
          batchId,
          before: { quantity: current },
          after: { quantity: current + delta },
        },
      });

      return { batchId, replayed: false, items };
    });
  }

  /** Moves stock between branches in one atomic step (Decision Q6). */
  async transfer(auth: AuthContext, dto: TransferStockDto): Promise<StockOperationResultDto> {
    if (dto.fromLocationId === dto.toLocationId) throw new BadRequestException('Choose two different branches');

    return this.tenantDb.transaction(async (trx) => {
      if (dto.id && (await this.ledger.batchExists(trx, dto.id))) return this.replay(trx, dto.id);
      const batchId = dto.id ?? this.ledger.newBatchId();
      const reason = dto.note?.trim() || null;

      const items = await this.ledger.record(
        trx,
        dto.items.flatMap<LedgerEntry>((i) => [
          { productId: i.productId, locationId: dto.fromLocationId, type: 'transfer_out', quantityDelta: -i.quantity, reason },
          { productId: i.productId, locationId: dto.toLocationId, type: 'transfer_in', quantityDelta: i.quantity, reason },
        ]),
        { organizationId: auth.organizationId, actorId: auth.userId, batchId },
      );

      await this.events.record(trx, {
        type: EventTypes.StockTransferred,
        aggregateType: 'stock_batch',
        aggregateId: batchId,
        locationId: dto.fromLocationId,
        payload: {
          fromLocationId: dto.fromLocationId,
          toLocationId: dto.toLocationId,
          note: reason,
          items: dto.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        },
      });

      return { batchId, replayed: false, items };
    });
  }

  async levels(query: StockLevelsQueryDto): Promise<StockLevelDto[]> {
    const pattern = query.search?.trim() ? `%${likeEscape(query.search.trim())}%` : null;

    const rows = await this.tenantDb.transaction((trx) =>
      trx
        .selectFrom('products as p')
        .leftJoin(
          (eb) =>
            eb
              .selectFrom('stock_levels')
              .select(['product_id', sql<number>`sum(quantity)::bigint`.as('quantity')])
              .$if(!!query.locationId, (qb) => qb.where('location_id', '=', query.locationId!))
              .groupBy('product_id')
              .as('s'),
          (join) => join.onRef('s.product_id', '=', 'p.id'),
        )
        .select(['p.id', 'p.name', 'p.unit', 'p.category', 'p.reorder_level', 's.quantity'])
        .where('p.tracks_stock', '=', true)
        .where('p.is_active', '=', true)
        .$if(pattern !== null, (qb) => qb.where('p.name', 'ilike', pattern!))
        .orderBy('p.name')
        .execute(),
    );

    const levels = rows.map((r) => {
      const quantity = Number(r.quantity ?? 0);
      return {
        productId: r.id,
        productName: r.name,
        unit: r.unit,
        category: r.category,
        locationId: query.locationId ?? null,
        quantity,
        reorderLevel: r.reorder_level,
        isLow: r.reorder_level !== null && quantity <= r.reorder_level,
      };
    });
    return query.lowStockOnly === 'true' ? levels.filter((l) => l.isLow) : levels;
  }

  async movements(query: StockMovementsQueryDto): Promise<StockMovementPageDto> {
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeCursor(query.cursor, 2) : null;

    const rows = await this.tenantDb.transaction((trx) =>
      trx
        .selectFrom('stock_movements as m')
        .innerJoin('products as p', 'p.id', 'm.product_id')
        .innerJoin('locations as l', 'l.id', 'm.location_id')
        .leftJoin('users as u', 'u.id', 'm.created_by')
        .selectAll('m')
        .select(['p.name as product_name', 'l.name as location_name', 'u.full_name as created_by_name'])
        .$if(!!query.productId, (qb) => qb.where('m.product_id', '=', query.productId!))
        .$if(!!query.locationId, (qb) => qb.where('m.location_id', '=', query.locationId!))
        .$if(!!query.type, (qb) => qb.where('m.type', '=', query.type!))
        .$if(!!query.from, (qb) => qb.where('m.created_at', '>=', new Date(query.from!)))
        .$if(!!query.to, (qb) => qb.where('m.created_at', '<', new Date(query.to!)))
        .$if(cursor !== null, (qb) =>
          qb.where(sql<boolean>`(m.created_at, m.id) < (${new Date(cursor![0]!)}, ${cursor![1]!})`),
        )
        .orderBy('m.created_at', 'desc')
        .orderBy('m.id', 'desc')
        .limit(limit + 1)
        .execute(),
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        batchId: r.batch_id,
        productId: r.product_id,
        productName: r.product_name,
        locationId: r.location_id,
        locationName: r.location_name,
        type: r.type,
        quantityDelta: r.quantity_delta,
        unitCostKobo: r.unit_cost_kobo,
        reason: r.reason,
        referenceType: r.reference_type,
        referenceId: r.reference_id,
        createdById: r.created_by,
        createdByName: r.created_by_name,
        createdAt: r.created_at,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor([last.created_at.toISOString(), last.id]) : null,
    };
  }

  private async currentQuantity(trx: Trx, locationId: string, productId: string): Promise<number> {
    const level = await trx
      .selectFrom('stock_levels')
      .select('quantity')
      .where('location_id', '=', locationId)
      .where('product_id', '=', productId)
      .executeTakeFirst();
    return level?.quantity ?? 0;
  }

  /** A retried request: describe what the original recorded, with today's quantities. */
  private async replay(trx: Trx, batchId: string): Promise<StockOperationResultDto> {
    const rows = await trx
      .selectFrom('stock_movements as m')
      .innerJoin('products as p', 'p.id', 'm.product_id')
      .leftJoin('stock_levels as s', (join) =>
        join.onRef('s.product_id', '=', 'm.product_id').onRef('s.location_id', '=', 'm.location_id'),
      )
      .select(['m.product_id', 'p.name', 'p.unit', 'm.location_id', 'm.type', 'm.quantity_delta', 's.quantity'])
      .where('m.batch_id', '=', batchId)
      .execute();
    return {
      batchId,
      replayed: true,
      items: rows.map((r) => ({
        productId: r.product_id,
        productName: r.name,
        unit: r.unit,
        locationId: r.location_id,
        type: r.type,
        quantityDelta: r.quantity_delta,
        quantityAfter: r.quantity ?? 0,
      })),
    };
  }
}
