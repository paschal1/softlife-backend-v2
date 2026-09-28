import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Selectable, Transaction } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '../../common/db/pg-errors';
import { uuidv7 } from '../../common/ids/uuidv7';
import { decodeCursor, encodeCursor, likeEscape } from '../../common/pagination';
import { isSupervisor } from '../../common/roles';
import type { DB, JsonValue, ProductsTable } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import { StockLedger } from '../inventory/stock-ledger.service';
import type {
  CreateProductDto,
  ListProductsQueryDto,
  ProductDetailDto,
  ProductDto,
  ProductPageDto,
  UpdateProductDto,
} from './dto/products.dto';

type Trx = Transaction<DB>;
type ProductRow = Selectable<ProductsTable>;

const UNIQUE_MESSAGES: Record<string, string> = {
  products_org_name_uidx: 'A product with this name already exists',
  products_org_sku_uidx: 'Another product already uses this SKU',
  products_org_barcode_uidx: 'Another product already uses this barcode',
};

/** Fields whose changes are recorded on product.updated (before/after). */
const TRACKED_FIELDS = [
  ['name', 'name'],
  ['sku', 'sku'],
  ['barcode', 'barcode'],
  ['category', 'category'],
  ['unit', 'unit'],
  ['sellingPriceKobo', 'selling_price_kobo'],
  ['wholesalePriceKobo', 'wholesale_price_kobo'],
  ['costPriceKobo', 'cost_price_kobo'],
  ['reorderLevel', 'reorder_level'],
  ['isActive', 'is_active'],
] as const;

