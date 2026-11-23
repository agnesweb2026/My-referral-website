
const db = require("../db");

const {
  normalizePhone,
  hashPassword,
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

    const phone = normalizePhone(body.phone);
    const password = body.password;
    const confirmPassword = body.confirmPassword;

    if (
      typeof password !== "string" ||
      typeof confirmPassword !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter your password and confirm it."
      });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        success: false,
        message: "Password must contain 8 to 128 characters."
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match."
      });
    }

    // Hash password before saving.
    const passwordHash = await hashPassword(password);

    // Create the separate website-user table.
    await db.query(`
      CREATE TABLE IF NOT EXISTS website_users (
        id BIGSERIAL PRIMARY KEY,
        phone VARCHAR(20) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Register user.
    let result;

    try {
      result = await db.query(
        `INSERT INTO website_users (phone, password_hash)
         VALUES ($1, $2)
         RETURNING id, phone, created_at`,
        [phone, passwordHash]
      );
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "This phone number already has an account. Please log in."
        });
      }

      throw error;
    }

    const user = result.rows[0];

    // Automatically log in after successful registration.
    const sessionToken = createSession(user.id);

    setSessionCookie(res, sessionToken);

    return res.status(201).json({
      success: true,
      message: "Account created successfully.",
      user: {
        id: user.id,
        phone: user.phone
      }
    });

  } catch (error) {
    console.error("Registration error:", error.message);

    if (
      error.message &&
      (
        error.message.includes("valid Kenyan number") ||
        error.message.includes("SESSION_SECRET")
      )
    ) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to create account. Please try again."
    });
  }
};
    
