#!/usr/bin/env bash
# HTTP smoke test for tenancy, money and payments. Needs a running API, jq, and
# `npm run build` (signs fake IPNs with dist/payment/vnpay.js). Run from backend/.
# Usage: API=http://localhost:3000 bash test/smoke.sh
# VNPAY part runs when VNPAY_HASH_SECRET is set to the same value the API uses.
set -euo pipefail
API=${API:-http://localhost:3000}
RUN=$RANDOM$RANDOM
fail() { echo "FAIL: $*"; exit 1; }
req() { curl -s -o /tmp/smoke.$RUN -w '%{http_code}' "$@"; }
body() { cat /tmp/smoke.$RUN; }

reg() { curl -sf "$API/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$1-$RUN@x.com\",\"password\":\"password123\",\"name\":\"$1\"}" | jq -r .token; }
OWNER=$(reg owner); OTHER=$(reg other)

slug="shop$RUN"
[ "$(req "$API/stores" -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d "{\"name\":\"Shop\",\"slug\":\"$slug\",\"currency\":\"usd\"}")" = 201 ] || fail "create store: $(body)"
[ "$(body | jq -r .currency)" = USD ] || fail "currency"
host=$(body | jq -r '.domains[0].hostname')
[[ "$host" == "$slug."* ]] || fail "primary domain: $host"

[ "$(req "$API/stores" -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d '{"name":"x","slug":"admin"}')" = 400 ] || fail "reserved slug"
[ "$(req "$API/stores" -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d "{\"name\":\"x\",\"slug\":\"$slug\"}")" = 409 ] || fail "duplicate slug"

[ "$(req "$API/stores/by-host/$host")" = 200 ] && [ "$(body | jq -r .slug)" = "$slug" ] || fail "by-host"
[ "$(req "$API/stores/by-host/nope.example.com")" = 404 ] || fail "by-host 404"

P="$API/stores/$slug/products"
[ "$(req "$P" -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d '{"name":"Tee","price":"19.99","stock":5,"status":"ACTIVE"}')" = 201 ] || fail "create product: $(body)"
variant=$(body | jq -r '.variants[0].id')
[ "$(body | jq -r '.variants[0].price')" = 19.99 ] || fail "price roundtrip"
[ "$(req "$P" -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d '{"name":"Bad","price":"1.999"}')" = 400 ] || fail "3-decimal price accepted"
[ "$(req "$P" -H "authorization: Bearer $OTHER" -H 'content-type: application/json' \
  -d '{"name":"Hack","price":1}')" = 403 ] || fail "non-member allowed"
[ "$(req "$P" -H 'content-type: application/json' -d '{"name":"Anon","price":1}')" = 401 ] || fail "anon allowed"

[ "$(req "$API/stores/$slug/orders" -H 'content-type: application/json' \
  -d "{\"guestEmail\":\"g@x.com\",\"guestName\":\"G\",\"items\":[{\"variantId\":\"$variant\",\"quantity\":3}]}")" = 201 ] || fail "order: $(body)"
[ "$(body | jq -r .total)" = 59.97 ] || fail "total $(body | jq -r .total) != 59.97"
[ "$(body | jq -r '.items[0].unitPrice')" = 19.99 ] || fail "unitPrice snapshot"
[ "$(req "$API/stores/$slug/orders" -H "authorization: Bearer $OTHER")" = 403 ] || fail "other list orders"
[ "$(req "$API/stores/$slug/orders" -H "authorization: Bearer $OWNER")" = 200 ] || fail "owner list orders"

oid=$(body | jq -r '.[0].id')
[ "$(body | jq -r '.[0].payments[0].method + "/" + .[0].payments[0].status')" = COD/PENDING ] || fail "COD payment created"
[ "$(req -X PATCH "$API/stores/$slug/orders/$oid/status" -H "authorization: Bearer $OWNER" \
  -H 'content-type: application/json' -d '{"status":"DELIVERED"}')" = 200 ] || fail "deliver"
[ "$(body | jq -r '.payments[0].status')" = SUCCEEDED ] || fail "COD collected on delivery"
[ "$(req "$API/stores/$slug/orders/$oid?email=g@x.com")" = 200 ] || fail "guest tracking"
[ "$(req "$API/stores/$slug/orders/$oid?email=bad@x.com")" = 404 ] || fail "tracking wrong email"

[ "$(req "$API/stores/$slug/payment-methods")" = 200 ] && [ "$(body | jq -c '[.COD,.VNPAY]')" = '[true,false]' ] || fail "default methods $(body)"
[ "$(req -X PUT "$API/stores/$slug/payment-methods" -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d '{"VNPAY":true}')" = 400 ] || fail "VNPAY on USD store allowed"
[ "$(req "$API/stores/$slug/orders" -H 'content-type: application/json' \
  -d "{\"guestEmail\":\"g@x.com\",\"guestName\":\"G\",\"paymentMethod\":\"VNPAY\",\"items\":[{\"variantId\":\"$variant\",\"quantity\":1}]}")" = 400 ] || fail "disabled method accepted"

if [ -n "${VNPAY_HASH_SECRET:-}" ]; then
  vslug="vnd$RUN"
  req "$API/stores" -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
    -d "{\"name\":\"VN\",\"slug\":\"$vslug\"}" >/dev/null
  vhost=$(body | jq -r '.domains[0].hostname')
  [ "$(req -X PUT "$API/stores/$vslug/payment-methods" -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
    -d '{"VNPAY":true}')" = 200 ] && [ "$(body | jq -r .VNPAY)" = true ] || fail "enable VNPAY $(body)"
  req "$API/stores/$vslug/products" -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
    -d '{"name":"Ao","price":150000,"stock":9,"status":"ACTIVE"}' >/dev/null
  vvariant=$(body | jq -r '.variants[0].id')
  order() { req "$API/stores/$vslug/orders" -H 'content-type: application/json' \
    -d "{\"guestEmail\":\"g@x.com\",\"guestName\":\"G\",\"paymentMethod\":\"VNPAY\",\"returnUrl\":\"$1\",\"items\":[{\"variantId\":\"$vvariant\",\"quantity\":2}]}"; }
  [ "$(order "https://evil.example/")" = 400 ] || fail "foreign returnUrl accepted"
  [ "$(order "http://$vhost:5173/")" = 201 ] || fail "VNPAY order $(body)"
  voi=$(body | jq -r .id); url=$(body | jq -r .paymentUrl)
  ref=$(sed -E 's/.*vnp_TxnRef=([^&]+).*/\1/' <<<"$url"); amt=$(sed -E 's/.*vnp_Amount=([^&]+).*/\1/' <<<"$url")
  [ "$amt" = 30000000 ] || fail "vnp_Amount $amt"
  ipn() { # args: amount responseCode secret
    local q; q=$(node -e "const v=require('./dist/payment/vnpay');const p={vnp_TxnRef:'$ref',vnp_Amount:'$1',vnp_ResponseCode:'$2',vnp_TransactionStatus:'$2',vnp_TransactionNo:'14000001',vnp_TmnCode:'TEST'};console.log(v.signData(p)+'&vnp_SecureHash='+v.sign(p,'$3'))")
    curl -s "$API/payments/vnpay/ipn?$q" | jq -r .RspCode; }
  [ "$(ipn "$amt" 00 wrong-secret)" = 97 ] || fail "bad signature"
  [ "$(ipn 1 00 "$VNPAY_HASH_SECRET")" = 04 ] || fail "bad amount"
  [ "$(req "$API/stores/$vslug/orders/$voi?email=g@x.com")" = 200 ] && [ "$(body | jq -r .status)" = PENDING ] || fail "paid before IPN"
  [ "$(ipn "$amt" 00 "$VNPAY_HASH_SECRET")" = 00 ] || fail "valid IPN"
  [ "$(ipn "$amt" 00 "$VNPAY_HASH_SECRET")" = 02 ] || fail "IPN replay"
  req "$API/stores/$vslug/orders/$voi?email=g@x.com" >/dev/null
  [ "$(body | jq -r '.status + "/" + .payments[0].status + "/" + .payments[0].providerPaymentId')" = PAID/SUCCEEDED/14000001 ] || fail "after IPN $(body)"
  echo "vnpay OK"
fi

echo "smoke OK"
