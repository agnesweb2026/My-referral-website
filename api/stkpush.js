export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const {
      phone,
      amount,
      minutes,
      ref
    } = req.body || {};

    if (!phone || !amount) {
      return res.status(400).json({
        success: false,
        message: "Phone number and amount are required."
      });
    }

    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const callbackUrl = process.env.MPESA_CALLBACK_URL;

    if (
      !consumerKey ||
      !consumerSecret ||
      !shortcode ||
      !passkey ||
      !callbackUrl
    ) {
      return res.status(500).json({
        success: false,
        message: "M-Pesa configuration is incomplete."
      });
    }

    // Convert phone number to 2547XXXXXXXX format
    let formattedPhone = String(phone).replace(/\D/g, "");

    if (formattedPhone.startsWith("0")) {
      formattedPhone = "254" + formattedPhone.substring(1);
    }

    if (formattedPhone.startsWith("+")) {
      formattedPhone = formattedPhone.substring(1);
    }

    if (!/^2547\d{8}$/.test(formattedPhone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Kenyan M-Pesa number."
      });
    }

    // Get OAuth access token
    const auth = Buffer.from(
      consumerKey + ":" + consumerSecret
    ).toString("base64");

    const tokenResponse = await fetch(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        method: "GET",
        headers: {
          Authorization: "Basic " + auth
        }
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      return res.status(500).json({
        success: false,
        message: "Could not obtain M-Pesa access token."
      });
    }

    // Create timestamp
    const now = new Date();

    const timestamp =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, "0") +
      String(now.getDate()).padStart(2, "0") +
      String(now.getHours()).padStart(2, "0") +
      String(now.getMinutes()).padStart(2, "0") +
      String(now.getSeconds()).padStart(2, "0");

    const password = Buffer.from(
      shortcode + passkey + timestamp
    ).toString("base64");

    // Send STK Push
    const stkResponse = await fetch(
      https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokenData.access_token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerBuyGoodsOnline",
          Amount: Number(amount),
          PartyA: formattedPhone,
          PartyB: 1605854,
          PhoneNumber: formattedPhone,
          CallBackURL: callbackUrl,
          AccountReference: ref || "Website",
          TransactionDesc:
            "Access " + (minutes || "") + " minutes"
        })
      }
    );

    const stkData = await stkResponse.json();

    if (stkData.ResponseCode === "0") {
      return res.status(200).json({
        success: true,
        message: "STK Push sent successfully.",
        checkoutRequestID: stkData.CheckoutRequestID
      });
    }

    return res.status(400).json({
      success: false,
      message:
        stkData.errorMessage ||
        stkData.ResponseDescription ||
        "M-Pesa payment request failed."
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Payment service error."
    });
  }
  }
