import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { DebtsModule } from '../debts/debts.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { RegistersModule } from '../registers/registers.module';
import { SalesModule } from '../sales/sales.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [RegistersModule, SalesModule, CustomersModule, DebtsModule, DeliveriesModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
