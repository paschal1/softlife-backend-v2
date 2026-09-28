import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, NotEquals, ValidateIf } from 'class-validator';
import {
  PAYMENT_METHODS_IN,
  WALLET_TRANSACTION_TYPES,
  type MoneyInMethod,
  type WalletTransactionType,
} from '../../../database/database.types';

const MAX_KOBO = 100_000_000_000;

export class TopUpWalletDto {
  /** Optional client-generated UUIDv7: resubmitting is a safe no-op. */
  @IsOptional() @IsUUID()
  id?: string;

  /** Amount added, in kobo. */
  @IsInt() @Min(1) @Max(MAX_KOBO)
  amountKobo!: number;

  @ApiProperty({
    enum: PAYMENT_METHODS_IN,
    description: 'cash goes into the caller\'s open till (must be clocked in). transfer needs the bank reference.',
  })
  @IsIn(PAYMENT_METHODS_IN)
  method!: MoneyInMethod;

  /** Bank transfer reference. Required for transfers (WAL-01). */
  @ValidateIf((o: TopUpWalletDto) => o.method === 'transfer')
  @IsString() @IsNotEmpty() @MaxLength(100)
  reference?: string;
}

export class AdjustWalletDto {
  @IsOptional() @IsUUID()
  id?: string;

  /** Signed kobo: positive credits the wallet, negative debits it. Cannot take it below zero. */
  @IsInt() @NotEquals(0) @Min(-MAX_KOBO) @Max(MAX_KOBO)
  amountKobo!: number;

  /** Required. e.g. "Top-up recorded twice on 3 March". */
  @IsString() @IsNotEmpty() @MaxLength(300)
  reason!: string;
}

export class WalletTransactionsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;
}

export class WalletTransactionDto {
  id!: string;
  customerId!: string;

  @ApiProperty({ enum: WALLET_TRANSACTION_TYPES })
  type!: WalletTransactionType;

  /** Signed: negative when money left the wallet. */
  amountKobo!: number;

  /** Wallet balance right after this transaction. Lets anyone verify the history line by line (WAL-03). */
  balanceAfterKobo!: number;

  @ApiProperty({ enum: PAYMENT_METHODS_IN, nullable: true })
  method!: MoneyInMethod | null;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  /** What caused it, e.g. "sale". */
  @ApiProperty({ type: String, nullable: true })
  referenceType!: string | null;

  @ApiProperty({ type: String, nullable: true })
  referenceId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  registerSessionId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  createdById!: string | null;

  @ApiProperty({ type: String, nullable: true })
  createdByName!: string | null;

  createdAt!: Date;
}

export class WalletOperationResultDto {
  transaction!: WalletTransactionDto;
  balanceKobo!: number;
  /** True when this id was already processed and nothing new was recorded. */
  replayed!: boolean;
}

export class WalletTransactionPageDto {
  /** Current balance: equals the balanceAfterKobo of the newest transaction. */
  balanceKobo!: number;

  @ApiProperty({ type: [WalletTransactionDto] })
  items!: WalletTransactionDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
