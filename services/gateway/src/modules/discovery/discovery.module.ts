import { Module } from '@nestjs/common';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

@Module({
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
