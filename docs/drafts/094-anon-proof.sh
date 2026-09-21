#!/bin/sh
# 094 proof, HTTP: call the four revoked RPCs through PostgREST with the ANON key, using random
# UUIDs so nothing can match a row. Before 094 each call EXECUTES (a function error such as
# "content_image not found", or 200); after 094 each must be refused with 42501 (permission denied).
# Usage: SUPA_URL=<https://<ref>.supabase.co> ANON_KEY=<anon key> sh docs/drafts/094-anon-proof.sh
# Prints status + error code/message only — never the key or the URL.
set -eu
Z=00000000-0000-4000-8000-0000000000
call() {
  name=$1; body=$2
  out=$(curl -s -o /tmp/094_body -w '%{http_code}' -X POST "$SUPA_URL/rest/v1/rpc/$name" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
    -d "$body")
  printf '%-24s HTTP %s  %s\n' "$name" "$out" "$(head -c 160 /tmp/094_body | tr -d '\n')"
}
call recompute_seg_status   "{\"p_seg_id\":\"${Z}01\"}"
call approve_content_image  "{\"p_id\":\"${Z}02\",\"p_approved_by\":null,\"p_public_url\":\"x\",\"p_storage_path\":\"x\"}"
call approve_content_image  "{\"p_id\":\"${Z}03\",\"p_approved_by\":null,\"p_public_url\":\"x\"}"
call approve_segment_bundle "{\"p_seg_id\":\"${Z}04\",\"p_approved_by\":null,\"p_images\":[]}"
rm -f /tmp/094_body
