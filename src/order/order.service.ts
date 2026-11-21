import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma, ProductStatus } from '@prisma/client';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';

type CreateOrderInput = {
  guestEmail?: string;
  guestName?: string;
  paymentMethod?: PaymentMethod;
  // VNPAY only: storefront page VNPAY redirects back to
  returnUrl?: string;
  items?: Array<{
    variantId?: string;
    quantity?: number;
  }>;
};

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
  ) {}

  findAllForStore(storeId: string) {
    return this.prisma.order.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      include: { items: true, payments: true },
    });
  }

  // Public order tracking: guest proves ownership with the email used at checkout.
  async findForGuest(storeId: string, orderId: string, email: string | undefined) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, storeId, guestEmail: email?.trim().toLowerCase() || '-' },
      include: { items: true, payments: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  async createGuestOrder(
    store: { id: string; currency: string },
    input: CreateOrderInput,
    ipAddr: string,
  ) {
    const storeId = store.id;
    const guestEmail = this.requiredEmail(input.guestEmail);
    const guestName = this.requiredText(input.guestName, 'guestName');
    const paymentMethod = input.paymentMethod ?? PaymentMethod.COD;
    if (!Object.values(PaymentMethod).includes(paymentMethod)) {
      throw new BadRequestException('paymentMethod must be COD or VNPAY');
    }
    await this.payments.assertEnabled(store, paymentMethod);
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

    let total = new Prisma.Decimal(0);
    const orderItems = variants.map((variant) => {
      const quantity = quantities.get(variant.id) ?? 0;
      if (variant.stock < quantity) {
        throw new BadRequestException(`${variant.product.name} is out of stock`);
      }
      total = total.plus(variant.price.times(quantity));
      return {
        variantId: variant.id,
        productNameSnapshot: variant.product.name,
        variantLabelSnapshot: this.variantLabel(variant.optionValues),
        unitPrice: variant.price,
        quantity,
      };
    });

    // ponytail: stock is reserved at order time; unpaid VNPAY orders keep it until
    // the merchant cancels. Add an expiry job (BullMQ) if that becomes a problem.
    const order = await this.prisma.$transaction(async (tx) => {
      for (const item of orderItems) {
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { decrement: item.quantity } },
        });
      }

      // one Customer per store + email; guest name/email stay on the order as a snapshot
      const customer = await tx.customer.upsert({
        where: { storeId_email: { storeId, email: guestEmail } },
        update: {},
        create: { storeId, email: guestEmail, name: guestName },
      });

      return tx.order.create({
        data: {
          storeId,
          customerId: customer.id,
          guestEmail,
          guestName,
          total,
          items: { create: orderItems },
          payments: { create: { method: paymentMethod, amount: total } },
        },
        include: { items: true, payments: true },
      });
    });

    const paymentUrl =
      paymentMethod === PaymentMethod.VNPAY
        ? await this.payments.vnpayUrl(storeId, order.payments[0], input.returnUrl, ipAddr)
        : null;
    return { ...order, paymentUrl };
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

    return this.prisma.$transaction(async (tx) => {
      // COD is collected on delivery
      if (status === OrderStatus.DELIVERED) {
        await tx.payment.updateMany({
          where: { orderId, method: PaymentMethod.COD, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.SUCCEEDED, paidAt: new Date() },
        });
      }
      return tx.order.update({
        where: { id: orderId },
        data: { status },
        include: { items: true, payments: true },
      });
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
