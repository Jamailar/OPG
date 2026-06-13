import { Module } from '@nestjs/common';
import { PublicProductsController } from './public-products.controller';
import { RedeemService } from './redeem.service';

@Module({
  controllers: [PublicProductsController],
  providers: [RedeemService],
  exports: [RedeemService],
})
export class RedeemModule {}
