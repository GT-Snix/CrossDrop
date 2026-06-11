/*
 * CrossDrop — app.js
 * Handles: room code generation, QR codes, WebRTC signaling via Firebase,
 * DataChannel lifecycle, chunked file transfer (send & receive),
 * room expiry, auto-cleanup, copy-to-clipboard, connection timeout, reset.
 */

import { db } from './firebase-config.js';
import {
    ref,
    set,
    get,
    push,
    remove,
    onValue,
    onChildAdded,
    off,
    onDisconnect,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const STUN_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ]
};

const CODE_CHARS         = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CHUNK_SIZE         = 16 * 1024;    // 16 KB per chunk
const BUFFER_THRESHOLD   = 256 * 1024;  // Back-pressure threshold (256 KB)
const ROOM_TTL_MS           = 10 * 60 * 1000; // 10 minutes in milliseconds
const STILL_WAITING_TIMEOUT = 15 * 1000;       // 15 s — show animated nudge on sender side
const CONNECTION_TIMEOUT    = 30 * 1000;       // 30 s — soft warning (sender) / hard kill (receiver)

// ─────────────────────────────────────────────
// DOM ELEMENTS
// ─────────────────────────────────────────────

// Sender
const generateCodeBtn    = document.getElementById('generate-code-btn');
const codeRow            = document.getElementById('code-row');
const roomCodeDisplay    = document.getElementById('room-code-display');
const copyCodeBtn        = document.getElementById('copy-code-btn');
const copyIcon           = document.getElementById('copy-icon');
const checkIcon          = document.getElementById('check-icon');
const qrCodeContainer    = document.getElementById('qrcode');
const waitingMsg              = document.getElementById('waiting-msg');
const stillWaitingIndicator   = document.getElementById('still-waiting-indicator');
const stillWaitingText        = document.getElementById('still-waiting-text');
const senderErrorMsg          = document.getElementById('sender-error-msg');
const filePickerArea     = document.getElementById('file-picker-area');
const fileDropZone       = document.getElementById('file-drop-zone');
const fileInput          = document.getElementById('file-input');
const senderFileInfo     = document.getElementById('sender-file-info');
const sendFileBtn        = document.getElementById('send-file-btn');
const senderProgressWrap = document.getElementById('sender-progress-wrap');
const senderProgressBar  = document.getElementById('sender-progress-bar');
const senderProgressPct  = document.getElementById('sender-progress-pct');
const senderProgressText = document.getElementById('sender-progress-text');
const sendAnotherBtn     = document.getElementById('send-another-btn');

// Receiver
const roomCodeInput        = document.getElementById('room-code-input');
const joinRoomBtn          = document.getElementById('join-room-btn');
const receiverErrorMsg     = document.getElementById('receiver-error-msg');
const receiverStatusArea   = document.getElementById('receiver-status-area');
const receiverStatusMsg    = document.getElementById('receiver-status-msg');
const receiverProgressWrap = document.getElementById('receiver-progress-wrap');
const receiverProgressBar  = document.getElementById('receiver-progress-bar');
const receiverProgressPct  = document.getElementById('receiver-progress-pct');
const downloadArea         = document.getElementById('download-area');
const downloadLink         = document.getElementById('download-link');
const startOverBtn         = document.getElementById('start-over-btn');

// Chat — sender
const senderChatArea      = document.getElementById('sender-chat-area');
const senderChatLog       = document.getElementById('sender-chat-log');
const senderChatInput     = document.getElementById('sender-chat-input');
const senderSendTextBtn   = document.getElementById('sender-send-text-btn');

// Chat — receiver
const receiverChatArea    = document.getElementById('receiver-chat-area');
const receiverChatLog     = document.getElementById('receiver-chat-log');
const receiverChatInput   = document.getElementById('receiver-chat-input');
const receiverSendTextBtn = document.getElementById('receiver-send-text-btn');

// Leave Room buttons
const senderLeaveBtn   = document.getElementById('sender-leave-btn');
const receiverLeaveBtn = document.getElementById('receiver-leave-btn');

// ─────────────────────────────────────────────
// APPLICATION STATE
// ─────────────────────────────────────────────

