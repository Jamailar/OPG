import { Global, Module } from '@nestjs/common';
import { OutboundHttpClientService } from './outbound-http-client.service';
import { OutboundProxyService } from './outbound-proxy.service';

@Global()
@Module({
  providers: [OutboundHttpClientService, OutboundProxyService],
  exports: [OutboundHttpClientService, OutboundProxyService],
})
export class OutboundProxyModule {}
