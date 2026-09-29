// api/liparo-stk.js

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed. Use POST."
    });
  }

  try {
    const {
      LIPARO_SECRET_KEY,
      LIPARO_PASSKEY,
      LIPARO_SHORTCODE
    } = process.env;

    // Check server environment variables
    if (!LIPARO_SECRET_KEY || !LIPARO_PASSKEY) {
      return res.status(500).json({
        success: false,
        message: "Liparo credentials are not configured on Vercel."
      });
    }

    // Use the shortcode from Vercel.
    // 3863372 is your current Liparo shortcode.
    const shortcode = LIPARO_SHORTCODE || "3863372";

    const { phone, amount, reference } = req.body || {};

    // Validate phone
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required."
      });
    }

    // Convert Kenyan formats to 2547XXXXXXXX
    let normalizedPhone = String(phone).trim();

    if (normalizedPhone.startsWith("+254")) {
      normalizedPhone = normalizedPhone.substring(1);
    } else if (normalizedPhone.startsWith("07")) {
      normalizedPhone = "254" + normalizedPhone.substring(1);
    }

    if (!/^2547\d{8}$/.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Kenyan phone number."
      });
    }

    // Validate amount
    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount."
      });
    }

    // Send STK request to Liparo
    const liparoResponse = await fetch(
      "https://api.liparo.co.ke/v1/initiatestk",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          secret_key: LIPARO_SECRET_KEY,
          passkey: LIPARO_PASSKEY,
          shortcode: shortcode,
          amount: numericAmount,
          phone: normalizedPhone
        })
      }
    );

    const responseText = await liparoResponse.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      data = {
        raw_response: responseText
      };
    }

    return res.status(liparoResponse.status).json({
      success: liparoResponse.ok,
      liparo: data,
      reference: reference || null
    });

  } catch (error) {
    console.error("Liparo STK error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to connect to Liparo.",
      error: error.message
    });
  }
        }
