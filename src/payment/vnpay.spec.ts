import { buildPaymentUrl, sign, toVnpAmount, verify, vnpayDate } from './vnpay';

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
