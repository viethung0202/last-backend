import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PageModule } from '../page/page.module';
import { PlatformController, TemplateController } from './platform.controller';

@Module({
  imports: [AuthModule, PageModule],
  controllers: [PlatformController, TemplateController],
})
export class PlatformModule {}
