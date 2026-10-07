# Deploying formatAI (the owner's checklist)

One Render web service on its `onrender.com` address, one MongoDB Atlas cluster. The service serves the web app and `/api` from
the same origin, so cookies stay first-party and there is no CORS (`render.yaml`, `apps/api/src/web.ts`, SPEC 21 v13).
Every secret goes into Render's environment (the Blueprint asks for it); none goes into the repository or into a chat.

`<host>` below is your service's hostname, e.g. `formatai.onrender.com`. Render shows it under the service name once the service
exists; if `formatai` was taken, Render adds a suffix, and that is the host you use everywhere.

Order: 1 Atlas, 2 Anthropic, 2b OpenAI (the fallback), 3 Render (this creates the host), 4 Google, 5 Turnstile, 6 Microsoft, 7 admin,
8 smoke test.

## 1. MongoDB Atlas

1. Create a cluster (Free M0 is enough to start), cloud AWS, region Frankfurt (`eu-central-1`) to sit next to Render's Frankfurt region.
2. **Database Access** > Add New Database User > password authentication. User `formatai`, a long generated password made of
   letters and digits only (so it needs no URL escaping). Built-in role: **Read and write to any database** is the simplest; the
   tighter choice is a custom privilege `readWrite` on the database `formatai` only. The API creates its collections and indexes on start.
3. **Network Access** > Add IP Address. Two choices, said plainly:
   - `0.0.0.0/0` (allow from anywhere): works with any Render IP, now and later. Anyone on the internet can try to connect; what stops them
     is TLS plus the password, so the password must be strong and the user least-privileged. **Recommended to start.**
   - Render's outbound IP ranges (Render dashboard > your service > Connect > Outbound): only those addresses can even try. They are
     shared with other Render customers (it narrows who can knock, it does not replace the password), and if Render adds a range
     the database connection stops until you add it. Switch to this when you want to tighten.
4. **Connect** > Drivers: copy the connection string. It looks like
   `mongodb+srv://formatai:<password>@<cluster>.<id>.mongodb.net/?retryWrites=true&w=majority`. Replace `<password>`. This whole string is `MONGODB_URI`.
   The database name is a separate variable (`MONGODB_DB=formatai`, already in `render.yaml`); the string needs no `/formatai` path.

## 2. Anthropic

1. console.anthropic.com > API keys > Create key (`formatai-prod`). This is `ANTHROPIC_API_KEY`. It is shown once.
2. **Set a monthly spend limit** (Console > Settings > Limits; SPEC 9.5 "also set a monthly spend limit in the provider's console").
   Pick an amount you could lose. The app has its own daily kill switch (`limits.budgets.dailyOverallUsd`, 50 USD a day today, a
   placeholder), which is far above any sane monthly cap, so this console limit is the one that protects your wallet.
3. Check the key from your own computer before you put it in Render: in the repository's `.env`, set `ANTHROPIC_API_KEY`, then run
   `pnpm --filter @formatai/api llm-check -- --provider anthropic`. It makes ONE small real learn call (a made-up customer list, masked)
   and prints the model, the time, the tokens, whether the answer was cut off and whether it passed the checks. It never prints the key.

## 2b. OpenAI (the fallback)

When Anthropic cannot answer a call - an outage, a timeout, a rate limit, its "overloaded" error, or a key it rejects - the same call is
made once more on OpenAI (`gpt-5-mini` for a first try or a repair, `gpt-5` for an escalation), and the user's learn goes on. After 3
such failures in a row, every call goes straight to OpenAI for 5 minutes, then Anthropic is tried again (`limits.llm.fallback`). A wrong
answer is never sent to OpenAI: only a call Anthropic could not serve. Each call in Atlas `llm_calls` says which provider and model
answered, and a fallback call has `fallback: true` and the reason; the admin overview counts them ("Calls made by the fallback provider").

1. platform.openai.com: first create a **project made for this app** (`formatai`), so its usage, rate limits and spend limit are its own.
   In that project: **API keys** > Create new secret key, named `formatai-prod`. Give it an expiry date and put the date in your calendar
   (OpenAI recommends keys that expire and a rotation habit). This is `OPENAI_API_KEY`. It is shown once.
