
const crypto = require("crypto");

/*
====================================================
AUTHENTICATION UTILITIES
====================================================
*/

// Session secret must be configured in Vercel.
function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET is missing or too short."
    );
  }

  return secret;
}


/*
====================================================
KENYAN PHONE NUMBER VALIDATION
====================================================
*/

function normalizePhone(phone) {
  if (typeof phone !== "string") {
    throw new Error("Enter a valid phone number.");
  }

  let value = phone.replace(/[\s-]/g, "");

  // Convert international Kenyan format to local format.
  if (value.startsWith("+254")) {
    value = "0" + value.slice(4);
  } else if (value.startsWith("254")) {
    value = "0" + value.slice(3);
  }

  if (!/^0[17]\d{8}$/.test(value)) {
    throw new Error(
      "Use a valid Kenyan number starting with 07 or 01."
    );
  }

  return value;
}


/*
====================================================
PASSWORD HASHING
====================================================
*/

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 128
    ) {
      return reject(
        new Error("Password must contain 8 to 128 characters.")
      );
    }

    const salt = crypto.randomBytes(16).toString("hex");

    crypto.scrypt(
      password,
      salt,
      64,
      {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024
      },
      (error, derivedKey) => {
        if (error) {
          return reject(error);
        }

        resolve(
          "scrypt:" +
          salt +
          ":" +
          derivedKey.toString("hex")
        );
      }
    );
  });
}


function verifyPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    if (
      typeof password !== "string" ||
      typeof storedHash !== "string"
    ) {
      return resolve(false);
    }

    const parts = storedHash.split(":");

    if (
      parts.length !== 3 ||
      parts[0] !== "scrypt"
    ) {
      return resolve(false);
    }

    const salt = parts[1];
    const originalHash = parts[2];

    if (!/^[a-f0-9]{32}$/i.test(salt)) {
      return resolve(false);
    }

    if (!/^[a-f0-9]{128}$/i.test(originalHash)) {
      return resolve(false);
    }

    crypto.scrypt(
      password,
      salt,
      64,
      {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024
      },
      (error, derivedKey) => {
        if (error) {
          return reject(error);
        }

        const original = Buffer.from(
          originalHash,
          "hex"
        );

        resolve(
          crypto.timingSafeEqual(
            derivedKey,
            original
          )
        );
      }
    );
  });
}


/*
====================================================
SESSION TOKEN
====================================================
*/

function sign(value) {
  return crypto
    .createHmac("sha256", getSessionSecret())
    .update(value)
    .digest("base64url");
}


function createSession(userId) {
  const payload = {
    userId: Number(userId),
    expiresAt:
      Date.now() + (7 * 24 * 60 * 60 * 1000)
  };

  if (
    !Number.isSafeInteger(payload.userId) ||
    payload.userId <= 0
  ) {
    throw new Error("Invalid user ID.");
  }

  const encoded = Buffer
    .from(JSON.stringify(payload))
    .toString("base64url");

  return encoded + "." + sign(encoded);
}


function verifySession(token) {
  try {
    if (
      typeof token !== "string" ||
      token.length > 2000
    ) {
      return null;
    }

    const parts = token.split(".");

    if (parts.length !== 2) {
      return null;
    }

    const [encoded, suppliedSignature] = parts;

    const expectedSignature = sign(encoded);

    const supplied = Buffer.from(
      suppliedSignature,
      "base64url"
    );

    const expected = Buffer.from(
      expectedSignature,
      "base64url"
    );

    if (
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(supplied, expected)
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    );

    if (
      !Number.isSafeInteger(payload.userId) ||
      payload.userId <= 0 ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }

    return payload;

  } catch (error) {
    return null;
  }
}


/*
====================================================
COOKIE HELPERS
====================================================
*/

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || "";

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");

    if (separator === -1) continue;

    const name = cookie
      .slice(0, separator)
      .trim();

    const value = cookie
      .slice(separator + 1)
      .trim();

    if (name === "live_session") {
      try {
        return decodeURIComponent(value);
      } catch (error) {
        return null;
      }
    }
  }

  return null;
}


function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    "live_session=" +
    encodeURIComponent(token) +
    "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800"
  );
}


function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "live_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
  );
}


/*
====================================================
EXPORTS
====================================================
*/

module.exports = {
  normalizePhone,
  hashPassword,
  verifyPassword,
  createSession,
  verifySession,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie
};
                              
