import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CreateUserDto, SetPinDto, UserDto } from './dto/users.dto';
import { UsersService } from './users.service';

@ApiTags('Users & staff')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List staff', description: "Also what a till shows on its \"who's clocking in?\" screen." })
  @ApiOkResponse({ type: [UserDto] })
  list(): Promise<UserDto[]> {
    return this.users.list();
  }

  @Post()
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Add a staff member', description: 'Owners add managers, cashiers and drivers; managers add cashiers and drivers. Give a password for back-office access, a PIN for till access, or both.' })
  @ApiCreatedResponse({ type: UserDto })
  create(@CurrentUser() actor: AuthContext, @Body() dto: CreateUserDto): Promise<UserDto> {
    return this.users.create(actor, dto);
  }

  @Put(':id/pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set or reset a PIN', description: 'Staff can set their own; owners and managers can reset it for staff they manage. Also clears a PIN lockout.' })
  @ApiNoContentResponse()
  setPin(@CurrentUser() actor: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPinDto): Promise<void> {
    return this.users.setPin(actor, id, dto.pin);
  }
}
