#!/usr/bin/env bash
# HTTP smoke test for merchant admin APIs (my stores, settings, domains, staff,
# customers, dashboard, collections). Needs a running API and jq.
# Usage: API=http://localhost:3000 bash test/smoke-admin.sh
set -euo pipefail
API=${API:-http://localhost:3000}
RUN=$RANDOM$RANDOM
fail() { echo "FAIL: $*"; exit 1; }
req() { curl -s -o /tmp/smoke-admin.$RUN -w '%{http_code}' "$@"; }
body() { cat /tmp/smoke-admin.$RUN; }
json=(-H 'content-type: application/json')

reg() { curl -sf "$API/auth/register" "${json[@]}" \
  -d "{\"email\":\"$1-$RUN@x.com\",\"password\":\"password123\",\"name\":\"$1\"}" | jq -r "$2"; }
OWNER=$(reg owner .token); STAFF=$(reg staff .token); STAFF_ID=$(curl -sf "$API/auth/login" "${json[@]}" \
  -d "{\"email\":\"staff-$RUN@x.com\",\"password\":\"password123\"}" | jq -r .user.id)
own=(-H "authorization: Bearer $OWNER"); stf=(-H "authorization: Bearer $STAFF")

slug="adm$RUN"; S="$API/stores/$slug"
req "$API/stores" "${own[@]}" "${json[@]}" -d "{\"name\":\"Adm\",\"slug\":\"$slug\"}" >/dev/null
[ "$(req "$API/stores" "${own[@]}")" = 200 ] && [ "$(body | jq -r ".[] | select(.slug==\"$slug\") | .role")" = OWNER ] || fail "my stores"

# staff
[ "$(req "$S/members" "${own[@]}" "${json[@]}" -d "{\"email\":\"staff-$RUN@x.com\",\"role\":\"STAFF\"}")" = 201 ] || fail "add member $(body)"
[ "$(req "$S/members" "${own[@]}" "${json[@]}" -d '{"email":"nobody@x.com"}')" = 404 ] || fail "unknown user"
[ "$(req "$S/members" "${stf[@]}" "${json[@]}" -d '{"email":"x@x.com"}')" = 403 ] || fail "staff manages staff"
OWNER_ID=$(body >/dev/null; req "$S/members" "${own[@]}" >/dev/null; body | jq -r '.[] | select(.role=="OWNER") | .userId')
[ "$(req -X DELETE "$S/members/$OWNER_ID" "${own[@]}")" = 400 ] || fail "removed last owner"
[ "$(req -X PATCH "$S/members/$OWNER_ID" "${own[@]}" "${json[@]}" -d '{"role":"STAFF"}')" = 400 ] || fail "demoted last owner"
[ "$(req "$API/stores" "${stf[@]}")" = 200 ] && [ "$(body | jq -r ".[] | select(.slug==\"$slug\") | .role")" = STAFF ] || fail "staff sees store"

# settings: owner only
[ "$(req -X PATCH "$S" "${stf[@]}" "${json[@]}" -d '{"name":"Hacked"}')" = 403 ] || fail "staff edits settings"
[ "$(req -X PATCH "$S" "${own[@]}" "${json[@]}" -d '{"name":"Renamed","currency":"usd"}')" = 200 ] || fail "edit settings"
[ "$(body | jq -r '.name + "/" + .currency')" = Renamed/USD ] || fail "settings saved"

# domains
[ "$(req "$S/domains" "${own[@]}" "${json[@]}" -d '{"hostname":"other.localhost"}')" = 400 ] || fail "claimed platform subdomain"
[ "$(req "$S/domains" "${own[@]}" "${json[@]}" -d '{"hostname":"not a host"}')" = 400 ] || fail "bad hostname"
[ "$(req "$S/domains" "${own[@]}" "${json[@]}" -d "{\"hostname\":\"Shop$RUN.Example.com.\"}")" = 201 ] || fail "add domain $(body)"
did=$(body | jq -r .id); [ "$(body | jq -r .hostname)" = "shop$RUN.example.com" ] || fail "hostname normalized"
[ "$(req "$S/domains" "${own[@]}" "${json[@]}" -d "{\"hostname\":\"shop$RUN.example.com\"}")" = 409 ] || fail "duplicate domain"
[ "$(req "$S/domains" "${stf[@]}" "${json[@]}" -d '{"hostname":"x.example.org"}')" = 403 ] || fail "staff adds domain"
[ "$(req -X POST "$S/domains/$did/primary" "${own[@]}")" = 201 ] && [ "$(body | jq -r '.[0].id')" = "$did" ] || fail "set primary"
[ "$(req "$API/stores/by-host/shop$RUN.example.com")" = 200 ] || fail "custom domain resolves"
old=$(req "$S/domains" "${stf[@]}" >/dev/null; body | jq -r ".[] | select(.id!=\"$did\") | .id")
[ "$(req -X DELETE "$S/domains/$did" "${own[@]}")" = 400 ] || fail "deleted primary"
[ "$(req -X DELETE "$S/domains/$old" "${own[@]}")" = 200 ] && [ "$(body | jq length)" = 1 ] || fail "delete domain"

# collections (staff can manage catalog)
[ "$(req "$S/collections" "${stf[@]}" "${json[@]}" -d '{"name":"Summer"}')" = 201 ] || fail "create collection"
cid=$(body | jq -r .id)
[ "$(req "$S/collections" "${stf[@]}" "${json[@]}" -d '{"name":"Summer"}')" = 409 ] || fail "duplicate collection slug -> $(body)"
[ "$(req -X PATCH "$S/collections/$cid" "${stf[@]}" "${json[@]}" -d '{"name":"Hot"}')" = 200 ] || fail "rename collection"
req "$S/products" "${stf[@]}" "${json[@]}" -d "{\"name\":\"Tee\",\"price\":10,\"stock\":3,\"status\":\"ACTIVE\",\"collectionIds\":[\"$cid\"]}" >/dev/null
variant=$(body | jq -r '.variants[0].id')
[ "$(req -X DELETE "$S/collections/$cid" "${stf[@]}")" = 200 ] || fail "delete collection"
[ "$(req "$S/products")" = 200 ] && [ "$(body | jq '.[0].collections | length')" = 0 ] || fail "product kept, unlinked"

# customers from checkout
order() { req "$S/orders" "${json[@]}" -d "{\"guestEmail\":\"$1\",\"guestName\":\"Lan\",\"items\":[{\"variantId\":\"$variant\",\"quantity\":1}]}"; }
[ "$(order Lan@x.com)" = 201 ] && [ "$(order lan@x.com)" = 201 ] || fail "orders $(body)"
[ "$(req "$S/customers" "${stf[@]}")" = 200 ] || fail "list customers"
[ "$(body | jq -r '.[0] | "\(.email) \(.orderCount) \(.totalSpent)"')" = "lan@x.com 2 20" ] || fail "customer stats $(body)"
[ "$(body | jq -r '.[0] | has("passwordHash")')" = false ] || fail "passwordHash leaked"
cus=$(body | jq -r '.[0].id')
[ "$(req "$S/customers/$cus" "${stf[@]}")" = 200 ] && [ "$(body | jq '.orders | length')" = 2 ] || fail "customer detail"
[ "$(req "$S/customers")" = 401 ] || fail "anon customers"

# dashboard
[ "$(req "$S/dashboard" "${stf[@]}")" = 200 ] || fail "dashboard"
[ "$(body | jq -c '[.products,.activeProducts,.orders,.pendingOrders,.customers,.revenue,(.lowStock|length),(.recentOrders|length)]')" = '[1,1,2,2,1,"0",1,2]' ] \
  || fail "dashboard numbers $(body | jq -c '[.products,.activeProducts,.orders,.pendingOrders,.customers,.revenue,(.lowStock|length),(.recentOrders|length)]')"

# owner removes staff -> staff loses access
[ "$(req -X DELETE "$S/members/$STAFF_ID" "${own[@]}")" = 200 ] || fail "remove staff"
[ "$(req "$S/dashboard" "${stf[@]}")" = 403 ] || fail "removed staff still has access"

echo "admin smoke OK"
