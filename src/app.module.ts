import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from './auth/auth.module';
import { AuditApiModule } from './modules/audit/audit-api.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { RequestContextInterceptor } from './auth/request-context.interceptor';
import { type Env, validateEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health/health.controller';
import { FilesController } from './storage/files.controller';
import { StorageModule } from './storage/storage.module';
import { LocationsModule } from './modules/locations/locations.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DebtsModule } from './modules/debts/debts.module';
import { DeliveriesModule } from './modules/deliveries/deliveries.module';
import { InsightsModule } from './modules/insights/insights.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProductsModule } from './modules/products/products.module';
import { ReceiptsModule } from './modules/receipts/receipts.module';
import { RegistersModule } from './modules/registers/registers.module';
import { SalesModule } from './modules/sales/sales.module';
import { SyncModule } from './modules/sync/sync.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: { algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
    DatabaseModule,
    EventsModule,
    StorageModule,
    AuthModule,
    OrganizationsModule,
    LocationsModule,
    UsersModule,
    RegistersModule,
    InventoryModule,
    ProductsModule,
    CustomersModule,
    SalesModule,
    ReceiptsModule,
    DebtsModule,
    DeliveriesModule,
    SyncModule,
    NotificationsModule,
    InsightsModule,
    AuditApiModule,
  ],
  controllers: [HealthController, FilesController],
  providers: [
    // Order matters: authenticate, then authorize, then enter the tenant context.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule {}
