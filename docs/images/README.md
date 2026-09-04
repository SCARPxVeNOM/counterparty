# Screenshots

Three from the running console, three from the Razorpay Dashboard. All committed.

| file | what it shows | status |
|---|---|---|
| `razorpay-captured.jpg` | the console's Razorpay panel, with the audit rows it produced | ✅ |
| `razorpay-payment-link.jpg` | a real Payment Link issued at the gate-signed price | ✅ |
| `collapse.jpg` | the envelope at 0%, and the sale still available through Razorpay | ✅ |
| `dashboard-order-notes.png` | an order in Razorpay's Dashboard, with `authorized_by` in its Notes | ✅ |
| `dashboard-orders.png` | the orders the agent created, including the one real **Paid** card tap | ✅ |
| `dashboard-payment-links.png` | four links issued at gate-signed prices, receipts tracing to offer ids | ✅ |

## Why the Dashboard ones matter

Every other piece of evidence here is something we produced: our console, our
ledger, our terminal output. A reader has to accept that the object ids are real.

The Dashboard captures are the artifacts **Razorpay produced about us**, and they
closed the loop in both directions — they also caught an overclaim. The README
had said the console "creates a real order and captures it". The order detail
shows `Status: Created`, `Payments: No Payments`, because the console's card tap
is simulated and `captureFull` short-circuits on it. The claim is corrected and
the ledger now says so in the row itself.

## Adding more

If you want to re-take or extend these:

Log in at <https://dashboard.razorpay.com> with **Test Mode** on.

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

Keep the existing filenames so the README keeps resolving them.