@Injectable()
export class ProductsService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly ledger: StockLedger,
    private readonly events: EventPublisher,
  ) {}

  async create(auth: AuthContext, dto: CreateProductDto): Promise<ProductDetailDto> {
    const tracksStock = dto.tracksStock ?? true;
    if (!tracksStock && dto.openingStock?.length) {
      throw new BadRequestException('Opening stock only applies to products that track stock');
    }

    return this.withFriendlyErrors(() =>
      this.tenantDb.transaction(async (trx) => {
        if (dto.id) {
          const existing = await trx.selectFrom('products').select('id').where('id', '=', dto.id).executeTakeFirst();
          if (existing) return this.detail(trx, auth, existing.id);
        }
        const id = dto.id ?? uuidv7();

        const product = await trx
          .insertInto('products')
          .values({
            id,
            organization_id: auth.organizationId,
            name: dto.name.trim(),
            sku: clean(dto.sku),
            barcode: clean(dto.barcode),
            category: clean(dto.category),
            unit: clean(dto.unit) ?? 'piece',
            selling_price_kobo: dto.sellingPriceKobo,
            wholesale_price_kobo: dto.wholesalePriceKobo ?? null,
            cost_price_kobo: dto.costPriceKobo ?? 0,
            tracks_stock: tracksStock,
            reorder_level: dto.reorderLevel ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await this.events.record(trx, {
          type: EventTypes.ProductCreated,
          aggregateType: 'product',
          aggregateId: id,
          payload: { after: snapshot(product) },
        });

        if (dto.openingStock?.length) {
          await this.ledger.record(
            trx,
            dto.openingStock.map((o) => ({
              productId: id,
              locationId: o.locationId,
              type: 'opening' as const,
              quantityDelta: o.quantity,
              unitCostKobo: dto.costPriceKobo ?? null,
            })),
            { organizationId: auth.organizationId, actorId: auth.userId, batchId: uuidv7() },
          );
        }

        return this.detail(trx, auth, id);
      }),
    );
  }

  async update(auth: AuthContext, id: string, dto: UpdateProductDto): Promise<ProductDetailDto> {
    return this.withFriendlyErrors(() =>
      this.tenantDb.transaction(async (trx) => {
        const current = await trx.selectFrom('products').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!current) throw new NotFoundException('Product not found');

        const changes: Partial<ProductRow> = {};
        const before: Record<string, JsonValue> = {};
        const after: Record<string, JsonValue> = {};

        for (const [dtoKey, column] of TRACKED_FIELDS) {
          const raw = dto[dtoKey];
          if (raw === undefined) continue;
          const next = typeof raw === 'string' ? (column === 'name' ? raw.trim() : clean(raw)) : raw;
          if (next === current[column]) continue;
          (changes as Record<string, unknown>)[column] = next;
          before[dtoKey] = current[column] as JsonValue;
          after[dtoKey] = next as JsonValue;
        }

        if (Object.keys(changes).length > 0) {
          await trx.updateTable('products').set(changes).where('id', '=', id).execute();
          // Price changes land in the audit log with who, when, from and to.
          await this.events.record(trx, {
            type: EventTypes.ProductUpdated,
            aggregateType: 'product',
            aggregateId: id,
            payload: { before, after },
          });
        }

        return this.detail(trx, auth, id);
      }),
    );
  }

  /** POS-01: search, scan or browse. */
  async list(auth: AuthContext, query: ListProductsQueryDto): Promise<ProductPageDto> {
    const limit = query.limit ?? 100;
    const cursor = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const search = query.search?.trim();
    const pattern = search ? `%${likeEscape(search)}%` : null;

    return this.tenantDb.transaction(async (trx) => {
      const rows = await trx
        .selectFrom('products')
        .selectAll()
        .$if(query.includeInactive !== 'true', (qb) => qb.where('is_active', '=', true))
        .$if(!!query.barcode, (qb) => qb.where('barcode', '=', query.barcode!.trim()))
        .$if(!!query.category, (qb) => qb.where('category', '=', query.category!))
        .$if(pattern !== null, (qb) =>
          qb.where((eb) => eb.or([eb('name', 'ilike', pattern!), eb('sku', 'ilike', pattern!), eb('barcode', '=', search!)])),
        )
        .$if(cursor !== null, (qb) => qb.where((eb) => eb(eb.refTuple('name', 'id'), '>', eb.tuple(cursor![0]!, cursor![1]!))))
        .orderBy('name')
        .orderBy('id')
        .limit(limit + 1)
        .execute();

      const page = rows.slice(0, limit);
      const stock = query.locationId ? await this.stockAt(trx, query.locationId, page.map((p) => p.id)) : null;
      const last = page[page.length - 1];

      return {
        items: page.map((p) => toDto(p, auth, stock ? (p.tracks_stock ? (stock.get(p.id) ?? 0) : null) : null)),
        nextCursor: rows.length > limit && last ? encodeCursor([last.name, last.id]) : null,
      };
    });
  }

  async get(auth: AuthContext, id: string): Promise<ProductDetailDto> {
    return this.tenantDb.transaction((trx) => this.detail(trx, auth, id));
  }

  async categories(): Promise<string[]> {
    const rows = await this.tenantDb.transaction((trx) =>
      trx
        .selectFrom('products')
        .select('category')
        .distinct()
        .where('category', 'is not', null)
        .where('is_active', '=', true)
        .orderBy('category')
        .execute(),
    );
    return rows.map((r) => r.category!);
  }

  private async detail(trx: Trx, auth: AuthContext, id: string): Promise<ProductDetailDto> {
    const product = await trx.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirst();
    if (!product) throw new NotFoundException('Product not found');

    const stockByLocation = product.tracks_stock
      ? await trx
          .selectFrom('locations as l')
          .leftJoin('stock_levels as s', (join) => join.onRef('s.location_id', '=', 'l.id').on('s.product_id', '=', id))
          .select(['l.id as locationId', 'l.name as locationName', 's.quantity'])
          .where('l.is_active', '=', true)
          .orderBy('l.created_at')
          .execute()
      : [];

    return {
      ...toDto(product, auth, null),
      stockByLocation: stockByLocation.map((s) => ({ locationId: s.locationId, locationName: s.locationName, quantity: s.quantity ?? 0 })),
    };
  }

  private async stockAt(trx: Trx, locationId: string, productIds: string[]): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const levels = await trx
      .selectFrom('stock_levels')
      .select(['product_id', 'quantity'])
      .where('location_id', '=', locationId)
      .where('product_id', 'in', productIds)
      .execute();
    return new Map(levels.map((l) => [l.product_id, l.quantity]));
  }

  private async withFriendlyErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const code = pgErrorCode(err);
      if (code === PG_UNIQUE_VIOLATION) {
        const constraint = (err as { constraint?: string }).constraint ?? '';
        throw new ConflictException(UNIQUE_MESSAGES[constraint] ?? 'This product conflicts with an existing one');
      }
      if (code === PG_FOREIGN_KEY_VIOLATION) throw new BadRequestException('Unknown location');
      throw err;
    }
  }
}

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toDto(p: ProductRow, auth: AuthContext, stockQuantity: number | null): ProductDto {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    barcode: p.barcode,
    category: p.category,
    unit: p.unit,
    sellingPriceKobo: p.selling_price_kobo,
    wholesalePriceKobo: p.wholesale_price_kobo,
    costPriceKobo: isSupervisor(auth.role) ? p.cost_price_kobo : null,
    tracksStock: p.tracks_stock,
    reorderLevel: p.reorder_level,
    isActive: p.is_active,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    stockQuantity,
  };
}

function snapshot(p: ProductRow): { [key: string]: JsonValue } {
  return {
    name: p.name,
    sku: p.sku,
    barcode: p.barcode,
    category: p.category,
    unit: p.unit,
    sellingPriceKobo: p.selling_price_kobo,
    wholesalePriceKobo: p.wholesale_price_kobo,
    costPriceKobo: p.cost_price_kobo,
    tracksStock: p.tracks_stock,
    reorderLevel: p.reorder_level,
  };
}
