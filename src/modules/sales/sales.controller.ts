import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { CreateSaleDto, ListSalesQueryDto, SaleDto, SalePageDto, VoidSaleDto, VoidSaleResultDto } from './dto/sales.dto';
import { SalesService } from './sales.service';

@ApiTags('Sales')
@ApiBearerAuth()
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post()
  @ApiOperation({
    summary: 'Complete a sale',
    description:
      'Prices are always taken from the product catalogue (wholesale price on wholesale orders). ' +
      'Payments must equal the total. In one transaction this records the sale, removes stock, ' +
      'charges the wallet, opens a debt for the credit portion, and puts cash in the till. ' +
      'Send a client-generated id so a retry after a dropped connection never charges twice.',
  })
  @ApiCreatedResponse({ type: SaleDto, description: 'The completed sale: everything needed to print a receipt.' })
  @ApiBadRequestResponse({ description: 'Payments do not add up, insufficient wallet balance, missing customer, etc.' })
  @ApiForbiddenResponse({ description: 'Not clocked in to a register (REG-02)' })
  @ApiConflictResponse({
    description:
      'error = MANAGER_APPROVAL_REQUIRED: resubmit with managerApproval (owner/manager PIN); `reasons` says why. ' +
      'error = CREDIT_LIMIT_EXCEEDED: hard limit mode, the sale cannot go through on credit.',
  })
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateSaleDto): Promise<SaleDto> {
    return this.sales.create(auth, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List sales', description: 'Newest first. Cashiers see only their own sales.' })
  @ApiOkResponse({ type: SalePageDto })
  list(@CurrentUser() auth: AuthContext, @Query() query: ListSalesQueryDto): Promise<SalePageDto> {
    return this.sales.list(auth, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One sale with lines and payments (receipt data)' })
  @ApiOkResponse({ type: SaleDto })
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<SaleDto> {
    return this.sales.get(auth, id);
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Void a sale',
    description:
      'Reverses everything: stock returns, wallet is refunded, the debt is cancelled, and cash comes out of the ' +
      "caller's open till. Transfers and card payments are listed in manualRefunds for you to refund yourself. " +
      'Cashiers need managerApproval. Not allowed once any of the sale\'s debt has been repaid.',
  })
  @ApiOkResponse({ type: VoidSaleResultDto })
  @ApiConflictResponse({ description: 'MANAGER_APPROVAL_REQUIRED (reasons: ["void"])' })
  void(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidSaleDto): Promise<VoidSaleResultDto> {
    return this.sales.void(auth, id, dto);
  }
}
