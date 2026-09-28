import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ManagerApproval } from './manager-approval.service';
import { PasswordHasher } from './password-hasher.service';
import { PinVerifier } from './pin-verifier.service';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, PasswordHasher, PinVerifier, ManagerApproval],
  exports: [PasswordHasher, ManagerApproval],
})
export class AuthModule {}