2. **Set a monthly limit** on the **Limits** page (platform.openai.com/settings/organization/limits, or the project's own limits): a
   **spend alert** emails you past an amount, and a **hard spend limit** stops the project's calls at its cap (they get a 429; OpenAI's
   "spend limits" guide explains it). Pick an amount you could lose. Billing information must be on the account for the key to work at
   all. Like Anthropic's console limit (2.2), this is the one that protects your wallet.
3. Check the key from your own computer: set `OPENAI_API_KEY` in the repository's `.env` and run
   `pnpm --filter @formatai/api llm-check -- --provider openai` (one small call, as in 2.3).
4. In Render it is asked for when the Blueprint is created (`OPENAI_API_KEY`, step 3.2). `render.yaml` already sets
   `LLM_FALLBACK_PROVIDER=openai`: the start check refuses to start without the key.

**Turning the fallback off:** Render > service > **Environment** > delete `LLM_FALLBACK_PROVIDER` > Save (Render redeploys). Every call then
stays on Anthropic, and a call it cannot serve fails as before (it is never counted against the user). `OPENAI_API_KEY` can stay or go.
To use other OpenAI models for it, set `LLM_FALLBACK_MODEL_FIRST_TRY` / `LLM_FALLBACK_MODEL_ESCALATION` (a model `apps/api/src/llm/providers/openai.ts`
knows: the GPT-5 family; anything else needs its row there first).

## 3. Render

1. render.com > New > **Blueprint** > connect the GitHub repository > the branch that has `render.yaml` (`main` once the deploy work is merged). The service starts on Render's **free** plan (no payment method needed; it sleeps after 15 idle minutes and the next visitor waits about a minute). When real users arrive, change `plan: free` to `plan: starter` in `render.yaml` (or the instance type in the dashboard).
2. Render lists the service `formatai` and asks for every `sync: false` value. Enter:

   | Question | Enter |
   |---|---|
   | `MONGODB_URI` | the string from 1.4 |
   | `ANTHROPIC_API_KEY` | the key from 2.1 |
   | `OPENAI_API_KEY` | the key from 2b.1 (the fallback; to run without one, see "Turning the fallback off" in 2b) |
   | `ADMIN_EMAILS` | your Google email (comma-separated for more). See 7 |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | the word `pending` for now: you cannot have them before the host exists. Steps 4 and 5 replace them |

   **And add `TURNSTILE_DISABLED` = `true`** (Environment > Add): Cloudflare's Turnstile widget wants a live hostname, and the service won't start without Turnstile otherwise. While it is on, Turnstile is off on purpose (the start log says so, and visitors are protected by the rate limits only). Step 5 removes it.

   `SESSION_SECRET` and `IP_HASH_SECRET` are generated by Render; you never see or type them.
3. Apply. The first build takes a few minutes (`pnpm install`, then `pnpm build`). When it is live, note `<host>`.
4. Whenever you change a value later: service > **Environment** > edit > Save: Render redeploys.

If the build log says Node 24 is not accepted, set `NODE_VERSION` to a full version (e.g. `24.11.0`).
If the deploy fails after the build with "formatAI cannot start in production", the log lists every setting that is missing or
malformed, by name (never the value). Fix them and redeploy; the previous version keeps serving meanwhile.

## 4. Google sign-in

1. console.cloud.google.com > create or pick a project > **APIs & Services** > **OAuth consent screen**: External, app name, your support
   email. Scopes: `openid`, `email`, `profile` (no verification needed for these). **Publishing status: In production** (in Testing
   only listed test users can sign in).
2. **Credentials** > Create credentials > OAuth client ID > **Web application**.
   - Authorized JavaScript origins: `https://<host>`
   - Authorized redirect URIs: `https://<host>/api/auth/google/callback` (exactly this path)
3. Copy the Client ID and Client secret into Render (Environment): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
   To also try it locally: add `http://localhost:8787/api/auth/google/callback` as a second redirect URI.

## 5. Cloudflare Turnstile

