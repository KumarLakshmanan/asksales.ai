#!/bin/bash
# =============================================================================
# Meta API Test Script — Trigger "Test API Call" for Advanced Access Permissions
# =============================================================================
# Usage:
#   chmod +x server/scripts/test-meta-permissions.sh
#
#   # Test Instagram permissions (IGAA token):
#   IG_TOKEN="IGAA..." ./server/scripts/test-meta-permissions.sh instagram
#
#   # Test Facebook/Pages/Ads/Business permissions (EAA token):
#   META_TOKEN="EAA..." ./server/scripts/test-meta-permissions.sh facebook
#
#   # Test all (provide both):
#   META_TOKEN="EAA..." IG_TOKEN="IGAA..." ./server/scripts/test-meta-permissions.sh all
#
# After running, wait ~24 hours for the "Request Advanced Access" button to
# become active in Meta App Review.
# =============================================================================

set -euo pipefail

MODE="${1:-all}"

# ── Tokens ─────────────────────────────────────────────────────────────────────
FB_TOKEN="${META_TOKEN:-}"
IG_TOKEN="${IG_TOKEN:-}"

API_VERSION="v25.0"
FB_BASE="https://graph.facebook.com/${API_VERSION}"
IG_BASE="https://graph.instagram.com/${API_VERSION}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

passed=0
failed=0
skipped=0
total=0

call_api() {
  local label="$1"
  local url="$2"
  local method="${3:-GET}"
  local body="${4:-}"

  total=$((total + 1))
  printf "\n${CYAN}[%d] %s${NC}\n" "$total" "$label"
  printf "    %s %s\n" "$method" "$(echo "$url" | sed 's/access_token=[^&]*/access_token=***/g')"

  if [ "$method" = "POST" ] && [ -n "$body" ]; then
    response=$(curl -s -w "\n%{http_code}" -X POST "$url" -d "$body" 2>&1)
  else
    response=$(curl -s -w "\n%{http_code}" "$url" 2>&1)
  fi

  http_code=$(echo "$response" | tail -1)
  body_out=$(echo "$response" | sed '$d')

  if [[ "$http_code" =~ ^2 ]]; then
    printf "    ${GREEN}✓ HTTP %s${NC}\n" "$http_code"
    echo "$body_out" | python3 -m json.tool 2>/dev/null | head -20 || echo "$body_out" | head -c 200
    passed=$((passed + 1))
  else
    printf "    ${RED}✗ HTTP %s${NC}\n" "$http_code"
    echo "$body_out" | python3 -m json.tool 2>/dev/null | head -15 || echo "$body_out" | head -c 300
    failed=$((failed + 1))
  fi
  echo ""
}

skip_test() {
  total=$((total + 1))
  skipped=$((skipped + 1))
  printf "\n${YELLOW}[%d] %s — SKIPPED${NC}\n" "$total" "$1"
}

