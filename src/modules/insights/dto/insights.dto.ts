import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';

export class DailySummaryQueryDto {
  /** Business-local day, YYYY-MM-DD. Defaults to today in the business's timezone. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  /** One branch. Omit for the whole business. (Debt and wallet figures are always business-wide.) */
  @IsOptional() @IsUUID()
  locationId?: string;
}

class SalesSummaryDto {
  count!: number;
  totalKobo!: number;
  voidedCount!: number;
  /** e.g. { cash: 1000000, transfer: 845000 } */
  @ApiProperty({ type: Object })
  byMethod!: Record<string, number>;
}

class TopProductDto {
  productId!: string;
  name!: string;
  quantity!: number;
  revenueKobo!: number;
}

class OpenRegisterDto {
  registerName!: string;
  staffName!: string;
  openedAt!: Date;
}

class RegistersSummaryDto {
  flaggedClosings!: number;
  netVarianceKobo!: number;
  @ApiProperty({ type: [OpenRegisterDto] })
  stillOpen!: OpenRegisterDto[];
}

class DebtSummaryDto {
  newCreditKobo!: number;
  repaidKobo!: number;
  outstandingKobo!: number;
  over90DaysKobo!: number;
}

class LowItemDto {
  name!: string;
  quantity!: number;
}

class StockSummaryDto {
  lowCount!: number;
  @ApiProperty({ type: [LowItemDto] })
  lowItems!: LowItemDto[];
}

class DeliveriesSummaryDto {
  delivered!: number;
  pending!: number;
  failed!: number;
  cashWithDriversKobo!: number;
}

class WalletsSummaryDto {
  toppedUpKobo!: number;
}

export class DailySummaryDto {
  date!: string;
  sales!: SalesSummaryDto;
  @ApiProperty({ type: [TopProductDto] })
  topProducts!: TopProductDto[];
  registers!: RegistersSummaryDto;
  debt!: DebtSummaryDto;
  wallets!: WalletsSummaryDto;
  stock!: StockSummaryDto;
  deliveries!: DeliveriesSummaryDto;
}
