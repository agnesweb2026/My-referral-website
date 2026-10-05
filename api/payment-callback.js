const crypto = require("crypto");
const { query, ensurePaymentTable } = require("./db");

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {

    const secret =
      process.env.PAYLOR_WEBHOOK_SECRET;

    if (!secret) {

      console.error(
        "PAYLOR_WEBHOOK_SECRET is missing"
      );

      return res.status(500).json({
        success: false,
        message:
          "Paylor webhook secret is not configured"
      });
    }


    await ensurePaymentTable();


    /*
    =====================================================
    RAW BODY
    =====================================================
    */

    let rawBody;

    if (req.rawBody) {

      rawBody =
        Buffer.isBuffer(req.rawBody)
          ? req.rawBody
          : Buffer.from(req.rawBody);

    } else if (
      typeof req.body === "string"
    ) {

      rawBody =
        Buffer.from(req.body);

    } else {

      rawBody =
        Buffer.from(
          JSON.stringify(
            req.body || {}
          )
        );
    }


    /*
    =====================================================
    WEBHOOK SIGNATURE
    =====================================================
    */

    const signature =
      req.headers[
        "x-webhook-signature"
      ] ||
      req.headers[
        "X-Webhook-Signature"
      ];


    if (!signature) {

      console.error(
        "Missing Paylor webhook signature"
      );

      return res.status(401).json({
        success: false,
        message:
          "Missing webhook signature"
      });
    }


    /*
    =====================================================
    HMAC SHA-256
    =====================================================
    */

    const expectedSignature =
      crypto
        .createHmac(
          "sha256",
          secret
        )
        .update(rawBody)
        .digest("hex");


    const providedBuffer =
      Buffer.from(
        String(signature)
      );

    const expectedBuffer =
      Buffer.from(
        expectedSignature
      );


    if (
      providedBuffer.length !==
        expectedBuffer.length ||
      !crypto.timingSafeEqual(
        providedBuffer,
        expectedBuffer
      )
    ) {

      console.error(
        "Invalid Paylor webhook signature"
      );

      return res.status(401).json({
        success: false,
        message:
          "Invalid webhook signature"
      });
    }


    /*
    =====================================================
    PARSE BODY
    =====================================================
    */

    const body =
      typeof req.body === "object"
        ? req.body
        : JSON.parse(
            rawBody.toString("utf8")
          );


    const event =
      body.event;


    const transaction =
      body.transaction || {};


    const reference =
      transaction.reference ||
      body.reference ||
      transaction.merchantReference ||
      body.merchantReference ||
      null;


    const transactionId =
      transaction.id ||
      transaction.transactionId ||
      body.transactionId ||
      body.id ||
      null;


    const providerRef =
      transaction.providerRef ||
      body.providerRef ||
      null;


    const mpesaReceipt =
      transaction.mpesaReceipt ||
      transaction.metadata?.mpesaReceipt ||
      body.mpesaReceipt ||
      null;


    const status =
      String(
        transaction.status ||
        body.status ||
        ""
      )
        .toUpperCase()
        .trim();


    /*
    =====================================================
    NO REFERENCE
    =====================================================
    */

    if (!reference) {

      console.error(
        "Paylor webhook has no payment reference"
      );

      return res.status(200).json({
        received: true,
        processed: false
      });
    }


    /*
    =====================================================
    PAYMENT SUCCESS
    =====================================================
    */

    if (
      event === "payment.success" ||
      status === "COMPLETED" ||
      status === "CONFIRMED"
    ) {

      /*
      ---------------------------------------------------
      UPDATE PAYMENTS
      ---------------------------------------------------
      */

      await query(
        `
        UPDATE payments

        SET
          status = 'completed',

          transaction_id =
            COALESCE(
              $1,
              transaction_id
            ),

          transaction_code =
            COALESCE(
              $2,
              transaction_code
            ),

          updated_at = NOW()

        WHERE reference = $3
        `,
        [
          transactionId,

          mpesaReceipt ||
            providerRef,

          reference
        ]
      );


      /*
      ---------------------------------------------------
      UPDATE PAYMENT ATTEMPT
      ---------------------------------------------------
      */

      await query(
        `
        UPDATE payment_attempts

        SET
          status = 'completed',

          transaction_id =
            COALESCE(
              $1,
              transaction_id
            ),

          updated_at = NOW()

        WHERE
          reference = $2

          OR (
            $1 IS NOT NULL
            AND transaction_id = $1
          )
        `,
        [
          transactionId,

          reference
        ]
      );


      console.log(
        "PAYLOR PAYMENT COMPLETED:",
        reference,
        transactionId,
        mpesaReceipt
      );


      return res.status(200).json({

        received: true,

        processed: true,

        paid: true
      });
    }


    /*
    =====================================================
    PAYMENT FAILED / CANCELLED / REJECTED
    =====================================================
    */

    if (
      event === "payment.failed" ||
      status === "FAILED" ||
      status === "CANCELLED" ||
      status === "CANCELED" ||
      status === "REJECTED"
    ) {

      let attemptStatus =
        "failed";


      if (
        status === "CANCELLED" ||
        status === "CANCELED"
      ) {

        attemptStatus =
          "cancelled";

      } else if (
        status === "REJECTED"
      ) {

        attemptStatus =
          "rejected";
      }


      /*
      ---------------------------------------------------
      UPDATE PAYMENTS
      ---------------------------------------------------
      */

      await query(
        `
        UPDATE payments

        SET
          status = 'failed',

          transaction_id =
            COALESCE(
              $1,
              transaction_id
            ),

          updated_at = NOW()

        WHERE reference = $2
        `,
        [
          transactionId,

          reference
        ]
      );


      /*
      ---------------------------------------------------
      UPDATE PAYMENT ATTEMPT
      ---------------------------------------------------
      */

      await query(
        `
        UPDATE payment_attempts

        SET
          status = $1,

          transaction_id =
            COALESCE(
              $2,
              transaction_id
            ),

          updated_at = NOW()

        WHERE
          reference = $3

          OR (
            $2 IS NOT NULL
            AND transaction_id = $2
          )
        `,
        [
          attemptStatus,

          transactionId,

          reference
        ]
      );


      console.log(
        "PAYLOR PAYMENT FAILED:",
        reference,
        transactionId,
        attemptStatus
      );


      return res.status(200).json({

        received: true,

        processed: true,

        paid: false
      });
    }


    /*
    =====================================================
    OTHER EVENTS
    =====================================================
    */

    console.log(
      "PAYLOR WEBHOOK RECEIVED:",
      event,
      reference,
      status
    );


    return res.status(200).json({

      received: true,

      processed: false
    });


  } catch (error) {

    console.error(
      "PAYLOR WEBHOOK ERROR:",
      error
    );


    return res.status(500).json({

      success: false,

      message:
        "Webhook processing failed"
    });
  }
};
