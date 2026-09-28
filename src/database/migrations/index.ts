import type { Migration } from 'kysely';
import * as m0001 from './0001_foundation';
import * as m0002 from './0002_registers';
import * as m0003 from './0003_products_inventory';
import * as m0004 from './0004_customers_wallets';
import * as m0005 from './0005_sales';
import * as m0006 from './0006_voids_repayments';
import * as m0007 from './0007_deliveries';
import * as m0008 from './0008_sync';
import * as m0009 from './0009_notifications';
import * as m0010 from './0010_exports_signatures';

/**
 * Explicit, ordered migration list. Add each new migration here.
 * (A static list works identically under tsx, the compiled build and Jest,
 * unlike folder scanning with dynamic imports.)
 */
export const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
  '0002_registers': m0002,
  '0003_products_inventory': m0003,
  '0004_customers_wallets': m0004,
  '0005_sales': m0005,
  '0006_voids_repayments': m0006,
  '0007_deliveries': m0007,
  '0008_sync': m0008,
  '0009_notifications': m0009,
  '0010_exports_signatures': m0010,
};
