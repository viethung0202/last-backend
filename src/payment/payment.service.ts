import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPaymentUrl, buildRefundRequest, refundApiUrl, toVnpAmount, verify, verifyRefundResponse, vnpayConfig, vnpayDate } from './vnpay';
import type { VnpayConfig } from './vnpay';

type IpnResult = { RspCode: string; Message: string };

@Injectable()
export class PaymentService {
  constructor(private readonly prisma: PrismaService) {}

  async getMethods(store: { id: string; currency: string }) {
    const rows = await this.prisma.storePaymentMethod.findMany({ where: { storeId: store.id } });
    const enabled = (method: PaymentMethod) => rows.some((row) => row.method === method && row.enabled);
    const vnpayUsable = await this.vnpayUsable(store);
    return {
      COD: enabled(PaymentMethod.COD),
      // a stale VNPAY row is ignored if the platform lost its config or the store isn't VND
      VNPAY: enabled(PaymentMethod.VNPAY) && vnpayUsable,
      vnpayAvailable: vnpayUsable,
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
      if (method === PaymentMethod.VNPAY && enabled && !(await this.vnpayUsable(store))) {
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
    const config = await this.config();
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
    const config = await this.config();
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
          payDate: query.vnp_PayDate ?? null,
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

  // Asks VNPAY to send the money back (full amount). Resolves only when VNPAY confirms; any other
  // outcome throws, so the caller never marks something refunded that VNPAY did not refund.
  async refundVnpay(
    payment: { id: string; amount: Prisma.Decimal; providerPaymentId: string | null; payDate: string | null; paidAt: Date | null },
    createBy: string,
    ipAddr: string,
  ) {
    const config = await this.config();
    if (!config) {
      throw new BadRequestException('VNPAY is not configured');
    }
    const request = buildRefundRequest(config, {
      requestId: payment.id,
      txnRef: payment.id,
      amountVnd: payment.amount.toFixed(2),
      transactionNo: payment.providerPaymentId ?? '',
      transactionDate: payment.payDate ?? vnpayDate(payment.paidAt ?? new Date()),
      createBy,
      ipAddr,
    });
    let response: Response;
    try {
      response = await fetch(refundApiUrl(config), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new BadGatewayException('Could not reach VNPAY to refund. Nothing was changed, try again.');
    }
    const res = (await response.json().catch(() => null)) as Record<string, string> | null;
    if (!res) {
      throw new BadGatewayException(`VNPAY refund API answered with an unexpected response (HTTP ${response.status}). Nothing was changed.`);
    }
    if (!verifyRefundResponse(res, config.hashSecret)) {
      throw new BadGatewayException('VNPAY refund response failed signature check. Nothing was changed.');
    }
    // 00 = refunded; anything else (e.g. 94 duplicate, 95 not refundable) is reported as-is
    if (res.vnp_ResponseCode !== '00') {
      throw new BadGatewayException(`VNPAY refused the refund (${res.vnp_ResponseCode}: ${res.vnp_Message ?? 'no message'})`);
    }
  }

  private async vnpayUsable(store: { currency: string }) {
    return store.currency === 'VND' && Boolean(await this.config());
  }

  async config() {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: 'vnpay' } });
    return vnpayConfig(row?.value as Partial<VnpayConfig> | null);
  }
}
