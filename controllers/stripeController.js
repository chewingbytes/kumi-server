import dotenv from "dotenv";
import Stripe from "stripe";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import supabase from "../config/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "..", ".env") });

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn(
    "[Stripe] STRIPE_SECRET_KEY is missing. Payment endpoints will reject requests."
  );
}

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    })
  : null;

const BILLING_TABLE = process.env.SUPABASE_BILLING_TABLE || null;
const USAGE_TABLE = process.env.SUPABASE_USAGE_TABLE || null;
const DEFAULT_SUCCESS_URL = `${process.env.PUBLIC_URL ?? "http://localhost:5173"}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
const DEFAULT_CANCEL_URL = `${process.env.PUBLIC_URL ?? "http://localhost:5173"}/billing/cancel`;

const ensureStripeClient = () => {
  if (!stripe) {
    throw new Error("Stripe client not initialized. Check STRIPE_SECRET_KEY.");
  }
  return stripe;
};

const toUnixSeconds = (value) => {
  if (!value) return Math.floor(Date.now() / 1000);
  if (typeof value === "number") return Math.floor(value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return Math.floor(Date.now() / 1000);
  return Math.floor(parsed.getTime() / 1000);
};

const getStripeMetadata = (payload = {}) => ({
  user_id: payload.userId ?? "",
  center_name: payload.centerName ?? "",
  plan_type: payload.planType ?? "payg",
  project_name: payload.projectName ?? "",
});

const logAndPersistSubscription = async ({
  userId,
  subscriptionId,
  status,
  customerId,
  projectName,
  planType,
  currentPeriodEnd,
  invoiceAmount,
  invoiceCurrency,
}) => {
  if (!userId) {
    console.warn("[Stripe] Missing userId, skipping Supabase sync.");
    return;
  }

  if (!BILLING_TABLE) {
    console.log("[Stripe] SUPABASE_BILLING_TABLE not set, skipping persistence.");
    return;
  }

  const payload = {
    user_id: userId,
    project_name: projectName ?? null,
    plan_type: planType ?? "payg",
    stripe_subscription_id: subscriptionId ?? null,
    stripe_customer_id: customerId ?? null,
    subscription_status: status ?? null,
    current_period_end: currentPeriodEnd
      ? new Date(currentPeriodEnd * 1000).toISOString()
      : null,
    last_invoice_amount: invoiceAmount ?? null,
    last_invoice_currency: invoiceCurrency ?? null,
    grant_access: status === "paid" || status === "active",
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from(BILLING_TABLE)
    .upsert([payload], { onConflict: "user_id" });

  if (error) {
    console.error("[Stripe] Failed to persist subscription state:", error);
  }
};

const persistUsageRecord = async ({
  userId,
  projectName,
  quantity,
  subscriptionItemId,
  stripeUsageId,
}) => {
  if (!USAGE_TABLE || !userId) {
    return;
  }

  const { error } = await supabase.from(USAGE_TABLE).insert([
    {
      user_id: userId,
      project_name: projectName ?? null,
      quantity,
      subscription_item_id: subscriptionItemId,
      stripe_usage_record_id: stripeUsageId,
      created_at: new Date().toISOString(),
    },
  ]);

  if (error) {
    console.error("[Stripe] Failed to persist usage record:", error);
  }
};

export const createPaygCheckoutSession = async (req, res) => {
  try {
    const stripeClient = ensureStripeClient();
    const {
      userId,
      email,
      projectName,
      planName,
      usagePriceId = process.env.STRIPE_PAYG_PRICE_ID,
      basePriceId,
      trialDays = Number(process.env.STRIPE_PAYG_TRIAL_DAYS || 0),
      successUrl = DEFAULT_SUCCESS_URL,
      cancelUrl = DEFAULT_CANCEL_URL,
    } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    if (!usagePriceId) {
      return res.status(400).json({ error: "usagePriceId is required" });
    }

    const lineItems = [
      {
        price: usagePriceId,
        quantity: 1, // Metered price collects usage monthly.
      },
    ];

    if (basePriceId) {
      lineItems.unshift({ price: basePriceId, quantity: 1 });
    }

    const session = await stripeClient.checkout.sessions.create({
      mode: "subscription",
      billing_address_collection: "auto",
      customer_email: email,
      line_items: lineItems,
      subscription_data: {
        trial_period_days: trialDays > 0 ? trialDays : undefined,
        metadata: getStripeMetadata({ userId, projectName, planType: planName }),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error("[Stripe] Checkout session error:", error);
    return res.status(500).json({ error: error.message });
  }
};

export const createBillingPortalSession = async (req, res) => {
  try {
    const stripeClient = ensureStripeClient();
    const { customerId, sessionId, returnUrl = `${process.env.PUBLIC_URL ?? "http://localhost:5173"}/billing` } =
      req.body;

    let resolvedCustomer = customerId;
    if (!resolvedCustomer && sessionId) {
      const checkoutSession = await stripeClient.checkout.sessions.retrieve(sessionId);
      resolvedCustomer = checkoutSession.customer;
    }

    if (!resolvedCustomer) {
      return res.status(400).json({ error: "customerId or sessionId is required" });
    }

    const portalSession = await stripeClient.billingPortal.sessions.create({
      customer: resolvedCustomer,
      return_url: returnUrl,
    });

    return res.status(200).json({ url: portalSession.url });
  } catch (error) {
    console.error("[Stripe] Billing portal error:", error);
    return res.status(500).json({ error: error.message });
  }
};

const findMeteredSubscriptionItem = (subscription) =>
  subscription?.items?.data?.find(
    (item) => item.price?.recurring?.usage_type === "metered"
  );

export const reportPaygUsage = async (req, res) => {
  try {
    const stripeClient = ensureStripeClient();
    const {
      subscriptionItemId,
      subscriptionId,
      quantity,
      timestamp,
      action = "increment",
      userId,
      projectName,
    } = req.body;

    if (!quantity || Number(quantity) <= 0) {
      return res.status(400).json({ error: "quantity must be greater than 0" });
    }

    let itemId = subscriptionItemId;
    if (!itemId && subscriptionId) {
      const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
      const meteredItem = findMeteredSubscriptionItem(subscription);
      itemId = meteredItem?.id;
    }

    if (!itemId) {
      return res
        .status(400)
        .json({ error: "Provide subscriptionItemId or subscriptionId with a metered price" });
    }

    const usageRecord = await stripeClient.subscriptionItems.createUsageRecord(itemId, {
      quantity: Number(quantity),
      timestamp: timestamp ? toUnixSeconds(timestamp) : "now",
      action,
    });

    await persistUsageRecord({
      userId,
      projectName,
      quantity: Number(quantity),
      subscriptionItemId: itemId,
      stripeUsageId: usageRecord.id,
    });

    return res.status(200).json({ usageRecord });
  } catch (error) {
    console.error("[Stripe] Usage reporting error:", error);
    return res.status(500).json({ error: error.message });
  }
};

const extractUserIdFromEvent = (payload) =>
  payload?.metadata?.user_id ||
  payload?.subscription_details?.metadata?.user_id ||
  payload?.lines?.data?.[0]?.metadata?.user_id ||
  payload?.data?.object?.metadata?.user_id;

export const handleStripeWebhook = async (req, res) => {
  try {
    const stripeClient = ensureStripeClient();
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event = req.body;

    if (endpointSecret) {
      const signature = req.headers["stripe-signature"];
      const rawBody =
        req.rawBody instanceof Buffer
          ? req.rawBody
          : Buffer.from(req.rawBody || JSON.stringify(req.body), "utf8");

      try {
        event = stripeClient.webhooks.constructEvent(rawBody, signature, endpointSecret);
      } catch (err) {
        console.error("[Stripe] Webhook verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
    }

    const { type } = event;
    console.log(`[Stripe] Webhook received: ${type}`);

    switch (type) {
      case "invoice.paid": {
        const invoice = event.data.object;
        const userId = extractUserIdFromEvent(invoice);
        await logAndPersistSubscription({
          userId,
          subscriptionId: invoice.subscription,
          status: invoice.status,
          customerId: invoice.customer,
          projectName: invoice.subscription_details?.metadata?.project_name,
          planType: invoice.subscription_details?.metadata?.plan_type,
          currentPeriodEnd: invoice.lines?.data?.[0]?.period?.end,
          invoiceAmount: invoice.amount_paid,
          invoiceCurrency: invoice.currency,
        });
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const userId = extractUserIdFromEvent(invoice);
        await logAndPersistSubscription({
          userId,
          subscriptionId: invoice.subscription,
          status: invoice.status,
          customerId: invoice.customer,
          projectName: invoice.subscription_details?.metadata?.project_name,
          planType: invoice.subscription_details?.metadata?.plan_type,
          currentPeriodEnd: invoice.lines?.data?.[0]?.period?.end,
        });
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const subscription = event.data.object;
        const userId = extractUserIdFromEvent(subscription);
        await logAndPersistSubscription({
          userId,
          subscriptionId: subscription.id,
          status: subscription.status,
          customerId: subscription.customer,
          projectName: subscription.metadata?.project_name,
          planType: subscription.metadata?.plan_type,
          currentPeriodEnd: subscription.current_period_end,
        });
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const userId = extractUserIdFromEvent(subscription);
        await logAndPersistSubscription({
          userId,
          subscriptionId: subscription.id,
          status: "canceled",
          customerId: subscription.customer,
          projectName: subscription.metadata?.project_name,
          planType: subscription.metadata?.plan_type,
          currentPeriodEnd: subscription.current_period_end,
        });
        break;
      }
      case "usage_record.summary.updated": {
        const summary = event.data.object;
        console.log("[Stripe] Usage summary updated", summary);
        break;
      }
      default:
        console.log(`[Stripe] Unhandled event type ${type}`);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("[Stripe] Webhook handler failed:", error);
    return res.status(500).json({ error: error.message });
  }
};
