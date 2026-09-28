const crypto = require("crypto");

module.exports = async (req, res) => {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {

    const sig =
      req.headers["x-neptune-signature"];

    const ts =
      req.headers["x-neptune-timestamp"];

    const secretKey =
      process.env.NEPTUNE_SECRET_KEY;

    if (!sig || !ts || !secretKey) {
      return res
        .status(401)
        .send("Unauthorized");
    }

    const expected = crypto
      .createHmac("sha256", secretKey)
      .update(
        ts +
        "." +
        JSON.stringify(req.body)
      )
      .digest("hex");

    const a = Buffer.from(String(sig));
    const b = Buffer.from(expected);

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return res
        .status(401)
        .send("Unauthorized");
    }

    const {
      event,
      paymentId,
      status,
      amount,
      phone,
      reference
    } = req.body || {};

    console.log(
      "Verified Neptune Pay webhook:",
      {
        event,
        paymentId,
        status,
        amount,
        phone,
        reference
      }
    );

    return res.status(200).json({
      received: true
    });

  } catch (error) {

    console.error(
      "Webhook error:",
      error
    );

    return res.status(500).json({
      received: false
    });
  }
};
