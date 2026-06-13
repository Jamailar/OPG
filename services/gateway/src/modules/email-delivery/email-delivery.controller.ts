import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { EmailDeliveryService } from './email-delivery.service';

@ApiTags('Email')
@Controller(tenantControllerPaths('email', true))
export class EmailDeliveryController {
  constructor(private readonly emailDeliveryService: EmailDeliveryService) {}

  @Get('unsubscribe')
  @ApiOperation({ summary: '邮件退订' })
  async unsubscribe(@Param('app') app: string | undefined, @Query('email') email: string, @Query('token') token: string) {
    return this.emailDeliveryService.unsubscribe(app, token, email);
  }

  @Post('unsubscribe')
  @ApiOperation({ summary: '邮件退订' })
  async unsubscribePost(@Param('app') app: string | undefined, @Body() body: { email?: string; token?: string }) {
    return this.emailDeliveryService.unsubscribe(app, body?.token || '', body?.email || '');
  }
}
