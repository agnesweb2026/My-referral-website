const crypto = require("crypto");

function json(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(data));
}

module.exports = async (req, res) => {

  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      message: "Method not allowed"
    });
  }

  try {

    const {
      phone,
      amount,
      reference,
      description
    } = req.body || {};


    /*
    ================================================
    CLEAN INPUTS
    ================================================
    */

    const cleanPhone = String(phone || "")
      .replace(/\s+/g, "")
      .trim();

    const cleanAmount = Number(amount);

    const cleanReference = String(reference || "")
      .trim()
      .slice(0, 100);

    const cleanDescription = String(
      description || "M-PESA payment"
    )
      .trim()
      .slice(0, 100);


    /*
    ================================================
    VALIDATE PHONE
    ================================================
    */

    if (!/^2547\d{8}$/.test(cleanPhone)) {

      return json(res, 400, {
        success: false,
        message:
          "Enter a valid Safaricom M-PESA number, for example 254712345678.",
        validation: "phone"
      });

    }


    /*
    ================================================
    VALIDATE AMOUNT
    ================================================
    */

    if (
      !Number.isInteger(cleanAmount) ||
      cleanAmount < 1
    ) {

      return json(res, 400, {
        success: false,
        message:
          "Invalid payment amount.",
        validation: "amount"
      });

    }


    /*
    ================================================
    VALIDATE REFERENCE
    ================================================
    */

    if (!cleanReference) {

      return json(res, 400, {
        success: false,
        message:
          "Missing payment reference.",
        validation: "reference"
      });

    }


    /*
    ================================================
    READ VERCEL ENVIRONMENT VARIABLES
    ================================================
    */

    const publicKey =
      process.env.NEPTUNE_PUBLIC_KEY;

    const secretKey =
      process.env.NEPTUNE_SECRET_KEY;


    if (!publicKey || !secretKey) {

      return json(res, 500, {
        success: false,
        message:
          "Neptune Pay keys are not configured on the server."
      });

    }


    /*
    ================================================
    TIMESTAMP
    ================================================
    */

    const timestamp =
      Math.floor(
        Date.now() / 1000
      ).toString();


    /*
    ================================================
    NEPTUNE REQUEST BODY
    ================================================
    */

    const body = {

      phone:
        cleanPhone,

      amount:
        cleanAmount,

      reference:
        cleanReference,

      description:
        cleanDescription

    };


    const bodyString =
      JSON.stringify(body);


    /*
    ================================================
    CREATE HMAC SIGNATURE
    ================================================
    */

    const signature =
      crypto
        .createHmac(
          "sha256",
          secretKey
        )
        .update(
          timestamp +
          "." +
          bodyString
        )
        .digest("hex");


    /*
    ================================================
    SEND REQUEST TO NEPTUNE
    ================================================
    */

    const response =
      await fetch(
        "https://api.neptunepay.co.ke/api/v1/payments/stk-push",
        {

          method:
            "POST",

          headers: {

            "Content-Type":
              "application/json",

            "x-public-key":
              publicKey,

            "x-signature":
              signature,

            "x-timestamp":
              timestamp

          },

          body:
            bodyString

        }
      );


    /*
    ================================================
    READ NEPTUNE RESPONSE
    ================================================
    */

    const responseText =
      await response.text();


    let data;


    try {

      data =
        JSON.parse(
          responseText
        );

    } catch {

      data = {

        success:
          false,

        message:
          responseText ||
          "Neptune returned an empty response."

      };

    }


    /*
    ================================================
    RETURN NEPTUNE RESPONSE
    ================================================
    
    IMPORTANT:
    We do NOT return the secret key,
    signature, or other credentials.
    */

    return json(
      res,
      response.status,
      {

        success:
          Boolean(data.success),

        message:
          data.message ||
          data.error ||
          "Neptune Pay rejected the request.",

        error:
          data.error ||
          null,

        validation:
          data.validation ||
          null,

        details:
          data.details ||
          null,

        neptuneResponse:
          data,

        neptuneHttpStatus:
          response.status

      }
    );


  } catch (error) {

    console.error(
      "Neptune STK Push error:",
      error
    );


    return json(
      res,
      500,
      {

        success:
          false,

        message:
          "Unable to start the M-PESA prompt.",

        error:
          String(
            error.message ||
            error
          )

      }
    );

  }

};
