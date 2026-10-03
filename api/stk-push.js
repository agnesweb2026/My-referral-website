const { query, ensurePaymentTable } = require("./db");

function json(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(data));
}

// In-memory protection.
// Hii ni protection ya ziada; database ndiyo source ya payment records.
const recentRequests = new Map();

const COOLDOWN_MS = 30 * 1000;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    // =========================
    // DATABASE SETUP
    // =========================
    await ensurePaymentTable();

    const {
      phone,
      amount,
      reference
    } = req.body || {};

    // =========================
    // PHONE
    // =========================
    const rawPhone = String(phone || "")
      .replace(/\D/g, "");

    let mpesaPhone = rawPhone;

    if (/^07\d{8}$/.test(rawPhone)) {
      mpesaPhone =
        "254" + rawPhone.substring(1);
    }

    if (/^2547\d{8}$/.test(rawPhone)) {
      mpesaPhone = rawPhone;
    }

    if (!/^2547\d{8}$/.test(mpesaPhone)) {
      return json(res, 400, {
        success: false,
        message:
          "Enter a valid Safaricom M-PESA number.",
        validation: "phone"
      });
    }

    // =========================
    // AMOUNT
    // =========================
    const cleanAmount = Number(amount);

    if (
      !Number.isInteger(cleanAmount) ||
      cleanAmount < 1 ||
      cleanAmount > 150000
    ) {
      return json(res, 400, {
        success: false,
        message: "Invalid payment amount.",
        validation: "amount"
      });
    }

    // =========================
    // REFERENCE
    // =========================
    const cleanReference = String(
      reference || ""
    )
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 12);

    if (!cleanReference) {
      return json(res, 400, {
        success: false,
        message: "Missing payment reference.",
        validation: "reference"
      });
    }

    // =========================
    // DUPLICATE REQUEST PROTECTION
    // =========================
    const requestKey =
      mpesaPhone +
      "|" +
      cleanAmount +
      "|" +
      cleanReference;

    const now = Date.now();

    const previousRequest =
      recentRequests.get(requestKey);

    if (
      previousRequest &&
      now - previousRequest < COOLDOWN_MS
    ) {
      return json(res, 429, {
        success: false,
        message:
          "A payment request was already sent. Please wait before trying again.",
        retry_after_seconds:
          Math.ceil(
            (COOLDOWN_MS -
              (now - previousRequest)) / 1000
          )
      });
    }

    recentRequests.set(
      requestKey,
      now
    );

    // Clean old memory entries.
    if (recentRequests.size > 5000) {
      for (const [
        key,
        timestamp
      ] of recentRequests) {
        if (
          now - timestamp >
          COOLDOWN_MS
        ) {
          recentRequests.delete(key);
        }
      }
    }

    // =========================
    // CHECK EXISTING DATABASE PAYMENT
    // =========================
    const existingPayment =
      await query(
        `
        SELECT
          id,
          amount,
          phone,
          status,
          transaction_request_id
        FROM payments
        WHERE reference = $1
        LIMIT 1
        `,
        [cleanReference]
      );

    if (
      existingPayment.rows.length > 0
    ) {
      const existing =
        existingPayment.rows[0];

      // Never allow the same reference
      // to be reused for a different amount.
      if (
        Number(existing.amount) !==
        cleanAmount
      ) {
        recentRequests.delete(
          requestKey
        );

        return json(res, 409, {
          success: false,
          message:
            "This payment reference is already linked to another amount."
        });
      }

      // If a previous request is still pending,
      // don't send another STK request.
      if (
        String(existing.status).toLowerCase() ===
        "pending"
      ) {
        recentRequests.delete(
          requestKey
        );

        return json(res, 409, {
          success