1. dash.cloudflare.com > **Turnstile** > Add widget. Hostname: `<host>` (the exact hostname, not `onrender.com`). Mode: Managed.
2. Copy the **site key** into `TURNSTILE_SITE_KEY` and the **secret key** into `TURNSTILE_SECRET_KEY` (Render > Environment).
3. **Delete `TURNSTILE_DISABLED`** in the same screen, then save (Render redeploys with Turnstile on). Check: the start log no longer says "Turnstile is OFF".
   The site key is public and the API hands it to the browser at runtime (`GET /api/session`), so the web build needs no key and
   nothing has to be rebuilt when it changes.

## 6. Microsoft sign-in (Entra)

Optional on day one: a provider is offered only when both its id and secret are set. Register when you want it.

1. entra.microsoft.com (or portal.azure.com) > **App registrations** > New registration.
   - Name: formatAI.
   - **Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"** (the API uses the `common` endpoint).
   - Redirect URI: platform **Web**, `https://<host>/api/auth/microsoft/callback`.
2. **Overview**: copy **Application (client) ID** > `MICROSOFT_CLIENT_ID`.
3. **Certificates & secrets** > New client secret (24 months; put the expiry in your calendar). Copy the **Value** (not the Secret ID) right
   away > `MICROSOFT_CLIENT_SECRET`.
4. **API permissions**: Microsoft Graph, delegated: `openid`, `email`, `profile` (the default `User.Read` can stay).
   **Token configuration** > Add optional claim > ID token > `email`.
5. Add `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` in Render (Environment). The sign-in page then offers Microsoft.

The account is identified by the ID token's `tid` + `oid` (never the email). Before approaching companies, complete Microsoft publisher
verification (SPEC 12): many company tenants refuse apps from unverified publishers. Personal accounts are not affected.

## 7. Making yourself admin

An admin is a signed-in user with a **verified Google email** listed in `ADMIN_EMAILS`, or a Microsoft account whose **object id** is
listed in `MICROSOFT_ADMIN_OIDS` (comma-separated; `oid`, or `tid:oid` to pin the tenant). Case does not matter, and changes apply on the next request.

- Google: nothing to look up. Put the email you sign in with in `ADMIN_EMAILS`.
- Microsoft: the email never grants admin (Microsoft does not verify it), so you need your `oid`. Sign in once with Microsoft, then in Atlas
  > Browse Collections > `formatai.users`: your user's `identities` entry has `provider: "microsoft"`, `subject` (this is the `oid`) and `tenantId`
  (the `tid`; personal Microsoft accounts all share `9188040d-6c67-4c5b-b112-36a304b66dad`). Put the `subject` into `MICROSOFT_ADMIN_OIDS`.
  (For a work account the same id is also "Object ID" under Entra > Users.)

## 8. Smoke test (after every deploy that matters)

Use `eval/cases/` as the examples: `orders-dedupe` (solved on your computer) and `branch-lookup-50` (needs the AI).

1. **Health**: open `https://<host>/api/health`: `{"ok":true,"db":"connected"}`. `"db":"error"`: the URI is wrong or Atlas Network Access blocks Render (1.3). `"not configured"`: `MONGODB_URI` is missing.
2. **The page**: `https://<host>/` loads (Hebrew or English by your browser) and a deep link such as `https://<host>/formats` loads too. The browser console has no red errors.
3. **Sign in**: Google, then Microsoft if configured. You come back to the site signed in, your name shows in the account menu, and `https://<host>/api/me` says `"isAdmin":true` for the admin.
4. **A free learn**: sign out or stay in. Drop `orders-dedupe/input.xlsx` and `output.csv` > Learn the format: verified, "solved on your computer", no AI call (no `/api/learn` request in the Render log).
5. **An AI learn**: signed in, drop `branch-lookup-50/input.xlsx` and `output.xlsx` > Learn with AI. There is no Turnstile check here: the AI learn is gated by the sign-in (with the per-user quota and daily request cap), and the answer verifies. Check that a row appeared in Atlas `llm_calls` (`provider: "anthropic"`, no `fallback`) and the spend in `budgets`, and the usage in the Anthropic console.
   The fallback itself is checked from your computer (`llm-check`, 2b.3); a row with `fallback: true` in `llm_calls` later means Anthropic could not serve that call.
