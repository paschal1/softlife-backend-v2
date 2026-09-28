import { Module } from '@nestjs/common';
import { FcmChannel } from './channels/fcm.channel';
import { TermiiChannel } from './channels/termii.channel';
import { NotificationService } from './notification.service';

/** Shared by the API (inbox, settings) and the worker (alerts, digest, dispatch). */
@Module({
  providers: [FcmChannel, TermiiChannel, NotificationService],
  exports: [FcmChannel, TermiiChannel, NotificationService],
})
export class NotificationsCoreModule {}
