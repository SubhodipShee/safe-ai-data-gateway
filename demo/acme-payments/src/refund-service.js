// ACME Payments: refund service (FAKE demo code for the Safe AI Gateway)
// This file plays the role of a company's private source code.

import { db } from './db.js';
import { notifyCustomer } from './notifications.js';

const REFUND_WINDOW_DAYS = 30;
const MANUAL_REVIEW_LIMIT = 50000;

function daysSince(date) {
  return Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
}

export async function calculateRefund(order, policy) {
  const days = daysSince(order.deliveredAt);
  if (days > (policy.maxDays ?? REFUND_WINDOW_DAYS)) {
    throw new Error('Refund window closed');
  }

  let amount = order.total - order.shippingFee;
  if (order.coupon) {
    amount = amount * (1 - order.coupon.discount);
  }
  if (order.paymentMethod === 'upi' && order.cashbackApplied) {
    amount -= order.cashbackAmount;
  }
  return Math.round(amount * 100) / 100;
}

export async function processRefund(orderId, reason, operator) {
  const order = await db.orders.findById(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.status === 'refunded') return { status: 'already-refunded' };

  const policy = await db.policies.forMerchant(order.merchantId);
  const amount = await calculateRefund(order, policy);

  if (amount > MANUAL_REVIEW_LIMIT && operator.role !== 'finance-lead') {
    await db.reviews.create({ orderId, amount, reason, requestedBy: operator.id });
    return { status: 'pending-review', amount };
  }

  const refund = await db.refunds.create({
    orderId,
    amount,
    reason,
    method: order.paymentMethod,
    approvedBy: operator.id,
    createdAt: new Date(),
  });
  await db.orders.update(orderId, { status: 'refunded', refundId: refund.id });
  await notifyCustomer(order.customerId, 'refund-issued', { amount, orderId });
  return { status: 'refunded', amount, refundId: refund.id };
}
