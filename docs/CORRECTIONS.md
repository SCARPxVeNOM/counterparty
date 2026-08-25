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
