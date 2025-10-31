console.log("🔥 Function deployed at:", new Date().toISOString());

const functions = require("firebase-functions");
const express = require("express");
const admin = require("firebase-admin");
const axios = require("axios");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const app = express();
app.use(bodyParser.json());

// --- SECURE CONFIGURATION ---
const CF_APP_ID = functions.config().cashfree?.app_id;
const CF_KEY_SECRET = functions.config().cashfree?.key_secret;
const CF_ENV = (
  functions.config().cashfree?.environment || "TEST"
).toUpperCase();
const SMTP_HOST = functions.config().smtp?.host;
const SMTP_PORT = functions.config().smtp?.port || 465;
const SMTP_USER = functions.config().smtp?.user;
const SMTP_PASS = functions.config().smtp?.pass;
const WEBINAR_LINK = functions.config().webinar?.link;
const WHATSAPP_GROUP_LINK = functions.config().webinar?.whatsapp_group; // ✅ NEW FIELD
const YOUR_WEBSITE_URL = functions.config().project?.url;
// --- END CONFIG ---

const CASHFREE_BASE =
  CF_ENV === "PROD"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";

// Initialize email transporter
let transporter;
function getTransporter() {
  if (!transporter && SMTP_HOST && SMTP_USER && SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: {user: SMTP_USER, pass: SMTP_PASS},
    });
  }
  return transporter;
}

// --- CREATE ORDER ---
app.post("/api/createOrder", async (req, res) => {
  if (!CF_APP_ID || !CF_KEY_SECRET || !YOUR_WEBSITE_URL) {
    console.error("❌ Missing config. Run 'firebase functions:config:set ...'");
    return res.status(500).json({
      message: "Server configuration error. Please contact support.",
    });
  }

  try {
    const {
      name,
      email,
      whatsapp,
      amount = 99,
      currency = "INR",
      registrationId,
    } = req.body;

    const orderPayload = {
      order_id: `REG_${Date.now()}`,
      order_amount: Number(amount),
      order_currency: currency,
      order_note: `Webinar registration for ${name}`,
      customer_details: {
        customer_id: registrationId || email.replace(/[^a-zA-Z0-9_-]/g, "_"),
        customer_name: name,
        customer_email: email,
        customer_phone: whatsapp ? `+91${whatsapp.replace(/\D/g, "")}` : "",
      },
      order_meta: {
        return_url: `${YOUR_WEBSITE_URL}/thankyou.html?order_id={order_id}&status={order_status}`,
        notify_url: `https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/api/webhook`,
      },
    };

    const headers = {
      "Content-Type": "application/json",
      "x-client-id": CF_APP_ID,
      "x-client-secret": CF_KEY_SECRET,
      "x-api-version": "2022-09-01",
    };

    console.log("DEBUG Cashfree Headers:", {
      CF_APP_ID,
      CF_KEY_SECRET: CF_KEY_SECRET
        ? CF_KEY_SECRET.slice(0, 8) + "..."
        : "MISSING",
      CF_ENV,
      CASHFREE_BASE,
    });

    const url = `${CASHFREE_BASE}/orders`;
    const cfResp = await axios.post(url, orderPayload, {headers});
    const cfData = cfResp.data || {};

    const regRef = db
      .collection("registrations")
      .doc(registrationId || `reg_${Date.now()}`);
    await regRef.set(
      {
        name,
        email,
        whatsapp,
        status: "payment_initiated",
        orderPayload,
        cfData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true}
    );

    const payment_link = cfData?.payment_link || cfData?.payments?.url || null;
    return res.status(200).json({payment_link, cfData});
  } catch (err) {
    console.error(
      "createOrder error",
      err?.response?.data || err.message || err
    );
    return res.status(500).json({
      message: "Error creating order. Please check your details and try again.",
      detail: err?.response?.data || err.message,
    });
  }
});