let currentRoomCode    = null;
let peerConnection     = null;
let dataChannel        = null;
let role               = null;   // 'sender' | 'receiver'
let selectedFile       = null;
let connectionTimer    = null;   // setTimeout handle for 30 s hard/soft timeout
let stillWaitingTimer  = null;   // setTimeout handle for 15 s animated nudge (sender only)

// Receiver reassembly state
const rx = {
    meta:          null,
    chunks:        [],
    bytesReceived: 0,
};

// Firebase listener handles (for detaching)
const activeListeners = [];

// ─────────────────────────────────────────────
// UTILITIES — General
// ─────────────────────────────────────────────

function generateRoomCode() {
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    }
    return result;
}

function renderQRCode(code) {
    qrCodeContainer.innerHTML = '';
    const roomUrl = `${window.location.origin}${window.location.pathname}?room=${code}`;
    new QRCode(qrCodeContainer, {
        text: roomUrl,
        width: 160,
        height: 160,
        colorDark:    '#000000',
        colorLight:   '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
    });
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
}

function hideError(el) {
    el.textContent = '';
    el.classList.add('hidden');
}

// ─────────────────────────────────────────────
// COPY CODE BUTTON
// ─────────────────────────────────────────────

copyCodeBtn.addEventListener('click', () => {
    if (!currentRoomCode) return;
    navigator.clipboard.writeText(currentRoomCode).then(() => {
        // Swap to check icon
        copyIcon.classList.add('hidden');
        checkIcon.classList.remove('hidden');
        copyCodeBtn.classList.add('copied');

        // Revert after 2s
        setTimeout(() => {
            copyIcon.classList.remove('hidden');
            checkIcon.classList.add('hidden');
            copyCodeBtn.classList.remove('copied');
        }, 2000);
    });
});

// ─────────────────────────────────────────────
// UTILITIES — Chat
// ─────────────────────────────────────────────

/** Escapes user-supplied text before injecting it as innerHTML. */
function escapeHtml(str) {
    return str
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;');
}

/** Returns the chat log + input elements for the current role. */
function activeChatEls() {
    return role === 'sender'
        ? { log: senderChatLog,   input: senderChatInput }
        : { log: receiverChatLog, input: receiverChatInput };
}

/**
 * Appends a single chat message to the active role's log.
 * @param {'you'|'them'} who
 * @param {string}       content
 */
function appendChatMessage(who, content) {
    const { log } = activeChatEls();
    const time    = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const el      = document.createElement('div');
    el.className  = `chat-message ${who}`;
    el.innerHTML  =
        `<span class="chat-meta">${who === 'you' ? 'You' : 'Them'} · ${time}</span>` +
        `<span class="chat-bubble">${escapeHtml(content)}</span>`;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
}

/**
 * Reads the active role's textarea, sends a { type:'text' } message over the
 * DataChannel, echoes it locally as "You", then clears the input.
 */
function sendTextMessage() {
    const { input } = activeChatEls();
    const content   = input.value.trim();
    if (!content || !dataChannel || dataChannel.readyState !== 'open') return;
    dataChannel.send(JSON.stringify({ type: 'text', content }));
    appendChatMessage('you', content);
    input.value = '';
    input.focus();
}

// ─────────────────────────────────────────────
// CONNECTION TIMERS
// ─────────────────────────────────────────────

/**
 * Starts two timers:
 *
 * • 15 s (sender only) — reveals the animated “still waiting” indicator so
 *   the sender knows the app is alive and the room is still open.
 *
 * • 30 s — behaviour differs by role:
 *   - Sender: soft nudge only (no cleanup). The Firebase listeners and WebRTC
 *     handshake stay alive so a late-joining receiver can still connect.
 *   - Receiver: hard failure (calls cleanup). At this point the STUN handshake
 *     has genuinely failed; keeping the connection attempt open is useless.
 */
