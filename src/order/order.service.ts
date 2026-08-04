import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type CreateOrderInput = {
  guestEmail?: string;
  guestName?: string;
  items?: Array<{
    variantId?: string;
    quantity?: number;
  }>;
};

@Injectable()
export class OrderService {
  constructor(private readonly prisma: PrismaService) {}

  findAllForStore(storeId: string) {
    return this.prisma.order.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      include: { items: true, payments: true },
    });
  }

  async createGuestOrder(storeId: string, input: CreateOrderInput) {
    const guestEmail = this.requiredEmail(input.guestEmail);
    const guestName = this.requiredText(input.guestName, 'guestName');
    const items = input.items ?? [];
    if (items.length === 0) {
      throw new BadRequestException('items are required');
    }

    const quantities = new Map<string, number>();
    for (const item of items) {
      const variantId = this.requiredText(item.variantId, 'variantId');
      const quantity = this.requiredCount(item.quantity, 'quantity');
      quantities.set(variantId, (quantities.get(variantId) ?? 0) + quantity);
    }

    const variants = await this.prisma.productVariant.findMany({
      where: {
        id: { in: [...quantities.keys()] },
        product: { storeId, status: ProductStatus.ACTIVE },
      },
      include: { product: true },
    });
    if (variants.length !== quantities.size) {
      throw new BadRequestException('Some variants are not available');
    }

    let totalCents = 0;
    const orderItems = variants.map((variant) => {
      const quantity = quantities.get(variant.id) ?? 0;
      if (variant.stock < quantity) {
        throw new BadRequestException(`${variant.product.name} is out of stock`);
      }
      totalCents += variant.priceCents * quantity;
      return {
        variantId: variant.id,
        productNameSnapshot: variant.product.name,
        variantLabelSnapshot: this.variantLabel(variant.optionValues),
        unitPriceCents: variant.priceCents,
        quantity,
      };
    });

    return this.prisma.$transaction(async (tx) => {
      for (const item of orderItems) {
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { decrement: item.quantity } },
        });
      }

      return tx.order.create({
        data: {
          storeId,
          guestEmail,
          guestName,
          totalCents,
          items: { create: orderItems },
        },
        include: { items: true, payments: true },
      });
    });
  }

  async updateStatus(storeId: string, orderId: string, status: OrderStatus) {
    if (!Object.values(OrderStatus).includes(status)) {
      throw new BadRequestException('Invalid order status');
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, storeId },
      select: { id: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: { status },
      include: { items: true, payments: true },
    });
  }

  private requiredText(value: string | undefined, field: string) {
    const text = value?.trim();
    if (!text) {
      throw new BadRequestException(`${field} is required`);
    }
    return text;
  }

  private requiredEmail(value: string | undefined) {
    const email = this.requiredText(value, 'guestEmail').toLowerCase();
    if (!email.includes('@')) {
      throw new BadRequestException('Valid guestEmail is required');
    }
    return email;
  }

  private requiredCount(value: number | undefined, field: string) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }
    return value;
  }

  private variantLabel(optionValues: unknown) {
    if (!optionValues || Object.keys(optionValues).length === 0) {
      return 'Default';
    }
    return Object.entries(optionValues as Record<string, string>)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
  }
}
