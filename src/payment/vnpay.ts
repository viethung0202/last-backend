import { createHmac, timingSafeEqual } from 'crypto';

// VNPAY Payment API v2.1.0. Signing mirrors VNPAY's official Node demo:
// sort vnp_* keys, encodeURIComponent each key/value with %20 -> '+', join with &,
// HMAC-SHA512 with the hash secret, hex.

export type VnpayConfig = {
  tmnCode: string;
  hashSecret: string;
  payUrl: string;
};

// Platform admin config (PlatformSetting "vnpay") wins; env vars are the fallback.
export function vnpayConfig(stored?: Partial<VnpayConfig> | null): VnpayConfig | null {
  const tmnCode = stored?.tmnCode || process.env.VNPAY_TMN_CODE;
  const hashSecret = stored?.tmnCode ? stored.hashSecret : process.env.VNPAY_HASH_SECRET;
  if (!tmnCode || !hashSecret) {
    return null;
  }
  return {
    tmnCode,
    hashSecret,
    payUrl:
      (stored?.tmnCode ? stored.payUrl : process.env.VNPAY_URL) ||
      'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  };
}

function encode(value: string) {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

export function signData(params: Record<string, string>) {
  return Object.keys(params)
    .filter((key) => key.startsWith('vnp_') && key !== 'vnp_SecureHash' && key !== 'vnp_SecureHashType')
    .sort()
    .map((key) => `${encode(key)}=${encode(params[key])}`)
    .join('&');
}

export function sign(params: Record<string, string>, secret: string) {
  return createHmac('sha512', secret).update(signData(params), 'utf8').digest('hex');
}

export function verify(params: Record<string, string>, secret: string) {
  const given = Buffer.from(params.vnp_SecureHash ?? '', 'utf8');
  const expected = Buffer.from(sign(params, secret), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// yyyyMMddHHmmss in GMT+7, which VNPAY requires regardless of server timezone.
export function vnpayDate(date: Date) {
  return new Date(date.getTime() + 7 * 3600_000)
    .toISOString()
    .replace(/\D/g, '')
    .slice(0, 14);
}

export function buildPaymentUrl(
  config: VnpayConfig,
  input: { txnRef: string; amountVnd: string; orderInfo: string; returnUrl: string; ipAddr: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const params: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: config.tmnCode,
    // VNPAY amount = VND * 100, integer
    vnp_Amount: toVnpAmount(input.amountVnd),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: input.txnRef,
    vnp_OrderInfo: input.orderInfo,
    vnp_OrderType: 'other',
    vnp_Locale: 'vn',
    vnp_ReturnUrl: input.returnUrl,
    vnp_IpAddr: input.ipAddr,
    vnp_CreateDate: vnpayDate(now),
    vnp_ExpireDate: vnpayDate(new Date(now.getTime() + 15 * 60_000)),
  };
  const query = signData(params);
  return `${config.payUrl}?${query}&vnp_SecureHash=${sign(params, config.hashSecret)}`;
}

// "150000.5" -> "15000050" without float math.
export function toVnpAmount(amount: string) {
  const [whole, fraction = ''] = amount.split('.');
  return String(BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)));
}
