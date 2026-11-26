#!/usr/bin/env bash
# HTTP smoke test: page builder draft/publish/versions/public read.
# Usage: API=http://localhost:3000 bash test/smoke-pages.sh   (needs jq)
set -euo pipefail
API=${API:-http://localhost:3000}
RUN=$RANDOM$RANDOM
fail() { echo "FAIL: $*"; exit 1; }
F=/tmp/smoke-pages.$RUN
req() { curl -s -o $F -w '%{http_code}' "$@"; }
body() { cat $F; }
json=(-H 'content-type: application/json')
TOKEN=$(curl -sf "$API/auth/register" "${json[@]}" -d "{\"email\":\"pg-$RUN@x.com\",\"password\":\"password123\",\"name\":\"P\"}" | jq -r .token)
D=(-H "authorization: Bearer $TOKEN" "${json[@]}")
slug="pg$RUN"; S="$API/stores/$slug"
req "$API/stores" "${D[@]}" -d "{\"name\":\"Pg\",\"slug\":\"$slug\"}" >/dev/null

HOME_DATA='{"root":{"props":{}},"content":[{"type":"Hero","props":{"id":"h1","title":"Hi"}}]}'
[ "$(req "$S/pages" "${D[@]}" -d "{\"title\":\"Home\",\"slug\":\"home\",\"data\":$HOME_DATA}")" = 201 ] || fail "create $(body)"
PID=$(body | jq -r .id)
[ "$(req "$S/pages" "${D[@]}" -d '{"title":"Home","slug":"home"}')" = 400 ] || fail "dup slug"
[ "$(req "$S/pages" "${D[@]}" -d '{"title":"Về chúng tôi"}')" = 201 ] && [ "$(body | jq -r .slug)" = ve-chung-toi ] || fail "slugify $(body)"
[ "$(req "$S/pages" "${D[@]}" -d '{"title":"x","data":{"content":[{"type":"Script","props":{}}]}}')" = 400 ] || fail "unknown section accepted"
[ "$(req "$S/pages")" = 401 ] || fail "pages list public"
[ "$(req "$S/site/home")" = 404 ] || fail "unpublished visible"

[ "$(req "$S/pages/$PID/publish" "${D[@]}" -X POST)" = 201 ] && [ "$(body | jq .publishedVersion.version)" = 1 ] || fail "publish $(body)"
[ "$(req "$S/site/home")" = 200 ] && [ "$(body | jq -r .data.content[0].props.title)" = Hi ] || fail "public read $(body)"

# draft edits don't leak until publish
NEW='{"data":{"root":{"props":{}},"content":[{"type":"Hero","props":{"id":"h1","title":"Bye"}},{"type":"Spacer","props":{"id":"s"}}]}}'
[ "$(req -X PUT "$S/pages/$PID/draft" "${D[@]}" -d "$NEW")" = 200 ] || fail "save draft $(body)"
[ "$(req "$S/site/home")" = 200 ] && [ "$(body | jq -r .data.content[0].props.title)" = Hi ] || fail "draft leaked"
req "$S/pages/$PID/publish" "${D[@]}" -X POST >/dev/null
[ "$(req "$S/site/home")" = 200 ] && [ "$(body | jq -r '[.version,.data.content[0].props.title]|join(",")')" = "2,Bye" ] || fail "v2 $(body)"

# rollback to v1 then publish -> v3 with v1 content; v1 itself unchanged
V1=$(req "$S/pages/$PID" "${D[@]}" >/dev/null; body | jq -r '.versions[]|select(.version==1)|.id')
[ "$(req -X POST "$S/pages/$PID/versions/$V1/restore" "${D[@]}")" = 201 ] && [ "$(body | jq -r .draft.content[0].props.title)" = Hi ] || fail "restore $(body)"
req "$S/pages/$PID/publish" "${D[@]}" -X POST >/dev/null
[ "$(req "$S/site/home")" = 200 ] && [ "$(body | jq -r '[.version,.data.content[0].props.title]|join(",")')" = "3,Hi" ] || fail "v3 $(body)"
[ "$(req -X DELETE "$S/pages/$PID" "${D[@]}")" = 200 ] || fail "delete $(body)"
[ "$(req "$S/site/home")" = 404 ] || fail "deleted page still public"
rm -f $F
echo "pages smoke OK"