echo "=============================================="
echo "  Meta API Permission Test Script"
echo "=============================================="
echo ""
echo "Mode: ${MODE}"
[ -n "$FB_TOKEN" ] && echo "Facebook Token: ${FB_TOKEN:0:15}...${FB_TOKEN: -8}" || echo "Facebook Token: NOT SET"
[ -n "$IG_TOKEN" ] && echo "Instagram Token: ${IG_TOKEN:0:15}...${IG_TOKEN: -8}" || echo "Instagram Token: NOT SET"
echo "API Version: ${API_VERSION}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
#  INSTAGRAM PERMISSIONS (using graph.instagram.com + IGAA token)
# ═══════════════════════════════════════════════════════════════════════════════
if [[ "$MODE" == "instagram" || "$MODE" == "all" ]]; then
  echo ""
  printf "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
  printf "${YELLOW}  INSTAGRAM PERMISSIONS (graph.instagram.com)${NC}\n"
  printf "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

  if [ -z "$IG_TOKEN" ]; then
    printf "\n${RED}No IG_TOKEN set — skipping all Instagram tests${NC}\n"
    printf "${YELLOW}Usage: IG_TOKEN=\"IGAA...\" ./server/scripts/test-meta-permissions.sh instagram${NC}\n"
  else
    # ── instagram_basic — Get user profile ───────────────────────────────────
    call_api "instagram_basic — /me (profile)" \
      "${IG_BASE}/me?fields=id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,website&access_token=${IG_TOKEN}"

    # Extract user ID
    IG_USER_ID=$(curl -s "${IG_BASE}/me?fields=id&access_token=${IG_TOKEN}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('id', ''))
except: pass
" 2>/dev/null)
    printf "    ${CYAN}IG User ID: ${IG_USER_ID:-<none>}${NC}\n\n"

    if [ -n "$IG_USER_ID" ]; then
      # ── instagram_basic — Get media ────────────────────────────────────────
      call_api "instagram_basic — /me/media (recent posts)" \
        "${IG_BASE}/me/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,permalink,like_count,comments_count&limit=5&access_token=${IG_TOKEN}"

      # Get first media ID
      MEDIA_ID=$(curl -s "${IG_BASE}/me/media?fields=id&limit=1&access_token=${IG_TOKEN}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('data', [{}])[0].get('id', ''))
except: pass
" 2>/dev/null)

      # ── instagram_manage_comments — Read comments ──────────────────────────
      if [ -n "$MEDIA_ID" ]; then
        call_api "instagram_manage_comments — Comments (/${MEDIA_ID}/comments)" \
          "${IG_BASE}/${MEDIA_ID}/comments?fields=id,text,username,timestamp,like_count&limit=5&access_token=${IG_TOKEN}"

        call_api "instagram_manage_comments — Comment with replies" \
          "${IG_BASE}/${MEDIA_ID}/comments?fields=id,text,username,timestamp,replies{id,text,username,timestamp}&limit=3&access_token=${IG_TOKEN}"
      else
        skip_test "instagram_manage_comments — no media found"
        skip_test "instagram_manage_comments — replies"
      fi

      # ── instagram_manage_messages — Conversations ──────────────────────────
      call_api "instagram_manage_messages — /me/conversations (DMs)" \
        "${IG_BASE}/me/conversations?fields=id,updated_time,participants&platform=instagram&limit=3&access_token=${IG_TOKEN}"

      # ── instagram_content_publish — Publishing limit ───────────────────────
      call_api "instagram_content_publish — /me/content_publishing_limit" \
        "${IG_BASE}/me/content_publishing_limit?fields=config,quota_usage&access_token=${IG_TOKEN}"

      # ── instagram_basic — Stories ──────────────────────────────────────────
      call_api "instagram_basic — /me/stories" \
        "${IG_BASE}/me/stories?fields=id,media_type,timestamp&access_token=${IG_TOKEN}"

      # ── instagram_basic — Live media ───────────────────────────────────────
      call_api "instagram_basic — /me/live_media" \
        "${IG_BASE}/me/live_media?fields=id,media_type,timestamp&access_token=${IG_TOKEN}"

      # ── instagram_basic — Media insights ───────────────────────────────────
      if [ -n "$MEDIA_ID" ]; then
        call_api "instagram_basic — Media insights (/${MEDIA_ID}/insights)" \
          "${IG_BASE}/${MEDIA_ID}/insights?metric=impressions,reach&access_token=${IG_TOKEN}"
      fi

      # ── instagram_basic — Account insights ─────────────────────────────────
      NOW=$(date +%s)
      WEEK_AGO=$((NOW - 604800))
      call_api "instagram_basic — Account insights (/me/insights)" \
        "${IG_BASE}/me/insights?metric=impressions,reach,profile_views&period=day&since=${WEEK_AGO}&until=${NOW}&access_token=${IG_TOKEN}"

    else
      printf "\n${RED}Could not get IG User ID — token may be invalid or expired${NC}\n"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
#  FACEBOOK / PAGES / ADS / BUSINESS (using graph.facebook.com + EAA token)
# ═══════════════════════════════════════════════════════════════════════════════
if [[ "$MODE" == "facebook" || "$MODE" == "all" ]]; then
  echo ""
  printf "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
  printf "${YELLOW}  FACEBOOK / PAGES / ADS / BUSINESS (graph.facebook.com)${NC}\n"
  printf "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

  if [ -z "$FB_TOKEN" ]; then
    printf "\n${RED}No META_TOKEN set — skipping all Facebook tests${NC}\n"
    printf "${YELLOW}To generate a Facebook User Token:${NC}\n"
    printf "${YELLOW}  1. Go to https://developers.facebook.com/tools/explorer/${NC}\n"
    printf "${YELLOW}  2. Select your Meta App${NC}\n"
    printf "${YELLOW}  3. Click 'Get User Access Token'${NC}\n"
    printf "${YELLOW}  4. Check all permissions you need${NC}\n"
    printf "${YELLOW}  5. Click 'Generate Access Token'${NC}\n"
    printf "${YELLOW}  6. Run: META_TOKEN=\"EAA...\" ./server/scripts/test-meta-permissions.sh facebook${NC}\n"
  else
    # ── Basic identity ───────────────────────────────────────────────────────
    call_api "identity — /me (Facebook user)" \
      "${FB_BASE}/me?fields=id,name,email&access_token=${FB_TOKEN}"

    # ── pages_show_list ──────────────────────────────────────────────────────
    call_api "pages_show_list — /me/accounts" \
      "${FB_BASE}/me/accounts?fields=id,name,category,access_token&access_token=${FB_TOKEN}"

    # Extract page info
    PAGE_ID=$(curl -s "${FB_BASE}/me/accounts?fields=id&access_token=${FB_TOKEN}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('data', [{}])[0].get('id', ''))
except: pass
" 2>/dev/null)

    PAGE_TOKEN=$(curl -s "${FB_BASE}/me/accounts?fields=id,access_token&access_token=${FB_TOKEN}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('data', [{}])[0].get('access_token', ''))
except: pass
" 2>/dev/null)

    IG_BIZ_ID=$(curl -s "${FB_BASE}/me/accounts?fields=instagram_business_account&access_token=${FB_TOKEN}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    igba = d.get('data', [{}])[0].get('instagram_business_account', {})
    print(igba.get('id', ''))
except: pass
" 2>/dev/null)

    printf "    ${CYAN}Page ID: ${PAGE_ID:-<none>}${NC}\n"
    printf "    ${CYAN}Page Token: ${PAGE_TOKEN:+available}${PAGE_TOKEN:-(none)}${NC}\n"
    printf "    ${CYAN}IG Business Account: ${IG_BIZ_ID:-<none>}${NC}\n\n"

    # ── Pages permissions ────────────────────────────────────────────────────
    if [ -n "$PAGE_ID" ] && [ -n "$PAGE_TOKEN" ]; then
      call_api "pages_read_engagement — Page feed (/${PAGE_ID}/feed)" \
        "${FB_BASE}/${PAGE_ID}/feed?fields=id,message,created_time,shares,likes.summary(true),comments.summary(true)&limit=3&access_token=${PAGE_TOKEN}"

      call_api "pages_read_user_content — Tagged posts (/${PAGE_ID}/tagged)" \
        "${FB_BASE}/${PAGE_ID}/tagged?fields=id,message,from&limit=3&access_token=${PAGE_TOKEN}"

      call_api "pages_manage_metadata — Page details (/${PAGE_ID})" \
        "${FB_BASE}/${PAGE_ID}?fields=id,name,about,category,fan_count,website,hours,location&access_token=${PAGE_TOKEN}"

      call_api "pages_messaging — Conversations (/${PAGE_ID}/conversations)" \
        "${FB_BASE}/${PAGE_ID}/conversations?fields=id,updated_time,participants,message_count&limit=3&access_token=${PAGE_TOKEN}"

      call_api "pages_manage_conversations — Conversation detail" \
        "${FB_BASE}/${PAGE_ID}/conversations?fields=id,snippet,updated_time,message_count&limit=3&access_token=${PAGE_TOKEN}"

      # ── IG Business via Page token ─────────────────────────────────────────
      if [ -n "$IG_BIZ_ID" ]; then
        call_api "instagram_basic (via Page) — IG profile (/${IG_BIZ_ID})" \
          "${FB_BASE}/${IG_BIZ_ID}?fields=id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count&access_token=${PAGE_TOKEN}"

        call_api "instagram_basic (via Page) — IG media (/${IG_BIZ_ID}/media)" \
          "${FB_BASE}/${IG_BIZ_ID}/media?fields=id,caption,media_type,timestamp,permalink&limit=3&access_token=${PAGE_TOKEN}"

        call_api "instagram_manage_messages (via Page) — IG conversations" \
          "${FB_BASE}/${IG_BIZ_ID}/conversations?fields=id,updated_time,participants&platform=instagram&limit=3&access_token=${PAGE_TOKEN}"
      fi
    else
      skip_test "pages_read_engagement — no Page ID/Token"
      skip_test "pages_read_user_content — no Page ID/Token"
      skip_test "pages_manage_metadata — no Page ID/Token"
      skip_test "pages_messaging — no Page ID/Token"
    fi

    # ── business_management ──────────────────────────────────────────────────
    call_api "business_management — /me/businesses" \
      "${FB_BASE}/me/businesses?fields=id,name,verification_status&access_token=${FB_TOKEN}"

    BUSINESS_ID=$(curl -s "${FB_BASE}/me/businesses?fields=id&access_token=${FB_TOKEN}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('data', [{}])[0].get('id', ''))
except: pass
" 2>/dev/null)

    # ── ads_read / ads_management ────────────────────────────────────────────
    call_api "ads_read — /me/adaccounts" \
      "${FB_BASE}/me/adaccounts?fields=id,name,account_status,currency,business&limit=5&access_token=${FB_TOKEN}"

    AD_ACCOUNT_ID=$(curl -s "${FB_BASE}/me/adaccounts?fields=id&limit=1&access_token=${FB_TOKEN}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('data', [{}])[0].get('id', ''))
except: pass
" 2>/dev/null)

    if [ -n "$AD_ACCOUNT_ID" ]; then
      call_api "ads_read — Account details (/${AD_ACCOUNT_ID})" \
        "${FB_BASE}/${AD_ACCOUNT_ID}?fields=id,name,account_status,currency,amount_spent,balance,spend_cap&access_token=${FB_TOKEN}"

      call_api "ads_read — Campaigns (/${AD_ACCOUNT_ID}/campaigns)" \
        "${FB_BASE}/${AD_ACCOUNT_ID}/campaigns?fields=id,name,status,objective,daily_budget&limit=5&access_token=${FB_TOKEN}"

      call_api "ads_read — Insights (/${AD_ACCOUNT_ID}/insights)" \
        "${FB_BASE}/${AD_ACCOUNT_ID}/insights?fields=impressions,clicks,spend,cpc,cpm&date_preset=last_7d&access_token=${FB_TOKEN}"
    else
      skip_test "ads_management — no Ad Account found"
    fi

    # ── WhatsApp Business ────────────────────────────────────────────────────
    if [ -n "$BUSINESS_ID" ]; then
      call_api "whatsapp_business_management — WABA list" \
        "${FB_BASE}/${BUSINESS_ID}/owned_whatsapp_business_accounts?fields=id,name,currency,message_template_namespace&access_token=${FB_TOKEN}"

      WABA_ID=$(curl -s "${FB_BASE}/${BUSINESS_ID}/owned_whatsapp_business_accounts?fields=id&access_token=${FB_TOKEN}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('data', [{}])[0].get('id', ''))
except: pass
" 2>/dev/null)

      if [ -n "$WABA_ID" ]; then
        call_api "whatsapp_business_management — Phone numbers (/${WABA_ID}/phone_numbers)" \
          "${FB_BASE}/${WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&access_token=${FB_TOKEN}"

        call_api "whatsapp_business_messaging — Templates (/${WABA_ID}/message_templates)" \
          "${FB_BASE}/${WABA_ID}/message_templates?fields=id,name,status,language,category&limit=5&access_token=${FB_TOKEN}"
      else
        skip_test "whatsapp_business_messaging — no WABA found"
      fi
    else
      skip_test "whatsapp_business_management — no Business ID found"
    fi
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "=============================================="
printf "  ${GREEN}Passed: %d${NC}  ${RED}Failed: %d${NC}  ${YELLOW}Skipped: %d${NC}  Total: %d\n" "$passed" "$failed" "$skipped" "$total"
echo "=============================================="
echo ""

if [ "$passed" -gt 0 ]; then
  printf "${GREEN}✓ %d API calls succeeded. Meta should register them within 24 hours.${NC}\n" "$passed"
  printf "  Check: https://developers.facebook.com/apps → App Review → Permissions\n"
fi

if [ "$failed" -gt 0 ]; then
  echo ""
  printf "${YELLOW}Tips for failed calls:${NC}\n"
  printf "  • IGAA tokens (Instagram) → use with graph.instagram.com (mode: instagram)\n"
  printf "  • EAA tokens (Facebook) → use with graph.facebook.com (mode: facebook)\n"
  printf "  • Generate Facebook tokens at: https://developers.facebook.com/tools/explorer/\n"
  printf "  • Make sure to select ALL needed permissions when generating the token\n"
fi
echo ""
