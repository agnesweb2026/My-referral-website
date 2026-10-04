const { query, ensurePaymentTable } = require("./db");

function json(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(data));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      paid: false,
      message: "Method not allowed"
    });
  }

  try {
    const {
      transaction_request_id,
      transaction_id
    } = req.body || {};

    const transactionId = String(
      transaction_id ||
      transaction_request_id ||
      ""
    ).trim();

    if (!transactionId) {
      return json(res, 400, {
        success: false,
        paid: false,
        message: "Missing transaction ID."
      });
    }

    if (transactionId.length > 150) {
      return json(res, 400, {
        success: false,
        paid: false,
        message: "Invalid transaction ID."
      });
    }

    await ensurePaymentTable();

    // =====================================================
    // LIPARO CREDENTIALS
    // =====================================================

    const liparoSecret =
      String(
        process.env.LIPARO_SECRET || ""
      ).trim();

    const liparoPasskey =
      String(
        process.env.LIPARO_PASSKEY || ""
      ).trim();

    const liparoShortcode =
      String(
        process.env.LIPARO_SHORTCODE || ""
      ).trim();

    if (
      !liparoSecret ||
      !liparoPasskey ||
      !liparoShortcode
    ) {
      return json(res, 500, {
        success: false,
        paid: false,
        message:
          "Liparo payment credentials are not configured on the server."
      });
    }

    // =====================================================
    // STEP 1
    // CHECK OUR DATABASE FIRST
    // =====================================================

    const saved = await query(
      `
      SELECT
        reference,
        amount,
        phone,
        status,
        transaction_request_id,
        transaction_id,
        transaction_code
      FROM payments
      WHERE
        transaction_request_id = $1
        OR transaction_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [transactionId]
    );

    if (saved.rows.length > 0) {
      const payment =
        saved.rows[0];

      const savedStatus =
        String(
          payment.status || ""
        )
          .trim()
          .toLowerCase();

      // ===================================================
      // ALREADY PAID
      // ===================================================

      if (
        savedStatus === "completed" ||
        savedStatus === "complete" ||
        savedStatus === "paid" ||
        savedStatus === "successful" ||
        savedStatus === "success"
      ) {
        return json(res, 200, {
          success: true,
          paid: true,
          status: "Completed",

          transaction_id:
            payment.transaction_id ||
            transactionId,

          transaction_request_id:
            payment.transaction_request_id ||
            transactionId,

          amount:
            payment.amount ?? null,

          phone:
            payment.phone ?? null,

          reference:
            payment.reference ?? null,

          message:
            "Payment completed successfully."
        });
      }

      // ===================================================
      // FAILED
      // ===================================================

      if (
        savedStatus === "failed" ||
        savedStatus === "failure" ||
        savedStatus === "rejected"
      ) {
        return json(res, 200, {
          success: true,
          paid: false,
          status: "Failed",

          transaction_id:
            payment.transaction_id ||
            transactionId,

          transaction_request_id:
            payment.transaction_request_id ||
            transactionId,

          message:
            "Payment failed."
        });
      }

      // ===================================================
      // CANCELLED
      // ===================================================

      if (
        savedStatus === "cancelled" ||
        savedStatus === "canceled"
      ) {
        return json(res, 200, {
          success: true,
          paid: false,
          status: "Cancelled",

          transaction_id:
            payment.transaction_id ||
            transactionId,

          transaction_request_id:
            payment.transaction_request_id ||
            transactionId,

          message:
            "Payment was cancelled."
        });
      }
    }

    // =====================================================
    // STEP 2
    // ASK LIPARO FOR CURRENT STATUS
    // =====================================================

    const response =
      await fetch(
        "https://api.liparo.co.ke/v1/checktransaction",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "Accept":
              "application/json"
          },

          body: JSON.stringify({
            secret_key:
              liparoSecret,

            passkey:
              liparoPasskey,

            shortcode:
              liparoShortcode,

            transaction_id:
              transactionId
          })
        }
      );

    const responseText =
      await response.text();

    let data = {};

    try {
      data = responseText
        ? JSON.parse(responseText)
        : {};
    } catch {
      data = {
        success: false,

        message:
          responseText ||
          "Liparo returned an invalid response."
      };
    }

    console.log(
      "LIPARO_STATUS_RESULT",
      JSON.stringify({
        transaction_id:
          transactionId,

        httpStatus:
          response.status,

        status:
          data.status ||
          null,

        success:
          data.success === true,

        receipt:
          data.mpesa_receipt ||
          null
      })
    );

    // =====================================================
    // NORMALIZE STATUS
    // =====================================================

    const status =
      String(
        data.status || ""
      )
        .trim()
        .toLowerCase();

    const completed =
      status === "completed" ||
      status === "complete" ||
      status === "successful" ||
      status === "success" ||
      status === "paid";

    const failed =
      status === "failed" ||
      status === "failure" ||
      status === "rejected";

    const cancelled =
      status === "cancelled" ||
      status === "canceled";

    // =====================================================
    // PAYMENT COMPLETED
    // =====================================================

    if (
      response.ok &&
      data.success === true &&
      completed
    ) {
      await query(
        `
        UPDATE payments
        SET
          status = 'completed',

          transaction_request_id =
            COALESCE(
              transaction_request_id,
              $1
            ),

          transaction_id =
            COALESCE(
              transaction_id,
              $1
            ),

          transaction_code =
            COALESCE(
              transaction_code,
              $2
            ),

          updated_at = NOW()

        WHERE
          transaction_request_id = $1
          OR transaction_id = $1
        `,
        [
          transactionId,

          data.mpesa_receipt ||
            data.transaction_code ||
            "0"
        ]
      );

      return json(res, 200, {
        success: true,
        paid: true,
        status: "Completed",

        transaction_id:
          transactionId,

        transaction_request_id:
          transactionId,

        amount:
          data.amount ??
          null,

        phone:
          data.phone ??
          null,

        reference:
          data.reference ??
          null,

        mpesa_receipt:
          data.mpesa_receipt ??
          null,

        message:
          data.result_desc ||
          data.message ||
          "Payment completed successfully."
      });
    }

    // =====================================================
    // PAYMENT FAILED
    // =====================================================

    if (failed) {
      await query(
        `
        UPDATE payments
        SET
          status = 'failed',
          updated_at = NOW()
        WHERE
          transaction_request_id = $1
          OR transaction_id = $1
        `,
        [transactionId]
      );

      return json(res, 200, {
        success: true,
        paid: false,
        status: "Failed",

        transaction_id:
          transactionId,

        transaction_request_id:
          transactionId,

        message:
          data.result_desc ||
          data.message ||
          "Payment failed."
      });
    }

    // =====================================================
    // PAYMENT CANCELLED
    // =====================================================

    if (cancelled) {
      await query(
        `
        UPDATE payments
        SET
          status = 'cancelled',
          updated_at = NOW()
        WHERE
          transaction_request_id = $1
          OR transaction_id = $1
        `,
        [transactionId]
      );

      return json(res, 200, {
        success: true,
        paid: false,
        status: "Cancelled",

        transaction_id:
          transactionId,

        transaction_request_id:
          transactionId,

        message:
          data.result_desc ||
          data.message ||
          "Payment was cancelled."
      });
    }

    // =====================================================
    // STILL PENDING
    // =====================================================

    return json(res, 200, {
      success: true,
      paid: false,

      status:
        data.status ||
        "Pending",

      transaction_id:
        transactionId,

      transaction_request_id:
        transactionId,

      message:
        data.result_desc ||
        data.message ||
        "Payment is still pending."
    });

  } catch (error) {
    console.error(
      "LIPARO_STATUS_ERROR",
      error
    );

    return json(res, 500, {
      success: false,
      paid: false,

      message:
        "Unable to check the M-PESA payment status."
    });
  }
};
