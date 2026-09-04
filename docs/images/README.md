# Screenshots

Three are committed and were captured from the running console. One is missing
and only the account holder can take it.

| file | what it shows | status |
|---|---|---|
| `razorpay-captured.jpg` | the console after a capture, with the audit rows it produced | ✅ |
| `razorpay-payment-link.jpg` | a real Payment Link issued at the gate-signed price | ✅ |
| `collapse.jpg` | the envelope at 0%, and the sale still available through Razorpay | ✅ |
| `razorpay-dashboard.jpg` | **the same objects inside Razorpay's own Dashboard** | ⬜ **you** |

## Why the Dashboard one is worth taking

Every other piece of evidence in this repo is something we produced: our console,
our ledger, our terminal output. A judge reading it has to accept that the object
ids are real.

A Dashboard screenshot is the one artifact **Razorpay produced about us**. It
closes the loop, and it takes about two minutes.

## What to capture

Log in at <https://dashboard.razorpay.com>, make sure the **Test Mode** toggle is
on, and take these four:

**1. Orders list** — `Transactions → Orders`

Shows a column of `order_…` ids created by the agent. The point is volume: this
is not one lucky call.

**2. One order's detail, with Notes expanded** — click `order_TY87q17mUQfIXb`

This is the strongest single image in the whole submission. The **Notes** panel
carries `authorized_by: authority.per_buyer_discount_cap_inr` alongside
`envelope_id` and `depth_pct`. The clause that permitted the price, on Razorpay's
own record. Crop tight on the Notes.

**3. The captured payment** — `Transactions → Payments`, open `pay_TUQ7MKc8zXf1gE`

Status `captured`, ₹4,491, with the ₹500 refund against it. Proof a real human
card went through the gate.

**4. Payment Links** — `Payment Links`

The links the console and the win-back campaign issued, including
`plink_TY8UrCfdVSXN4N`.

## Before you commit them

- **Test mode only.** Never a screenshot with live-mode data in it.
- **Crop or blur** the account name, business email, phone, bank details and any
  settlement figures in the sidebar or header. The object ids and amounts are
  fine — they are already in this README.
- The key id `rzp_test_…` is safe to show; the **key secret** must never appear.

Save the best one as `razorpay-dashboard.jpg` — the README already references it.
Add the others as `razorpay-dashboard-2.jpg` and so on if you want more than one.
