// Stripe is the source of truth for subscription state. We never trust the
// payload of a subscription event for state: we re-fetch the subscription, so
// out-of-order or replayed webhooks always converge on Stripe's current view.

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

const idOf = (ref) => (typeof ref === 'string' ? ref : ref?.id ?? null);

function periodEnd(subscription) {
  // Newer Stripe API versions report the period on the subscription items.
  return subscription.items?.data?.[0]?.current_period_end ?? subscription.current_period_end ?? null;
}

export function createBilling({ db, stripe, config, log = console }) {
  const linkCustomer = db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?');
  // A late event about an old, ended subscription must not overwrite a newer
  // paid one (cancel, then resubscribe), so that single case is skipped.
  const saveSubscription = db.prepare(`
    UPDATE users SET stripe_subscription_id = @subscriptionId, subscription_status = @status, current_period_end = @periodEnd
    WHERE stripe_customer_id = @customerId
      AND NOT (stripe_subscription_id IS NOT NULL AND stripe_subscription_id <> @subscriptionId
               AND subscription_status IN ('active', 'trialing') AND @status NOT IN ('active', 'trialing'))`);
  const userByCustomer = db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?');

  async function syncSubscription(subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const customerId = idOf(subscription.customer);
    if (!userByCustomer.get(customerId)) {
      log.warn(`Stripe: no user for customer ${customerId} (subscription ${subscription.id})`);
      return;
    }
    saveSubscription.run({
      subscriptionId: subscription.id,
      status: subscription.status,
      periodEnd: periodEnd(subscription),
      customerId,
    });
  }

  async function syncCheckoutSession(session) {
    const userId = Number(session.client_reference_id);
    const customerId = idOf(session.customer);
    const subscriptionId = idOf(session.subscription);
    if (!userId || !customerId || !subscriptionId) {
      log.warn(`Stripe: checkout session ${session.id} is missing user, customer or subscription`);
      return;
    }
    linkCustomer.run(customerId, userId);
    await syncSubscription(subscriptionId);
  }

  return {
    async startCheckout(user) {
      // One Stripe customer per user, created up front, so repeated checkouts
      // (two tabs, a retry after cancel) never split a user across customers.
      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({ email: user.email, metadata: { user_id: String(user.id) } });
        customerId = customer.id;
        linkCustomer.run(customerId, user.id);
      }
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: config.stripe.priceId, quantity: 1 }],
        client_reference_id: String(user.id),
        customer: customerId,
        allow_promotion_codes: true,
        locale: 'hu',
        success_url: `${config.baseUrl}/elofizetes/sikeres?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.baseUrl}/elofizetes`,
      });
      return session.url;
    },

    // The success redirect can beat the webhook, so we sync here too.
    async confirmCheckout(user, sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.client_reference_id !== String(user.id)) return false;
      await syncCheckoutSession(session);
      return true;
    },

    async portalUrl(user) {
      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        return_url: `${config.baseUrl}/fiok`,
      });
      return session.url;
    },

    // Throws on a bad signature; the route turns that into a 400.
    parseWebhook(rawBody, signature) {
      return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
    },

    async handleEvent(event) {
      const object = event.data.object;
      if (event.type === 'checkout.session.completed' && object.mode === 'subscription') {
        await syncCheckoutSession(object);
      } else if (SUBSCRIPTION_EVENTS.has(event.type)) {
        if (userByCustomer.get(idOf(object.customer))) await syncSubscription(object.id);
      }
    },
  };
}
