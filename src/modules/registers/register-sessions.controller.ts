import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import {
  CashMovementDto,
  CloseSessionDto,
  CreateCashMovementDto,
  CurrentSessionResponseDto,
  ListSessionsQueryDto,
  RegisterSessionPageDto,
  RegisterSessionReportDto,
} from './dto/registers.dto';
import { RegisterSessionsService } from './register-sessions.service';

@ApiTags('Register sessions & End of Day')
@ApiBearerAuth()
@Controller('register-sessions')
export class RegisterSessionsController {
  constructor(private readonly sessions: RegisterSessionsService) {}

  @Get('current')
  @ApiOperation({ summary: "The caller's open session, or null (REG-02)", description: 'The POS calls this on start-up: null means show the clock-in screen, not the sales screen.' })
  @ApiOkResponse({ type: CurrentSessionResponseDto })
  current(@CurrentUser() auth: AuthContext): Promise<CurrentSessionResponseDto> {
    return this.sessions.current(auth);
  }

  @Get()
  @ApiOperation({ summary: 'List sessions / EOD reports (EOD-03)', description: 'Newest first. Cashiers and drivers see only their own. Filter by date, register, staff, status or flagged variance.' })
  @ApiOkResponse({ type: RegisterSessionPageDto })
  list(@CurrentUser() auth: AuthContext, @Query() query: ListSessionsQueryDto): Promise<RegisterSessionPageDto> {
    return this.sessions.list(auth, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One session with its full cash breakdown (EOD report)' })
  @ApiOkResponse({ type: RegisterSessionReportDto })
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RegisterSessionReportDto> {
    return this.sessions.get(auth, id);
  }

  @Post(':id/cash-movements')
  @ApiOperation({ summary: 'Record a pay-in or pay-out', description: 'A reason is required. Pay-outs cannot exceed the cash expected in the till.' })
  @ApiCreatedResponse({ type: CashMovementDto })
  recordCashMovement(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCashMovementDto,
  ): Promise<CashMovementDto> {
    return this.sessions.recordCashMovement(auth, id, dto);
  }

  @Get(':id/eod-preview')
  @ApiOperation({ summary: 'EOD step 1: expected cash in till (EOD-01)', description: 'Read-only. Show this before asking staff to count.' })
  @ApiOkResponse({ type: RegisterSessionReportDto })
  eodPreview(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RegisterSessionReportDto> {
    return this.sessions.eodPreview(auth, id);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'EOD step 2: submit counted cash and close (EOD-01, EOD-02)',
    description:
      'Computes variance = counted − expected, flags it if above the organization threshold, ' +
      'raises an alert event when flagged, and closes the register permanently. Retry-safe.',
  })
  @ApiOkResponse({ type: RegisterSessionReportDto })
  close(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseSessionDto,
  ): Promise<RegisterSessionReportDto> {
    return this.sessions.close(auth, id, dto);
  }
}
