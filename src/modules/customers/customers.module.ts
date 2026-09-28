import { Module } from '@nestjs/common';
import { RegistersModule } from '../registers/registers.module';
import { CustomersController, WalletController } from './customers.controller';
import { CustomersService } from './customers.service';
import { WalletLedger } from './wallet-ledger.service';
import { WalletService } from './wallet.service';

@Module({
  imports: [RegistersModule],
  controllers: [CustomersController, WalletController],
  providers: [CustomersService, WalletService, WalletLedger],
  // Sales pays from wallets and checks credit limits through these.
  exports: [CustomersService, WalletLedger, WalletService],
})
export class CustomersModule {}
