import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { DatabaseModule } from './config/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { UploadModule } from './modules/upload/upload.module';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { AiChatModule } from './modules/ai-chat/ai-chat.module';
import { AiAgentsModule } from './modules/ai-agents/ai-agents.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { TenantSiteModule } from './modules/tenant-site/tenant-site.module';
import { EmailDeliveryModule } from './modules/email-delivery/email-delivery.module';
import { OutboundProxyModule } from './modules/outbound-proxy/outbound-proxy.module';
import { AcquisitionModule } from './modules/acquisition/acquisition.module';
import { RuntimeSettingsModule } from './modules/runtime-settings/runtime-settings.module';
import { DeveloperSdkModule } from './modules/developer-sdk/developer-sdk.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { BootstrapModule } from './modules/bootstrap/bootstrap.module';
import { PlatformTasksModule } from './modules/platform-tasks/platform-tasks.module';
import { AppSchemaModule } from './modules/app-schema/app-schema.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    ObservabilityModule,
    AuthModule,
    UsersModule,
    UploadModule,
    PlatformAdminModule,
    DiscoveryModule,
    AiChatModule,
    AiAgentsModule,
    PaymentsModule,
    TenantSiteModule,
    EmailDeliveryModule,
    OutboundProxyModule,
    AcquisitionModule,
    RuntimeSettingsModule,
    DeveloperSdkModule,
    PlatformTasksModule,
    AppSchemaModule,
    BootstrapModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
export class AppModule {}
