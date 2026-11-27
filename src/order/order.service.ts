import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Discount, OrderStatus, PaymentMethod, PaymentStatus, Prisma, ProductStatus } from '@prisma/client';
import { DiscountService } from '../discount/discount.service';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';

type CreateOrderInput = {
  guestEmail?: string;
  guestName?: string;
  paymentMethod?: PaymentMethod;
  discountCode?: string;
  // VNPAY only: storefront page VNPAY redirects back to
  returnUrl?: string;
  items?: Array<{
    variantId?: string;
    quantity?: number;
  }>;
};

export type DraftInput = {
  guestEmail?: string;
  guestName?: string;
  note?: string;
  discountCode?: string;
  items?: Array<{ variantId?: string; quantity?: number }>;
};

type Priced = {
  orderItems: Array<{
    variantId: string;
    productNameSnapshot: string;
    variantLabelSnapshot: string;
    unitPrice: Prisma.Decimal;
    quantity: number;
  }>;
  subtotal: Prisma.Decimal;
  discount: Discount | null;
  discountAmount: Prisma.Decimal;
  total: Prisma.Decimal;
};

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly discounts: DiscountService,
  ) {}

  findAllForStore(storeId: string) {
    return this.prisma.order.findMany({
      where: { storeId, status: { not: OrderStatus.DRAFT } },
      orderBy: { createdAt: 'desc' },
      include: { items: true, payments: true },
    });
  }

  // Public order tracking: guest proves ownership with the email used at checkout.
  async findForGuest(storeId: string, orderId: string, email: string | undefined) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, storeId, status: { not: OrderStatus.DRAFT }, guestEmail: email?.trim().toLowerCase() || '-' },
      include: { items: true, payments: { orderBy: { createdAt: 'asc' } } },
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

    const priced = await this.price(this.prisma, storeId, items, input.discountCode, true);

    // stock is reserved at order time; unpaid VNPAY orders are cancelled by OrderExpiryService
    const order = await this.prisma.$transaction(async (tx) => {
      await this.reserve(tx, priced);

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
          ...this.orderTotals(priced),
          items: { create: priced.orderItems },
          payments: { create: { method: paymentMethod, amount: priced.total } },
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

  // Cancelling gives back what the order reserved: stock and the discount use. The status guard
  // makes it apply once, so a merchant cancel and the expiry sweep can't both restock.
  private async cancelOrder(tx: Prisma.TransactionClient, order: { id: string; storeId: string; discountCode: string | null }) {
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DRAFT] } },
      data: { status: OrderStatus.CANCELLED },
    });
    if (!count) return false;
    const items = await tx.orderItem.findMany({ where: { orderId: order.id, variantId: { not: null } } });
    for (const item of items) {
      await tx.productVariant.update({ where: { id: item.variantId! }, data: { stock: { increment: item.quantity } } });
    }
    if (order.discountCode) {
      await tx.discount.updateMany({
        where: { storeId: order.storeId, code: order.discountCode, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
    }
    await tx.payment.updateMany({ where: { orderId: order.id, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.FAILED } });
    return true;
  }

  // Unpaid VNPAY orders: the payment link lives 15 minutes, so after `minutes` nobody can still pay.
  async expireUnpaid(minutes: number) {
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING,
        createdAt: { lt: new Date(Date.now() - minutes * 60_000) },
        payments: { some: { method: PaymentMethod.VNPAY }, none: { status: PaymentStatus.SUCCEEDED } },
      },
      select: { id: true, storeId: true, discountCode: true },
      take: 100,
    });
    let cancelled = 0;
    for (const order of orders) {
      if (await this.prisma.$transaction((tx) => this.cancelOrder(tx, order))) cancelled++;
    }
    return cancelled;
  }

  // Customer pays again after a failed/abandoned VNPAY attempt. Each attempt is its own Payment
  // (its id is the VNPAY txnRef), and whichever one the IPN confirms marks the order PAID.
  async retryPayment(store: { id: string; currency: string }, orderId: string, input: { email?: string; returnUrl?: string }, ipAddr: string) {
    await this.payments.assertEnabled(store, PaymentMethod.VNPAY);
    const order = await this.findForGuest(store.id, orderId, input.email);
    if (order.status !== OrderStatus.PENDING || !order.payments.some((p) => p.method === PaymentMethod.VNPAY)) {
      throw new BadRequestException('This order cannot be paid online');
    }
    if (order.payments.some((p) => p.status === PaymentStatus.SUCCEEDED)) {
      throw new BadRequestException('Order is already paid');
    }
    const payment = await this.prisma.payment.create({ data: { orderId, method: PaymentMethod.VNPAY, amount: order.total } });
    return { paymentUrl: await this.payments.vnpayUrl(store.id, payment, input.returnUrl, ipAddr) };
  }

  async updateStatus(storeId: string, orderId: string, status: OrderStatus) {
    if (!Object.values(OrderStatus).includes(status) || status === OrderStatus.DRAFT) {
      throw new BadRequestException('Invalid order status');
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, storeId, status: { not: OrderStatus.DRAFT } },
      select: { id: true, storeId: true, status: true, discountCode: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('A cancelled order cannot be changed');
    }

    return this.prisma.$transaction(async (tx) => {
      if (status === OrderStatus.CANCELLED) {
        await this.cancelOrder(tx, order);
        return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, payments: true } });
      }
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

  // ---- draft orders (merchant-created, no stock reserved until completed) ----

  findDrafts(storeId: string) {
    return this.prisma.order.findMany({
      where: { storeId, status: OrderStatus.DRAFT },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
  }

  async findDraft(storeId: string, id: string) {
    const draft = await this.prisma.order.findFirst({
      where: { id, storeId, status: OrderStatus.DRAFT },
      include: { items: true },
    });
    if (!draft) {
      throw new NotFoundException('Draft order not found');
    }
    return draft;
  }

  async createDraft(storeId: string, input: DraftInput) {
    const priced = await this.price(this.prisma, storeId, input.items ?? [], input.discountCode, false);
    return this.prisma.order.create({
      data: { storeId, status: OrderStatus.DRAFT, ...this.draftFields(input), ...this.orderTotals(priced), items: { create: priced.orderItems } },
      include: { items: true },
    });
  }

  async updateDraft(storeId: string, id: string, input: DraftInput) {
    await this.findDraft(storeId, id);
    const priced = await this.price(this.prisma, storeId, input.items ?? [], input.discountCode, false);
    return this.prisma.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      return tx.order.update({
        where: { id },
        data: { ...this.draftFields(input), ...this.orderTotals(priced), items: { create: priced.orderItems } },
        include: { items: true },
      });
    });
  }

  async deleteDraft(storeId: string, id: string) {
    await this.findDraft(storeId, id);
    await this.prisma.$transaction([
      this.prisma.orderItem.deleteMany({ where: { orderId: id } }),
      this.prisma.order.delete({ where: { id } }),
    ]);
    return { deleted: true };
  }

  // Turns a draft into a real order: re-prices at today's prices, reserves stock,
  // creates the customer. ponytail: manual payment only (cash/bank transfer, COD record);
  // a VNPAY payment link for drafts can reuse PaymentService.vnpayUrl later.
  async completeDraft(storeId: string, id: string, markPaid: boolean) {
    const draft = await this.findDraft(storeId, id);
    const guestEmail = this.requiredEmail(draft.guestEmail ?? undefined);
    const guestName = this.requiredText(draft.guestName ?? undefined, 'guestName');
    const priced = await this.price(
      this.prisma,
      storeId,
      draft.items.flatMap((i) => (i.variantId ? [{ variantId: i.variantId, quantity: i.quantity }] : [])),
      draft.discountCode ?? undefined,
      false,
    );
    if (priced.orderItems.length !== draft.items.length) {
      throw new BadRequestException('A product in this draft no longer exists');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.reserve(tx, priced);
      const customer = await tx.customer.upsert({
        where: { storeId_email: { storeId, email: guestEmail } },
        update: {},
        create: { storeId, email: guestEmail, name: guestName },
      });
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      return tx.order.update({
        where: { id },
        data: {
          customerId: customer.id,
          status: markPaid ? OrderStatus.PAID : OrderStatus.PENDING,
          ...this.orderTotals(priced),
          items: { create: priced.orderItems },
          payments: {
            create: {
              method: PaymentMethod.COD,
              amount: priced.total,
              ...(markPaid ? { status: PaymentStatus.SUCCEEDED, paidAt: new Date() } : {}),
            },
          },
        },
        include: { items: true, payments: true },
      });
    });
  }

  // ---- pricing -------------------------------------------------------------

  private draftFields(input: DraftInput) {
    return {
      guestEmail: input.guestEmail?.trim().toLowerCase() || null,
      guestName: input.guestName?.trim() || null,
      note: input.note?.trim() || null,
    };
  }

  private orderTotals(p: Priced) {
    return {
      subtotal: p.subtotal,
      discountCode: p.discount?.code ?? null,
      discountAmount: p.discountAmount,
      total: p.total,
    };
  }

  // Prices cart lines from the DB (never trusts the client) and applies the discount code.
  private async price(
    db: PrismaService,
    storeId: string,
    items: Array<{ variantId?: string; quantity?: number }>,
    discountCode: string | undefined,
    activeOnly: boolean,
  ): Promise<Priced> {
    if (items.length === 0) {
      throw new BadRequestException('items are required');
    }
    const quantities = new Map<string, number>();
    for (const item of items) {
      const variantId = this.requiredText(item.variantId, 'variantId');
      const quantity = this.requiredCount(item.quantity, 'quantity');
      quantities.set(variantId, (quantities.get(variantId) ?? 0) + quantity);
    }

    const variants = await db.productVariant.findMany({
      where: {
        id: { in: [...quantities.keys()] },
        product: { storeId, ...(activeOnly ? { status: ProductStatus.ACTIVE } : {}) },
      },
      include: { product: true },
    });
    if (variants.length !== quantities.size) {
      throw new BadRequestException('Some variants are not available');
    }

    let subtotal = new Prisma.Decimal(0);
    const orderItems = variants.map((variant) => {
      const quantity = quantities.get(variant.id) ?? 0;
      if (variant.stock < quantity) {
        throw new BadRequestException(`${variant.product.name} is out of stock`);
      }
      subtotal = subtotal.plus(variant.price.times(quantity));
      return {
        variantId: variant.id,
        productNameSnapshot: variant.product.name,
        variantLabelSnapshot: this.variantLabel(variant.optionValues),
        unitPrice: variant.price,
        quantity,
      };
    });

    let discount: Discount | null = null;
    let discountAmount = new Prisma.Decimal(0);
    if (discountCode?.trim()) {
      ({ discount, amount: discountAmount } = await this.discounts.quote(db, storeId, discountCode, subtotal));
    }
    return { orderItems, subtotal, discount, discountAmount, total: subtotal.minus(discountAmount) };
  }

  // Stock decrement only matches while enough is left, so two checkouts can't oversell.
  private async reserve(tx: Prisma.TransactionClient, priced: Priced) {
    for (const item of priced.orderItems) {
      const { count } = await tx.productVariant.updateMany({
        where: { id: item.variantId, stock: { gte: item.quantity } },
        data: { stock: { decrement: item.quantity } },
      });
      if (count === 0) {
        throw new BadRequestException(`${item.productNameSnapshot} is out of stock`);
      }
    }
    if (priced.discount) {
      await this.discounts.consume(tx, priced.discount);
    }
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
