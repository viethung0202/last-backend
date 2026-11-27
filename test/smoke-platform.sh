#!/usr/bin/env bash
# HTTP smoke test: platform admin (stores lock/unlock, templates, VNPAY settings).
# Usage: PLATFORM_ADMIN_EMAILS must contain $ADMIN_EMAIL on the server.
# WARNING: resets the platform VNPAY setting; run against a local DB, not production.
#   API=http://localhost:3000 ADMIN_EMAIL=admin@x.com bash test/smoke-platform.sh   (needs jq)
set -euo pipefail
API=${API:-http://localhost:3000}
ADMIN_EMAIL=${ADMIN_EMAIL:?set ADMIN_EMAIL to an address listed in PLATFORM_ADMIN_EMAILS}
RUN=$RANDOM$RANDOM
fail() { echo "FAIL: $*"; exit 1; }
F=/tmp/smoke-platform.$RUN
req() { curl -s -o $F -w '%{http_code}' "$@"; }
body() { cat $F; }
json=(-H 'content-type: application/json')
login() { # register, or log in if the account exists
  curl -s "$API/auth/register" "${json[@]}" -d "{\"email\":\"$1\",\"password\":\"password123\",\"name\":\"N\"}" | jq -r '.token // empty' ||
    true
}
ADMIN=$(login "$ADMIN_EMAIL"); [ -n "$ADMIN" ] || ADMIN=$(curl -sf "$API/auth/login" "${json[@]}" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"password123\"}" | jq -r .token)
TOKEN=$(login "pl-$RUN@x.com")
A=(-H "authorization: Bearer $ADMIN" "${json[@]}")
D=(-H "authorization: Bearer $TOKEN" "${json[@]}")
P="$API/platform"
slug="pl$RUN"; S="$API/stores/$slug"
req "$API/stores" "${D[@]}" -d "{\"name\":\"Pl\",\"slug\":\"$slug\"}" >/dev/null

[ "$(req "$P/stats")" = 401 ] || fail "stats public"
[ "$(req "$P/stats" "${D[@]}")" = 403 ] || fail "merchant reached platform"
[ "$(req "$P/stats" "${A[@]}")" = 200 ] && [ "$(body | jq '.stores >= 1')" = true ] || fail "stats $(body)"

# lock / unlock a store
SID=$(req "$P/stores?q=$slug" "${A[@]}" >/dev/null; body | jq -r ".[] | select(.slug==\"$slug\") | .id")
[ -n "$SID" ] || fail "store not listed $(body)"
[ "$(body | jq -r ".[0].owners[0].email")" = "pl-$RUN@x.com" ] || fail "owner $(body)"
[ "$(req -X PATCH "$P/stores/$SID" "${A[@]}" -d '{"status":"NOPE"}')" = 400 ] || fail "bad status"
[ "$(req -X PATCH "$P/stores/$SID" "${A[@]}" -d '{"status":"SUSPENDED"}')" = 200 ] || fail "suspend $(body)"
[ "$(req "$S/products")" = 403 ] || fail "suspended store still public"
[ "$(req "$S/products" -H 'authorization: Bearer forged')" = 403 ] || fail "forged token bypassed suspension"
[ "$(req "$S/products" "${D[@]}")" = 200 ] || fail "member locked out of own suspended store"
[ "$(req "$API/stores/$slug")" = 200 ] && [ "$(body | jq -r .status)" = SUSPENDED ] || fail "status not exposed $(body)"
req -X PATCH "$P/stores/$SID" "${A[@]}" -d '{"status":"ACTIVE"}' >/dev/null
[ "$(req "$S/products")" = 200 ] || fail "unsuspend"

# merchants
[ "$(req "$P/merchants" "${A[@]}")" = 200 ] && [ "$(body | jq -r ".[]|select(.email==\"pl-$RUN@x.com\")|.stores[0].slug")" = "$slug" ] || fail "merchants $(body)"

# templates: draft template invisible to merchants until published, then usable for a page
TPL='{"root":{"props":{}},"content":[{"type":"Hero","props":{"id":"h","title":"From template"}}]}'
[ "$(req "$P/templates" "${A[@]}" -d "{\"name\":\"Fashion $RUN\",\"category\":\"Fashion\",\"data\":$TPL}")" = 201 ] || fail "create template $(body)"
TID=$(body | jq -r .id)
[ "$(req "$P/templates" "${A[@]}" -d '{"name":"x","data":{"content":[{"type":"Script"}]}}')" = 400 ] || fail "bad template data accepted"
[ "$(req "$P/templates" "${A[@]}" -d '{"name":"x","thumbnailUrl":"javascript:1"}')" = 400 ] || fail "bad thumbnail accepted"
[ "$(req "$P/templates" "${D[@]}" -d '{"name":"x"}')" = 403 ] || fail "merchant created template"
req "$API/templates" "${D[@]}" >/dev/null; [ "$(body | jq "[.[]|select(.id==\"$TID\")]|length")" = 0 ] || fail "unpublished template visible"
[ "$(req "$S/pages" "${D[@]}" -d "{\"title\":\"T\",\"templateId\":\"$TID\"}")" = 400 ] || fail "unpublished template usable"
[ "$(req -X PUT "$P/templates/$TID" "${A[@]}" -d '{"published":true}')" = 200 ] || fail "publish template $(body)"
req "$API/templates" "${D[@]}" >/dev/null; [ "$(body | jq "[.[]|select(.id==\"$TID\")]|length")" = 1 ] || fail "published template hidden"
[ "$(req "$S/pages" "${D[@]}" -d "{\"title\":\"From tpl\",\"templateId\":\"$TID\"}")" = 201 ] || fail "page from template $(body)"
PID=$(body | jq -r .id)
[ "$(req "$S/pages/$PID" "${D[@]}")" = 200 ] && [ "$(body | jq -r .draft.content[0].props.title)" = "From template" ] || fail "template data not copied $(body)"
[ "$(req -X DELETE "$P/templates/$TID" "${A[@]}")" = 200 ] || fail "delete template"
[ "$(req "$S/pages/$PID" "${D[@]}")" = 200 ] || fail "page broke after template delete"

# VNPAY settings: secret is write-only
req -X PUT "$P/settings/vnpay" "${A[@]}" -d '{"tmnCode":""}' >/dev/null
[ "$(req -X PUT "$P/settings/vnpay" "${A[@]}" -d '{"tmnCode":"T1"}')" = 400 ] || fail "vnpay without secret"
[ "$(req -X PUT "$P/settings/vnpay" "${A[@]}" -d '{"tmnCode":"T1","hashSecret":"S1","payUrl":"http://x"}')" = 400 ] || fail "http payUrl accepted"
[ "$(req -X PUT "$P/settings/vnpay" "${A[@]}" -d '{"tmnCode":"T1","hashSecret":"S1"}')" = 200 ] || fail "save vnpay $(body)"
[ "$(body | jq -r '[.tmnCode,.hashSecretSet]|join(",")')" = "T1,true" ] && ! grep -q S1 $F || fail "secret leaked $(body)"
[ "$(req -X PUT "$P/settings/vnpay" "${A[@]}" -d '{"tmnCode":"T2"}')" = 200 ] && [ "$(body | jq -r .tmnCode)" = T2 ] || fail "keep secret $(body)"
[ "$(req "$S/payment-methods")" = 200 ] && [ "$(body | jq .vnpayAvailable)" = true ] || fail "payment methods $(body)"
[ "$(req -X PUT "$P/settings/vnpay" "${A[@]}" -d '{"tmnCode":""}')" = 200 ] && [ "$(body | jq -r .hashSecretSet)" = false ] || fail "clear vnpay $(body)"

rm -f $F
echo "OK smoke-platform"
