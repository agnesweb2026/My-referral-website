
const db = require("../db");

const {
  normalizePhone,
  verifyPassword,
  createSession,
  setSessionCookie
} = require("../auth-utils");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const body = req.body || {};

    let phone;

    try {
      phone = normalizePhone(body.phone);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Kenyan phone number starting with 07 or 01."
      });
    }

    const password = body.password;

    if (
      typeof password !== "string" ||
      password.length < 1 ||
      password.length > 128
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter your password."
      });
    }

    const result = await db.query(
      `SELECT id, phone, password_hash
       FROM website_users
       WHERE phone = $1
       LIMIT 1`,
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Incorrect phone number or password."
      });
    }

    const user = result.rows[0];

    const passwordIsCorrect = await verifyPassword(
      password,
      user.password_hash
    );

    if (!passwordIsCorrect) {
      return res.status(401).json({
        success: false,
        message: "Incorrect phone number or password."
      });
    }

    const sessionToken = createSession(user.id);

    setSessionCookie(res, sessionToken);

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      user: {
        id: user.id,
        phone: user.phone
      }
    });

  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to log in. Please try again."
    });
  }
};