function startConnectionTimer() {
    clearConnectionTimer();

    // ── 15 s: animated indicator (sender only) ──────────────────────────
    stillWaitingTimer = setTimeout(() => {
        if (role === 'sender' && (!dataChannel || dataChannel.readyState !== 'open')) {
            stillWaitingIndicator.classList.remove('hidden');
        }
    }, STILL_WAITING_TIMEOUT);

    // ── 30 s: soft nudge for sender / hard kill for receiver ────────────
    connectionTimer = setTimeout(() => {
        if (!dataChannel || dataChannel.readyState !== 'open') {
            if (role === 'sender') {
                // Soft nudge only — do NOT call cleanup().
                // Firebase listeners and the RTCPeerConnection stay alive;
                // a receiver who joins now will still be able to connect.
                waitingMsg.textContent = '⏳ Still waiting… Your room stays open for up to 10 minutes.';
                stillWaitingText.textContent = 'The room is still open — share the code or QR with the other device';
            } else {
                // Receiver: WebRTC handshake genuinely failed — hard reset.
                showError(receiverErrorMsg, '⚠️ Could not connect. You may be on a restricted network.');
                joinRoomBtn.disabled    = false;
                joinRoomBtn.textContent = 'Join Room';
                cleanup();
            }
        }
    }, CONNECTION_TIMEOUT);
}

/**
 * Cancels both timers and hides the animated nudge.
 * Called on successful connect, on leave, and on cleanup.
 */
function clearConnectionTimer() {
    if (connectionTimer) {
        clearTimeout(connectionTimer);
        connectionTimer = null;
    }
    if (stillWaitingTimer) {
        clearTimeout(stillWaitingTimer);
        stillWaitingTimer = null;
    }
    stillWaitingIndicator.classList.add('hidden');
    // Reset the waiting message text in case it was updated at the 30 s mark
    waitingMsg.textContent = '⏳ Waiting for peer to join…';
}

// ─────────────────────────────────────────────
// FIREBASE ROOM CLEANUP
// ─────────────────────────────────────────────

/**
 * Deletes the entire room node from Firebase.
 * Called by the sender once the DataChannel opens — both peers are connected
 * at that point so the signaling data is no longer needed, and no third
 * party can reuse the code.
 */
async function deleteRoom(code) {
    try {
        await remove(ref(db, `rooms/${code}`));
        console.log(`[Firebase] Room ${code} deleted.`);
    } catch (err) {
        console.warn('[Firebase] Could not delete room:', err);
    }
}

// ─────────────────────────────────────────────
// UTILITIES — WebRTC helpers
// ─────────────────────────────────────────────

function createPeerConnection() {
    const pc = new RTCPeerConnection(STUN_SERVERS);

    pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        const path = role === 'sender'
            ? `rooms/${currentRoomCode}/senderCandidates`
            : `rooms/${currentRoomCode}/receiverCandidates`;
        set(push(ref(db, path)), candidate.toJSON());
    };

    pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] connectionState → ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            const errorEl = role === 'sender' ? senderErrorMsg : receiverErrorMsg;
            showError(errorEl, '⚠️ Could not connect. You may be on a restricted network.');
        }
    };

    return pc;
}

function listenForRemoteCandidates(candidatePath) {
    const r = ref(db, candidatePath);
    const fn = onChildAdded(r, async (snap) => {
        const candidate = snap.val();
        if (candidate && peerConnection) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.error('[ICE] addIceCandidate failed:', err);
            }
        }
    });
    activeListeners.push({ ref: r, fn });
}

function cleanup() {
    clearConnectionTimer();
    for (const { ref: r } of activeListeners) {
        off(r);
    }
    activeListeners.length = 0;
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    dataChannel = null;
    selectedFile = null;
    resetRxState();

    // Reset chat UI for both sides
    senderChatArea.classList.add('hidden');
    receiverChatArea.classList.add('hidden');
    senderChatLog.innerHTML   = '';
    receiverChatLog.innerHTML = '';
    senderChatInput.value     = '';
    receiverChatInput.value   = '';

    // Hide leave buttons
    senderLeaveBtn.classList.add('hidden');
    receiverLeaveBtn.classList.add('hidden');
}

function resetRxState() {
    rx.meta          = null;
    rx.chunks        = [];
    rx.bytesReceived = 0;
}

