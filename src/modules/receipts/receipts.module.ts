import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module';
import { PublicReceiptsController, SaleReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [SalesModule],
  controllers: [SaleReceiptsController, PublicReceiptsController],
  providers: [ReceiptsService],
})
export class ReceiptsModule {}
