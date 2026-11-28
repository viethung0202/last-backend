import { createHmac } from 'crypto';
import { buildPaymentUrl, buildRefundRequest, sign, toVnpAmount, verify, verifyRefundResponse, vnpayDate } from './vnpay';

const config = { tmnCode: 'TEST', hashSecret: 'SECRET', payUrl: 'https://pay.test/vpcpay.html' };

describe('vnpay', () => {
  it('builds a URL whose params verify with the same secret', () => {
    const url = buildPaymentUrl(config, {
      txnRef: 'pay1',
      amountVnd: '150000.5',
      orderInfo: 'Thanh toan don hang abc',
      returnUrl: 'http://shop.localhost:5173/',
      ipAddr: '127.0.0.1',
      now: new Date('2026-10-19T00:00:00Z'),
    });
    const params = Object.fromEntries(new URL(url).searchParams);
    expect(params.vnp_Amount).toBe('15000050');
    expect(params.vnp_CreateDate).toBe('20261019070000');
    expect(params.vnp_ReturnUrl).toBe('http://shop.localhost:5173/');
    expect(verify(params, 'SECRET')).toBe(true);
    expect(verify(params, 'OTHER')).toBe(false);
    expect(verify({ ...params, vnp_Amount: '1' }, 'SECRET')).toBe(false);
  });

  it('ignores non-vnp keys and the hash itself when signing', () => {
    const base = { vnp_B: 'x y', vnp_A: '1' };
    expect(sign({ ...base, other: 'z', vnp_SecureHash: 'h' }, 'S')).toBe(sign(base, 'S'));
  });

  it('converts amounts without float error', () => {
    expect(toVnpAmount('19.99')).toBe('1999');
    expect(toVnpAmount('150000')).toBe('15000000');
    expect(toVnpAmount('0.1')).toBe('10');
    expect(vnpayDate(new Date('2026-12-31T20:00:00Z'))).toBe('20270101030000');
  });
});

describe('vnpay refund', () => {
  const input = { requestId: 'p1', txnRef: 'p1', amountVnd: '100000.00', transactionNo: '14000001', transactionDate: '20261128101500', createBy: 'a@x.com', ipAddr: '127.0.0.1', now: new Date('2026-11-28T04:00:00Z') };

  it('signs the values in the fixed pipe order and converts the amount', () => {
    const req = buildRefundRequest(config, input);
    expect(req.vnp_Amount).toBe('10000000');
    expect(req.vnp_TransactionType).toBe('02');
    expect(req.vnp_CreateDate).toBe('20261128110000');
    const data = ['p1', '2.1.0', 'refund', 'TEST', '02', 'p1', '10000000', '14000001', '20261128101500', 'a@x.com', '20261128110000', '127.0.0.1', 'Hoan tien don hang p1'].join('|');
    expect(req.vnp_SecureHash).toBe(createHmac('sha512', 'SECRET').update(data).digest('hex'));
  });

  it('verifies a response signed with the same secret only', () => {
    const res: Record<string, string> = { vnp_ResponseId: 'r1', vnp_Command: 'refund', vnp_ResponseCode: '00', vnp_Message: 'Refund Success', vnp_TmnCode: 'TEST', vnp_TxnRef: 'p1', vnp_Amount: '10000000', vnp_PayDate: '20261128101500', vnp_TransactionNo: '14000001', vnp_TransactionType: '02', vnp_TransactionStatus: '05', vnp_OrderInfo: 'x' };
    const keys = ['vnp_ResponseId', 'vnp_Command', 'vnp_ResponseCode', 'vnp_Message', 'vnp_TmnCode', 'vnp_TxnRef', 'vnp_Amount', 'vnp_BankCode', 'vnp_PayDate', 'vnp_TransactionNo', 'vnp_TransactionType', 'vnp_TransactionStatus', 'vnp_OrderInfo'];
    res.vnp_SecureHash = createHmac('sha512', 'SECRET').update(keys.map((k) => res[k] ?? '').join('|')).digest('hex');
    expect(verifyRefundResponse(res, 'SECRET')).toBe(true);
    expect(verifyRefundResponse(res, 'OTHER')).toBe(false);
    expect(verifyRefundResponse({ ...res, vnp_ResponseCode: '99' }, 'SECRET')).toBe(false);
  });
});
