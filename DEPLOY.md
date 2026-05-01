# RxVault Platform — Deployment Guide
# ============================================================
# Follow these steps exactly. Takes about 2 hours start to finish.
# ============================================================

## STEP 1 — Create Supabase Database (10 min)

1. Go to https://supabase.com → New Project
2. Choose a name: "rxvault-prod"
3. Set a strong database password (save it somewhere)
4. Region: US East (closest to Railway)
5. Once created → SQL Editor → paste the entire contents of db/schema.sql → Run
6. Copy your:
   - Database URL (Settings → Database → Connection string → URI)
   - Project URL (Settings → API → Project URL)
   - Service Role Key (Settings → API → service_role key)

---

## STEP 2 — Deploy Backend to Railway (15 min)

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Push this backend folder to a GitHub repo first:
   ```
   git init
   git add .
   git commit -m "Initial RxVault backend"
   git remote add origin https://github.com/YOUR_USERNAME/rxvault-backend.git
   git push -u origin main
   ```
3. In Railway: select your repo → it auto-detects Node.js
4. Add environment variables (Variables tab) — copy from .env.example and fill in:

   Required first (platform won't start without these):
   DATABASE_URL          = (from Supabase Step 1)
   PCP_PARTNER_ID        = FEB64BC3-3EE1-4264-A699-59454C07A089
   JWT_SECRET            = (generate: openssl rand -base64 64)
   NODE_ENV              = production

   Add these as you set up each service:
   TWILIO_ACCOUNT_SID    = (from twilio.com)
   TWILIO_AUTH_TOKEN     = (from twilio.com)
   TWILIO_PHONE_NUMBER   = (buy a number at twilio.com ~$1/mo)
   STRIPE_SECRET_KEY     = (from stripe.com → Developers → API Keys)
   STRIPE_WEBHOOK_SECRET = (from stripe.com → Webhooks)
   KLAVIYO_API_KEY       = (from klaviyo.com → Account → API Keys)
   BASE_DOMAIN           = yourdomain.com

5. Railway gives you a URL like: rxvault-backend.up.railway.app
6. Test it: visit https://rxvault-backend.up.railway.app/health → should return {"status":"ok"}

---

## STEP 3 — Sync PCP Product Catalog (5 min)

Once backend is running, call the sync endpoint once to populate your database:

```bash
curl -X POST https://rxvault-backend.up.railway.app/api/products/sync \
  -H "Authorization: Bearer YOUR_ADMIN_JWT"
```

Or call it from the admin panel once you're logged in.

---

## STEP 4 — Set Up Twilio (10 min)

1. Go to https://twilio.com → Sign up
2. Get Account SID and Auth Token from dashboard
3. Buy a phone number (~$1/month) → add to TWILIO_PHONE_NUMBER env var
4. Add your Railway backend URL as a webhook for inbound SMS (optional)

---

## STEP 5 — Set Up Stripe (10 min)

1. Go to https://stripe.com → Activate your account
2. Developers → API Keys → copy Secret Key → add to STRIPE_SECRET_KEY
3. Developers → Webhooks → Add endpoint:
   URL: https://rxvault-backend.up.railway.app/api/webhooks/stripe
   Events: payment_intent.succeeded, payment_intent.payment_failed
4. Copy the webhook signing secret → add to STRIPE_WEBHOOK_SECRET

---

## STEP 6 — Buy Your Domain + Set Up Cloudflare (20 min)

1. Buy domain at Namecheap or Google Domains (e.g., rxvault.com)
2. Sign up at https://cloudflare.com → Add Site → follow DNS migration steps
3. Once on Cloudflare:
   - Add A record: @ → points to Railway IP
   - Add CNAME: * → your Railway URL (for wildcard subdomains)
   - Enable "Proxied" on both records
4. Get your Zone ID from Cloudflare dashboard → add to CLOUDFLARE_ZONE_ID
5. Create API Token (My Profile → API Tokens → Create Token → "Edit zone DNS")
   → add to CLOUDFLARE_API_TOKEN

---

## STEP 7 — Deploy Frontend (15 min)

1. The frontend React app goes in a separate repo
2. In Vercel (free): import the frontend repo
3. Set environment variables:
   REACT_APP_API_URL = https://rxvault-backend.up.railway.app
   REACT_APP_STRIPE_PK = pk_live_your_stripe_publishable_key
4. Vercel auto-deploys on every git push

---

## STEP 8 — Create Your Admin Account

Run this SQL in Supabase to create JP's admin account:

```sql
INSERT INTO admins (email, password_hash, name)
VALUES (
  'jp@yourdomain.com',
  '$2b$12$REPLACE_WITH_BCRYPT_HASH',  -- use bcrypt to hash your password
  'Jonathan Padgett'
);
```

Or use this endpoint once (then disable it):
POST /api/auth/admin/setup
{ "email": "jp@...", "password": "...", "name": "Jonathan Padgett", "setupKey": "YOUR_SETUP_KEY" }

---

## MONTHLY COSTS

| Service       | Cost         |
|---------------|--------------|
| Railway       | ~$10-20/mo   |
| Supabase      | Free → $25   |
| Twilio SMS    | ~$0.0079/SMS |
| Stripe        | 2.9% + $0.30 |
| Cloudflare    | Free         |
| Vercel        | Free         |
| Domain        | ~$12/yr      |
| **TOTAL**     | **~$40-50/mo** |

---

## WHEN SOMETHING BREAKS

1. Check Railway logs (Deployments → View Logs)
2. Check Supabase logs (Logs → API logs)
3. Copy the error message → paste it to Claude → I'll fix it immediately
4. Common issues:
   - "Cannot connect to database" → check DATABASE_URL in Railway env vars
   - "JWT malformed" → check JWT_SECRET matches between deployments
   - "PCP API timeout" → PCP server is slow, retry is built in
   - "Twilio auth error" → check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN

---

## ENVIRONMENT VARIABLES CHECKLIST

Before going live, confirm these are all set in Railway:
[ ] DATABASE_URL
[ ] PCP_PARTNER_ID
[ ] JWT_SECRET
[ ] TWILIO_ACCOUNT_SID
[ ] TWILIO_AUTH_TOKEN
[ ] TWILIO_PHONE_NUMBER
[ ] STRIPE_SECRET_KEY
[ ] STRIPE_WEBHOOK_SECRET
[ ] KLAVIYO_API_KEY
[ ] BASE_DOMAIN
[ ] NODE_ENV=production
[ ] ALLOWED_ORIGINS
