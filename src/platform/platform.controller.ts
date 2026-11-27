import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { PageService } from '../page/page.service';
import { VnpayConfig } from '../payment/vnpay';
import { PrismaService } from '../prisma/prisma.service';

// ponytail: platform admins are listed in env PLATFORM_ADMIN_EMAILS (comma-separated);
// move to a User.role column if admins need to be managed from the UI.
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const email = context.switchToHttp().getRequest().user?.email?.toLowerCase();
    const admins = (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!email || !admins.includes(email)) throw new ForbiddenException('Platform admin only');
    return true;
  }
}

type TemplateInput = {
  name?: string;
  description?: string | null;
  category?: string | null;
  thumbnailUrl?: string | null;
  data?: unknown;
  published?: boolean;
};

const templateSummary = {
  id: true, name: true, description: true, category: true, thumbnailUrl: true,
  source: true, published: true, createdAt: true, updatedAt: true,
} satisfies Prisma.TemplateSelect;

@Controller('platform')
@UseGuards(MerchantAuthGuard, PlatformAdminGuard)
export class PlatformController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pages: PageService,
  ) {}

  @Get('stats')
  async stats() {
    const [stores, suspended, merchants, orders, templates] = await Promise.all([
      this.prisma.store.count(),
      this.prisma.store.count({ where: { status: 'SUSPENDED' } }),
      this.prisma.user.count(),
      this.prisma.order.count({ where: { status: { not: 'DRAFT' } } }),
      this.prisma.template.count(),
    ]);
    return { stores, suspended, merchants, orders, templates };
  }

  @Get('stores')
  async stores(@Query('q') q?: string) {
    const query = q?.trim();
    const stores = await this.prisma.store.findMany({
      where: query ? { OR: [{ name: { contains: query, mode: 'insensitive' } }, { slug: { contains: query, mode: 'insensitive' } }] } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        members: { where: { role: 'OWNER' }, include: { user: { select: { email: true, name: true } } } },
        _count: { select: { products: true, orders: true } },
      },
    });
    return stores.map(({ members, _count, theme: _theme, ...store }) => ({
      ...store,
      owners: members.map((m) => m.user),
      productCount: _count.products,
      orderCount: _count.orders,
    }));
  }

  @Patch('stores/:id')
  async setStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    if (body.status !== 'ACTIVE' && body.status !== 'SUSPENDED') throw new BadRequestException('status must be ACTIVE or SUSPENDED');
    const { count } = await this.prisma.store.updateMany({ where: { id }, data: { status: body.status } });
    if (!count) throw new NotFoundException('Store not found');
    return { id, status: body.status };
  }

  @Get('merchants')
  async merchants() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, email: true, name: true, createdAt: true, memberships: { select: { role: true, store: { select: { slug: true, name: true, status: true } } } } },
    });
    return users.map(({ memberships, ...u }) => ({ ...u, stores: memberships.map((m) => ({ ...m.store, role: m.role })) }));
  }

  @Get('templates')
  templates() {
    return this.prisma.template.findMany({ select: templateSummary, orderBy: { createdAt: 'desc' } });
  }

  @Get('templates/:id')
  async template(@Param('id') id: string) {
    const template = await this.prisma.template.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  @Post('templates')
  createTemplate(@Body() body: TemplateInput) {
    const data = this.templateData(body, true) as Prisma.TemplateCreateInput;
    return this.prisma.template.create({ data, select: templateSummary });
  }

  @Put('templates/:id')
  async updateTemplate(@Param('id') id: string, @Body() body: TemplateInput) {
    await this.template(id);
    return this.prisma.template.update({ where: { id }, data: this.templateData(body, false), select: templateSummary });
  }

  @Delete('templates/:id')
  async deleteTemplate(@Param('id') id: string) {
    await this.template(id);
    await this.prisma.template.delete({ where: { id } });
    return { id };
  }

  @Get('settings/vnpay')
  async vnpay() {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: 'vnpay' } });
    const v = (row?.value ?? {}) as Partial<VnpayConfig>;
    return {
      tmnCode: v.tmnCode ?? '',
      payUrl: v.payUrl ?? '',
      hashSecretSet: !!v.hashSecret,
      envFallback: !v.tmnCode && !!process.env.VNPAY_TMN_CODE,
    };
  }

  // hashSecret is write-only: leave it empty to keep the stored one. Empty tmnCode clears the config (env fallback).
  @Put('settings/vnpay')
  async setVnpay(@Body() body: { tmnCode?: string; hashSecret?: string; payUrl?: string }) {
    const tmnCode = body.tmnCode?.trim() ?? '';
    if (!tmnCode) {
      await this.prisma.platformSetting.deleteMany({ where: { key: 'vnpay' } });
      return this.vnpay();
    }
    const row = await this.prisma.platformSetting.findUnique({ where: { key: 'vnpay' } });
    const hashSecret = body.hashSecret?.trim() || (row?.value as Partial<VnpayConfig> | undefined)?.hashSecret;
    if (!hashSecret) throw new BadRequestException('hashSecret is required');
    const payUrl = body.payUrl?.trim() || '';
    if (payUrl && !/^https:\/\//.test(payUrl)) throw new BadRequestException('payUrl must be https');
    const value = { tmnCode, hashSecret, ...(payUrl ? { payUrl } : {}) };
    await this.prisma.platformSetting.upsert({ where: { key: 'vnpay' }, create: { key: 'vnpay', value }, update: { value } });
    return this.vnpay();
  }

  private templateData(body: TemplateInput, requireAll: boolean): Prisma.TemplateUpdateInput {
    const out: Prisma.TemplateUpdateInput = {};
    if (body.name !== undefined || requireAll) {
      const name = body.name?.trim();
      if (!name) throw new BadRequestException('name is required');
      out.name = name;
    }
    for (const key of ['description', 'category'] as const) {
      if (body[key] !== undefined) out[key] = body[key]?.trim() || null;
    }
    if (body.thumbnailUrl !== undefined) {
      const url = body.thumbnailUrl?.trim() || null;
      if (url && !/^https?:\/\//.test(url)) throw new BadRequestException('thumbnailUrl must be http(s)');
      out.thumbnailUrl = url;
    }
    if (body.data !== undefined || requireAll) {
      out.data = this.pages.parseData(body.data ?? { root: { props: {} }, content: [] });
    }
    if (body.published !== undefined) out.published = !!body.published;
    return out;
  }
}

// Merchants browse published templates when creating a page.
@Controller('templates')
@UseGuards(MerchantAuthGuard)
export class TemplateController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.template.findMany({
      where: { published: true },
      select: { id: true, name: true, description: true, category: true, thumbnailUrl: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}
