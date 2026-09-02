# Corrections

Claims in the original design note that turned out to be wrong, what replaced
them, and the evidence. Kept in the repo because the reasoning is part of the
pitch: a mandate system whose authors did not check what the rails actually do
would be asserting exactly the thing it exists to disprove.

---

## C1 — Razorpay does not support partial capture

**Design note §5.3** proposed *"**partial capture** at the conceded amount —
negotiation settled lower"* as one of four things the agent could do inside the
authorization window, and listed it as money action #5 of 12.

**This primitive does not exist.** Razorpay's Capture API specifies the amount as
*"the amount to be captured (should be equal to the order amount, in the smallest
unit of the currency)"* and returns a documented `400` error:

> **Capture amount must be equal to the amount authorized.**
> The amount you are trying to capture differs from the authorised amount.

Source: [Capture a Payment — Razorpay API docs](https://razorpay.com/docs/api/payments/capture/)

**What survives.** The rest of §5.3 checks out. Payments do hold in the
`authorized` state and *"payments that are not captured within this period will be
refunded automatically to customers"* after **3 days**
([Payment Capture Settings](https://razorpay.com/docs/payments/payments/capture-settings/)).
So authorization-as-a-decaying-option is real. Only the partial-capture leg was
wrong.

Partial refunds *are* supported — *"make full or partial refunds to customers"*,
on payments in the `captured` state
([Refunds](https://razorpay.com/docs/api/refunds/)).

### The replacement

Two settlement paths, with a rule about which applies. The rule matters more than
the mechanism: "the gate picks" without a stated rule is just deferring the
decision.

**Path A — pre-auth concession. The default for all negotiation.**

```
negotiate → gate signs the final price → orders.create(conceded_amount)
          → authorize → capture(full)
```

Capture is always full-amount. Nothing is composed, nothing is worked around.
Because negotiation concludes *before* money is frozen, the conceded price is
simply the order amount.

**Path B — post-auth concession. The exception, and only these cases.**

Used when money is already frozen and cannot be rewound: partial fulfilment,
out-of-stock, a post-sale defect. One gate decision drives two rails calls:

```
gate.sign(concession)          ← ONE decision, ONE authorizing clause
  ├─ POST /payments/:id/capture   ₹4,990   (full — the API requires it)
  └─ POST /payments/:id/refund    ₹  750   (the delta)
     net settlement to merchant = ₹4,240 = the conceded price
```

Both calls are real Razorpay calls. The audit row carries both object IDs, the
net, and the reason the post-auth path was taken:

```
action=settle_at_conceded  net=₹4,240 (list ₹4,990, depth 15.0%)
  settlement_path=post_auth  reason=partial_fulfilment
  rails=[pay_XXXX:capture ₹4,990, rfnd_YYYY:refund ₹750]
  authorized_by=clause:authority.max_discount_depth_pct (15)
```

**Why this is better than the original claim.** The composite is honest about
what the rails do, it keeps all twelve money actions, and it forces the mandate
to say *when* each path is allowed rather than leaving settlement to whatever the
agent felt like. A primitive that did not exist was replaced by two that do, plus
a clause governing the choice between them.

---

## C2 — The envelope did not name the gate it delegates to

**Not an error in the note so much as a missing field**, but it breaks the
verification chain, so it belongs here.

The design note's envelope (§4) is signed by the merchant and describes the
authority granted — but never says *who* is authorized to exercise it. A buyer
agent verifying a signed offer could confirm that some gate approved the terms,
and separately that some merchant issued some envelope, with nothing binding the
two together. Any gate key could claim to be operating under any envelope.

**Added:** `gate_key: { kid, public_key_pem }` inside the signed body. The
merchant delegates to a specific key. Verification is now anchored:

1. merchant signature over the envelope — this merchant granted this authority
2. envelope is within `issued_at` / `expires_at`
3. gate signature over the offer, checked against `envelope.gate_key` — this is
   the gate the merchant delegated to
4. the offer cites this `envelope_id`
5. the offer's terms re-checked against the envelope's clauses independently

Issuance additionally refuses an envelope whose `gate_key` is the merchant's own
key. If the authority to grant and the authority to exercise are the same key,
the separation is decorative.

---

## C3 — Model-scored pressure is self-defeating

**Design note §5.2** has the selling agent score manipulation pressure per turn,
with the gate acting on the score.

A prompt-injected model reports `0.0`. The envelope never collapses. The one
mechanism specifically designed to resist injection is the mechanism injection
turns off first.

**Replacement — the model emits signals, a pure reducer decides.**

- `PressureSignal` is a shared vocabulary of structured observations
  (`injected_imperative`, `role_marker`, `escalating_reframe`,
  `unverifiable_claim`, `probing_variation`, …).
- Deterministic detectors in `packages/core/pressure/detectors.ts` emit signals
  from the raw buyer message, before it reaches any model.
- The LLM classifier emits signals in the *same* vocabulary. It performs
  perception only — it does not score and it does not decide.
- `reducePressure(signals, sessionState)` maps signals to a score, a ratchet
  transition and a set of actions. Pure, no I/O.

Signals **union** rather than compare. A captured model can only ever *add*
signals; it has no channel through which to suppress what the detectors already
emitted, and there is no single number for it to lie about. Monotonic safety
becomes structural instead of arithmetic.

The side effect that matters in a review: the entire collapse decision is
data-in/data-out, so the adversarial corpus runs as ordinary unit tests with zero
model calls. "Here is the attack corpus and here is the suite proving the
envelope collapses on each category" is a claim backed by a command, not by a
live demo that has to fire on the night.

---

## C6 — Razorpay has no create-offer API

**Design note §7** says the campaign path is native: *"Razorpay supplies the
pieces natively: create an Offer, generate payment links for the segment."*

Half of that is right. There is no create-offer API.

```
POST /offers  ->  405 Method Not Allowed
GET  /offers  ->  400 BAD_REQUEST / "Request Validation Failure"
                  (source: NA, step: NA, reason: NA — nothing to act on)
```

Razorpay's docs confirm it: offers are created *from the Dashboard*, and the
API only lets you reference an existing `offer_id` when creating an order,
payment link or subscription.
Sources: [Create Offers](https://razorpay.com/docs/payments/offers/create/),
[Offers on Payment Links](https://razorpay.com/docs/api/payments/payment-links/offers/).

### The replacement

A campaign executes as a **payment link at the gate-signed price**, optionally
carrying an `offer_id` the merchant created by hand.

This is arguably the better shape. A Dashboard-created offer is itself a
merchant act, so referencing one keeps the chain of authority intact, whereas an
agent minting its own discount object out of nothing is exactly the move this
system exists to make impossible. The discount authority still comes from the
mandate and the gate — only the addressing changes, which is what §7 claimed all
along. The Razorpay offer object was never where the authority lived.

`offersAvailable()` and `subscriptionsAvailable()` report rather than throw. A
campaign does not need an offer object to run; it needs a signed price. Refusing
to run one because a presentation detail is unavailable would be the wrong
failure.

**Also found:** `reference_id` is unique per account, so a campaign link and a
negotiation link for the same signed offer collide. Suffixed rather than
randomised — the collision is worth keeping, because two live links for one
authorization is two ways to get paid for the same signed price.

**Account state at time of writing:** Offers and Subscriptions are both switched
off on the test account. Orders, Payment Links, Payments, Refunds, Customers and
Settlements all work.

---

## C5 — Two clauses in §4's envelope are unreachable as written

Not errors — the reference envelope is coherent and every clause validates. But
building the gate and testing clause by clause showed that two of §4's numbers
never actually bind, because a tighter clause always gets there first. A merchant
reading the envelope would reasonably believe they were the operative limits.

**`bundle_rules.combined_depth_pct: 20` is unreachable for most SKUs.**
Clearing an 18% floor margin at a 20% discount requires a list margin of at least
34.4%:

```
offered = list × 0.80,  and we need  (offered − cost) / offered ≥ 0.18
⇒ cost ≤ list × 0.80 × 0.82 = list × 0.656
⇒ list margin ≥ 34.4%
```

The demo kettle has a 31.9% list margin, so `floor_margin_pct` binds at 16.9% and
the bundle ceiling never applies. It only becomes operative on genuinely
high-margin lines.

**`per_buyer_discount_cap_inr: 2000` binds before the bundle ceiling above
₹10,000.** A 20% discount on a ₹14,970 three-unit basket is ₹2,994, so the cap
binds at 13.36% — again before the bundle rule.

Both are asserted as tests rather than fixed, because both may well be what the
merchant intended: a per-buyer cap *should* bind on large baskets, and a floor
margin *should* stop an unaffordable bundle discount. The point is that the gate
now cites the clause that actually bound rather than the one someone assumed
would, which is the difference between an audit row that explains a decision and
one that merely accompanies it.

---

## C4 — Collapse had to be a ratchet

**Design note §5.2** describes authority collapsing above a threshold, but not
what happens on the following turn.

If pressure is scored per turn and authority is restored when the score drops,
the attack is: inject, collapse, send one benign message, exploit the restored
authority. The defence lasts exactly one turn.

**Replacement:** collapse is monotonic within a session.
`NORMAL → GUARDED → COLLAPSED` only ever moves in one direction. Only human
review resets it. `guard_threshold` was added to the envelope so there is an
intermediate state — going straight from full authority to zero leaves the agent
no room to tighten before it has to stop conceding entirely.

---

## C7 — A Payment Link cannot authorize a specific order

Not a claim from the design note — a claim the *implementation* made, which is
worse, because it shipped and passed its tests.

The live authorize path created a Payment Link, printed the `short_url`, and
polled `GET /orders/{our_order}/payments` waiting for the payment to appear.

**It never can.** `POST /payment_links` has no `order_id` field, in the request
or the response — verified directly against the API:

```
link keys: accept_partial, allow_full_payment, amount, amount_paid,
           cancelled_at, created_at, currency, customer, description,
           expire_by, expired_at, first_min_partial_amount, id, notes,
           notify, payment_plan, payments, reference_id, reminder_enable,
           reminders, short_url, status, updated_at, upi_link, user_id,
           whatsapp_link
```

A payment link mints its own order internally and exposes its own `payments`
array. So a paid link produces a payment under an order we never created, while
the order the gate signed sits at `status: created`, `attempts: 0`.

**Why this is more than plumbing.** The whole §5.3 story is that *one* order is
authorized and then captured, lapsed or refunded as a decaying option. An order
nobody paid is not an option on anything. Had this shipped, the demo would have
taken real money onto an order carrying none of the mandate's `notes` — no
`offer_id`, no `envelope_id`, no `authorized_by` — and the audit trail would
have pointed at an order with no payment on it.

**Replacement:** Razorpay Checkout, which *does* accept `order_id`. The
authorizer serves a Checkout page bound to the order from a throwaway loopback
server, closed in a `finally`. The payment lands on our order, inherits its
`payment_capture: 0`, and settles into `authorized` for the gate to act on.

`rails.createPaymentLink` stays. It is a way to bill someone, which is a real
money action; it is not a way to authorize a specific order.

### What let this through

The tests. They stubbed `fetch`, routed `/payment_links` and
`/orders/order_ABC123/payments` to canned responses, and asserted that a payment
link was created. Every assertion passed while describing a route that cannot
exist, **because a stub will happily answer a request that reality never
routes.** Mocking the transport meant the test could not observe the one fact
that mattered: which order the human is actually paying.

The replacements inject a fake *checkout host* rather than a fake network, and
assert the binding — `checkout.shown[0].orderId === order.id` — plus a negative:
the authorizer must not call `/payment_links` at all.

### Two smaller findings from the same run

**Opening Checkout on page load silently half-renders.** The overlay mounts
before Checkout can draw into it, leaving a dimmed page with no modal and an
empty console — no error, no warning. It is indistinguishable from a page that
simply failed, and gives no reason to suspect the button underneath would work.
It opens on a click now, and a test pins that.

**`4111 1111 1111 1111` is Razorpay's *international* test card.** An Indian
test account declines it:

> Your payment could not be completed as this business accepts domestic
> (Indian) card payments only.

This arrives as a real, recorded, `failed` payment against the correct order —
so the plumbing looks entirely healthy right up until it declines. The domestic
card is `4100 2800 0000 1007`
([Test Card Details](https://razorpay.com/docs/payments/payments/test-card-details/)).

---

## C8 — A Razorpay Payment Page cannot be scraped, and has no cost on it

**Design note §6** describes onboarding as `Storefront ──▶ Crawl + LLM extract`,
with the implicit assumption that a merchant's page is markup you can read.

Pointed at a real Razorpay-hosted Payment Page, the storefront reader throws
`no SKU found` — and it is right to, because the page has no product content at
all. Its entire body is:

```html
<div id="paymentpage-container"></div>
```

Everything visible is rendered client-side. A crawler reading rendered text
finds nothing; a crawler reading the HTML finds an empty shell.

**But the page is not withholding the data.** It ships a JSON object between two
markers Razorpay puts there deliberately:

```
// <<<JSON_DATA_START>>>
var data = {"key_id":…,"payment_link":{"amount":100000,…}}
// <<<JSON_DATA_END>>>
```

So the answer was not a better scraper. `readSource` now dispatches on what the
bytes are, and `razorpay-page.ts` reads the payload directly. A structured
source earns a structured confidence — one authoritative amount, in paise, in a
typed field, with nothing on the page able to contradict it.

### The finding underneath

**The page carries no unit cost, and no customer-facing page ever will.** Not an
omission — a property of what a storefront is for. A page states what the
customer pays; it never states what the merchant paid.

So margin cannot be established from a public page at all, `cost_absent` fires,
cost confidence collapses to 0.048, and the gate refuses any discount on that
SKU citing `confidence_policy.min_margin_confidence`.

This matters for how §5.4 is argued. The synthetic blender fixture demonstrates
the clause firing on manufactured ambiguity — struck-through MRP, variant table,
a stale-cost marker — all of which we wrote ourselves. The real page
demonstrates it firing for the reason it will actually fire in production, on
bytes nobody on this project authored. Both fixtures stay: one exercises the
ambiguity detectors, the other is evidence.

### A parsing detail worth keeping

The block between the markers does not end where it appears to. It closes with
`;` **and the `// ` that prefixes the end-marker line**, so trimming a trailing
semicolon leaves a comment behind and `JSON.parse` fails 2,664 characters from
anything a reader would think to suspect. Bounding the object by its own first
`{` and last `}` needs no such guesswork. There is a test for it.

---

## C9 — A model being *available* is not a property of the key

**The plan's risk list** flagged that Gemini model ids had moved past training
data, and answered it by putting the ids in one config module. Correct as far as
it goes, and not the failure that actually happened.

Five keys were tested against the three models `packages/config` routes to.
Every key authenticated; all three models were visible to all five. On the
routed selling-agent model, keys 1–3 answered and keys 4–5 returned `503`.

That reads as an obvious conclusion — two of the keys are bad — and it is wrong.
Re-running just those two, four attempts each, three seconds apart:

```
KEY_4: OK | OK | 503 | 503
KEY_5: OK | 503 | OK | 503
```

**The failure does not follow the key. It follows the model.** `503 UNAVAILABLE`
is capacity, and at that moment `gemini-3.7-flash` was roughly a coin flip. A
provider with no retry turns that into a demo that breaks in front of a panel
for a reason unrelated to anything being demonstrated.

### Two failures that look alike and are not

`gemini-3.1-pro-preview` returned `429 RESOURCE_EXHAUSTED` on all five keys —
free-tier quota, not capacity. The remedies are opposites:

| | means | retrying the same model | switching model |
|---|---|---|---|
| `503` | the model is busy | **helps** — wait and ask again | helps |
| `429` | the quota is spent | does not help; invites throttling | **helps** — a different model has its own quota |

So `retry.ts` treats them differently: `5xx` retries with exponential backoff,
`429` abandons the model immediately and falls through to the next in the chain,
and everything else — `400`, `401`, `404` — throws at once, because asking again
with the same wrong key produces the same wrong key, slower.

This was not theoretical. During the first recording run key 1's free-tier quota
for `gemini-3.7-flash` ran out mid-way; the log shows the fallback to
`gemini-3.6-flash` carrying the remaining personas. Without this work the run
would have died at persona two.

### Why swapping models mid-flight is safe *here*

In most systems it would not be. It is safe here for the reason the whole
project exists: no commercial commitment is downstream of which model answered.
The model proposes; the gate signs. A fallback changes the prose and nothing
that binds — which is a claim the type system enforces rather than one this
document asserts.

### A misdiagnosis worth recording

The first round of testing reported all five keys as returning HTTP 200 with
empty text, which looks like a dead key. It was not. Gemini 3.x are thinking
models and reasoning tokens are drawn from the same output budget as the answer;
a 10-token budget was spent entirely on `thoughtsTokenCount` before a single
character of answer. The probe was too small, not the key.

`GeminiProvider` now puts that diagnosis in the error itself — an empty response
with `finishReason=MAX_TOKENS` reports the thinking-token count and says the key
is fine — because the next person to hit it will otherwise spend the same hour.

### And one bug that only a real run could find

With the recordings committed and the replay test green, the console was still
calling Gemini for every turn.

`createProvider({ cassetteDir: 'cassettes/console' })` — a relative path. Next
serves with cwd `apps/web`, vitest and the scripts run from the repo root. So one
string named two directories: the test loaded 38 recordings and passed, and the
console loaded zero, missed on every request, and wrote a second set of cassettes
under `apps/web/` that nothing would ever read.

Nothing errored. Nothing could have: in `live` mode a cassette miss is a
perfectly good reason to call the model, which is the whole point of that mode.
The test was not wrong and the console was not wrong; the path meant different
things to each and neither was in a position to notice.

It surfaced by driving the running console and comparing its reply to the
recorded one word for word. They did not match. That is the only check that
would have caught it — the test suite, the typechecker and the build were all
green throughout, and a passing replay test is precisely the evidence that makes
you stop looking.

`fromRepoRoot()` in `packages/config` now anchors the path, and both callers read
one exported constant. The general form of the lesson: a path shared across
processes with different working directories is not a string, and a green test
suite proves the test's environment, not the application's.
