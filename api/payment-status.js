const { query, ensurePaymentTable } = require("./db");

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const PAYLOR_API_KEY = process.env.PAYLOR_API_KEY;

    if (!PAYLOR_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "Paylor API key is not configured on the server"
      });
    }

    await ensurePaymentTable();

    // Accept reference from the frontend
    const reference =
      req.method === "GET"
        ? req.query.reference
        : req.body?.reference;

    const transactionId =
      req.method === "GET"
        ? req.query.transactionId
        : req.body?.transactionId;

    if (!reference && !transactionId) {
      return res.status(400).json({
        success: false,
        message: "reference or transactionId is required"
      });
    }

    /*
     * ---------------------------------------------------------
     * 1. Find our local payment record
     * ---------------------------------------------------------
     */

    let payment = null;

    if (reference) {
      const result = await query(
        `
        SELECT *
        FROM payments
        WHERE reference = $1
        LIMIT 1
        `,
        [reference]
      );

      payment = result.rows[0] || null;
    } else if (transactionId) {
      const result = await query(
        `
        SELECT *
        FROM payments
        WHERE transaction_request_id = $1
           OR transaction_id = $1
        LIMIT 1
        `,
        [transactionId]
      );

      payment = result.rows[0] || null;
    }

    /*
     * ---------------------------------------------------------
     * 2. If already completed locally, trust our DB
     * ---------------------------------------------------------
     */

    if (payment && payment.status === "completed") {
      return res.status(200).json({
        success: true,
        paid: true,
        status: "COMPLETED",
        reference: payment.reference,
        transaction_id:
          payment.transaction_id ||
          payment.transaction_request_id ||
          null
      });
    }

    /*
     * ---------------------------------------------------------
     * 3. Get Paylor transaction ID
     * ---------------------------------------------------------
     */

    const paylorTransactionId =
      transactionId ||
      payment?.transaction_id ||
      payment?.transaction_request_id;

    if (!paylorTransactionId) {
      return res.status(200).json({
        success: true,
        paid: false,
        status: "PENDING",
        reference: payment?.reference || reference || null
      });
    }

    /*
     * ---------------------------------------------------------
     * 4. Ask Paylor for current transaction status
     * ---------------------------------------------------------
     */

    const paylorResponse = await fetch(
      `https://api.paylorke.com/api/v1/merchants/payments/transactions/${encodeURIComponent(
        paylorTransactionId
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${PAYLOR_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const rawText = await paylorResponse.text();

    let data;

    try {
      data = JSON.parse(rawText);
    } catch {
      data = {
        message: rawText
      };
    }

    if (!paylorResponse.ok) {
      console.error("Paylor status error:", paylorResponse.status, data);

      return res.status(200).json({
        success: true,
        paid: false,
        status: "PENDING",
        reference: payment?.reference || reference || null,
        message: "Payment is still being processed"
      });
    }

    /*
     * Paylor response:
     *
     * {
     *   id,
     *   reference,
     *   amount,
     *   status,
     *   provider,
     *   providerRef,
     *   mpesaReceipt
     * }
     */

    const paylorStatus = String(
      data.status || data.transaction?.status || ""
    ).toUpperCase();

    const finalReference =
      data.reference ||
      data.transaction?.reference ||
      payment?.reference ||
      reference ||
      null;

    const finalTransactionId =
      data.id ||
      data.transaction?.id ||
      paylorTransactionId;

    const providerRef =
      data.providerRef ||
      data.transaction?.providerRef ||
      null;

    const mpesaReceipt =
      data.mpesaReceipt ||
      data.transaction?.mpesaReceipt ||
      null;

    /*
     * ---------------------------------------------------------
     * 5. COMPLETED
     * ---------------------------------------------------------
     */

    if (
      paylorStatus === "COMPLETED" ||
      paylorStatus === "CONFIRMED" ||
      paylorStatus === "SUCCESS"
    ) {
      if (payment) {
        await query(
          `
          UPDATE payments
          SET
            status = 'completed',
            transaction_id = COALESCE($1, transaction_id),
            transaction_code = COALESCE($2, transaction_code),
            updated_at = NOW()
          WHERE reference = $3
          `,
          [
            finalTransactionId,
            mpesaReceipt || providerRef,
            payment.reference
          ]
        );
      }

      return res.status(200).json({
        success: true,
        paid: true,
        status: "COMPLETED",
        reference: finalReference,
        transaction_id: finalTransactionId,
        mpesaReceipt: mpesaReceipt || null
      });
    }

    /*
     * ---------------------------------------------------------
     * 6. FAILED / CANCELLED
     * ---------------------------------------------------------
     */

    if (
      paylorStatus === "FAILED" ||
      paylorStatus === "CANCELLED" ||
      paylorStatus === "CANCELED" ||
      paylorStatus === "REJECTED"
    ) {
      if (payment) {
        await query(
          `
          UPDATE payments
          SET
            status = 'failed',
            transaction_id = COALESCE($1, transaction_id),
            updated_at = NOW()
          WHERE reference = $2
          `,
          [
            finalTransactionId,
            payment.reference
          ]
        );
      }

      return res.status(200).json({
        success: true,
        paid: false,
        status: paylorStatus,
        reference: finalReference,
        transaction_id: finalTransactionId
      });
    }

    /*
     * ---------------------------------------------------------
     * 7. STILL WAITING
     * ---------------------------------------------------------
     */

    return res.status(200).json({
      success: true,
      paid: false,
      status: paylorStatus || "PENDING",
      reference: finalReference,
      transaction_id: finalTransactionId
    });

  } catch (error) {
    console.error("PAYLOR PAYMENT STATUS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to check payment status"
    });
  }
};