6. **The Run screen**: save that format, open **Convert** (`/convert`), drop `next.input.xlsx` of the same case, create the file, and check it against `next.output.xlsx`.

## Rolling back

- **A bad deploy**: Render > service > **Deploys** (or Events) > pick the last good deploy > **Rollback**. It redeploys that build (the
  environment variables are NOT rolled back: they are as they are now). To stop new commits deploying meanwhile: Settings > Auto-Deploy > Off.
- **A bad setting**: change it back under Environment; Render redeploys.
- **The data**: a code rollback does not touch MongoDB. The free M0 cluster has no backups; paid Atlas tiers do (Atlas > Backup).
  Nothing in the database is a user's file (SPEC 15), only accounts, formats' rules, counters and the ledger.

## Every environment variable

| Name | Set by | Purpose / where it comes from |
|---|---|---|
| `NODE_ENV=production` | `render.yaml` | Secure cookies, no dev routes, the web app served by the API, the start check |
| `NODE_VERSION=24` | `render.yaml` | Node version on Render |
| `LLM_PROVIDER=anthropic` | `render.yaml` | The production LLM is the Anthropic API (the start check refuses `claude-cli` and `fake`) |
| `LLM_FALLBACK_PROVIDER=openai` | `render.yaml` | The fallback for a call Anthropic cannot serve (2b). Delete it to turn the fallback off |
| `TRUST_PROXY=true` | `render.yaml` | Real client IP behind Render's proxy for the per-IP limits (see Known limits) |
| `MONGODB_DB=formatai` | `render.yaml` | Database name inside the cluster |
| `SESSION_SECRET` | Render (generated) | Signs the session and sign-in cookies; 32+ characters; changing it signs everyone out |
| `IP_HASH_SECRET` | Render (generated) | Keys the per-IP counters and learn ids; 32+ characters |
| `MONGODB_URI` | you (3.2) | Atlas connection string (1.4) |
| `ANTHROPIC_API_KEY` | you (3.2) | Anthropic console (2.1) |
| `OPENAI_API_KEY` | you (3.2) | OpenAI platform, the app's own project (2b.1); required while `LLM_FALLBACK_PROVIDER=openai` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | you (4.3) | Google Cloud OAuth client |
| `TURNSTILE_SITE_KEY` | you (5.2) | Cloudflare Turnstile widget, public; served to the browser at runtime |
| `TURNSTILE_SECRET_KEY` | you (5.2) | Cloudflare Turnstile widget, secret |
| `ADMIN_EMAILS` | you (3.2) | Verified Google emails that open the admin view |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | you, later (6) | Entra app registration |
| `MICROSOFT_ADMIN_OIDS` | you, later (7) | Microsoft object ids that open the admin view |
| `RENDER_EXTERNAL_URL` | Render | Your `https://<host>`; the public origin when `PUBLIC_ORIGIN` is not set |
| `PUBLIC_ORIGIN` | optional | Overrides the origin (a custom domain later). Defaults `WEB_ORIGIN` and `API_PUBLIC_URL`, which can still be set on their own |
| `PORT` | Render | Render sets 10000; the API listens on it |
| `WEB_ORIGIN`, `API_PUBLIC_URL` | optional | The web origin (CORS, redirects after sign-in) and the API's public URL (the OIDC redirect URIs). Both default to the public origin above; set only to split them |
| `WEB_DIST` | optional | Folder of the built web app; default `apps/web/dist` |
| `TURNSTILE_DISABLED` | you, first deploy only (3.2) | `true` turns Turnstile off on purpose until the widget exists (the start log warns). Delete it in step 5 |
| `LEARN_CHECKS` | optional, not set | AI code checks (SPEC 21 v14): `off`, `admin` (admin accounts only) or `all`. Unset = `off`. Any other value stops the start. Listed, commented, in `render.yaml` |
| `LLM_MODEL_FIRST_TRY`, `LLM_MODEL_ESCALATION` | optional | Override the models in `packages/shared/src/config/models.ts` without a code change. The model must have a price in `packages/shared/src/config/prices.ts` (the same for `LLM_FALLBACK_MODEL_*`): a production start stops on one that has none, and an unpriced model is counted at the highest configured price |
| `LLM_FALLBACK_MODEL_FIRST_TRY`, `LLM_FALLBACK_MODEL_ESCALATION` | optional | The same for the fallback provider's two slots (default `gpt-5-mini`, `gpt-5`) |
| `VITE_TURNSTILE_SITE_KEY` | development only | The older name of `TURNSTILE_SITE_KEY` (read when that one is not set); not needed on Render |
| `DEV_SIGN_IN` | development only | `true` offers the throw-away dev sign-in from another address (a phone on the LAN, a tunnel). Never available in production, whatever it says |
| `CLAUDE_CLI_PATH` | development only | The Claude Code CLI for `LLM_PROVIDER=claude-cli`, which the production start refuses |

