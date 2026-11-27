#!/usr/bin/env bash
# HTTP smoke test: VNPAY retry, cancel/expiry giving stock + discount back.
# Server must run with VNPAY_HASH_SECRET=<same as below>, ORDER_EXPIRE_MINUTES=0.05, ORDER_SWEEP_SECONDS=1.
# Usage: API=http://localhost:3999 VNPAY_HASH_SECRET=SECRET bash test/smoke-payments.sh   (needs jq, run from backend/)
set -euo pipefail
API=${API:-http://localhost:3000}
SECRET=${VNPAY_HASH_SECRET:?set VNPAY_HASH_SECRET to the secret the API uses}
RUN=$RANDOM$RANDOM
fail() { echo "FAIL: $*"; exit 1; }
F=/tmp/smoke-payments.$RUN
req() { curl -s -o $F -w '%{http_code}' "$@"; }
body() { cat $F; }
json=(-H 'content-type: application/json')
TOKEN=$(curl -sf "$API/auth/register" "${json[@]}" -d "{\"email\":\"pay-$RUN@x.com\",\"password\":\"password123\",\"name\":\"P\"}" | jq -r .token)
D=(-H "authorization: Bearer $TOKEN" "${json[@]}")
slug="pay$RUN"; S="$API/stores/$slug"
req "$API/stores" "${D[@]}" -d "{\"name\":\"Pay\",\"slug\":\"$slug\"}" >/dev/null
req -X PUT "$S/payment-methods" "${D[@]}" -d '{"VNPAY":true}' >/dev/null
req "$S/products" "${D[@]}" -d '{"name":"Ao","price":100000,"stock":5,"status":"ACTIVE"}' >/dev/null
PID=$(body | jq -r .id); VAR=$(body | jq -r '.variants[0].id')
req "$S/discounts" "${D[@]}" -d '{"code":"SALE10","type":"PERCENTAGE","value":10,"usageLimit":1}' >/dev/null
stock() { req "$S/products/$PID" >/dev/null; body | jq -r '.variants[0].stock'; }
used() { req "$S/discounts" "${D[@]}" >/dev/null; body | jq -r '.[0].usedCount'; }
order() { # qty [discount]
  req "$S/orders" "${json[@]}" -d "{\"guestEmail\":\"g@x.com\",\"guestName\":\"G\",\"paymentMethod\":\"VNPAY\",\"returnUrl\":\"http://localhost:5175/\",\"discountCode\":\"${2:-}\",\"items\":[{\"variantId\":\"$VAR\",\"quantity\":$1}]}"; }
ipn() { # txnRef amount code
  local q; q=$(node -e "const v=require('./dist/payment/vnpay');const p={vnp_TxnRef:'$1',vnp_Amount:'$2',vnp_ResponseCode:'$3',vnp_TransactionStatus:'$3',vnp_TransactionNo:'14000001',vnp_TmnCode:'TEST'};console.log(v.signData(p)+'&vnp_SecureHash='+v.sign(p,'$SECRET'))")
  curl -s "$API/payments/vnpay/ipn?$q" | jq -r .RspCode; }
ref() { sed -E 's/.*vnp_TxnRef=([^&]+).*/\1/' <<<"$1"; }
amt() { sed -E 's/.*vnp_Amount=([^&]+).*/\1/' <<<"$1"; }
status() { req "$S/orders/$1?email=g@x.com" >/dev/null; body | jq -r '.status'; }

# --- failed attempt, then retry succeeds
[ "$(order 1)" = 201 ] || fail "order $(body)"
O1=$(body | jq -r .id); URL=$(body | jq -r .paymentUrl)
[ "$(ipn "$(ref "$URL")" "$(amt "$URL")" 24)" = 00 ] || fail "failed IPN"   # 24 = customer cancelled
[ "$(status "$O1")" = PENDING ] || fail "order not pending after failed payment"
[ "$(req "$S/orders/$O1/pay" "${json[@]}" -d '{"email":"bad@x.com","returnUrl":"http://localhost:5175/"}')" = 404 ] || fail "retry with wrong email"
[ "$(req "$S/orders/$O1/pay" "${json[@]}" -d '{"email":"g@x.com","returnUrl":"https://evil.example/"}')" = 400 ] || fail "retry foreign returnUrl"
[ "$(req "$S/orders/$O1/pay" "${json[@]}" -d '{"email":"g@x.com","returnUrl":"http://localhost:5175/"}')" = 201 ] || fail "retry $(body)"
URL2=$(body | jq -r .paymentUrl)
[ "$(ref "$URL2")" != "$(ref "$URL")" ] && [ "$(amt "$URL2")" = 10000000 ] || fail "retry should be a new payment with the same amount"
[ "$(ipn "$(ref "$URL2")" "$(amt "$URL2")" 00)" = 00 ] || fail "retry IPN"
[ "$(status "$O1")" = PAID ] || fail "not PAID after retry"
[ "$(req "$S/orders/$O1/pay" "${json[@]}" -d '{"email":"g@x.com","returnUrl":"http://localhost:5175/"}')" = 400 ] || fail "paying a paid order"
[ "$(stock)" = 4 ] || fail "stock $(stock)"

# --- merchant cancel gives stock + discount back, once
[ "$(order 2 SALE10)" = 201 ] || fail "discount order $(body)"
O2=$(body | jq -r .id)
[ "$(stock)" = 2 ] && [ "$(used)" = 1 ] || fail "reserve: stock $(stock) used $(used)"
[ "$(req -X PATCH "$S/orders/$O2/status" "${D[@]}" -d '{"status":"CANCELLED"}')" = 200 ] || fail "cancel $(body)"
[ "$(stock)" = 4 ] && [ "$(used)" = 0 ] || fail "restore: stock $(stock) used $(used)"
[ "$(req -X PATCH "$S/orders/$O2/status" "${D[@]}" -d '{"status":"PAID"}')" = 400 ] || fail "reopened cancelled order"
[ "$(stock)" = 4 ] || fail "double restock"

# --- unpaid VNPAY order expires on its own (server sweeps every second, expiry ~3s)
[ "$(order 3 SALE10)" = 201 ] || fail "expiry order $(body)"
O3=$(body | jq -r .id)
[ "$(stock)" = 1 ] || fail "reserve 3"
for _ in $(seq 1 15); do [ "$(status "$O3")" = CANCELLED ] && break; sleep 1; done
[ "$(status "$O3")" = CANCELLED ] || fail "unpaid order was not expired"
[ "$(stock)" = 4 ] && [ "$(used)" = 0 ] || fail "expiry restore: stock $(stock) used $(used)"
[ "$(req "$S/orders/$O3/pay" "${json[@]}" -d '{"email":"g@x.com","returnUrl":"http://localhost:5175/"}')" = 400 ] || fail "paying an expired order"
[ "$(status "$O1")" = PAID ] || fail "paid order touched by sweep"

rm -f $F
echo "OK smoke-payments"