// ─────────────────────────────────────────────
// SENDER — File transfer over DataChannel
// ─────────────────────────────────────────────

async function sendFile(file) {
    sendFileBtn.classList.add('hidden');
    sendAnotherBtn.classList.add('hidden');
    fileDropZone.style.pointerEvents = 'none';

    senderProgressWrap.classList.remove('hidden');
    updateSenderProgress(0, file.size);

    // ── 1. Send metadata as a JSON string ───────────────────────
    const meta = JSON.stringify({
        type:     'meta',
        name:     file.name,
        size:     file.size,
        mimeType: file.type || 'application/octet-stream',
    });
    dataChannel.send(meta);  // string → arrives as typeof === 'string' on receiver

    // ── 2. Send chunks as raw ArrayBuffer ───────────────────────
    const buffer = await file.arrayBuffer();
    let offset = 0;

    dataChannel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

    function sendNextChunk() {
        while (offset < buffer.byteLength) {
            if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
                dataChannel.onbufferedamountlow = () => {
                    dataChannel.onbufferedamountlow = null;
                    sendNextChunk();
                };
                return;
            }
            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
            dataChannel.send(chunk);  // ArrayBuffer → arrives as instanceof ArrayBuffer on receiver
            offset += chunk.byteLength;
            updateSenderProgress(offset, buffer.byteLength);
        }

        // Transfer complete
        senderProgressText.textContent = '✅ Sent!';
        senderProgressPct.textContent  = '100%';
        sendAnotherBtn.classList.remove('hidden');
        fileDropZone.style.pointerEvents = '';
    }

    sendNextChunk();
}

function updateSenderProgress(sent, total) {
    const pct = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
    senderProgressBar.style.width  = `${pct}%`;
    senderProgressPct.textContent  = `${pct}%`;
    senderProgressText.textContent = `Sending… ${formatBytes(sent)} / ${formatBytes(total)}`;
}

// ─────────────────────────────────────────────
// RECEIVER — Reassembly over DataChannel
// ─────────────────────────────────────────────

function handleReceivedMessage(event) {
    // ── Metadata: arrives as a string ───────────────────────────
    if (typeof event.data === 'string') {
        let parsed;
        try { parsed = JSON.parse(event.data); } catch { return; }
        if (parsed.type === 'text') {
            appendChatMessage('them', parsed.content);
            return;
        }

        if (parsed.type !== 'meta') return;

        resetRxState();
        rx.meta = parsed;

        receiverProgressWrap.classList.remove('hidden');
        downloadArea.classList.add('hidden');
        startOverBtn.classList.add('hidden');
        receiverStatusMsg.textContent = `📥 Receiving "${parsed.name}" (${formatBytes(parsed.size)})…`;
        updateReceiverProgress(0, parsed.size);
        return;
    }

    // ── Chunks: arrive as ArrayBuffer ────────────────────────────
    if (event.data instanceof ArrayBuffer) {
        if (!rx.meta) {
            console.warn('[RX] Chunk received before metadata — ignoring.');
            return;
        }

        rx.chunks.push(event.data);
        rx.bytesReceived += event.data.byteLength;
        updateReceiverProgress(rx.bytesReceived, rx.meta.size);

        if (rx.bytesReceived >= rx.meta.size) {
            const blob = new Blob(rx.chunks, { type: rx.meta.mimeType });
            triggerDownload(blob, rx.meta.name);
            receiverStatusMsg.textContent = `✅ "${rx.meta.name}" received!`;
            startOverBtn.classList.remove('hidden');
            resetRxState();
        }
    }
}

function updateReceiverProgress(received, total) {
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    receiverProgressBar.style.width = `${pct}%`;
    receiverProgressPct.textContent = `${pct}%`;
}

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    downloadLink.href     = url;
    downloadLink.download = filename;
    downloadArea.classList.remove('hidden');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ─────────────────────────────────────────────
// DataChannel setup (shared — sender & receiver)
// ─────────────────────────────────────────────

