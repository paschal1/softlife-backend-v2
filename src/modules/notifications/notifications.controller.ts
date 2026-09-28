import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import {
  ListNotificationsQueryDto,
  NotificationDto,
  NotificationPageDto,
  NotificationSettingsDto,
  RegisterDeviceDto,
  UnreadCountDto,
  UnregisterDeviceDto,
  UpdateNotificationSettingsDto,
} from './dto/notifications.dto';
import { InboxService } from './inbox.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @ApiOperation({ summary: 'My notifications', description: 'Newest first: alerts (low stock, till variances, voids, overdue debts...) and the daily digest.' })
  @ApiOkResponse({ type: NotificationPageDto })
  list(@CurrentUser() auth: AuthContext, @Query() query: ListNotificationsQueryDto): Promise<NotificationPageDto> {
    return this.inbox.list(auth, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Badge count' })
  @ApiOkResponse({ type: UnreadCountDto })
  unreadCount(@CurrentUser() auth: AuthContext): Promise<UnreadCountDto> {
    return this.inbox.unreadCount(auth);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all as read' })
  @ApiOkResponse({ type: UnreadCountDto })
  readAll(@CurrentUser() auth: AuthContext): Promise<UnreadCountDto> {
    return this.inbox.markAllRead(auth);
  }

  @Get('settings')
  @ApiOperation({ summary: 'My notification settings' })
  @ApiOkResponse({ type: NotificationSettingsDto })
  settings(@CurrentUser() auth: AuthContext): Promise<NotificationSettingsDto> {
    return this.inbox.settings(auth);
  }

  @Put('settings')
  @ApiOperation({ summary: 'Change my notification settings', description: 'Turn push, SMS or the daily digest on/off, or mute kinds of alert.' })
  @ApiOkResponse({ type: NotificationSettingsDto })
  updateSettings(@CurrentUser() auth: AuthContext, @Body() dto: UpdateNotificationSettingsDto): Promise<NotificationSettingsDto> {
    return this.inbox.updateSettings(auth, dto);
  }

  @Post('devices')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Register this phone/browser for push', description: 'Send the Firebase token after login and whenever it changes.' })
  @ApiNoContentResponse()
  registerDevice(@CurrentUser() auth: AuthContext, @Body() dto: RegisterDeviceDto): Promise<void> {
    return this.inbox.registerDevice(auth, dto);
  }

  @Post('devices/unregister')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop push to this device', description: 'Call on sign-out.' })
  @ApiNoContentResponse()
  unregisterDevice(@CurrentUser() auth: AuthContext, @Body() dto: UnregisterDeviceDto): Promise<void> {
    return this.inbox.unregisterDevice(auth, dto.token);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one as read' })
  @ApiOkResponse({ type: NotificationDto })
  read(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<NotificationDto> {
    return this.inbox.markRead(auth, id);
  }
}
