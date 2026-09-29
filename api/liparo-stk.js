export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed. Use POST."
    });
  }

  try {
    const secretKey = process.env.LIPARO_SECRET_KEY;
    const passkey = process.env.LIPARO_PASSKEY;
    const shortcode = process.env.LIPARO_SHORTCODE || "3863372";

    if (!secretKey || !passkey) {
      return res.status(500).json({
        success: false,
        message: "Liparo credentials are not configured."
      });
    }

    const { phone, amount, reference } = req.body || {};

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required."
      });
    }

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

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount."
      });
    }

    const response = await fetch(
      "https://api.liparo.co.ke/v1/initiatestk",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          secret_key: secretKey,
          passkey: passkey,
          shortcode: shortcode,
          amount: numericAmount,
          phone: normalizedPhone
        })
      }
    );

    const responseText = await response.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      data = {
        raw_response: responseText
      };
    }

    return res.status(response.status).json({
      success: response.ok,
      liparo: data,
      reference: reference || null
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Unable to connect to Liparo.",
      error: error.message
    });
  }
          }
