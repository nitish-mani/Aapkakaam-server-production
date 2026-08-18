const FinancialAudit = require("../models/financialAudit");
const logger = require("../logger/logger");

class AuditService {
  async logPaymentEvent(data) {
    try {
      const auditEntry = new FinancialAudit({
        requestId: data.requestId,
        transactionId: data.transactionId,
        orderId: data.orderId,
        paymentId: data.paymentId,
        gateway: data.gateway || "razorpay",
        userId: data.userId,
        vendorId: data.vendorId,
        event: data.event,
        status: data.status,
        previousStatus: data.previousStatus,
        newStatus: data.newStatus,
        amount: data.amount,
        finalAmount: data.finalAmount,
        discount: data.discount,
        currency: data.currency || "INR",
        ip: data.ip,
        userAgent: data.userAgent,
        device: data.device,
        success: data.success,
        error: data.error,
        metadata: data.metadata,
        eventTime: data.eventTime || new Date(),
      });

      await auditEntry.save();

      logger.info(
        {
          requestId: data.requestId,
          event: data.event,
          transactionId: data.transactionId,
          success: data.success,
        },
        "Financial audit logged",
      );

      return auditEntry;
    } catch (error) {
      // Audit failures must never break the main flow
      logger.error({ error, data }, "Failed to log financial audit");
    }
  }

  async getTransactionAudit(transactionId) {
    return await FinancialAudit.find({ transactionId }).sort({ eventTime: 1 }).lean();
  }

  async getOrderAudit(orderId) {
    return await FinancialAudit.find({ orderId }).sort({ eventTime: 1 }).lean();
  }

  async getRequestAudit(requestId) {
    return await FinancialAudit.find({ requestId }).sort({ eventTime: 1 }).lean();
  }
}

module.exports = new AuditService();
