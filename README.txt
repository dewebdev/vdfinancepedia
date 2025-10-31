Vinith Dcosta Webinar — Firebase + Cashfree (Sandbox) + Hostinger SMTP + Meta WhatsApp

Quick start:

1) Install Firebase CLI and login:
   npm install -g firebase-tools
   firebase login

2) Create Firebase project (in console) and note the project id.
   - In the project settings -> create a Web App and copy the Firebase config (apiKey, authDomain, projectId, appId, ...)

3) Replace placeholders:
   - Edit public/index.html: replace FIREBASE_* placeholders with your Firebase web config.
   - Edit .firebaserc and replace "your-firebase-project-id" with your Firebase project id.
   - Set function config values:
     firebase functions:config:set \
       cashfree.app_id="YOUR_CASHFREE_APP_ID" \
       cashfree.key_secret="YOUR_CASHFREE_KEY_SECRET" \
       cashfree.environment="TEST" \
       smtp.host="mail.yourdomain.com" \
       smtp.port="465" \
       smtp.user="no-reply@vinithdcosta.in" \
       smtp.pass="YOUR_SMTP_PASSWORD" \
       whatsapp.meta_token="YOUR_META_TOKEN" \
       whatsapp.phone_number_id="YOUR_PHONE_NUMBER_ID" \
       webinar.link="https://your-webinar-link.example.com"

4) Install functions dependencies:
   cd functions
   npm install

5) Deploy to Firebase:
   cd ..
   firebase deploy --only hosting,functions

6) Configure Cashfree webhook to:
   https://<PROJECT_REGION>-<PROJECT>.cloudfunctions.net/api/webhook

Notes:
- Using Cashfree SANDBOX by default. Switch to PROD when ready.
- Hostinger SMTP used for emails (no-reply@vinithdcosta.in).
- WhatsApp uses Meta Cloud API.
