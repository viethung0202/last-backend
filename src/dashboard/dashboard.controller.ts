import { Controller, Get, UseGuards } from '@nestjs/common';
import { OrderStatus, PaymentStatus, ProductStatus } from '@prisma/client';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreMemberGuard } from '../auth/store-member.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentStore } from '../store/current-store.decorator';
import { TenantGuard } from '../store/tenant.guard';

const LOW_STOCK = 5;

@Controller('stores/:storeSlug/dashboard')
@UseGuards(TenantGuard, MerchantAuthGuard, StoreMemberGuard)
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async summary(@CurrentStore() store: { id: string }) {
    const storeId = store.id;
    const [products, activeProducts, orders, pendingOrders, customers, revenue, lowStock, recentOrders] =
      await Promise.all([
        this.prisma.product.count({ where: { storeId } }),
        this.prisma.product.count({ where: { storeId, status: ProductStatus.ACTIVE } }),
        this.prisma.order.count({ where: { storeId, status: { not: OrderStatus.DRAFT } } }),
        this.prisma.order.count({ where: { storeId, status: OrderStatus.PENDING } }),
        this.prisma.customer.count({ where: { storeId } }),
        // money actually collected: VNPAY confirmed by IPN, COD on delivery
        this.prisma.payment.aggregate({
          where: { status: PaymentStatus.SUCCEEDED, order: { storeId } },
          _sum: { amount: true },
        }),
        this.prisma.productVariant.findMany({
          where: { product: { storeId, status: ProductStatus.ACTIVE }, stock: { lte: LOW_STOCK } },
          select: { id: true, stock: true, product: { select: { id: true, name: true } } },
          orderBy: { stock: 'asc' },
          take: 5,
        }),
        this.prisma.order.findMany({
          where: { storeId, status: { not: OrderStatus.DRAFT } },
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { payments: true },
        }),
      ]);
    return {
      products,
      activeProducts,
      orders,
      pendingOrders,
      customers,
      revenue: revenue._sum.amount ?? '0',
      lowStock,
      recentOrders,
    };
  }
}
