import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { NOTIFICATION_KINDS, type NotificationKind } from '../rules';

export class ListNotificationsQueryDto {
  @IsOptional() @IsIn(['true', 'false'])
  unreadOnly?: 'true' | 'false';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;
}

export class NotificationDto {
  id!: string;

  @ApiProperty({ enum: NOTIFICATION_KINDS })
  kind!: NotificationKind;

  @ApiProperty({ enum: ['info', 'warning', 'critical'] })
  severity!: 'info' | 'warning' | 'critical';

  title!: string;
  body!: string;

  /** Ids to open the right screen, e.g. { saleId } or { customerId }. */
  @ApiProperty({ type: Object })
  data!: unknown;

  @ApiProperty({ type: Date, nullable: true })
  readAt!: Date | null;

  createdAt!: Date;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationDto] })
  items!: NotificationDto[];

  unreadCount!: number;

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class NotificationSettingsDto {
  pushEnabled!: boolean;
  /** SMS carries only critical alerts and the daily digest. Needs a phone number on your account. */
  smsEnabled!: boolean;
  dailyDigest!: boolean;

  @ApiProperty({ enum: NOTIFICATION_KINDS, isArray: true })
  mutedKinds!: NotificationKind[];

  /** Which channels the business has switched on (keys configured on the server). */
  @ApiProperty({ enum: ['in_app', 'push', 'sms'], isArray: true })
  availableChannels!: string[];
}

/** Send only what changes. */
export class UpdateNotificationSettingsDto {
  @ValidateIf((o: UpdateNotificationSettingsDto) => o.pushEnabled !== undefined)
  @IsBoolean()
  pushEnabled?: boolean;

  @ValidateIf((o: UpdateNotificationSettingsDto) => o.smsEnabled !== undefined)
  @IsBoolean()
  smsEnabled?: boolean;

  @ValidateIf((o: UpdateNotificationSettingsDto) => o.dailyDigest !== undefined)
  @IsBoolean()
  dailyDigest?: boolean;

  @ApiPropertyOptional({ enum: NOTIFICATION_KINDS, isArray: true })
  @ValidateIf((o: UpdateNotificationSettingsDto) => o.mutedKinds !== undefined)
  @IsArray() @ArrayUnique() @IsIn(NOTIFICATION_KINDS, { each: true })
  mutedKinds?: NotificationKind[];
}

export class RegisterDeviceDto {
  /** The FCM registration token from the Firebase SDK on the phone or browser. */
  @IsString() @IsNotEmpty() @MaxLength(4096)
  token!: string;

  @ApiProperty({ enum: ['android', 'ios', 'web'] })
  @IsIn(['android', 'ios', 'web'])
  platform!: 'android' | 'ios' | 'web';
}

export class UnregisterDeviceDto {
  @IsString() @IsNotEmpty() @MaxLength(4096)
  token!: string;
}

export class UnreadCountDto {
  unreadCount!: number;
}
