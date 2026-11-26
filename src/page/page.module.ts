import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantGuard } from '../store/tenant.guard';
import { PageController, SiteController } from './page.controller';
import { PageService } from './page.service';

@Module({
  imports: [AuthModule],
  controllers: [PageController, SiteController],
  providers: [PageService, TenantGuard],
})
export class PageModule {}
