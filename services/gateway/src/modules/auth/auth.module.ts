import { forwardRef, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigType } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccountBindingService } from './account-binding.service';
import { AppleIdentityService } from './apple-identity.service';
import { EmailVerificationService } from './email-verification.service';
import { IosAppAttestService } from './ios-app-attest.service';
import { JwtStrategy } from './jwt.strategy';
import configuration from '../../config/configuration';
import { AiChatModule } from '../ai-chat/ai-chat.module';
import { RedeemModule } from '../redeem/redeem.module';
import { EmailDeliveryModule } from '../email-delivery/email-delivery.module';
import { OutboundProxyModule } from '../outbound-proxy/outbound-proxy.module';
import { RuntimeSettingsModule } from '../runtime-settings/runtime-settings.module';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    forwardRef(() => AiChatModule),
    RedeemModule,
    EmailDeliveryModule,
    OutboundProxyModule,
    RuntimeSettingsModule,
    SmsModule,
    JwtModule.registerAsync({
      inject: [configuration.KEY],
      useFactory: (config: ConfigType<typeof configuration>) => ({
        secret: config.jwt.secret,
        signOptions: { expiresIn: config.jwt.expiresIn },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AccountBindingService, AppleIdentityService, IosAppAttestService, JwtStrategy, EmailVerificationService],
  exports: [AuthService, AccountBindingService, AppleIdentityService, IosAppAttestService, EmailVerificationService],
})
export class AuthModule {}
