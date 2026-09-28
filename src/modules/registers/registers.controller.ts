import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { ClockInDto, CreateRegisterDto, ListRegistersQueryDto, RegisterSessionReportDto, RegisterStatusDto } from './dto/registers.dto';
import { RegisterSessionsService } from './register-sessions.service';
import { RegistersService } from './registers.service';

@ApiTags('Registers')
@ApiBearerAuth()
@Controller('registers')
export class RegistersController {
  constructor(
    private readonly registers: RegistersService,
    private readonly sessions: RegisterSessionsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List registers with live status (REG-03)', description: 'Open (who, since when, float) or closed (last close time). Poll for near-real-time updates.' })
  @ApiOkResponse({ type: [RegisterStatusDto] })
  list(@Query() query: ListRegistersQueryDto): Promise<RegisterStatusDto[]> {
    return this.registers.listWithStatus(query.locationId);
  }

  @Post()
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Create a register (till) at a branch' })
  @ApiCreatedResponse({ type: RegisterStatusDto })
  create(@Body() dto: CreateRegisterDto): Promise<RegisterStatusDto> {
    return this.registers.create(dto);
  }

  @Post(':registerId/clock-in')
  @ApiOperation({
    summary: 'Clock in and declare the opening float (REG-01)',
    description:
      'Opens a session for the caller, usually right after /auth/pin-login on the till. ' +
      'One open session per register and one per staff member. Retry-safe with sessionId.',
  })
  @ApiCreatedResponse({ type: RegisterSessionReportDto })
  @ApiConflictResponse({ description: 'Register already in use, or caller clocked in elsewhere' })
  clockIn(
    @CurrentUser() auth: AuthContext,
    @Param('registerId', ParseUUIDPipe) registerId: string,
    @Body() dto: ClockInDto,
  ): Promise<RegisterSessionReportDto> {
    return this.sessions.clockIn(auth, registerId, dto);
  }
}