## Known limits

- **`TRUST_PROXY=true` and spoofed IPs.** It trusts the whole `X-Forwarded-For` chain, taking its first address as the client. Render's proxy
  appends to what the client sent rather than replacing it (the community reports disagree on the details), so a determined client can invent
  its IP and slip the per-IP request limit. That limit is one of several guards: the AI step is for signed-in users only (no Turnstile there: the sign-in is
  the gate), with a per-user quota, a per-user daily request cap, and the daily budget. To tighten: count the hops (e.g. `TRUST_PROXY=2`) once you can see the real addresses in a test request, and change the variable.
  **Owner action (API audit, 2026-10-07): set `TRUST_PROXY` to the measured hop count** in the Render dashboard (Environment), not `true`:
  send one request with a made-up `X-Forwarded-For: 203.0.113.9` header and see which address the API takes for you - the hop count is the
  number of proxies between you and the service (Render's own, usually 1). With `true`, a client that rotates the header gets a fresh
  per-IP allowance on every request; the public forms are now also held to a global daily cap (`limits.contact.globalPerDay`, 200
  stored a day) and the AI to a per-user daily request cap (`limits.protection.aiRequestsPerDay`), so a spoofed address cannot fill the
  database or spend the budget, but the per-IP limits only mean something with the right count. (`render.yaml` keeps `true` until you
  have measured it.)
- **Turnstile must be turned back on (owner action).** `TURNSTILE_DISABLED=true` was for the first deploy only (section 3): while it is
  set the public forms (the only place Turnstile checks: a visitor who is not signed in) are protected by the rate limits alone. Do section 5 - set `TURNSTILE_SITE_KEY` and
  `TURNSTILE_SECRET_KEY`, delete `TURNSTILE_DISABLED` - and check that the start log no longer says "Turnstile is OFF".
- **The public forms' global cap.** Past `limits.contact.globalPerDay` stored submissions in a UTC day (leads, waitlist and feedback
  together), every form answers "too many requests" until the next UTC day - a flood from invented addresses stops the forms for a
  day rather than filling the Atlas storage. Raise it in config if real traffic ever comes close.
- **One instance.** The per-IP request limiter is in memory; keep `numInstances: 1` (usage counters, budgets and the cache are in MongoDB and are fine at any size).
- **Startup.** The API runs its TypeScript source through `tsx`, as in development: a start takes a couple of seconds longer than compiled code.
- **Custom domain later.** Add it in Render, set `PUBLIC_ORIGIN=https://that.domain`, and add the new redirect URIs / origin in Google, Entra and Turnstile (the old ones can stay until you switch).

## Running the production build on your own machine

```
pnpm install --frozen-lockfile && pnpm build
# set NODE_ENV=production, PORT (a spare one), PUBLIC_ORIGIN=http://localhost:<PORT>, MONGODB_URI (a local MongoDB), MONGODB_DB (a test name),
# LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY, SESSION_SECRET and IP_HASH_SECRET (32+ characters), the Google ids, and Cloudflare's
# test Turnstile keys (site 1x00000000000000000000AA, secret 1x0000000000000000000000000000000AA)
cd apps/api && node --import tsx src/index.ts
```

Missing settings are listed by name when it starts.