function setupDataChannel(channel) {
    dataChannel = channel;
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => {
        console.log('[DataChannel] Open — P2P connected!');
        clearConnectionTimer();

        if (role === 'sender') {
            waitingMsg.classList.add('hidden');
            filePickerArea.classList.remove('hidden');
            senderLeaveBtn.classList.remove('hidden');
        } else {
            receiverStatusMsg.textContent = '⏳ Waiting for sender to send a file…';
            receiverLeaveBtn.classList.remove('hidden');
        }

        // Reveal the chat panel for whichever role this peer plays
        (role === 'sender' ? senderChatArea : receiverChatArea).classList.remove('hidden');
    };

    dataChannel.onclose = () => console.log('[DataChannel] Closed.');
    dataChannel.onerror = (err) => console.error('[DataChannel] Error:', err);
    dataChannel.onmessage = handleReceivedMessage;
}

// ─────────────────────────────────────────────
// SENDER FLOW — WebRTC signaling
// ─────────────────────────────────────────────

async function startSenderSession(code) {
    cleanup();
    role = 'sender';
    currentRoomCode = code;

    peerConnection = createPeerConnection();
    const channel = peerConnection.createDataChannel('fileTransfer');
    setupDataChannel(channel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // Write offer + creation timestamp to Firebase
    await set(ref(db, `rooms/${code}`), {
        offer:     { type: offer.type, sdp: offer.sdp },
        createdAt: Date.now(),
    });
    console.log(`[Sender] Room created at rooms/${code}`);

    // Auto-delete the room if the sender's tab closes or crashes
    await onDisconnect(ref(db, `rooms/${code}`)).remove();
    console.log(`[Sender] onDisconnect registered for rooms/${code}`);

    // Watch for receiver's answer
    const answerRef = ref(db, `rooms/${code}/answer`);
    const unsub = onValue(answerRef, async (snap) => {
        const answer = snap.val();
        if (answer && peerConnection && peerConnection.currentRemoteDescription === null) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            console.log('[Sender] Remote description (answer) set.');
            off(answerRef);
        }
    });
    activeListeners.push({ ref: answerRef, fn: unsub });

    listenForRemoteCandidates(`rooms/${code}/receiverCandidates`);

    // Start 30s connection timeout
    startConnectionTimer();
}

// ─────────────────────────────────────────────
// RECEIVER FLOW — WebRTC signaling
// ─────────────────────────────────────────────

async function startReceiverSession(code) {
    cleanup();
    role = 'receiver';
    currentRoomCode = code;

    const roomSnap = await get(ref(db, `rooms/${code}`));
    if (!roomSnap.exists()) {
        showError(receiverErrorMsg, '❌ Room not found. Make sure the sender has generated a code first.');
        joinRoomBtn.disabled    = false;
        joinRoomBtn.textContent = 'Join Room';
        return;
    }

    const roomData = roomSnap.val();

    // ── Expiry check — reject rooms older than 10 minutes ───────
    const age = Date.now() - (roomData.createdAt || 0);
    if (age > ROOM_TTL_MS) {
        showError(receiverErrorMsg, '⏰ This code has expired. Please ask for a new one.');
        joinRoomBtn.disabled    = false;
        joinRoomBtn.textContent = 'Join Room';
        return;
    }

    peerConnection = createPeerConnection();
    peerConnection.ondatachannel = (event) => {
        console.log('[Receiver] DataChannel received.');
        setupDataChannel(event.channel);
    };

    await peerConnection.setRemoteDescription(new RTCSessionDescription(roomData.offer));
    console.log('[Receiver] Remote description (offer) set.');

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    await set(ref(db, `rooms/${code}/answer`), { type: answer.type, sdp: answer.sdp });
    console.log(`[Receiver] Answer written → rooms/${code}/answer`);

    listenForRemoteCandidates(`rooms/${code}/senderCandidates`);

    // Watch for the room being deleted (sender left / crashed)
    watchRoomDeletion(code);

    receiverStatusArea.classList.remove('hidden');
    hideError(receiverErrorMsg);

    // Start 30s connection timeout
    startConnectionTimer();
}

// ─────────────────────────────────────────────
// UI — File selection (click & drag-and-drop)
// ─────────────────────────────────────────────

