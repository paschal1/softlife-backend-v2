import { Module } from '@nestjs/common';
import { RegisterSessionsController } from './register-sessions.controller';
import { RegisterSessionsService } from './register-sessions.service';
import { RegistersController } from './registers.controller';
import { RegistersService } from './registers.service';

@Module({
  controllers: [RegistersController, RegisterSessionsController],
  providers: [RegistersService, RegisterSessionsService],
  // Sales imports this module and calls requireOpenSession() inside its own transaction.
  exports: [RegisterSessionsService],
})
export class RegistersModule {}
