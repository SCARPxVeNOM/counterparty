import { describe, expect, it } from 'vitest';
import {
  DOMESTIC_TEST_CARD,
  LocalCheckoutHost,
  renderCheckoutPage,
  type CheckoutRequest,
} from '../src/checkout';

const REQUEST: CheckoutRequest = {
  keyId: 'rzp_test_abc123',
  orderId: 'order_ABC123',
  amountPaise: 449_100,
  description: 'Offer off_1 (authority.max_discount_depth_pct)',
  merchantName: 'Kettle & Co',
};

describe('renderCheckoutPage', () => {
  it('binds Checkout to the order, at the order amount', () => {
    const html = renderCheckoutPage(REQUEST);
    expect(html).toContain('"order_id":"order_ABC123"');
    expect(html).toContain('"amount":449100');
    expect(html).toContain('"key":"rzp_test_abc123"');
  });

  it('loads Razorpay checkout, not a payment link', () => {
    const html = renderCheckoutPage(REQUEST);
    expect(html).toContain('https://checkout.razorpay.com/v1/checkout.js');
    expect(html).not.toContain('rzp.io');
  });

  /**
   * The international card declines on an Indian test account — as a real,
   * recorded, failed payment, which looks like working plumbing right up until
   * it doesn't. Two ten-minute waits went into learning that, so the page names
   * the domestic card and says outright which one not to reach for.
   */
  it('names the domestic test card, and warns off the international one', () => {
    const html = renderCheckoutPage(REQUEST);
    expect(html).toContain(DOMESTIC_TEST_CARD);
    expect(html).toContain('4111 1111 1111 1111');
    expect(html).toMatch(/Not <code>4111 1111 1111 1111<\/code>/);
  });

  /**
   * Auto-opening mounts the overlay before Checkout can render into it: a
   * dimmed page, no modal, and an empty console. It cost a real ten-minute
   * wait on a payment that was never possible to make, so the page opens on a
   * click and only on a click.
   */
  it('opens Checkout only from the button, never on load', () => {
    const html = renderCheckoutPage(REQUEST);
    const opens = html.match(/rzp\.open\(\)/g) ?? [];
    expect(opens).toHaveLength(1);
    expect(html).toMatch(/onclick = function \(\) \{[^}]*rzp\.open\(\)/s);
  });

  /**
   * Values reach the script through JSON.stringify rather than concatenation.
   * None of these fields are attacker-controlled today — order ids come from
   * Razorpay — but this file's whole job is taking payment, and a page that
   * builds JS by gluing strings is one refactor from being an injection site.
   */
  it('cannot be broken out of by a hostile order id', () => {
    const html = renderCheckoutPage({
      ...REQUEST,
      orderId: '</script><script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('\\u003c/script');
  });
});

describe('LocalCheckoutHost', () => {
  it('serves the page on loopback and stops listening when closed', async () => {
    const session = await new LocalCheckoutHost().open(REQUEST);

    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const response = await fetch(session.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('order_ABC123');

    await session.close();
    await expect(fetch(session.url)).rejects.toThrow();
  });

  it('gives each session its own port', async () => {
    const a = await new LocalCheckoutHost().open(REQUEST);
    const b = await new LocalCheckoutHost().open(REQUEST);
    expect(a.url).not.toBe(b.url);
    await a.close();
    await b.close();
  });
});
