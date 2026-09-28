import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CreateCustomerDto, CustomerDto, CustomerPageDto, ListCustomersQueryDto, UpdateCustomerDto } from './dto/customers.dto';
import {
  AdjustWalletDto,
  TopUpWalletDto,
  WalletOperationResultDto,
  WalletTransactionPageDto,
  WalletTransactionsQueryDto,
} from './dto/wallet.dto';
import { CustomersService } from './customers.service';
import { WalletService } from './wallet.service';

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'Find customers (CUST-01)', description: 'Search by name or any form of phone number. Includes wallet balance.' })
  @ApiOkResponse({ type: CustomerPageDto })
  list(@Query() query: ListCustomersQueryDto): Promise<CustomerPageDto> {
    return this.customers.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One customer with wallet balance and credit limit' })
  @ApiOkResponse({ type: CustomerDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDto> {
    return this.customers.get(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Add a customer',
    description: 'Any staff member, e.g. at checkout. Tags other than retail need an owner/manager; credit limits need the owner. Retry-safe with id.',
  })
  @ApiCreatedResponse({ type: CustomerDto })
  @ApiConflictResponse({ description: 'Phone number already belongs to another customer' })
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateCustomerDto): Promise<CustomerDto> {
    return this.customers.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a customer (CUST-02)', description: 'Send only changed fields. Type and status need an owner/manager; credit limit needs the owner. Changes are audited.' })
  @ApiOkResponse({ type: CustomerDto })
  update(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto): Promise<CustomerDto> {
    return this.customers.update(auth, id, dto);
  }
}

@ApiTags('Customer wallets')
@ApiBearerAuth()
@Controller('customers/:customerId/wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('transactions')
  @ApiOperation({ summary: 'Wallet history (WAL-03)', description: 'Newest first. Each line shows the balance after it, so the history reconciles exactly to the current balance.' })
  @ApiOkResponse({ type: WalletTransactionPageDto })
  transactions(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: WalletTransactionsQueryDto,
  ): Promise<WalletTransactionPageDto> {
    return this.wallet.transactions(customerId, query);
  }

  @Post('top-ups')
  @ApiOperation({
    summary: 'Top up a wallet (WAL-01)',
    description: 'Cash top-ups go into the caller\'s open till and count toward its EOD. Transfers need the bank reference. Retry-safe with id.',
  })
  @ApiCreatedResponse({ type: WalletOperationResultDto })
  topUp(
    @CurrentUser() auth: AuthContext,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: TopUpWalletDto,
  ): Promise<WalletOperationResultDto> {
    return this.wallet.topUp(auth, customerId, dto);
  }

  @Post('adjustments')
  @Roles('owner')
  @ApiOperation({ summary: 'Correct a wallet balance', description: 'Owner only, reason required, cannot go below zero. Fully audited.' })
  @ApiCreatedResponse({ type: WalletOperationResultDto })
  adjust(
    @CurrentUser() auth: AuthContext,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: AdjustWalletDto,
  ): Promise<WalletOperationResultDto> {
    return this.wallet.adjust(auth, customerId, dto);
  }
}
