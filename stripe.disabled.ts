/**
 * stripe.disabled.ts
 * ==================
 * This file contains all Stripe-specific code extracted from server.ts for
 * safe-keeping. Each section is annotated with its original location so it
 * can be re-integrated easily if Stripe support is re-enabled.
 *
 * To re-enable Stripe:
 *  1. Add `import Stripe from 'stripe';` to the top of server.ts (after the discord.js import block).
 *  2. Re-add each section below to server.ts at the indicated location.
 *  3. Install the stripe package: `npm install stripe`
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Import line
// Location in server.ts: line 32, after `import dotenv from 'dotenv';`
// ─────────────────────────────────────────────────────────────────────────────
import Stripe from 'stripe';


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — stripePollers Map declaration
// Location in server.ts: ~line 125, alongside cashappPollers / zellePollers
// ─────────────────────────────────────────────────────────────────────────────
const stripePollers = new Map<string, { interval: ReturnType<typeof setInterval>, timeout: ReturnType<typeof setTimeout> }>();


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Per-guild Stripe client cache + getStripeForGuild function
// Location in server.ts: ~lines 558–572, after process.on('unhandledRejection')
// ─────────────────────────────────────────────────────────────────────────────

// Per-guild Stripe client cache, keyed by guildId
const guildStripeClients = new Map<string, Stripe>();

async function getStripeForGuild(guildId: string): Promise<Stripe | null> {
  if (guildStripeClients.has(guildId)) return guildStripeClients.get(guildId)!;
  const config = await getGuildConfig(guildId) || {};
  const key = config.stripeSecretKey;
  if (!key) {
    console.warn(`⚠️ No Stripe secret key configured for guild ${guildId}. Admin must run /admin_setup.`);
    return null;
  }
  const client = new Stripe(key, { apiVersion: '2026-02-25.clover' });
  guildStripeClients.set(guildId, client);
  return client;
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — stripeBtn ButtonBuilder in payment options
// Location in server.ts: ~lines 2421–2422, inside the checkout button handler,
//   just before `if (config.cashappTag) { buttons.push(...) }`
// ─────────────────────────────────────────────────────────────────────────────
//
//   const stripeBtn = new ButtonBuilder().setCustomId('pay_stripe').setLabel('💳 Pay with Stripe').setStyle(ButtonStyle.Primary);
//   buttons.push(stripeBtn);


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — pay_stripe button handler block
// Location in server.ts: ~lines 2485–2623
//   `} else if (interaction.customId === 'pay_stripe') { ... }`
//   Comes after `} else if (interaction.customId === 'confirm_manual') {`
//   and before `} else if (['pay_cashapp', ...].includes(interaction.customId)) {`
// ─────────────────────────────────────────────────────────────────────────────
/*
            } else if (interaction.customId === 'pay_stripe') {
              try {
                await interaction.deferUpdate();
                const stripe = await getStripeForGuild(interaction.guildId!);
                if (!stripe) {
                  return await interaction.followUp({ content: '❌ Stripe is not configured for this server. An admin must run `/admin_setup` to add a Stripe key.', flags: MessageFlags.Ephemeral });
                }

                const session = await stripe.checkout.sessions.create({
                  payment_method_types: ['card'],
                  line_items: [{
                    price_data: {
                      currency: 'usd',
                      product_data: {
                        name: state.orders.map((o: any) => o.type).join(', '),
                        description: `${state.orders.length} Entree(s)`,
                      },
                      unit_amount: Math.round(state.totalPrice * 100),
                    },
                    quantity: 1,
                  }],
                  mode: 'payment',
                  success_url: 'https://discord.com/channels/@me',
                  cancel_url: 'https://discord.com/channels/@me',
                  client_reference_id: interaction.user.id,
                  metadata: {
                    orderId: state.currentOrderId,
                    userId: interaction.user.id
                  }
                });

                state.stripeSessionId = session.id;
                state.isFulfilled = false;
                state.stripeInteraction = interaction;

                const config = await getGuildConfig(interaction.guildId!) || {};
                const checkoutMsg = config.checkoutMessage || 'Please pay using the link below. Your order will be sent to the kitchen automatically once payment is confirmed.';

                const payBtn = new ButtonBuilder().setLabel('Pay with Stripe').setStyle(ButtonStyle.Link).setURL(session.url!);
                const checkBtn = new ButtonBuilder().setCustomId('check_payment').setLabel('Check Payment Status').setStyle(ButtonStyle.Primary);
                const refreshBtn = new ButtonBuilder().setCustomId('refresh_link').setLabel('Refresh Link').setStyle(ButtonStyle.Secondary);
                const backBtn = new ButtonBuilder().setCustomId('checkout').setLabel('Back to Payment Options').setStyle(ButtonStyle.Danger);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(payBtn, checkBtn, refreshBtn, backBtn);

                await interaction.editReply({
                  content: `Total: **$${state.totalPrice.toFixed(2)}**. ${checkoutMsg}\n\n*If the order doesn't process after payment, click "Check Payment Status".*`,
                  components: [row]
                });

                // Auto-poll Stripe every 5 seconds; fulfill automatically on payment
                const pollerSessionId = session.id;
                const pollerOrderId = state.currentOrderId;
                const pollerUserId = interaction.user.id;
                const pollerGuildIdCapture = interaction.guildId!;
                const pollerKey = `${pollerUserId}:${pollerGuildIdCapture}`;

                // Cancel any existing poller for this user+guild (handles double-click on "Pay with Stripe")
                const existingPoller = stripePollers.get(pollerKey);
                if (existingPoller) {
                  clearInterval(existingPoller.interval);
                  clearTimeout(existingPoller.timeout);
                  stripePollers.delete(pollerKey);
                }

                const stopPoller = (key: string) => {
                  const p = stripePollers.get(key);
                  if (p) {
                    clearInterval(p.interval);
                    clearTimeout(p.timeout);
                    stripePollers.delete(key);
                  }
                };

                const pollerInterval = setInterval(async () => {
                  try {
                    const stripeClient = await getStripeForGuild(pollerGuildIdCapture);
                    if (!stripeClient) return;
                    const sess = await stripeClient.checkout.sessions.retrieve(pollerSessionId);
                    if (sess.status === 'complete' && sess.payment_status === 'paid') {
                      // Stop poller immediately — prevents retry loops if subsequent async work fails
                      stopPoller(pollerKey);

                      // Grab interaction and order data before fulfillOrder clears state
                      const currentState = orderState.get(pollerKey);
                      const storedInteraction = currentState?.stripeInteraction;
                      const pollerGuildId = currentState?.guildId;
                      const config = pollerGuildId ? (await getGuildConfig(pollerGuildId) || {}) : {};
                      const orderDoc = await db.collection('orders').doc(pollerOrderId).get();
                      const parsedOrders = safeParseOrders(orderDoc.data()?.orderData);
                      const orderDetails = formatOrderItems(parsedOrders);

                      await fulfillOrder(pollerOrderId, true);

                      // Update the customer's Discord screen
                      if (storedInteraction) {
                        try {
                          const successMsg = config.successMessage || 'Your order has been sent to the kitchen.';
                          const successEmbed = createEmbed(config)
                            .setTitle('🎉 Payment Confirmed — Thank You!')
                            .setDescription(`${successMsg}\n\n**Your Order Details:**\n${orderDetails}`);
                          await storedInteraction.editReply({ content: '', embeds: [successEmbed], components: [] });
                        } catch (e) {
                          console.error('Could not update screen after payment (token may have expired):', e);
                        }
                      }
                    } else if (sess.status === 'expired') {
                      stopPoller(pollerKey);
                    }
                  } catch (e) {
                    console.error('Stripe poll error:', e);
                  }
                }, 5000);

                // Stop polling after 30 minutes (matches Stripe session expiry)
                const pollerTimeout = setTimeout(() => stopPoller(pollerKey), 30 * 60 * 1000);
                stripePollers.set(pollerKey, { interval: pollerInterval, timeout: pollerTimeout });

              } catch (err: any) {
                console.error('Stripe Session Error:', err);

                let userMessage = 'Please try again later.';
                if (err.type === 'StripeInvalidRequestError') {
                  userMessage = 'There was an issue with the order details. Please review your cart and try again.';
                } else if (err.type === 'StripeAPIError') {
                  userMessage = 'Stripe is currently experiencing issues. Please try again later.';
                } else if (err.type === 'StripeConnectionError') {
                  userMessage = 'Network issue connecting to the payment provider. Please check your connection and try again.';
                } else if (err.type === 'StripeAuthenticationError') {
                  userMessage = 'Payment system configuration error. Please contact the administrator.';
                } else if (err.message) {
                  userMessage = err.message;
                }

                if (interaction.deferred || interaction.replied) {
                  await interaction.followUp({ content: `❌ Error creating payment session: ${userMessage}`, flags: MessageFlags.Ephemeral });
                } else {
                  await interaction.reply({ content: `❌ Error creating payment session: ${userMessage}`, flags: MessageFlags.Ephemeral });
                }
              }
*/


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — /stripe-webhook Express endpoint
// Location in server.ts: ~lines 3040–3118, inside startServer()
//   IMPORTANT: must be registered BEFORE express.json() middleware.
//   Place right before: `app.use(express.json());`
// ─────────────────────────────────────────────────────────────────────────────
/*
  // IMPORTANT: Stripe webhook must be registered BEFORE express.json()
  // so the raw body is preserved for signature verification.
  app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log('--- Webhook Received ---');
    const sig = req.headers['stripe-signature'];

    let event: any;

    try {
      if (sig) {
        // Parse body to look up the guild's per-server Stripe credentials
        let parsedBody: any;
        try { parsedBody = JSON.parse(req.body.toString()); } catch { return res.status(400).send('Invalid JSON.'); }

        const orderId = parsedBody?.data?.object?.metadata?.orderId;
        let webhookSecret: string | undefined;
        let stripeKey: string | undefined;

        if (orderId) {
          try {
            const orderDoc = await db.collection('orders').doc(orderId).get();
            const guildId = orderDoc.data()?.guildId;
            if (guildId) {
              const guildCfg = await getGuildConfig(guildId) || {};
              webhookSecret = guildCfg.stripeWebhookSecret;
              stripeKey = guildCfg.stripeSecretKey;
            }
          } catch (e) { /* fall through * / }
        }

        if (webhookSecret && stripeKey) {
          const verifier = new Stripe(stripeKey, { apiVersion: '2026-02-25.clover' });
          event = verifier.webhooks.constructEvent(req.body, sig, webhookSecret);
          console.log('Webhook signature verified.');
        } else {
          console.error('❌ No per-guild Stripe webhook secret configured — rejecting unverified event.');
          return res.status(400).send('Webhook Error: No webhook secret configured. Admin must run /admin_setup to configure Stripe for this server.');
        }
      } else {
        console.error('❌ No Stripe-Signature header — rejecting webhook.');
        return res.status(400).send('Webhook Error: Missing Stripe-Signature header.');
      }
    } catch (err: any) {
      console.error(`Webhook Signature Verification Failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: Invalid signature or payload.`);
    }

    console.log(`Event Type: ${event.type}`);

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.orderId;

        console.log(`Processing order ID: ${orderId}`);

        if (orderId) {
          const success = await fulfillOrder(orderId);
          if (success) {
            console.log(`Order ${orderId} fulfilled successfully via webhook.`);
          } else {
            console.error(`Failed to fulfill order ${orderId} via webhook. Discord notification or database update may have failed.`);
            // Return 500 to tell Stripe to retry
            return res.status(500).send('Failed to fulfill order. Please retry.');
          }
        } else {
          console.error('Missing orderId in session metadata. Cannot fulfill order.');
          return res.status(400).send('Missing orderId in session metadata.');
        }
      } else {
        console.log(`Unhandled event type: ${event.type}`);
      }
    } catch (err: any) {
      console.error(`Error processing webhook event ${event.type}:`, err);
      return res.status(500).send(`Webhook Processing Error: ${err.message}`);
    }

    res.json({ received: true });
  });
*/


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — setup_stripe button handler
// Location in server.ts: ~lines 2091–2102, inside the
//   `if (interaction.isButton() && interaction.customId.startsWith('setup_'))` block
//   Place before the `if (interaction.customId === 'setup_webhook')` check.
// ─────────────────────────────────────────────────────────────────────────────
/*
            if (interaction.customId === 'setup_stripe') {
              const modal = new ModalBuilder().setCustomId('setup_stripe_modal').setTitle('💳 Stripe Configuration');
              const keyInput = new TextInputBuilder().setCustomId('stripeSecretKey').setLabel('Stripe Secret Key (sk_live_ or sk_test_...)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('sk_live_...');
              if (cfg.stripeSecretKey) keyInput.setValue(cfg.stripeSecretKey);
              const secretInput = new TextInputBuilder().setCustomId('stripeWebhookSecret').setLabel('Stripe Webhook Secret (whsec_...)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('whsec_...');
              if (cfg.stripeWebhookSecret) secretInput.setValue(cfg.stripeWebhookSecret);
              modal.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(keyInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(secretInput),
              );
              return await interaction.showModal(modal);
            }
*/


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — setup_stripe_modal modal submission handler
// Location in server.ts: ~lines 1630–1648, inside the modal submit handler block
//   (inside `if (interaction.type === InteractionType.ModalSubmit)`)
//   Place after the `setup_order_format_modal` handler and before `setup_webhook_modal`.
// ─────────────────────────────────────────────────────────────────────────────
/*
          if (interaction.customId === 'setup_stripe_modal') {
            const stripeKey = interaction.fields.getTextInputValue('stripeSecretKey').trim();
            const webhookSecret = interaction.fields.getTextInputValue('stripeWebhookSecret').trim();
            if (stripeKey && !stripeKey.startsWith('sk_')) {
              return await interaction.reply({ content: '❌ Invalid Stripe secret key. It must start with `sk_live_` or `sk_test_`.', flags: MessageFlags.Ephemeral });
            }
            if (webhookSecret && !webhookSecret.startsWith('whsec_')) {
              return await interaction.reply({ content: '❌ Invalid webhook secret. It must start with `whsec_`.', flags: MessageFlags.Ephemeral });
            }
            const cfg = await getGuildConfig(interaction.guildId!) || {};
            const updates: any = { ...cfg, stripeSecretKey: stripeKey, stripeWebhookSecret: webhookSecret };
            const success = await updateGuildConfig(interaction.guildId!, updates);
            if (success) {
              guildStripeClients.delete(interaction.guildId!);
              await handleSetup(interaction, '✅ Stripe configuration saved!');
            } else {
              await interaction.reply({ content: '❌ Failed to save Stripe configuration.', flags: MessageFlags.Ephemeral });
            }
          }
*/


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — isStripePaid / stripeSessionId block in check_payment handler
// Location in server.ts: ~lines 2822–2837, inside the check_payment handler
//   Place after the `isManuallyConfirmed` block and before
//   `if (state.isFulfilled || isManuallyConfirmed || isStripePaid)`
//
// Also: the `isStripePaid` variable must be added to the condition on the
//   `if (state.isFulfilled || isManuallyConfirmed ...)` line.
//
// Also re-add the sessionUrl block in the else branch (~lines 2860–2866):
//   const components = [];
//   if (sessionUrl) {
//     const payBtn = new ButtonBuilder().setLabel('Pay with Stripe').setStyle(ButtonStyle.Link).setURL(sessionUrl);
//     const row = new ActionRowBuilder<ButtonBuilder>().addComponents(payBtn);
//     components.push(row);
//   }
//   await interaction.editReply({ content: '❌ Payment not yet confirmed...', components, embeds: [] });
// ─────────────────────────────────────────────────────────────────────────────
/*
                let isStripePaid = false;
                let sessionUrl = null;
                if (state.stripeSessionId) {
                  try {
                    const stripe = await getStripeForGuild(interaction.guildId!);
                    if (stripe) {
                      const session = await stripe.checkout.sessions.retrieve(state.stripeSessionId);
                      sessionUrl = session.url;
                      if (session.status === 'complete' && session.payment_status === 'paid') {
                        isStripePaid = true;
                      }
                    }
                  } catch (e) {
                    console.error('Error retrieving stripe session:', e);
                  }
                }
*/


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — setup_stripe button in settings panel (handleSetup function)
// Location in server.ts: ~line 3957, inside `row1` ActionRowBuilder in handleSetup()
//   new ButtonBuilder().setCustomId('setup_stripe').setLabel('💳 Stripe Keys').setStyle(ButtonStyle.Primary),
// ─────────────────────────────────────────────────────────────────────────────
//
//   new ButtonBuilder().setCustomId('setup_stripe').setLabel('💳 Stripe Keys').setStyle(ButtonStyle.Primary),
