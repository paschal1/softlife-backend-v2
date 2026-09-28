import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CustomersModule } from '../customers/customers.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { InventoryModule } from '../inventory/inventory.module';
import { RegistersModule } from '../registers/registers.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [AuthModule, RegistersModule, InventoryModule, CustomersModule, DeliveriesModule],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
