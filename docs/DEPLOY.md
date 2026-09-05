# Deploying to Railway

Ten minutes, most of it waiting for a build. `railway.json` is committed; the
rest is four settings in their dashboard.

## 1. Create the service

<https://railway.app> → **New Project** → **Deploy from GitHub repo** → this
repo. Railway reads `railway.json` and uses Nixpacks — no Dockerfile needed.

## 2. Attach a volume — do this before the first deploy

**This is the step that matters.** A container filesystem is wiped on every
redeploy. The audit ledger is a SQLite file, and a project whose central claim
is *"the record outlives the process that wrote it"* cannot ship a ledger that
resets when the app does.

Service → **Variables** → **+ Volume**

| | |
|---|---|
| Mount path | `/data` |

Then set `LEDGER_PATH=/data/console.db` below, and the chain survives deploys.
Without it the console still runs, but every redeploy starts the ledger at row
1 — and someone will notice.

## 3. Variables

Service → **Variables** → **Raw editor**:

```
GEMINI_API_KEY=…
RAZORPAY_KEY_ID=rzp_test_…
RAZORPAY_KEY_SECRET=…
LEDGER_PATH=/data/console.db
LLM_MODE=cassette
AUTHORIZE_MODE=sim
NODE_ENV=production
```

`LLM_MODE=cassette` is the deliberate choice for a hosted demo. The 52
recordings in `cassettes/console/` are committed, so every persona replays in
about 100ms with no API key spend and no rate limit — and the gate, the
detectors, the signing and the audit chain all still run live, because none of
them are downstream of the model. Set `LLM_MODE=live` if you want a public URL
that calls Gemini on free-typed messages, and expect ~45s per turn.

Nothing here is committed. `.env` is gitignored and Railway holds the real
values.

## 4. Generate a domain

Service → **Settings** → **Networking** → **Generate Domain**.

Railway sets `PORT`; the start command in `railway.json` already binds to it and
to `0.0.0.0`, which a container needs and `next start` does not do by default.

---

## What works on the hosted URL

Everything except the parts that need a human or a terminal.

| | |
|---|---|
| The negotiation, the gate, the ratchet, the collapse | ✅ |
| The audit trail, hash-chained, surviving redeploys | ✅ *with the volume* |
| The counterparty check on every signed offer | ✅ |
| **Pay by card** — real Razorpay Checkout, real payment | ✅ |
| **Send a payment link** — real `plink_…` | ✅ |
| Onboarding, reading a real Razorpay Payment Page | ✅ |
| `pnpm demo`, `pnpm buy`, `pnpm revenue`, `pnpm tamper:check` | terminal only |

## Things that will bite

**better-sqlite3 is a native module.** Nixpacks compiles it during install, which
is why the build takes a few minutes the first time. If it fails, the log will
name Python or `node-gyp` — add `NIXPACKS_PKGS=python3` and redeploy.

**pnpm workspaces.** The build and start commands both use `--filter
@counterparty/web` so Railway operates on the app rather than the repo root.
Leaving that off builds nothing and starts nothing.

**Razorpay keys are test mode.** Keep them that way. A public URL with live keys
is a public URL that can move real money.
