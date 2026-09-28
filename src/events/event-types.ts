/**
 * The domain event catalog. Names are "<aggregate>.<past_tense_verb>".
 * Dotted names let subscribers use wildcards, e.g. 'sale.*' or '**' (everything).
 *
 * Foundation events live here now; each module adds its own as it is built
 * (sale.completed, sale.voided, debt.created, repayment.recorded, wallet.topped_up,
 * wallet.debited, stock.adjusted, delivery.assigned, delivery.confirmed,
 * register.opened, register.closed, threshold.crossed — per the Product Plan).
 */
export const EventTypes = {
  OrganizationCreated: 'organization.created',
  LocationCreated: 'location.created',
  UserCreated: 'user.created',
  UserPinChanged: 'user.pin_changed',
  UserPinLocked: 'user.pin_locked',
  OrganizationSettingsUpdated: 'organization.settings_updated',
  RegisterCreated: 'register.created',
  RegisterOpened: 'register.opened',
  RegisterClosed: 'register.closed',
  RegisterCashMoved: 'register.cash_moved',
  ThresholdCrossed: 'threshold.crossed',
  ProductCreated: 'product.created',
  ProductUpdated: 'product.updated',
  StockReceived: 'stock.received',
  StockAdjusted: 'stock.adjusted',
  StockTransferred: 'stock.transferred',
  CustomerCreated: 'customer.created',
  CustomerUpdated: 'customer.updated',
  WalletToppedUp: 'wallet.topped_up',
  WalletDebited: 'wallet.debited',
  WalletRefunded: 'wallet.refunded',
  WalletAdjusted: 'wallet.adjusted',
  SaleCompleted: 'sale.completed',
  SaleVoided: 'sale.voided',
  DebtCreated: 'debt.created',
  CreditLimitOverridden: 'credit.limit_overridden',
  RepaymentRecorded: 'repayment.recorded',
  DebtVoided: 'debt.voided',
  DeliveryQueued: 'delivery.queued',
  DeliveryAssigned: 'delivery.assigned',
  DeliveryDispatched: 'delivery.dispatched',
  DeliveryConfirmed: 'delivery.confirmed',
  DeliveryFailed: 'delivery.failed',
  DeliveryCancelled: 'delivery.cancelled',
  DriverCashRemitted: 'delivery.cash_remitted',
  SyncFlagged: 'sync.flagged',
  AuditExported: 'audit.exported',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];
