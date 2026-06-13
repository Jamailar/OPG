import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { RedeemService } from './redeem.service';

@ApiTags('PublicProducts')
@Controller(tenantControllerPaths('products', true))
export class PublicProductsController {
  constructor(private readonly redeemService: RedeemService) {}

  @Get()
  @Public()
  @Header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=86400')
  @ApiOperation({ summary: '公开产品列表' })
  async listProducts(
    @Param('app') app: string | undefined,
    @Query('limit') limit?: string,
  ): Promise<any> {
    const parsedLimit = Number(limit || 200);
    return this.redeemService.listPublicMembershipProductsByAppSlug(app, {
      limit: parsedLimit,
    });
  }
}
