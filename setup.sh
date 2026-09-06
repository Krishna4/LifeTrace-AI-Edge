#!/usr/bin/env bash
# LifeTrace AI — Generic One-Click Cloudflare Edge Deployment Script
# Anyone can clone this repository and deploy their own private LifeTrace AI in < 2 minutes.

set -e

echo "=========================================================="
echo "🌱 LifeTrace AI — One-Click Serverless Edge Setup"
echo "=========================================================="
echo "Deploys a 100% Free-Tier Personal RAG & Telegram Life Ledger."
echo "Stack: Cloudflare Workers + D1 SQLite + Vectorize + Workers AI"
echo "Cost: $0.00 / month (Runs within Cloudflare daily free limits)"
echo ""

# 1. Check Wrangler CLI & Authentication
if ! npx wrangler whoami > /dev/null 2>&1; then
  echo "🔑 Cloudflare authentication required."
  echo "👉 Opening Cloudflare login in your browser..."
  npx wrangler login
fi

echo "✅ Authenticated with Cloudflare."

# 2. Prepare wrangler.toml
if [ ! -f "wrangler.toml" ]; then
  echo "📄 Creating wrangler.toml from template..."
  cp wrangler.toml.example wrangler.toml
fi

# 3. Create or Link D1 Database
echo "🗄️ Checking / Creating Cloudflare D1 Database (personal-rag-db)..."
D1_CREATE_OUT=$(npx wrangler d1 create personal-rag-db 2>&1 || true)
DB_ID=$(echo "$D1_CREATE_OUT" | grep -o 'database_id = "[^"]*"' | head -n1 | cut -d'"' -f2 || true)

if [ -z "$DB_ID" ]; then
  # Already created, extract UUID from list
  DB_ID=$(npx wrangler d1 list --json 2>/dev/null | grep -B 2 -A 5 '"name": "personal-rag-db"' | grep '"uuid"' | head -n1 | cut -d'"' -f4 || true)
fi

if [ -n "$DB_ID" ]; then
  echo "✅ Linked D1 Database ID: $DB_ID"
  # Substitute in wrangler.toml
  sed -i.bak -e "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml && rm -f wrangler.toml.bak
else
  echo "⚠️ Could not auto-extract D1 ID. If deploying for the first time, check wrangler.toml."
fi

# 4. Apply Schema to D1
echo "📝 Applying database schema to remote D1..."
npx wrangler d1 execute personal-rag-db --file=schema.sql --remote

# 5. Create Vectorize Index
echo "🔍 Checking / Creating Cloudflare Vectorize Index (personal-rag-vectors)..."
npx wrangler vectorize create personal-rag-vectors --dimensions=384 --metric=cosine 2>&1 || echo "ℹ️ Vectorize index is ready."

# 6. Optional Telegram Credentials Setup
echo ""
read -p "📲 Do you want to configure Telegram Bot secrets now? (y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "Enter your Telegram credentials:"
  npx wrangler secret put TELEGRAM_BOT_TOKEN
  npx wrangler secret put TELEGRAM_CHAT_ID
  npx wrangler secret put API_KEY
fi

# 7. Deploy to Edge
echo ""
echo "🚀 Deploying your LifeTrace AI Worker to Cloudflare Edge..."
DEPLOY_RES=$(npx wrangler deploy)
echo "$DEPLOY_RES"

WORKER_URL=$(echo "$DEPLOY_RES" | grep -o 'https://[^ ]*\.workers\.dev' | head -n1 || true)

echo ""
echo "=========================================================="
echo "🎉 DEPLOYMENT COMPLETE!"
if [ -n "$WORKER_URL" ]; then
  echo "🌐 Your Private LifeTrace Edge URL: $WORKER_URL"
  echo ""
  echo "📲 To connect your Telegram Bot, run:"
  echo "   curl -F \"url=$WORKER_URL/telegram/webhook\" \\"
  echo "     https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook"
fi
echo "=========================================================="
