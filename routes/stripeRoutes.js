import express from "express";
import {
  createPaygCheckoutSession,
  createBillingPortalSession,
  reportPaygUsage,
  handleStripeWebhook,
} from "../controllers/stripeController.js";

const router = express.Router();

router.post("/checkout/payg", createPaygCheckoutSession);
router.post("/portal", createBillingPortalSession);
router.post("/usage", reportPaygUsage);
router.post("/webhook", handleStripeWebhook);

export default router;
