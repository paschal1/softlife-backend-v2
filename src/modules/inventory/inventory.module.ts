import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockLedger } from './stock-ledger.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, StockLedger],
  // Products (opening stock) and Sales (decrement on sale) record through the same ledger.
  exports: [StockLedger],
})
export class InventoryModule {}
