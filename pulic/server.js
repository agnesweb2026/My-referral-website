const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = 3000;

const RECIPIENT = "0783783687";

const PACKAGES = {
  30: 81,
  55: 138,
  73: 207,
  95: 253,
  105: 299,
  166: 393
};

const db = new Database("payments.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_code TEXT NOT NULL UNIQUE,
    recipient TEXT NOT NULL,
    amount INTEGER NOT NULL,
    minutes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


/*
  Strictly parse an M-PESA confirmation SMS.

  Expected style:

  UINIP7ZH7P Confirmed. Ksh23.00 sent to DIRECT PAY 04
  for account ATL2058983257 on 23/9/26 at 9:02 AM
  New M-PESA balance is Ksh781.65.
*/

function parseMpesaSms(sms) {
  if (typeof sms !== "string") {
    return null;
  }

  const text = sms.trim();

  // Must contain Confirmed immediately after a transaction code.
  const confirmedMatch = text.match(
    /^([A-Z0-9]{8,12})\s+Confirmed\./i
  );

  if (!confirmedMatch) {
    return null;
  }

  const transactionCode = confirmedMatch[1].toUpperCase();

  // Reject suspicious transaction codes.
  if (!/^[A-Z0-9]{8,12}$/.test(transactionCode)) {
    return null;
  }

  // Must contain Ksh amount.
  const amountMatch = text.match(
    /\bKsh\s*([0-9]+(?:\.[0-9]{1,2})?)\b/i
  );

  if (!amountMatch) {
    return null;
  }

  const amount = Number(amountMatch[1]);

  if (!Number.isFinite(amount)) {
    return null;
  }

  // We only accept whole-number package amounts.
  if (!Number.isInteger(amount)) {
    return null;
  }

  /*
    The payment must explicitly be sent to the required number.

    This prevents a message such as:

    Ksh23.00 sent to DIRECT PAY 04 ...

    from being accepted.
  */
  const recipientRegex = new RegExp(
    `\\bsent\\s+to\\s+[^\\n]*\\b${RECIPIENT}\\b`,
    "i"
  );

  if (!recipientRegex.test(text)) {
    return null;
  }

  // It must actually say Confirmed.
  if (!/\bConfirmed\./i.test(text)) {
    return null;
  }

  // Must contain "sent to".
  if (!/\bsent\s+to\b/i.test(text)) {
    return null;
  }

  // Must contain an M-PESA balance section.
  if (!/New\s+M-PESA\s+balance\s+is\s+Ksh/i.test(text)) {
    return null;
  }

  // Must contain transaction cost.
  if (!/Transaction\s+cost,\s*Ksh/i.test(text)) {
    return null;
  }

  return {
    transactionCode,
    amount,
    recipient: RECIPIENT
  };
}


/*
  Verify payment
*/
app.post("/api/verify", (req, res) => {
  try {
    const { sms, minutes } = req.body;

    const selectedMinutes = Number(minutes);

    if (!PACKAGES[selectedMinutes]) {
      return res.status(400).json({
        success: false,
        message: "Invalid package."
      });
    }

    const expectedAmount = PACKAGES[selectedMinutes];

    const payment = parseMpesaSms(sms);

    if (!payment) {
      return res.status(400).json({
        success: false,
        message: "Invalid M-PESA confirmation message."
      });
    }

    // Amount must match selected package exactly.
    if (payment.amount !== expectedAmount) {
      return res.status(400).json({
        success: false,
        message:
          `Wrong amount. This package requires KSh ${expectedAmount}.`
      });
    }

    // Recipient must match exactly.
    if (payment.recipient !== RECIPIENT) {
      return res.status(400).json({
        success: false,
        message: "Payment was not sent to the correct number."
      });
    }

    // Transaction must never have been used before.
    const existing = db
      .prepare(`
        SELECT id
        FROM payments
        WHERE transaction_code = ?
      `)
      .get(payment.transactionCode);

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "This M-PESA transaction has already been used."
      });
    }

    const now = Date.now();

    const expiresAt =
      now + selectedMinutes * 60 * 1000;

    db.prepare(`
      INSERT INTO payments
      (
        transaction_code,
        recipient,
        amount,
        minutes,
        created_at,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      payment.transactionCode,
      payment.recipient,
      payment.amount,
      selectedMinutes,
      now,
      expiresAt
    );

    return res.json({
      success: true,
      transactionCode: payment.transactionCode,
      minutes: selectedMinutes,
      expiresAt
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Server error."
    });
  }
});


app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
