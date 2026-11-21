#!/usr/bin/env bash
# HTTP smoke test: product options/variants/images, discounts, draft orders.
# Usage: API=http://localhost:3000 bash test/smoke-shopify.sh   (needs jq)
set -euo pipefail
API=${API:-http://localhost:3000}
RUN=$RANDOM$RANDOM
fail() { echo "FAIL: $*"; exit 1; }
F=/tmp/smoke-shopify.$RUN
req() { curl -s -o $F -w '%{http_code}' "$@"; }
body() { cat $F; }
json=(-H 'content-type: application/json')

TOKEN=$(curl -sf "$API/auth/register" "${json[@]}" -d "{\"email\":\"shop-$RUN@x.com\",\"password\":\"password123\",\"name\":\"S\"}" | jq -r .token)
own=(-H "authorization: Bearer $TOKEN")
slug="shp$RUN"; S="$API/stores/$slug"
req "$API/stores" "${own[@]}" "${json[@]}" -d "{\"name\":\"Shp\",\"slug\":\"$slug\"}" >/dev/null

# --- product with options + variants + images
P='{"name":"Tee","vendor":"Acme","tags":["summer","cotton","summer"],"status":"ACTIVE",
 "images":[{"url":"https://img.test/a.jpg","alt":"front"},{"url":"https://img.test/b.jpg"}],
 "options":[{"name":"Size","values":["S","M"]},{"name":"Color","values":["Red"]}],
 "variants":[{"sku":"T-S","price":"100000","compareAtPrice":"150000","stock":5,"optionValues":{"Size":"S","Color":"Red"}},
             {"sku":"T-M","price":"110000","stock":1,"optionValues":{"Size":"M","Color":"Red"}}]}'
[ "$(req "$S/products" "${own[@]}" "${json[@]}" -d "$P")" = 201 ] || fail "create product $(body)"
PID=$(body | jq -r .id)
[ "$(body | jq '.variants|length')" = 2 ] && [ "$(body | jq '.images|length')" = 2 ] && [ "$(body | jq -c .tags)" = '["summer","cotton"]' ] || fail "product shape $(body)"
V1=$(body | jq -r '.variants[] | select(.sku=="T-S") | .id'); V2=$(body | jq -r '.variants[] | select(.sku=="T-M") | .id')
[ "$(body | jq -r '.variants[0].compareAtPrice')" = 150000 ] || fail "compareAt"
# validation
bad=$(echo "$P" | jq '.variants[1].optionValues.Size="S"')
[ "$(req "$S/products" "${own[@]}" "${json[@]}" -d "$bad")" = 400 ] || fail "duplicate combo accepted"
bad=$(echo "$P" | jq '.variants[0].optionValues.Size="XL"')
[ "$(req "$S/products" "${own[@]}" "${json[@]}" -d "$bad")" = 400 ] || fail "unknown option value accepted"
bad=$(echo "$P" | jq '.images[0].url="javascript:x"')
[ "$(req "$S/products" "${own[@]}" "${json[@]}" -d "$bad")" = 400 ] || fail "bad image url accepted"
[ "$(req "$S/products/$PID")" = 200 ] || fail "get product"

# --- discounts
D=("${own[@]}" "${json[@]}")
[ "$(req "$S/discounts" "${D[@]}" -d '{"code":"sale10","type":"PERCENTAGE","value":10,"usageLimit":1}')" = 201 ] || fail "create discount $(body)"
DID=$(body | jq -r .id); [ "$(body | jq -r .code)" = SALE10 ] || fail "code uppercase"
[ "$(req "$S/discounts" "${D[@]}" -d '{"code":"SALE10","type":"FIXED","value":5}')" = 400 ] || fail "dup code"
[ "$(req "$S/discounts" "${D[@]}" -d '{"code":"BIG","type":"PERCENTAGE","value":101}')" = 400 ] || fail ">100%"
req "$S/discounts" "${D[@]}" -d '{"code":"MIN","type":"FIXED","value":50000,"minSubtotal":500000}' >/dev/null
[ "$(req "$S/discounts/validate" "${json[@]}" -d '{"code":"sale10","subtotal":"200000"}')" = 201 ] && [ "$(body | jq -r .amount)" = 20000 ] || fail "validate $(body)"
[ "$(req "$S/discounts/validate" "${json[@]}" -d '{"code":"MIN","subtotal":"100"}')" = 400 ] || fail "min subtotal"
[ "$(req "$S/discounts" )" = 401 ] || fail "discount list public"

# --- checkout with discount: 2 x 100000 - 10% = 180000
ORD='{"guestEmail":"c@x.com","guestName":"C","paymentMethod":"COD","discountCode":"sale10","items":[{"variantId":"'$V1'","quantity":2}]}'
[ "$(req "$S/orders" "${json[@]}" -d "$ORD")" = 201 ] || fail "checkout $(body)"
[ "$(body | jq -r '[.subtotal,.discountAmount,.total]|join(",")')" = "200000,20000,180000" ] || fail "totals $(body)"
[ "$(req "$S/orders" "${json[@]}" -d "$ORD")" = 400 ] || fail "usage limit not enforced"
[ "$(req "$S/products/$PID")" = 200 ] && [ "$(body | jq '.variants[]|select(.sku=="T-S")|.stock')" = 3 ] || fail "stock after order"