function handleFileSelected(file) {
    if (!file) return;
    selectedFile = file;
    senderFileInfo.innerHTML =
        `<strong>${file.name}</strong><br>${formatBytes(file.size)} · ${file.type || 'unknown type'}`;
    senderFileInfo.classList.remove('hidden');
    sendFileBtn.classList.remove('hidden');
    senderProgressWrap.classList.add('hidden');
    senderProgressBar.style.width = '0%';
    sendAnotherBtn.classList.add('hidden');
}

fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
});

fileDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileDropZone.classList.add('drag-over');
});
fileDropZone.addEventListener('dragleave', () => {
    fileDropZone.classList.remove('drag-over');
});
fileDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelected(file);
});

sendFileBtn.addEventListener('click', () => {
    if (!selectedFile || !dataChannel || dataChannel.readyState !== 'open') {
        showError(senderErrorMsg, '⚠️ Not ready to send. Make sure a peer is connected.');
        return;
    }
    hideError(senderErrorMsg);
    sendFile(selectedFile);
});

// ─────────────────────────────────────────────
// UI — Reset buttons
// ─────────────────────────────────────────────

/**
 * "Send Another File" — resets only the file picker state while keeping
 * the existing peer connection alive. The DataChannel stays open.
 */
sendAnotherBtn.addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    senderFileInfo.innerHTML = '';
    senderFileInfo.classList.add('hidden');
    sendFileBtn.classList.add('hidden');
    sendAnotherBtn.classList.add('hidden');
    senderProgressWrap.classList.add('hidden');
    senderProgressBar.style.width = '0%';
    fileDropZone.style.pointerEvents = '';
});

/**
 * "Start Over" — fully tears down the connection and resets the receiver UI
 * back to the initial "enter code" state.
 */
startOverBtn.addEventListener('click', () => {
    cleanup();
    role = null;
    currentRoomCode = null;

    // Reset receiver UI
    receiverStatusArea.classList.add('hidden');
    receiverProgressWrap.classList.add('hidden');
    downloadArea.classList.add('hidden');
    startOverBtn.classList.add('hidden');
    receiverProgressBar.style.width = '0%';
    receiverProgressPct.textContent = '0%';
    receiverStatusMsg.textContent = '⏳ Waiting for sender to send a file…';
    hideError(receiverErrorMsg);

    joinRoomBtn.disabled    = false;
    joinRoomBtn.textContent = 'Join Room';
    roomCodeInput.value     = '';
});

// ─────────────────────────────────────────────
// UI — Room code actions
// ─────────────────────────────────────────────

generateCodeBtn.addEventListener('click', async () => {
    hideError(senderErrorMsg);

    const code = generateRoomCode();
    currentRoomCode = code;

    roomCodeDisplay.textContent = code;
    codeRow.classList.remove('hidden');
    renderQRCode(code);
    waitingMsg.classList.remove('hidden');

    generateCodeBtn.disabled    = true;
    generateCodeBtn.textContent = 'Waiting for peer…';

    await startSenderSession(code);
});

joinRoomBtn.addEventListener('click', async () => {
    hideError(receiverErrorMsg);
    const code = roomCodeInput.value.trim();
    if (code.length !== 6) {
        showError(receiverErrorMsg, '⚠️ Please enter a valid 6-character room code.');
        return;
    }
    joinRoomBtn.disabled    = true;
    joinRoomBtn.textContent = 'Connecting…';
    await startReceiverSession(code);
});

// ─────────────────────────────────────────────
// Auto-fill code from QR scan URL param
// ─────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
    const params    = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam && roomParam.length === 6) {
        roomCodeInput.value = roomParam;
    }
});

// ─────────────────────────────────────────────
// UI — Chat: button click & Enter key
// ─────────────────────────────────────────────

[
    [senderSendTextBtn,   senderChatInput],
    [receiverSendTextBtn, receiverChatInput],
].forEach(([btn, input]) => {
    btn.addEventListener('click', sendTextMessage);
    input.addEventListener('keydown', (e) => {
        // Enter without Shift sends; Shift+Enter inserts a newline
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendTextMessage();
        }
    });
});

