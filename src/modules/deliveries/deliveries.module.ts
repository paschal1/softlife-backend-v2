import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { RegistersModule } from '../registers/registers.module';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';
import { DeliveryQueue } from './delivery-queue.service';

@Module({
  imports: [RegistersModule, InventoryModule],
  controllers: [DeliveriesController],
  providers: [DeliveriesService, DeliveryQueue],
  // Sales enqueues deliveries and cancels them on void, inside its own transaction.
  exports: [DeliveryQueue, DeliveriesService],
})
export class DeliveriesModule {}
