import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { RegistersModule } from '../registers/registers.module';
import { CustomerDebtsController, DebtsReportController } from './debts.controller';
import { DebtsService } from './debts.service';

@Module({
  imports: [RegistersModule, CustomersModule],
  controllers: [CustomerDebtsController, DebtsReportController],
  providers: [DebtsService],
  exports: [DebtsService],
})
export class DebtsModule {}
