import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import type { AuthContext } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { AuthTokensDto, MeDto } from './dto/auth-response.dto';
import { LoginDto, PinLoginDto, RefreshDto, SignupDto } from './dto/auth.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('signup')
  @ApiOperation({ summary: 'Register a business', description: 'Creates the organization, its first branch and the owner account, and signs the owner in.' })
  @ApiCreatedResponse({ type: AuthTokensDto })
  @ApiConflictResponse({ description: 'Email or phone already used to sign in' })
  signup(@Body() dto: SignupDto): Promise<AuthTokensDto> {
    return this.auth.signup(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Back-office sign in', description: 'identifier is an email address or phone number (0803…, +234803…, etc).' })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiUnauthorizedResponse({ description: 'Wrong credentials' })
  login(@Body() dto: LoginDto): Promise<AuthTokensDto> {
    return this.auth.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate tokens', description: 'Returns a new token pair. Reusing an old refresh token signs that login out everywhere.' })
  @ApiOkResponse({ type: AuthTokensDto })
  refresh(@Body() dto: RefreshDto): Promise<AuthTokensDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('pin-login')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Staff PIN hand-off on a till',
    description: "Call with the till's current token. Returns tokens for the staff member whose PIN was entered. Locks for 15 minutes after 5 wrong attempts.",
  })
  @ApiOkResponse({ type: AuthTokensDto })
  pinLogin(@CurrentUser() device: AuthContext, @Body() dto: PinLoginDto): Promise<AuthTokensDto> {
    return this.auth.pinLogin(device, dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out this login' })
  @ApiNoContentResponse()
  logout(@CurrentUser() auth: AuthContext): Promise<void> {
    return this.auth.logout(auth);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in user' })
  @ApiOkResponse({ type: MeDto })
  me(@CurrentUser() auth: AuthContext): Promise<MeDto> {
    return this.auth.me(auth);
  }
}