// --- CHECK ORDER STATUS (for thankyou.html) ---
app.get("/api/checkStatus/:orderId", async (req, res) => {
  try {
    const {orderId} = req.params;
    const url = `${CASHFREE_BASE}/orders/${orderId}`;
    const headers = {
      "Content-Type": "application/json",
      "x-client-id": CF_APP_ID,
      "x-client-secret": CF_KEY_SECRET,
      "x-api-version": "2022-09-01",
    };

    const cfResp = await axios.get(url, {headers});
    const cfData = cfResp.data;

    const q = await db
      .collection("registrations")
      .where("orderPayload.order_id", "==", orderId)
      .get();
    if (!q.empty) {
      q.forEach(async (docSnap) => {
        await docSnap.ref.update({
          status: cfData.order_status,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // ✅ Trigger email directly when payment confirmed
        const s = String(cfData.order_status || "").toLowerCase();
        const docData = (await docSnap.ref.get()).data();

        if (["paid", "success", "order_paid"].includes(s)) {
          await sendConfirmationEmail(docData);
        } else if (
          [
            "failed",
            "cancelled",
            "user_dropped",
            "not_paid",
            "active",
            "timeout",
          ].includes(s)
        ) {
          await sendFailedEmail(docData);
        }
      });
    }

    return res.status(200).json({
      orderId,
      status: cfData.order_status,
      cfData,
    });
  } catch (err) {
    console.error("checkStatus error", err?.response?.data || err.message);
    return res.status(500).json({
      message: "Unable to fetch status",
      detail: err?.response?.data || err.message,
    });
  }
});

// --- WEBHOOK (for Cashfree status updates) ---
app.post("/webhook", bodyParser.raw({type: "*/*"}), async (req, res) => {
  const webhookSecret = CF_KEY_SECRET || "DEFAULT_SECRET";

  try {
    const raw = req.body;
    const bodyStr = raw.toString("utf8");
    const signatureHeader =
      req.headers["x-webhook-signature"] ||
      req.headers["x-cf-signature"] ||
      req.headers["x-signature"];

    if (!signatureHeader) return res.status(400).send("Missing signature");

    const hmac = crypto.createHmac("sha256", webhookSecret);
    hmac.update(bodyStr);
    const expected = hmac.digest("hex");
    if (CF_KEY_SECRET && expected !== signatureHeader) {
      return res.status(403).send("Invalid signature");
    }

    const payload = JSON.parse(bodyStr);
    const eventData = payload.data || payload;
    const status =
      eventData.order_status || eventData.tx_status || eventData.status || "";
    const orderId = eventData.order_id;

    if (orderId) {
      const q = await db
        .collection("registrations")
        .where("orderPayload.order_id", "==", orderId)
        .get();

      if (!q.empty) {
        q.forEach(async (docSnap) => {
          await docSnap.ref.update({
            status,
            cfPayload: payload,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          const s = String(status).toLowerCase();
          const docData = (await docSnap.ref.get()).data();

          if (s === "paid" || s === "success" || s === "order_paid") {
            await sendConfirmationEmail(docData);
          } else if (
            s === "failed" ||
            s === "cancelled" ||
            s === "user_dropped"
          ) {
            await sendFailedEmail(docData);
          }
        });
      }
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("webhook error", err);
    return res.status(500).send("error");
  }
});

// --- EMAILS ---
async function sendConfirmationEmail(docData) {
  const mailer = getTransporter();
  if (!docData?.email || !mailer) {
    console.log(
      "SMTP not configured or email missing. Skipping success email."
    );
    return;
  }

  if (!WEBINAR_LINK || !WHATSAPP_GROUP_LINK) {
    console.error("CRITICAL: WEBINAR_LINK or WHATSAPP_GROUP_LINK not set.");
    return;
  }

  const mailOptions = {
    from: `"Vinith Dcosta & Associates" <${SMTP_USER}>`,
    to: docData.email,
    subject: "✅ Webinar Registration Confirmed",
    html: `<p>Hi ${docData.name || ""},</p>
           <p>Thank you for registering! Your payment has been successfully received.</p>
           <p><strong>🎥 Webinar Access Link:</strong><br>
           <a href="${WEBINAR_LINK}">${WEBINAR_LINK}</a></p>
           <p><strong>💬 Join our official WhatsApp group for updates:</strong><br>
           <a href="${WHATSAPP_GROUP_LINK}">${WHATSAPP_GROUP_LINK}</a></p>
           <p>We look forward to seeing you there!</p>
           <p>— Team Vinith Dcosta & Associates</p>`,
  };
  try {
    await mailer.sendMail(mailOptions);
    console.log("✅ Success email sent to", docData.email);
  } catch (e) {
    console.error("Email send failed", e);
  }
}

async function sendFailedEmail(docData) {
  const mailer = getTransporter();
  if (!docData?.email || !mailer) {
    console.log("SMTP not configured or email missing. Skipping failed email.");
    return;
  }

  const mailOptions = {
    from: `"Vinith Dcosta & Associates" <${SMTP_USER}>`,
    to: docData.email,
    subject: "❌ Webinar Payment Failed",
    html: `<p>Hi ${docData.name || ""},</p>
           <p>Unfortunately, your webinar payment did not complete successfully.</p>
           <p>Please try again here: <a href="${YOUR_WEBSITE_URL}">${YOUR_WEBSITE_URL}</a></p>
           <p>If you need help, contact us anytime.</p>
           <p>— Team Vinith Dcosta & Associates</p>`,
  };
  try {
    await mailer.sendMail(mailOptions);
    console.log("⚠️ Failed payment email sent to", docData.email);
  } catch (e) {
    console.error("Failed email send failed", e);
  }
}

app.use((req, res) => {
  console.log("➡️ Received request:", req.method, req.path);
  res.status(404).json({message: "Route not found", path: req.path});
});

exports.api = functions.https.onRequest(app);
