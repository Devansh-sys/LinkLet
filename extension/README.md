# LinkLet Chrome extension

This Manifest V3 extension connects one Telegram private chat to the LinkLet
server. It pairs through `/enroll/start` and `/enroll/claim`, keeps the JWT in
`chrome.storage.local`, polls inbound messages using the persisted cursor, and
sends outbound messages through `/send`.

## Load locally

1. Build the server with `npm run build` and start it with `npm start`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select this `extension` folder.
4. Open the LinkLet popup, save the server URL (default:
   `http://localhost:3000`), and grant access to that origin.
5. Choose **Start pairing**, then send the displayed code to your Telegram bot.

The extension keeps a 20-second server long poll active and starts the next
request immediately after each response; a 30-second Chrome alarm recovers
polling if the service worker is restarted. On a new inbound message it updates
the toolbar badge and asks Chrome to open the popup. This automatic popup
behavior requires Chrome 127 or later. Delivery while Chrome is closed is not
possible. The popup retains the latest 100 inbound and 100 outbound messages per
linked account in extension storage;
**Clear history** removes these local copies without changing the server cursor.
**Disconnect** removes the token, cursor, and locally saved messages. It does not
revoke the server-side account binding.

Remote API servers must use HTTPS. Message content and the JWT are stored in the
browser profile via `chrome.storage.local`; anyone with access to that profile
can access them. v1 has no refresh-token flow, so an expired session requires
pairing again.
