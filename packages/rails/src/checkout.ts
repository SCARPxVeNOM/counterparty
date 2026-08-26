/**
 * Putting Razorpay Checkout in front of a human, bound to a specific order.
 *
 * WHY THIS EXISTS, AND WHY A PAYMENT LINK IS NOT ENOUGH.
 *
 * The obvious way to let someone pay is to create a Payment Link and hand over
 * the short_url. That is what this system did first, and it cannot work for the
 * authorize step, for a reason the API makes plain:
 *
 *     POST /payment_links  ->  no order_id field, in the request or the response
 *
 * A payment link mints its own order internally. So a payment made against a
 * link never appears under GET /orders/{our_order}/payments — the poll that
 * waits for authorization would spin until it timed out even though the money
 * moved. Worse, the order the gate signed would sit untouched at `created`
 * while a second, unrelated order took the payment.
 *
 * That matters here beyond mere plumbing. The whole §5.3 story is that ONE
 * order is authorized and then captured, lapsed or refunded as a decaying
 * option. An order nobody paid is not an option on anything.
 *
 * Razorpay Checkout does accept an order_id, which is exactly the binding we
 * need: the payment lands on our order, inherits its `payment_capture: 0`, and
 * settles into `authorized` for the gate to act on later. Checkout is a browser
 * script, so it needs a page — hence a throwaway local server that exists for
 * the duration of one payment and is closed in a `finally`.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Razorpay's domestic (Indian) test card.
 *
 * NOT 4111 1111 1111 1111. That number appears in every payments tutorial ever
 * written, including Razorpay's own international table, and on an Indian test
 * account it fails with:
 *
 *   "this business accepts domestic (Indian) card payments only"
 *
 * The failure is a real, recorded payment against the right order, so the
 * plumbing looks correct right up until it declines. Razorpay's Indian test
 * cards are listed at
 * https://razorpay.com/docs/payments/payments/test-card-details/ — this is the
 * Visa consumer debit one. Any future expiry, any CVV, then Success on the mock
 * bank page.
 */
export const DOMESTIC_TEST_CARD = '4100 2800 0000 1007';

export interface CheckoutRequest {
  readonly keyId: string;
  readonly orderId: string;
  readonly amountPaise: number;
  readonly description: string;
  /** Shown on the Checkout modal so a judge can see what they are paying for. */
  readonly merchantName: string;
}

export interface CheckoutSession {
  /** Where the human should point a browser. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Somewhere to host the Checkout page.
 *
 * An interface rather than a bare function so tests can hand `LiveAuthorizer` a
 * host that binds no port and serves nothing. The previous tests stubbed
 * `fetch` and asserted a payment link was created — which passed while the
 * whole route was impossible, because a stub will happily answer a request that
 * reality never routes.
 */
export interface CheckoutHost {
  open(request: CheckoutRequest): Promise<CheckoutSession>;
}

/**
 * Serves the Checkout page on loopback for as long as one payment takes.
 *
 * Bound to 127.0.0.1 on an ephemeral port: this is a page for the person at
 * this machine, not a service. Nothing is written to disk and the server dies
 * with the authorize call.
 */
export class LocalCheckoutHost implements CheckoutHost {
  constructor(private readonly options: { readonly port?: number } = {}) {}

  async open(request: CheckoutRequest): Promise<CheckoutSession> {
    const page = renderCheckoutPage(request);

    const server = createServer((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(page);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, '127.0.0.1', resolve);
    });

    const { port } = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${port}/`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }
}

/**
 * The page itself.
 *
 * Every value crosses into JavaScript through JSON.stringify rather than string
 * concatenation. None of these are user input today, but a page that builds
 * script source by gluing strings together is one refactor away from being an
 * injection site, and this file's entire purpose is taking payment.
 */
export function renderCheckoutPage(request: CheckoutRequest): string {
  const options = toScriptJson({
    key: request.keyId,
    order_id: request.orderId,
    amount: request.amountPaise,
    currency: 'INR',
    name: request.merchantName,
    description: request.description,
    theme: { color: '#c98a3a' },
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Counterparty — authorize ${escapeHtml(request.orderId)}</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0d0c0b; color: #e8e2d8;
    font: 15px/1.6 ui-monospace, "IBM Plex Mono", Menlo, monospace;
  }
  .card { max-width: 34rem; padding: 2.5rem; text-align: center; }
  h1 { font-size: 1.1rem; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; color: #c98a3a; }
  dl { display: grid; grid-template-columns: auto auto; gap: .35rem 1.25rem; justify-content: center;
       margin: 1.75rem 0; font-size: .85rem; }
  dt { color: #8a8378; text-align: right; }
  dd { margin: 0; text-align: left; }
  button {
    font: inherit; padding: .7rem 1.6rem; cursor: pointer; color: #0d0c0b;
    background: #c98a3a; border: 0; border-radius: 2px;
  }
  .note { margin-top: 1.75rem; font-size: .8rem; color: #8a8378; }
  code { color: #6fb3c9; }
  #status:not(:empty) { margin-top: 1.5rem; padding: .9rem; border: 1px solid #3a3630; font-size: .85rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Authorize this order</h1>
    <dl>
      <dt>order</dt><dd><code>${escapeHtml(request.orderId)}</code></dd>
      <dt>amount</dt><dd>₹${(request.amountPaise / 100).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
      })}</dd>
      <dt>for</dt><dd>${escapeHtml(request.description)}</dd>
    </dl>
    <button id="pay">Open Razorpay Checkout</button>
    <div id="status"></div>
    <p class="note">
      Domestic test card <code>${DOMESTIC_TEST_CARD}</code> — any future expiry,
      any CVV, then <b>Success</b> on the mock bank page.<br>
      Not <code>4111 1111 1111 1111</code>: that is Razorpay's <i>international</i>
      test card, and an Indian test account rejects it.<br>
      The payment stays <code>authorized</code>; this order was created with
      <code>payment_capture: 0</code>, so capture is a separate gated decision.
    </p>
  </div>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  var options = ${options};
  var status = document.getElementById('status');

  options.handler = function (response) {
    status.textContent = 'Authorized: ' + response.razorpay_payment_id +
      ' — return to the terminal.';
  };
  options.modal = {
    ondismiss: function () {
      status.textContent = 'Checkout closed without paying. Press the button to try again.';
    }
  };

  var rzp = new Razorpay(options);
  rzp.on('payment.failed', function (response) {
    status.textContent = 'Failed: ' + (response.error && response.error.description);
  });

  // Opened by the button, never automatically.
  //
  // Opening on load looks convenient and is not: the overlay mounts
  // before Checkout is ready to render into it, leaving a dimmed page with no
  // modal on it and no error anywhere — the console stays empty. Someone
  // looking at that screen has no way to tell it apart from a page that simply
  // failed, and no reason to think a button underneath the dimming would fix
  // it. A click that always works beats an auto-open that usually does.
  document.getElementById('pay').onclick = function () {
    status.textContent = '';
    rzp.open();
  };
</script>
</body>
</html>`;
}

/**
 * JSON that is safe to drop inside a <script> block.
 *
 * `JSON.stringify` alone is not enough, which a test in this package proves by
 * feeding it an order id containing `</script>`: the string survives verbatim,
 * closes the tag early, and everything after it is markup again. The HTML
 * parser sees `</script>` before the JavaScript parser sees a string.
 *
 * So the four characters that can end a script context — plus U+2028 and
 * U+2029, which are literal line terminators to a JS parser but not to JSON —
 * get escaped into equivalent \\u forms. The value the browser parses is
 * identical; only its spelling changes.
 */
function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}
