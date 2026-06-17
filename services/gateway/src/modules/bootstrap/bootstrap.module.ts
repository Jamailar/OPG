import { Module } from '@nestjs/common';
import { BootstrapController } from './bootstrap.controller';
import { BootstrapService } from './bootstrap.service';

@Module({
  controllers: [BootstrapController],
  providers: [BootstrapService],
})
export class BootstrapModule {}
