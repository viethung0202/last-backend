import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreMemberGuard } from '../auth/store-member.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentStore } from '../store/current-store.decorator';
import { TenantGuard } from '../store/tenant.guard';

const publicFields = { id: true, email: true, name: true, createdAt: true } as const;

// Customers are created by checkout (one per store + email), see OrderService.
@Controller('stores/:storeSlug/customers')
@UseGuards(TenantGuard, MerchantAuthGuard, StoreMemberGuard)
export class CustomerController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async findAll(@CurrentStore() store: { id: string }) {
    const [customers, stats] = await Promise.all([
      this.prisma.customer.findMany({
        where: { storeId: store.id },
        select: { ...publicFields, _count: { select: { orders: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.order.groupBy({
        by: ['customerId'],
        where: { storeId: store.id, customerId: { not: null }, status: { not: OrderStatus.CANCELLED } },
        _sum: { total: true },
        _max: { createdAt: true },
      }),
    ]);
    const byCustomer = new Map(stats.map((row) => [row.customerId, row]));
    return customers.map(({ _count, ...customer }) => ({
      ...customer,
      orderCount: _count.orders,
      totalSpent: byCustomer.get(customer.id)?._sum.total ?? '0',
      lastOrderAt: byCustomer.get(customer.id)?._max.createdAt ?? null,
    }));
  }

  @Get(':customerId')
  async findOne(@CurrentStore() store: { id: string }, @Param('customerId') customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, storeId: store.id },
      select: {
        ...publicFields,
        orders: { orderBy: { createdAt: 'desc' }, include: { items: true, payments: true } },
      },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    return customer;
  }
}
