// Stand-in for VNPAY's refund API, for smoke-payments.sh. Usage: node test/mock-vnpay-refund.js <port> <secret>
// Refuses (95) while /tmp/mock-vnpay-fail exists; answers 99 if the request is malformed or its hash is wrong.
const http = require('http');
const fs = require('fs');
const { createHmac } = require('crypto');
const [port, secret] = [process.argv[2], process.argv[3]];
const REQ = ['vnp_RequestId', 'vnp_Version', 'vnp_Command', 'vnp_TmnCode', 'vnp_TransactionType', 'vnp_TxnRef', 'vnp_Amount', 'vnp_TransactionNo', 'vnp_TransactionDate', 'vnp_CreateBy', 'vnp_CreateDate', 'vnp_IpAddr', 'vnp_OrderInfo'];
const RES = ['vnp_ResponseId', 'vnp_Command', 'vnp_ResponseCode', 'vnp_Message', 'vnp_TmnCode', 'vnp_TxnRef', 'vnp_Amount', 'vnp_BankCode', 'vnp_PayDate', 'vnp_TransactionNo', 'vnp_TransactionType', 'vnp_TransactionStatus', 'vnp_OrderInfo'];
const hash = (o, keys) => createHmac('sha512', secret).update(keys.map((k) => o[k] ?? '').join('|')).digest('hex');
http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const r = JSON.parse(raw || '{}');
    const ok = hash(r, REQ) === r.vnp_SecureHash && r.vnp_TransactionNo === '14000001' && r.vnp_TransactionDate === '20261128101500' && r.vnp_TransactionType === '02';
    const code = !ok ? '99' : fs.existsSync('/tmp/mock-vnpay-fail') ? '95' : '00';
    const out = { vnp_ResponseId: 'mock', vnp_Command: 'refund', vnp_ResponseCode: code, vnp_Message: code === '00' ? 'Refund Success' : 'Refused', vnp_TmnCode: r.vnp_TmnCode, vnp_TxnRef: r.vnp_TxnRef, vnp_Amount: r.vnp_Amount, vnp_PayDate: r.vnp_TransactionDate, vnp_TransactionNo: r.vnp_TransactionNo, vnp_TransactionType: '02', vnp_TransactionStatus: '05', vnp_OrderInfo: r.vnp_OrderInfo };
    out.vnp_SecureHash = hash(out, RES);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
}).listen(port);
