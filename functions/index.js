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
// These are now read from the secure environment you set with the terminal command.
// They are no longer hard-coded and are safe for GitHub.
const CF_APP_ID = functions.config().cashfree?.app_id;
const CF_KEY_SECRET = functions.config().cashfree?.key_secret;
const CF_ENV = (
  functions.config().cashfree?.environment || "TEST"
).toUpperCase();
const SMTP_HOST = functions.config().smtp?.host;
const SMTP_PORT = functions.config().smtp?.port || 465;
const SMTP_USER = functions.config().smtp?.user;
const SMTP_PASS = functions.config().smtp?.pass;
const WHATSAPP_TOKEN = functions.config().whatsapp?.meta_token;
const WHATSAPP_PHONE_ID = functions.config().whatsapp?.phone_number_id;
const WEBINAR_LINK = functions.config().webinar?.link;
const YOUR_WEBSITE_URL = functions.config().project?.url;
// --- END OF CONFIG ---

const CASHFREE_BASE =
  CF_ENV === "PROD"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";

// Transporter is now initialized inside a helper to avoid crashing if config is missing
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

app.post("/api/createOrder", async (req, res) => {
  // Check that secrets are set
  if (!CF_APP_ID || !CF_KEY_SECRET || !YOUR_WEBSITE_URL) {
    console.error(
      "CRITICAL: Missing config. Run 'firebase functions:config:set ...'"
    );
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
        customer_phone: whatsapp ? `+91${whatsapp.replace(/\\D/g, "")}` : "",
      },
      order_meta: {
        return_url: `${YOUR_WEBSITE_URL}/thankyou.html?order_id={order_id}`,
      },
    };

    const url = `${CASHFREE_BASE}/orders`;

    // [THIS IS THE FIX for the 'Unexpected token' error]
    const headers = {
      "Content-Type": "application/json",
      "x-client-id": CF_APP_ID,
      "x-client-secret": CF_KEY_SECRET,
      "x-api-version": "2022-09-01", // This line was missing
    };

    console.log("DEBUG Cashfree Headers:", {
      CF_APP_ID,
      CF_KEY_SECRET: CF_KEY_SECRET
        ? CF_KEY_SECRET.slice(0, 8) + "..."
        : "MISSING",
      CF_ENV,
      CASHFREE_BASE,
    });

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

app.post("/webhook", bodyParser.raw({type: "*/*"}), async (req, res) => {
  // Check for secret, but use a default if not set to avoid webhook failure
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

    // Only fail if keys are set and signature is invalid
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
            await sendWhatsApp(docData);
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

// --- SUCCESS EMAIL ---
async function sendConfirmationEmail(docData) {
  const mailer = getTransporter();
  if (!docData?.email || !mailer) {
    console.log(
      "SMTP not configured or email missing. Skipping success email."
    );
    return;
  }

  if (!WEBINAR_LINK) {
    console.error("CRITICAL: WEBINAR_LINK not set. Cannot send email.");
    return;
  }

  const mailOptions = {
    from: `"Vinith Dcosta & Associates" <${SMTP_USER}>`,
    to: docData.email,
    subject: "Your Webinar Access — Registration Confirmed",
    html: `<p>Hi ${
      docData.name || ""
    },</p><p>Thanks for registering. Your payment is confirmed.</p><p>Join the webinar here: <a href="${WEBINAR_LINK}">${WEBINAR_LINK}</a></p><p>— Vinith Dcosta & Associates</p>`,
  };
  try {
    await mailer.sendMail(mailOptions);
    console.log("Email sent to", docData.email);
  } catch (e) {
    console.error("Email send failed", e);
  }
}

// --- FAILED EMAIL ---
async function sendFailedEmail(docData) {
  const mailer = getTransporter();
  if (!docData?.email || !mailer) {
    console.log("SMTP not configured or email missing. Skipping failed email.");
    return;
  }

  if (!YOUR_WEBSITE_URL) {
    console.error("CRITICAL: project.url not set. Cannot send failed email.");
    return;
  }

  const mailOptions = {
    from: `"Vinith Dcosta & Associates" <${SMTP_USER}>`,
    to: docData.email,
    subject: "There was an issue with your webinar payment",
    html: `<p>Hi ${docData.name || ""},</p>
           <p>We noticed you tried to register for the trading webinar, but the payment didn't complete successfully.</p>
           <p>If you'd still like to join, you can try registering again at any time right here:</p>
           <p><a href="${YOUR_WEBSITE_URL}">${YOUR_WEBSITE_URL}</a></p>
           <p>If you had trouble, please let us know. We're here to help.</p>
           <p>— Vinith Dcosta & Associates</p>`,
  };
  try {
    await mailer.sendMail(mailOptions);
    console.log("Failed payment email sent to", docData.email);
  } catch (e) {
    console.error("Failed email send failed", e);
  }
}

// --- WHATSAPP (Only sends on SUCCESS) ---
async function sendWhatsApp(docData) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID || !docData?.whatsapp) {
    console.log("WhatsApp not configured or number missing - skipping");
    return;
  }

  if (!WEBINAR_LINK) {
    console.error("CRITICAL: WEBINAR_LINK not set. Cannot send WhatsApp.");
    return;
  }

  try {
    const url = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`;
    const cleanWhatsapp = docData.whatsapp.replace(/\D/g, "");
    const body = {
      messaging_product: "whatsapp",
      to: `+91${cleanWhatsapp}`,
      type: "text",
      text: {
        body: `Hi ${
          docData.name || ""
        }! Your webinar registration is confirmed. Join: ${WEBINAR_LINK}`,
      },
    };
    const headers = {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    };
    const resp = await axios.post(url, body, {headers});
    console.log("WhatsApp sent", resp.data);
  } catch (e) {
    console.error("WhatsApp send failed", e?.response?.data || e.message || e);
  }
}

app.use((req, res) => {
  console.log("➡️ Received request:", req.method, req.path);
  res.status(404).json({message: "Route not found", path: req.path});
});

exports.api = functions.https.onRequest(app);
