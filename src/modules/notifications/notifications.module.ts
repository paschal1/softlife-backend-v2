import { Module } from '@nestjs/common';
import { InboxService } from './inbox.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsCoreModule } from './notifications-core.module';

/** API side: each user's inbox, preferences and push devices. */
@Module({
  imports: [NotificationsCoreModule],
  controllers: [NotificationsController],
  providers: [InboxService],
})
export class NotificationsModule {}
