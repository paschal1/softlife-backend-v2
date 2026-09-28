import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import {
  AdjustStockDto,
  ReceiveStockDto,
  StockLevelDto,
  StockLevelsQueryDto,
  StockMovementPageDto,
  StockMovementsQueryDto,
  StockOperationResultDto,
  TransferStockDto,
} from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('Inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('levels')
  @ApiOperation({
    summary: 'Stock on hand',
    description: 'Per branch with locationId, or totals across all branches without it. Includes tracked products with zero stock.',
  })
  @ApiOkResponse({ type: [StockLevelDto] })
  levels(@Query() query: StockLevelsQueryDto): Promise<StockLevelDto[]> {
    return this.inventory.levels(query);
  }

  @Get('movements')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Stock history', description: 'Every change to stock, newest first: who, what, why, and which sale or delivery caused it.' })
  @ApiOkResponse({ type: StockMovementPageDto })
  movements(@Query() query: StockMovementsQueryDto): Promise<StockMovementPageDto> {
    return this.inventory.movements(query);
  }

  @Post('receipts')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Receive stock at a branch', description: 'Supplier delivery or a production run. Retry-safe with id.' })
  @ApiCreatedResponse({ type: StockOperationResultDto })
  receive(@CurrentUser() auth: AuthContext, @Body() dto: ReceiveStockDto): Promise<StockOperationResultDto> {
    return this.inventory.receive(auth, dto);
  }

  @Post('adjustments')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Wastage, correction or stock count', description: 'A reason is always required. Cannot take stock below zero.' })
  @ApiCreatedResponse({ type: StockOperationResultDto })
  adjust(@CurrentUser() auth: AuthContext, @Body() dto: AdjustStockDto): Promise<StockOperationResultDto> {
    return this.inventory.adjust(auth, dto);
  }

  @Post('transfers')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Move stock between branches', description: 'Both sides are recorded atomically. Blocked if the sending branch lacks the stock.' })
  @ApiCreatedResponse({ type: StockOperationResultDto })
  transfer(@CurrentUser() auth: AuthContext, @Body() dto: TransferStockDto): Promise<StockOperationResultDto> {
    return this.inventory.transfer(auth, dto);
  }
}
