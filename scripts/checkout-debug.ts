/**
 * Serve one Checkout page and leave it up, so the browser side can be inspected.
 *
 * `smoke:live --wait` tears its page down the moment the poll ends, which is
 * right for a payment and useless for finding out why one never started. This
 * creates a real order, serves the same page against it, and just waits.
 *
 *   pnpm tsx scripts/checkout-debug.ts
 */

import { loadConfig } from '@counterparty/config';
import { LocalCheckoutHost, RazorpayClient } from '@counterparty/rails';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new RazorpayClient({
    credentials: { keyId: config.razorpayKeyId, keySecret: config.razorpayKeySecret },
  });

  const order = await client.post<{ id: string; amount: number }>('/orders', {
    amount: 449_100,
    currency: 'INR',
    payment_capture: 0,
  });

  const session = await new LocalCheckoutHost().open({
    keyId: client.keyId,
    orderId: order.id,
    amountPaise: order.amount,
    description: 'checkout diagnostic',
    merchantName: 'Counterparty',
  });

  console.log(`order   ${order.id}`);
  console.log(`page    ${session.url}`);
  console.log('serving until killed.');

  // Report any attempt that shows up, so this doubles as a live watch.
  setInterval(() => {
    void client
      .get<{ attempts?: number; status?: string }>(`/orders/${order.id}`)
      .then((o) => {
        if ((o.attempts ?? 0) > 0) console.log(`attempts=${o.attempts} status=${o.status}`);
      })
      .catch(() => {});
  }, 5000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
