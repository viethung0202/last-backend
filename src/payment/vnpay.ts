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
      'https://sandbox.vnpaytest.vn/paymentv2/vpcpay.html',
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

// ---- refund (merchant_webapi). Unlike the pay URL, this API signs the field VALUES joined by "|" in a fixed order.
const REFUND_REQUEST_KEYS = ['vnp_RequestId', 'vnp_Version', 'vnp_Command', 'vnp_TmnCode', 'vnp_TransactionType', 'vnp_TxnRef', 'vnp_Amount', 'vnp_TransactionNo', 'vnp_TransactionDate', 'vnp_CreateBy', 'vnp_CreateDate', 'vnp_IpAddr', 'vnp_OrderInfo'];
const REFUND_RESPONSE_KEYS = ['vnp_ResponseId', 'vnp_Command', 'vnp_ResponseCode', 'vnp_Message', 'vnp_TmnCode', 'vnp_TxnRef', 'vnp_Amount', 'vnp_BankCode', 'vnp_PayDate', 'vnp_TransactionNo', 'vnp_TransactionType', 'vnp_TransactionStatus', 'vnp_OrderInfo'];

function pipeSign(params: Record<string, string>, keys: string[], secret: string) {
  return createHmac('sha512', secret).update(keys.map((key) => params[key] ?? '').join('|'), 'utf8').digest('hex');
}

export function refundApiUrl(config: VnpayConfig) {
  return process.env.VNPAY_API_URL || `${new URL(config.payUrl).origin}/merchant_webapi/api/transaction`;
}

// Full refund ('02') of one paid transaction. requestId must be unique per request (we use the payment id,
// so a double click is the same request). transactionDate = the vnp_PayDate VNPAY sent with the payment.
export function buildRefundRequest(
  config: VnpayConfig,
  input: { requestId: string; txnRef: string; amountVnd: string; transactionNo: string; transactionDate: string; createBy: string; ipAddr: string; now?: Date },
): Record<string, string> {
  const params: Record<string, string> = {
    vnp_RequestId: input.requestId,
    vnp_Version: '2.1.0',
    vnp_Command: 'refund',
    vnp_TmnCode: config.tmnCode,
    vnp_TransactionType: '02',
    vnp_TxnRef: input.txnRef,
    vnp_Amount: toVnpAmount(input.amountVnd),
    vnp_OrderInfo: `Hoan tien don hang ${input.txnRef}`,
    vnp_TransactionNo: input.transactionNo,
    vnp_TransactionDate: input.transactionDate,
    vnp_CreateBy: input.createBy,
    vnp_CreateDate: vnpayDate(input.now ?? new Date()),
    vnp_IpAddr: input.ipAddr,
  };
  return { ...params, vnp_SecureHash: pipeSign(params, REFUND_REQUEST_KEYS, config.hashSecret) };
}

export function verifyRefundResponse(res: Record<string, string>, secret: string) {
  const given = Buffer.from(res.vnp_SecureHash ?? '', 'utf8');
  const expected = Buffer.from(pipeSign(res, REFUND_RESPONSE_KEYS, secret), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
