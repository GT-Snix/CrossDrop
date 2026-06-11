# CrossDrop 🚀

> Peer-to-peer file transfer between any two devices, directly in the browser. No accounts. No servers. No limits.

---

## What is CrossDrop?

CrossDrop is a lightweight, serverless file transfer tool that lets you send files directly between any two devices — Android to macOS, Windows to iPhone, anything to anything — as long as both have a modern browser.

You generate a 6-character room code on one device, enter it (or scan the QR code) on the other, and the file travels directly between the two devices over an encrypted WebRTC connection. Nothing passes through a server. Nothing is stored anywhere.

It was born out of frustration with WhatsApp's desktop restrictions and the general over-engineering of most file sharing tools.

---

## How it works

```
Device A                    Firebase                    Device B
   |                           |                           |
   |── Generate room code ──>  |                           |
   |── Write SDP offer ──────> |                           |
   |                           | <─── Enter room code ─── |
   |                           | <─── Read SDP offer ───── |
   |                           | <─── Write SDP answer ─── |
   |── Read SDP answer ──────> |                           |
   |                           |                           |
   |<══════════ Direct WebRTC DataChannel connection ══════>|
   |                           |                           |
   |── Delete room from Firebase (no longer needed)        |
   |                                                       |
   |════════════ File chunks transfer directly ════════════>|
```

Firebase is used **only for the handshake** (exchanging WebRTC SDP offers, answers, and ICE candidates). The moment both devices connect, Firebase is deleted from the equation entirely. Your files never touch any server.

---

## Features

- **No installation** — runs entirely in the browser, any OS, any device
- **No account required** — just open the page and go
- **6-character room codes** — 62⁶ (~56 billion) possible combinations, ephemeral and single-use
- **QR code support** — scan instead of typing the code on mobile
- **Large file support** — handles files up to 2GB with chunked transfer and back-pressure handling
- **Progress bar** — real-time transfer progress on both devices
- **Auto-download** — file downloads automatically on the receiver's device when transfer completes
- **Room expiry** — codes expire after 10 minutes automatically
- **Connection timeout** — friendly error if WebRTC fails to connect within 30 seconds
- **Privacy first** — files transfer directly between devices, nothing stored on any server

---

## Tech Stack

| Layer | Technology |
|---|---|
| File transfer | WebRTC DataChannels |
| Signaling (handshake only) | Firebase Realtime Database |
| QR code generation | qrcode.js (CDN) |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Hosting | Netlify (static, no backend) |

Zero frameworks. Zero build steps. Zero backend.

---

## Project Structure

```
CrossDrop/
├── index.html          # UI — sender and receiver panels
├── style.css           # Styling — dark theme, mobile-first
├── app.js              # All logic — room codes, WebRTC, file transfer
└── firebase-config.js  # Firebase project credentials (you fill this in)
```

---

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/GT-Snix/CrossDrop.git
cd crossdrop
```

### 2. Set up Firebase

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Create a new project
3. Enable **Realtime Database** → start in test mode
4. Register a Web app and copy the config object
5. Paste your config into `firebase-config.js`:

```javascript
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
```

### 3. Open locally

No build step needed. Just open `index.html` in Chrome.

### 4. Deploy

Drag the project folder to [netlify.com/drop](https://netlify.com/drop) for an instant public URL. No account required.

---

## How to Use

**Sending a file:**
1. Open CrossDrop in your browser
2. Click **Generate Code**
3. Share the 6-character code or QR code with the other device
4. Once connected, pick a file and hit **Send**

**Receiving a file:**
1. Open CrossDrop on the receiving device
2. Enter the 6-character code and click **Join**
3. Wait for connection — the file will download automatically once sent

---

## Firebase Security Rules

For development, Firebase's auto-generated time-limited rules work fine. For production, tighten them to only allow room-shaped keys:

```json
{
  "rules": {
    "rooms": {
      "$roomCode": {
        ".read": true,
        ".write": true,
        ".validate": "newData.hasChildren(['offer', 'createdAt'])"
      }
    }
  }
}
```

---

## Limitations

- **Strict NAT networks** — WebRTC peer-to-peer may fail on some corporate or university networks that block UDP. A TURN server would fix this but adds cost. For personal use, Google's free STUN servers work ~90% of the time.
- **Single file per session** — you can send multiple files in one session using "Send Another File" but only one at a time.
- **Same browser required** — both devices need a modern Chromium-based browser or Firefox for full WebRTC DataChannel support.

---

## Why not just use WhatsApp / AirDrop / Google Drive?

| Tool | Requires account | Works cross-platform | Files go through server | Size limit |
|---|---|---|---|---|
| WhatsApp | ✅ Yes | ⚠️ Limited | ✅ Yes | 2 GB |
| AirDrop | ✅ Yes (Apple only) | ❌ No | ❌ No | None |
| Google Drive | ✅ Yes | ✅ Yes | ✅ Yes | 5 GB free |
| **CrossDrop** | ❌ No | ✅ Yes | ❌ No | ~2 GB |

---

## License

MIT — do whatever you want with it.

---

*Built in a weekend with WebRTC, Firebase, and some well-placed vibe coding.*# CrossDrop
