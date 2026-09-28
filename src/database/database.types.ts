import type { ColumnType, Generated } from 'kysely';

export const ROLES = ['owner', 'manager', 'cashier', 'driver'] as const;
export type Role = (typeof ROLES)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Timestamps come back from node-postgres as Date objects.
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type TimestampWithDefault = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

// jsonb is always written as a JSON string (JSON.stringify). node-postgres would otherwise
// turn JS arrays into Postgres arrays, which silently corrupts JSON array payloads.
type Jsonb = ColumnType<JsonValue, string, string>;
type NullableJsonb = ColumnType<JsonValue | null, string | null | undefined, string | null>;

export interface OrganizationsTable {
  id: string;
  name: string;
  country_code: Generated<string>;
  currency: Generated<string>;
  timezone: Generated<string>;
  enabled_modules: Generated<string[]>;
  status: Generated<'active' | 'suspended'>;
  eod_variance_alert_kobo: Generated<number>;
  credit_limit_mode: Generated<'soft' | 'hard'>;
  default_credit_limit_kobo: number | null;
  enabled_order_types: Generated<OrderType[]>;
  /** Local hour (0-23, in the business's timezone) when the daily digest goes out. */
  daily_digest_hour: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LocationsTable {
  id: string;
  organization_id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UsersTable {
  id: string;
  organization_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  password_hash: string | null;
  pin_hash: string | null;
  default_location_id: string | null;
  is_active: Generated<boolean>;
  pin_failed_attempts: Generated<number>;
  pin_locked_until: NullableTimestamp;
  last_login_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AuthSessionsTable {
  id: string;
  organization_id: string;
  user_id: string;
  family_id: string;
  kind: 'password' | 'pin';
  token_hash: string;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
  replaced_by: string | null;
  created_at: Generated<Date>;
}

export interface OutboxEventsTable {
  id: string;
  organization_id: string;
  location_id: string | null;
  actor_id: string | null;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Jsonb;
  occurred_at: Timestamp;
  created_at: Generated<Date>;
  published_at: NullableTimestamp;
  attempts: Generated<number>;
  next_attempt_at: TimestampWithDefault;
  last_error: string | null;
  dead_lettered_at: NullableTimestamp;
}

export interface AuditLogTable {
  id: string;
  event_id: string;
  organization_id: string;
  location_id: string | null;
  actor_id: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string;
  before_state: NullableJsonb;
  after_state: NullableJsonb;
  occurred_at: Timestamp;
  recorded_at: Generated<Date>;
}

export interface RegistersTable {
  id: string;
  organization_id: string;
  location_id: string;
  name: string;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type RegisterSessionStatus = 'open' | 'closed';

export interface RegisterSessionsTable {
  id: string;
  organization_id: string;
  register_id: string;
  location_id: string;
  user_id: string;
  status: Generated<RegisterSessionStatus>;
  opening_float_kobo: number;
  opened_at: Generated<Date>;
  closed_at: NullableTimestamp;
  closed_by: string | null;
  expected_cash_kobo: number | null;
  counted_cash_kobo: number | null;
  variance_kobo: number | null;
  variance_flagged: Generated<boolean>;
  closing_note: string | null;
}

export const CASH_MOVEMENT_KINDS = [
  'opening_float',
  'pay_in',
  'pay_out',
  'cash_sale',
  'cash_refund',
  'wallet_top_up',
  'debt_repayment',
  'delivery_cash',
] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

export interface RegisterCashMovementsTable {
  id: string;
  organization_id: string;
  register_session_id: string;
  kind: CashMovementKind;
  /** Signed: negative = cash out of the till. */
  amount_kobo: number;
  reason: string | null;
  reference_type: string | null;
  reference_id: string | null;
  created_by: string;
  created_at: Generated<Date>;
}

export interface ProductsTable {
  id: string;
  organization_id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category: string | null;
  unit: Generated<string>;
  selling_price_kobo: number;
  wholesale_price_kobo: number | null;
  cost_price_kobo: Generated<number>;
  tracks_stock: Generated<boolean>;
  reorder_level: number | null;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Read-only for the API: maintained by a trigger on stock_movements. */
export interface StockLevelsTable {
  organization_id: string;
  location_id: string;
  product_id: string;
  quantity: number;
  updated_at: Generated<Date>;
}

export const STOCK_MOVEMENT_TYPES = [
  'opening',
  'purchase',
  'sale',
  'sale_reversal',
  'wastage',
  'correction',
  'stock_count',
  'transfer_out',
  'transfer_in',
  'delivery_return',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export interface StockMovementsTable {
  id: string;
  organization_id: string;
  batch_id: string;
  product_id: string;
  location_id: string;
  type: StockMovementType;
  /** Signed: negative = stock out. */
  quantity_delta: number;
  unit_cost_kobo: number | null;
  reason: string | null;
  reference_type: string | null;
  reference_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export const CUSTOMER_TYPES = ['retail', 'wholesale', 'vip', 'staff'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export interface CustomersTable {
  id: string;
  organization_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  type: Generated<CustomerType>;
  address: string | null;
  credit_limit_kobo: number | null;
  notes: string | null;
  is_active: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Read-only for the API: maintained by a trigger on wallet_transactions. */
export interface CustomerWalletsTable {
  organization_id: string;
  customer_id: string;
  balance_kobo: number;
  updated_at: Generated<Date>;
}

export const WALLET_TRANSACTION_TYPES = ['top_up', 'payment', 'refund', 'adjustment'] as const;
export type WalletTransactionType = (typeof WALLET_TRANSACTION_TYPES)[number];
export const PAYMENT_METHODS_IN = ['cash', 'transfer'] as const;
export type MoneyInMethod = (typeof PAYMENT_METHODS_IN)[number];

export interface WalletTransactionsTable {
  id: string;
  organization_id: string;
  customer_id: string;
  type: WalletTransactionType;
  /** Signed: negative = money out of the wallet. */
  amount_kobo: number;
  method: MoneyInMethod | null;
  /** Bank transfer reference. */
  reference: string | null;
  reason: string | null;
  reference_type: string | null;
  reference_id: string | null;
  register_session_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export const ORDER_TYPES = ['walk_in', 'delivery', 'credit', 'pre_order', 'wholesale'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const SALE_PAYMENT_METHODS = ['cash', 'transfer', 'card', 'wallet', 'credit', 'pay_on_delivery'] as const;
export type SalePaymentMethod = (typeof SALE_PAYMENT_METHODS)[number];

export interface DocumentCountersTable {
  organization_id: string;
  name: string;
  last_value: number;
}

export interface SalesTable {
  id: string;
  organization_id: string;
  number: number;
  location_id: string;
  register_id: string;
  register_session_id: string;
  cashier_id: string;
  customer_id: string | null;
  order_type: OrderType;
  status: Generated<'completed' | 'voided'>;
  subtotal_kobo: number;
  discount_kobo: Generated<number>;
  total_kobo: number;
  paid_kobo: number;
  credit_kobo: Generated<number>;
  change_kobo: Generated<number>;
  delivery_address: string | null;
  /** 'YYYY-MM-DD' (see pg-types.ts). */
  delivery_date: string | null;
  delivery_driver_id: string | null;
  note: string | null;
  approved_by: string | null;
  approval_reasons: string[] | null;
  occurred_at: Timestamp;
  created_at: Generated<Date>;
  voided_at: NullableTimestamp;
  voided_by: string | null;
  void_reason: string | null;
  void_approved_by: string | null;
  /** Amount to be collected on delivery or pickup. */
  cod_kobo: Generated<number>;
  fulfilment: 'delivery' | 'pickup' | null;
}

export interface SaleItemsTable {
  id: string;
  organization_id: string;
  sale_id: string;
  line_no: number;
  product_id: string;
  product_name: string;
  unit: string;
  quantity: number;
  unit_price_kobo: number;
  discount_kobo: Generated<number>;
  line_total_kobo: number;
}

export interface SalePaymentsTable {
  id: string;
  organization_id: string;
  sale_id: string;
  method: SalePaymentMethod;
  amount_kobo: number;
  reference: string | null;
  tendered_kobo: number | null;
  wallet_transaction_id: string | null;
  debt_record_id: string | null;
}

export interface DebtRecordsTable {
  id: string;
  organization_id: string;
  customer_id: string;
  sale_id: string;
  amount_kobo: number;
  paid_kobo: Generated<number>;
  /** Generated by the database from paid_kobo and voided_at. Never written. */
  status: ColumnType<'open' | 'settled' | 'voided', never, never>;
  voided_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export const REPAYMENT_METHODS = ['cash', 'transfer', 'card', 'wallet'] as const;
export type RepaymentMethod = (typeof REPAYMENT_METHODS)[number];

export interface DebtRepaymentsTable {
  id: string;
  organization_id: string;
  customer_id: string;
  amount_kobo: number;
  method: RepaymentMethod;
  reference: string | null;
  note: string | null;
  wallet_transaction_id: string | null;
  register_session_id: string | null;
  created_by: string;
  created_at: Generated<Date>;
}

export interface DebtRepaymentAllocationsTable {
  id: string;
  organization_id: string;
  repayment_id: string;
  debt_record_id: string;
  amount_kobo: number;
}

export const DELIVERY_STATUSES = ['queued', 'assigned', 'out_for_delivery', 'delivered', 'failed', 'cancelled'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type Fulfilment = 'delivery' | 'pickup';
export const COLLECTION_METHODS = ['cash', 'transfer', 'card'] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export interface DeliveriesTable {
  id: string;
  organization_id: string;
  sale_id: string;
  location_id: string;
  customer_id: string | null;
  fulfilment: Fulfilment;
  address: string | null;
  /** 'YYYY-MM-DD' */
  scheduled_date: string;
  driver_id: string | null;
  expected_at: NullableTimestamp;
  status: Generated<DeliveryStatus>;
  confirmation_code: string;
  code_attempts: Generated<number>;
  cod_kobo: Generated<number>;
  collected_kobo: Generated<number>;
  attempts: Generated<number>;
  proof_method: 'code' | 'recipient_name' | null;
  received_by_name: string | null;
  delivered_at: NullableTimestamp;
  delivered_by: string | null;
  failure_reason: string | null;
  /** File-storage key of the signature captured at the door, if any. */
  signature_key: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DeliveryCollectionsTable {
  id: string;
  organization_id: string;
  delivery_id: string;
  method: CollectionMethod;
  amount_kobo: number;
  reference: string | null;
  collected_by: string;
  collected_at: Generated<Date>;
  remittance_id: string | null;
}

export interface DeliveryRemittancesTable {
  id: string;
  organization_id: string;
  driver_id: string;
  expected_kobo: number;
  counted_kobo: number;
  variance_kobo: number;
  register_session_id: string;
  received_by: string;
  note: string | null;
  created_at: Generated<Date>;
}

export interface DeliveryReturnsTable {
  id: string;
  organization_id: string;
  delivery_id: string;
  product_id: string;
  quantity: number;
  note: string | null;
  created_at: Generated<Date>;
}

export interface SyncOperationsTable {
  op_id: string;
  organization_id: string;
  device_id: string;
  actor_id: string;
  type: string;
  occurred_at: Timestamp;
  status: 'applied' | 'rejected';
  entity_id: string | null;
  flags: Generated<string[]>;
  error_code: string | null;
  error_message: string | null;
  payload: Jsonb;
  received_at: Generated<Date>;
  resolved_at: NullableTimestamp;
  resolved_by: string | null;
  resolution_note: string | null;
}

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface NotificationsTable {
  id: string;
  organization_id: string;
  user_id: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  data: Jsonb;
  source_key: string;
  read_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface NotificationSettingsTable {
  organization_id: string;
  user_id: string;
  push_enabled: Generated<boolean>;
  sms_enabled: Generated<boolean>;
  daily_digest: Generated<boolean>;
  muted_kinds: Generated<string[]>;
  updated_at: Generated<Date>;
}

export interface PushDevicesTable {
  id: string;
  organization_id: string;
  user_id: string;
  token: string;
  platform: 'android' | 'ios' | 'web';
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  last_seen_at: TimestampWithDefault;
}

export interface NotificationDeliveriesTable {
  id: string;
  organization_id: string;
  notification_id: string;
  channel: 'push' | 'sms';
  target: string;
  status: Generated<'pending' | 'sent' | 'failed'>;
  attempts: Generated<number>;
  next_attempt_at: TimestampWithDefault;
  last_error: string | null;
  sent_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface JobRunsTable {
  organization_id: string;
  job: string;
  period_key: string;
  started_at: Generated<Date>;
  finished_at: NullableTimestamp;
  error: string | null;
}

export interface DebtOverdueAlertsTable {
  organization_id: string;
  debt_record_id: string;
  bucket: 'days31to60' | 'days61to90' | 'days90plus';
  created_at: Generated<Date>;
}

export type ExportStatus = 'queued' | 'running' | 'done' | 'failed' | 'expired';

export interface ExportsTable {
  id: string;
  organization_id: string;
  kind: 'audit_log';
  format: 'csv' | 'pdf';
  filters: Jsonb;
  status: Generated<ExportStatus>;
  row_count: number | null;
  file_key: string | null;
  file_size: number | null;
  error: string | null;
  attempts: Generated<number>;
  requested_by: string;
  created_at: Generated<Date>;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  expires_at: NullableTimestamp;
}

export interface DB {
  organizations: OrganizationsTable;
  locations: LocationsTable;
  users: UsersTable;
  auth_sessions: AuthSessionsTable;
  outbox_events: OutboxEventsTable;
  audit_log: AuditLogTable;
  registers: RegistersTable;
  register_sessions: RegisterSessionsTable;
  register_cash_movements: RegisterCashMovementsTable;
  products: ProductsTable;
  stock_levels: StockLevelsTable;
  stock_movements: StockMovementsTable;
  customers: CustomersTable;
  customer_wallets: CustomerWalletsTable;
  wallet_transactions: WalletTransactionsTable;
  document_counters: DocumentCountersTable;
  sales: SalesTable;
  sale_items: SaleItemsTable;
  sale_payments: SalePaymentsTable;
  debt_records: DebtRecordsTable;
  debt_repayments: DebtRepaymentsTable;
  debt_repayment_allocations: DebtRepaymentAllocationsTable;
  deliveries: DeliveriesTable;
  delivery_collections: DeliveryCollectionsTable;
  delivery_remittances: DeliveryRemittancesTable;
  delivery_returns: DeliveryReturnsTable;
  sync_operations: SyncOperationsTable;
  notifications: NotificationsTable;
  notification_settings: NotificationSettingsTable;
  push_devices: PushDevicesTable;
  notification_deliveries: NotificationDeliveriesTable;
  job_runs: JobRunsTable;
  debt_overdue_alerts: DebtOverdueAlertsTable;
  exports: ExportsTable;
}
