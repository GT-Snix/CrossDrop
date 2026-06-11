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
const ROOM_TTL_MS        = 10 * 60 * 1000; // 10 minutes in milliseconds
const CONNECTION_TIMEOUT = 30 * 1000;   // 30 seconds

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
const waitingMsg         = document.getElementById('waiting-msg');
const senderErrorMsg     = document.getElementById('sender-error-msg');
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

// ─────────────────────────────────────────────
// APPLICATION STATE
// ─────────────────────────────────────────────

let currentRoomCode    = null;
let peerConnection     = null;
let dataChannel        = null;
let role               = null;   // 'sender' | 'receiver'
let selectedFile       = null;
let connectionTimer    = null;   // setTimeout handle for 30s connection timeout

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
// CONNECTION TIMEOUT (30 seconds)
// ─────────────────────────────────────────────

function startConnectionTimer() {
    clearConnectionTimer();
    connectionTimer = setTimeout(() => {
        // Only fire if we haven't connected yet
        if (!dataChannel || dataChannel.readyState !== 'open') {
            const errorEl  = role === 'sender' ? senderErrorMsg : receiverErrorMsg;
            const buttonEl = role === 'sender' ? generateCodeBtn : joinRoomBtn;
            showError(errorEl, '⚠️ Could not connect. You may be on a restricted network.');
            if (role === 'sender') {
                waitingMsg.classList.add('hidden');
                generateCodeBtn.disabled    = false;
                generateCodeBtn.textContent = 'Generate Room Code';
            } else {
                joinRoomBtn.disabled    = false;
                joinRoomBtn.textContent = 'Join Room';
            }
            cleanup();
        }
    }, CONNECTION_TIMEOUT);
}

function clearConnectionTimer() {
    if (connectionTimer) {
        clearTimeout(connectionTimer);
        connectionTimer = null;
    }
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
            // Delete room from Firebase now that both peers are connected.
            // A third party can no longer join with this code.
            deleteRoom(currentRoomCode);

            waitingMsg.classList.add('hidden');
            filePickerArea.classList.remove('hidden');
        } else {
            receiverStatusMsg.textContent = '⏳ Waiting for sender to send a file…';
        }
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
