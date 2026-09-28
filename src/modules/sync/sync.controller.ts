import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import {
  ResolveSyncDto,
  SyncPullDto,
  SyncPullQueryDto,
  SyncPushDto,
  SyncPushResultDto,
  SyncReviewItemDto,
  SyncReviewQueryDto,
} from './dto/sync.dto';
import { SyncService } from './sync.service';

@ApiTags('Offline sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('push')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upload operations recorded offline',
    description:
      "Call with the till's own token. Operations are applied in order, each exactly once (re-sending an opId returns its stored outcome). " +
      'Sales that already happened are accepted as they happened and flagged when something differs (price, wallet balance, credit limit, approval). ' +
      'If a result is not_processed, send it and everything after it again.',
  })
  @ApiOkResponse({ type: SyncPushResultDto })
  push(@CurrentUser() device: AuthContext, @Body() dto: SyncPushDto): Promise<SyncPushResultDto> {
    return this.sync.push(device, dto);
  }

  @Get('pull')
  @ApiOperation({
    summary: 'Download what the till needs to work offline',
    description: 'Products, prices, customers, wallet balances, debts, stock, staff and registers changed since `since`. Omit `since` for a full download.',
  })
  @ApiOkResponse({ type: SyncPullDto })
  pull(@CurrentUser() device: AuthContext, @Query() query: SyncPullQueryDto): Promise<SyncPullDto> {
    return this.sync.pull(device, query);
  }

  @Get('review')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Offline operations needing attention',
    description: 'Rejected operations, and applied ones with flags (e.g. sold at an old price, wallet shortfall moved to credit). Unresolved by default.',
  })
  @ApiOkResponse({ type: [SyncReviewItemDto] })
  review(@Query() query: SyncReviewQueryDto): Promise<SyncReviewItemDto[]> {
    return this.sync.review(query);
  }

  @Post('review/:opId/resolve')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Mark a reviewed operation as dealt with', description: 'Say what was done. Recorded permanently.' })
  @ApiOkResponse({ type: SyncReviewItemDto })
  resolve(@CurrentUser() auth: AuthContext, @Param('opId', ParseUUIDPipe) opId: string, @Body() dto: ResolveSyncDto): Promise<SyncReviewItemDto> {
    return this.sync.resolve(auth, opId, dto);
  }
}
