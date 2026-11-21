import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPaymentUrl, toVnpAmount, verify, vnpayConfig } from './vnpay';

type IpnResult = { RspCode: string; Message: string };

@Injectable()
export class PaymentService {
  constructor(private readonly prisma: PrismaService) {}

  async getMethods(store: { id: string; currency: string }) {
    const rows = await this.prisma.storePaymentMethod.findMany({ where: { storeId: store.id } });
    const enabled = (method: PaymentMethod) => rows.some((row) => row.method === method && row.enabled);
    return {
      COD: enabled(PaymentMethod.COD),
      // a stale VNPAY row is ignored if the platform lost its config or the store isn't VND
      VNPAY: enabled(PaymentMethod.VNPAY) && this.vnpayUsable(store),
      vnpayAvailable: this.vnpayUsable(store),
    };
  }

  async setMethods(store: { id: string; currency: string }, input: Partial<Record<PaymentMethod, boolean>>) {
    for (const method of Object.values(PaymentMethod)) {
      const enabled = input[method];
      if (enabled === undefined) {
        continue;
      }
      if (typeof enabled !== 'boolean') {
        throw new BadRequestException(`${method} must be true or false`);
      }
      if (method === PaymentMethod.VNPAY && enabled && !this.vnpayUsable(store)) {
        throw new BadRequestException('VNPAY needs platform config and a VND store');
      }
      await this.prisma.storePaymentMethod.upsert({
        where: { storeId_method: { storeId: store.id, method } },
        update: { enabled },
        create: { storeId: store.id, method, enabled },
      });
    }
    return this.getMethods(store);
  }

  async assertEnabled(store: { id: string; currency: string }, method: PaymentMethod) {
    const methods = await this.getMethods(store);
    if (!methods[method]) {
      throw new BadRequestException(`${method} is not enabled for this store`);
    }
  }

  // returnUrl comes from the browser; only allow the store's own hosts so this
  // can't be used as an open redirect. localhost is allowed outside production.
  async vnpayUrl(
    storeId: string,
    payment: { id: string; amount: Prisma.Decimal; orderId: string },
    returnUrl: string | undefined,
    ipAddr: string,
  ) {
    const config = vnpayConfig();
    if (!config) {
      throw new BadRequestException('VNPAY is not configured');
    }
    let url: URL;
    try {
      url = new URL(returnUrl ?? '');
    } catch {
      throw new BadRequestException('returnUrl is required for VNPAY');
    }
    const domain = await this.prisma.storeDomain.findFirst({
      where: { storeId, hostname: url.hostname },
      select: { id: true },
    });
    const devHost = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (!domain && !devHost) {
      throw new BadRequestException('returnUrl must be on the store domain');
    }
    return buildPaymentUrl(config, {
      txnRef: payment.id,
      amountVnd: payment.amount.toFixed(2),
      orderInfo: `Thanh toan don hang ${payment.orderId}`,
      returnUrl: url.toString(),
      ipAddr,
    });
  }

  // VNPAY server-to-server callback. Response codes per VNPAY spec:
  // 00 ok, 01 order not found, 02 already confirmed, 04 invalid amount, 97 bad checksum, 99 other.
  async handleVnpayIpn(query: Record<string, string>): Promise<IpnResult> {
    const result = await this.processIpn(query).catch(
      (): IpnResult & { paymentId?: string } => ({ RspCode: '99', Message: 'Unknown error' }),
    );
    await this.prisma.paymentWebhookEvent.create({
      data: {
        provider: 'vnpay',
        paymentId: result.paymentId,
        payload: query,
        result: result.RspCode,
      },
    });
    return { RspCode: result.RspCode, Message: result.Message };
  }

  private async processIpn(query: Record<string, string>): Promise<IpnResult & { paymentId?: string }> {
    const config = vnpayConfig();
    if (!config || !verify(query, config.hashSecret)) {
      return { RspCode: '97', Message: 'Invalid signature' };
    }
    const payment = await this.prisma.payment.findFirst({
      where: { id: query.vnp_TxnRef, method: PaymentMethod.VNPAY },
    });
    if (!payment) {
      return { RspCode: '01', Message: 'Order not found' };
    }
    const base = { paymentId: payment.id };
    if (toVnpAmount(payment.amount.toFixed(2)) !== query.vnp_Amount) {
      return { ...base, RspCode: '04', Message: 'Invalid amount' };
    }
    if (payment.status !== PaymentStatus.PENDING) {
      return { ...base, RspCode: '02', Message: 'Order already confirmed' };
    }

    const success = query.vnp_ResponseCode === '00' && query.vnp_TransactionStatus === '00';
    const applied = await this.prisma.$transaction(async (tx) => {
      // status guard makes concurrent duplicate IPNs apply once
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: success ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED,
          providerPaymentId: query.vnp_TransactionNo ?? null,
          paidAt: success ? new Date() : null,
        },
      });
      if (count && success) {
        await tx.order.updateMany({
          where: { id: payment.orderId, status: OrderStatus.PENDING },
          data: { status: OrderStatus.PAID },
        });
      }
      return count > 0;
    });
    return applied
      ? { ...base, RspCode: '00', Message: 'Confirm Success' }
      : { ...base, RspCode: '02', Message: 'Order already confirmed' };
  }

  private vnpayUsable(store: { currency: string }) {
    return Boolean(vnpayConfig()) && store.currency === 'VND';
  }
}