# --- update variants: drop T-M, keep T-S (past order keeps its snapshot)
U=$(jq -n --arg v1 "$V1" '{variants:[{id:$v1,sku:"T-S",price:"90000",stock:3,optionValues:{Size:"S",Color:"Red"}},
   {sku:"T-L",price:"95000",stock:2,optionValues:{Size:"S",Color:"Red"}}]}')
[ "$(req -X PATCH "$S/products/$PID" "${D[@]}" -d "$U")" = 400 ] || fail "duplicate on update"
U=$(jq -n --arg v1 "$V1" '{options:[{name:"Size",values:["S","L"]},{name:"Color",values:["Red"]}],
  variants:[{id:$v1,sku:"T-S",price:"90000",stock:3,optionValues:{Size:"S",Color:"Red"}},
   {sku:"T-L",price:"95000",stock:2,optionValues:{Size:"L",Color:"Red"}}]}')
[ "$(req -X PATCH "$S/products/$PID" "${D[@]}" -d "$U")" = 200 ] || fail "update variants $(body)"
[ "$(body | jq -r '[.variants[].sku]|sort|join(",")')" = "T-L,T-S" ] || fail "variant set $(body)"
[ "$(body | jq -r '.variants[]|select(.sku=="T-S")|.price')" = 90000 ] || fail "variant price"
[ "$(req -X PATCH "$S/products/$PID" "${D[@]}" -d '{"images":[]}')" = 200 ] && [ "$(body | jq '.images|length')" = 0 ] || fail "clear images"
[ "$(req "$S/orders" "${own[@]}")" = 200 ] && [ "$(body | jq length)" = 1 ] || fail "orders list"

# --- draft orders
V3=$(req "$S/products/$PID" >/dev/null; body | jq -r '.variants[]|select(.sku=="T-L")|.id')
DR='{"guestEmail":"d@x.com","guestName":"Dee","note":"phone order","items":[{"variantId":"'$V3'","quantity":2}]}'
[ "$(req "$S/draft-orders" "${D[@]}" -d "$DR")" = 201 ] || fail "create draft $(body)"
DRID=$(body | jq -r .id); [ "$(body | jq -r '[.status,.total]|join(",")')" = "DRAFT,190000" ] || fail "draft shape $(body)"
[ "$(req "$S/draft-orders" "${own[@]}")" = 200 ] && [ "$(body | jq length)" = 1 ] || fail "list drafts"
[ "$(req "$S/orders" "${own[@]}")" = 200 ] && [ "$(body | jq length)" = 1 ] || fail "draft leaked into orders"
[ "$(req "$S/draft-orders")" = 401 ] || fail "drafts public"
[ "$(req "$S/products/$PID")" = 200 ] && [ "$(body | jq '.variants[]|select(.sku=="T-L")|.stock')" = 2 ] || fail "draft reserved stock"
[ "$(req -X PUT "$S/draft-orders/$DRID" "${D[@]}" -d "${DR/quantity\":2/quantity\":1}")" = 200 ] && [ "$(body | jq -r .total)" = 95000 ] || fail "update draft $(body)"
[ "$(req -X PATCH "$S/orders/$DRID/status" "${D[@]}" -d '{"status":"PAID"}')" = 404 ] || fail "status on draft"
[ "$(req "$S/draft-orders/$DRID/complete" "${D[@]}" -d '{"markPaid":true}')" = 201 ] || fail "complete $(body)"
[ "$(body | jq -r '[.status,.payments[0].status]|join(",")')" = "PAID,SUCCEEDED" ] || fail "completed shape $(body)"
[ "$(req "$S/products/$PID")" = 200 ] && [ "$(body | jq '.variants[]|select(.sku=="T-L")|.stock')" = 1 ] || fail "stock after complete"
[ "$(req "$S/draft-orders" "${own[@]}")" = 200 ] && [ "$(body | jq length)" = 0 ] || fail "draft still listed"
[ "$(req "$S/orders" "${own[@]}")" = 200 ] && [ "$(body | jq length)" = 2 ] || fail "completed order missing"
# draft without customer cannot complete
req "$S/draft-orders" "${D[@]}" -d '{"items":[{"variantId":"'$V3'","quantity":1}]}' >/dev/null
[ "$(req "$S/draft-orders/$(body | jq -r .id)/complete" "${D[@]}" -d '{}')" = 400 ] || fail "complete without customer"
# delete product with orders
[ "$(req -X DELETE "$S/products/$PID" "${own[@]}")" = 200 ] || fail "delete product $(body)"
[ "$(req "$S/orders" "${own[@]}")" = 200 ] && [ "$(body | jq length)" = 2 ] || fail "orders lost after product delete"
rm -f $F
echo "shopify smoke OK"