// ─────────────────────────────────────────────
// ROOM DELETION WATCHER (receiver side)
// ─────────────────────────────────────────────

/**
 * Sets up an onValue listener on the room node.
 * When the node is deleted (sender left or crashed), shows a message and
 * resets the receiver UI back to the initial state.
 * The `role !== 'receiver'` guard ensures we don’t react to our own leave.
 */
function watchRoomDeletion(code) {
    const roomRef = ref(db, `rooms/${code}`);
    let seenRoom  = false;

    const fn = onValue(roomRef, (snap) => {
        if (snap.exists()) {
            seenRoom = true;   // confirm the room existed at least once
            return;
        }
        // Room is gone — only act if it previously existed AND we’re still a receiver
        if (!seenRoom || role !== 'receiver') return;

        console.log('[Receiver] Room deleted — sender left or disconnected.');

        showError(receiverErrorMsg, '👋 The sender has left the room.');

        cleanup();          // detaches this listener via off() + closes WebRTC
        role            = null;
        currentRoomCode = null;

        // Reset receiver UI
        receiverStatusArea.classList.add('hidden');
        receiverProgressWrap.classList.add('hidden');
        downloadArea.classList.add('hidden');
        startOverBtn.classList.add('hidden');
        receiverProgressBar.style.width = '0%';
        receiverProgressPct.textContent = '0%';
        receiverStatusMsg.textContent   = '⏳ Waiting for sender to send a file…';
        joinRoomBtn.disabled    = false;
        joinRoomBtn.textContent = 'Join Room';
        roomCodeInput.value     = '';
    });

    activeListeners.push({ ref: roomRef, fn });
}

// ─────────────────────────────────────────────
// LEAVE ROOM
// ─────────────────────────────────────────────

/**
 * Handles "Leave Room" for both roles:
 *  1. Detaches all Firebase listeners & closes WebRTC (via cleanup()).
 *  2. Removes the room node from Firebase so the other peer is notified.
 *  3. Resets all UI to the initial state.
 *
 * Note: cleanup() is called first so the room-deletion watcher is detached
 * before remove() runs — this prevents the receiver from seeing its own leave.
 */
async function leaveRoom() {
    const code = currentRoomCode;

    cleanup();              // closes WebRTC + detaches Firebase listeners (incl. room watcher)
    role            = null;
    currentRoomCode = null;

    if (code) await deleteRoom(code);   // also cancels onDisconnect handler server-side

    // ── Sender UI reset ──────────────────────────────────
    generateCodeBtn.disabled    = false;
    generateCodeBtn.textContent = 'Generate Room Code';
    codeRow.classList.add('hidden');
    qrCodeContainer.innerHTML   = '';
    waitingMsg.classList.add('hidden');
    filePickerArea.classList.add('hidden');
    senderFileInfo.classList.add('hidden');
    senderFileInfo.innerHTML      = '';
    sendFileBtn.classList.add('hidden');
    senderProgressWrap.classList.add('hidden');
    senderProgressBar.style.width = '0%';
    senderProgressText.textContent = 'Sending…';
    senderProgressPct.textContent  = '0%';
    sendAnotherBtn.classList.add('hidden');
    fileDropZone.style.pointerEvents = '';
    fileInput.value = '';
    hideError(senderErrorMsg);

    // ── Receiver UI reset ──────────────────────────────
    receiverStatusArea.classList.add('hidden');
    receiverProgressWrap.classList.add('hidden');
    downloadArea.classList.add('hidden');
    startOverBtn.classList.add('hidden');
    receiverProgressBar.style.width = '0%';
    receiverProgressPct.textContent = '0%';
    receiverStatusMsg.textContent   = '⏳ Waiting for sender to send a file…';
    joinRoomBtn.disabled    = false;
    joinRoomBtn.textContent = 'Join Room';
    roomCodeInput.value     = '';
    hideError(receiverErrorMsg);
}

// ─────────────────────────────────────────────
// UI — Leave Room buttons
// ─────────────────────────────────────────────

[senderLeaveBtn, receiverLeaveBtn].forEach((btn) => {
    btn.addEventListener('click', leaveRoom);
});
