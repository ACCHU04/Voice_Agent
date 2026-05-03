/**
 * AEGIS PROTOCOL — server.js (v3 — Llama 3 on Local Ollama)
 * 
 * LLM: Llama 3 via Ollama on local network (http://10.59.197.186:11434)
 * STT: Deepgram Nova-2
 * TTS: Cartesia Sonic
 * 
 * KEY FIXES in this version:
 *  1. Switched to Llama 3 on local Ollama (free, no API key needed, fast)
 *  2. Fixed Cartesia audio encoding: pcm_f32le @ 44100Hz (matches frontend Float32Array)
 *  3. Added Deepgram keepalive (prevents 10s silence timeout)
 *  4. Deepgram tuned for Indian English (en-IN) with endpointing
 *  5. WhatsApp made fully optional — won't crash if Baileys not installed
 *  6. Keyword intent engine kept for instant tool triggers (bypasses LLM latency)
 *  7. Reduced verbose audio chunk logging to prevent console flooding
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const puppeteer = require('puppeteer');
const { search } = require('duck-duck-scrape');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

// ─── Ollama Configuration (Llama 3 on second PC) ────────────────────────────
const OLLAMA_HOST = process.env.OLLAMA_HOST || '10.59.197.186';
const OLLAMA_PORT = process.env.OLLAMA_PORT || '11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const OLLAMA_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/chat`;

console.log(`[Ollama] Brain: ${OLLAMA_URL} (Model: ${OLLAMA_MODEL})`);

// ─── Optional: WhatsApp via Baileys ─────────────────────────────────────────
let waSocket = null;
async function connectToWhatsApp() {
    if (!process.env.WHATSAPP_TARGET_NUMBER) {
        console.log('[WhatsApp] WHATSAPP_TARGET_NUMBER not set — WhatsApp logging disabled.');
        return;
    }
    try {
        const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
        const pino = require('pino');
        const qrcode = require('qrcode-terminal');

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();
        const sock = makeWASocket({
            version, auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Desktop'),
            printQRInTerminal: false,
        });
        sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
            if (qr) { console.log('\n[WhatsApp] Scan QR code:'); qrcode.generate(qr, { small: true }); }
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
            } else if (connection === 'open') {
                console.log('[WhatsApp] ✅ Connected!');
                waSocket = sock;
            }
        });
        sock.ev.on('creds.update', saveCreds);
    } catch (e) {
        console.log('[WhatsApp] Baileys not installed or failed — skipping WhatsApp logging.');
    }
}
connectToWhatsApp();

// ─── Core Setup ──────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Ensure required env vars
['DEEPGRAM_API_KEY', 'CARTESIA_API_KEY', 'CARTESIA_VOICE_ID'].forEach(v => {
    if (!process.env[v]) console.warn(`[WARNING] Missing env var: ${v}`);
});

// CORS
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

// Serve static frontend build
app.use(express.static(path.join(__dirname, '../voice-agent-frontend/build')));
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../voice-agent-frontend/build', 'index.html'));
});

// Health endpoint
app.get('/health', (_, res) => res.json({ status: 'ok', llm: `ollama/${OLLAMA_MODEL}` }));

// ─── Deepgram Client ─────────────────────────────────────────────────────────
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// ─── System Prompt (Optimized for Llama 3) ───────────────────────────────────
const SYSTEM_PROMPT = `You are Aegis, a dual-state voice agent.

STATE 1 — CIVILIAN (Default):
You are a friendly, conversational assistant. You help book movies, answer questions, play music, and chat naturally. Keep answers SHORT — 1-2 sentences max since you are speaking aloud.

STATE 2 — CODE RED (Emergency):
Triggered when user says "Initiate Code Red" or describes a medical emergency.
Become a zero-latency medical orchestrator. Ultra-concise sentences (max 10 words).
Confirm each action in 3 words. Ask for authorization code before dispatching medevac.

RULES:
- NEVER use markdown, asterisks, or bullet points. You are speaking aloud.
- NEVER use filler phrases like "Certainly!" or "Of course!".
- If the user interrupts or corrects themselves, discard previous instruction immediately.
- Emergency tools only in Code Red. Consumer tools only in Civilian mode.
- Keep every reply under 2 sentences. You are a voice agent, not a chatbot.`;

// ─── Ollama API Helper ───────────────────────────────────────────────────────
async function queryOllama(messages) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000); // 90s timeout

    try {
        const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                messages: messages,
                stream: false,
                options: {
                    temperature: 0.3,    // Lower = more focused for voice
                    num_predict: 150,    // Short replies for voice
                    top_p: 0.9,
                    repeat_penalty: 1.1
                }
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`Ollama ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data.message?.content || '';
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            console.error('[Ollama] Request timed out (90s)');
            return 'Sorry, I took too long to think. My brain might be overloaded.';
        }
        throw error;
    }
}

// ─── Tool Classification ─────────────────────────────────────────────────────
const EMERGENCY_TOOLS = ['log_vitals', 'administer_medication', 'trigger_trauma_alert', 'dispatch_medevac', 'activate_camera_triage'];
const CIVILIAN_TOOLS = [
    'book_movie_tickets', 'play_device_music', 'book_cab', 'schedule_appointment', 
    'check_discharge_status', 'web_search', 'lock_pc', 'open_application', 
    'save_note', 'amazon_shopping', 'check_weather', 'crypto_price', 'top_news', 'math_calculator',
    'close_browser', 'book_train', 'book_bus', 'schedule_meeting'
];

// ─── Browser Automation (Puppeteer) ──────────────────────────────────────────
let browserInstance = null;

// ─── MCP Memory Server Initialization ─────────────────────────────────────────
const mcpClient = new Client({ name: "aegis-agent", version: "1.0.0" }, { capabilities: { tools: {} } });
let mcpConnected = false;

async function connectMCP() {
  try {
    const mcpTransport = new StdioClientTransport({
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ["-y", "@modelcontextprotocol/server-memory"]
    });
    await mcpClient.connect(mcpTransport);
    mcpConnected = true;
    console.log("[MCP] ✅ Memory Server Connected!");
  } catch(e) {
    console.error("[MCP] Connection failed:", e.message);
  }
}
connectMCP();
async function playYouTubeVideo(songName) {
    try {
        if (!browserInstance || !browserInstance.isConnected()) {
            browserInstance = await puppeteer.launch({
                headless: false,
                defaultViewport: null,
                args: ['--start-maximized']
            });
        }
        
        const pages = await browserInstance.pages();
        const page = pages.length > 0 ? pages[0] : await browserInstance.newPage();
        await page.bringToFront();
        
        console.log(`[Puppeteer] Searching YouTube for: ${songName}`);
        const query = encodeURIComponent(songName);
        await page.goto(`https://www.youtube.com/results?search_query=${query}`, { waitUntil: 'domcontentloaded' });
        
        // Wait for first video thumbnail and click it
        await page.waitForSelector('a#video-title', { timeout: 10000 });
        await page.evaluate(() => {
            const firstVideo = document.querySelector('a#video-title');
            if (firstVideo) firstVideo.click();
        });
        console.log(`[Puppeteer] ✅ Playing: ${songName}`);
    } catch (error) {
        console.error('[Puppeteer] Failed to automate YouTube:', error.message);
    }
}

async function bookMovieTicketsPuppeteer(movieName) {
    try {
        if (!browserInstance || !browserInstance.isConnected()) {
            browserInstance = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
        }
        const pages = await browserInstance.pages();
        const page = pages.length > 0 ? pages[0] : await browserInstance.newPage();
        await page.bringToFront();
        
        console.log(`[Puppeteer] Booking movie: ${movieName}`);
        const query = encodeURIComponent(movieName);
        await page.goto(`https://in.bookmyshow.com/explore/movies-bengaluru?q=${query}`, { waitUntil: 'domcontentloaded' });
        console.log(`[Puppeteer] Stopping before payment. User must authenticate.`);
    } catch (error) {
        console.error('[Puppeteer] Failed movie booking:', error.message);
    }
}

async function amazonShoppingPuppeteer(product) {
    try {
        if (!browserInstance || !browserInstance.isConnected()) {
            browserInstance = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
        }
        const pages = await browserInstance.pages();
        const page = pages.length > 0 ? pages[0] : await browserInstance.newPage();
        await page.bringToFront();
        
        console.log(`[Puppeteer] Searching Amazon for: ${product}`);
        const query = encodeURIComponent(product);
        await page.goto(`https://www.amazon.in/s?k=${query}`, { waitUntil: 'domcontentloaded' });
        console.log(`[Puppeteer] Stopping for user selection.`);
    } catch (error) {
        console.error('[Puppeteer] Failed Amazon automation:', error.message);
    }
}

async function bookTrainPuppeteer(origin, destination, date) {
    try {
        if (!browserInstance || !browserInstance.isConnected()) {
            browserInstance = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
        }
        const pages = await browserInstance.pages();
        const page = pages.length > 0 ? pages[0] : await browserInstance.newPage();
        await page.bringToFront();
        
        console.log(`[Puppeteer] Booking train: ${origin} → ${destination} on ${date}`);
        const q = encodeURIComponent(`${origin} to ${destination} train ${date}`);
        await page.goto(`https://www.google.com/search?q=IRCTC+${q}`, { waitUntil: 'domcontentloaded' });
        console.log(`[Puppeteer] ✅ Train search opened. User must authenticate on IRCTC.`);
    } catch (error) {
        console.error('[Puppeteer] Failed train booking:', error.message);
    }
}

async function bookBusPuppeteer(origin, destination, date) {
    try {
        if (!browserInstance || !browserInstance.isConnected()) {
            browserInstance = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
        }
        const pages = await browserInstance.pages();
        const page = pages.length > 0 ? pages[0] : await browserInstance.newPage();
        await page.bringToFront();
        
        console.log(`[Puppeteer] Booking bus: ${origin} → ${destination} on ${date}`);
        const q = encodeURIComponent(`${origin} to ${destination}`);
        await page.goto(`https://www.redbus.in/bus-tickets/${q}?date=${date}`, { waitUntil: 'domcontentloaded' });
        console.log(`[Puppeteer] ✅ RedBus search opened.`);
    } catch (error) {
        console.error('[Puppeteer] Failed bus booking:', error.message);
    }
}

// ─── Slot-Filling Definitions ────────────────────────────────────────────────
const SLOT_DEFINITIONS = {
    book_train: {
        slots: ['destination', 'date', 'class'],
        defaults: { origin: 'Bangalore', class: 'Sleeper' },
        prompts: {
            destination: 'Where do you want to travel to?',
            date: 'Which date are you traveling?',
            class: 'Which class do you prefer? 1A, 2A, 3A, or Sleeper?'
        }
    },
    book_bus: {
        slots: ['destination', 'date'],
        defaults: { origin: 'Bangalore' },
        prompts: {
            destination: 'Where do you want to go by bus?',
            date: 'Which date should I book the bus for?'
        }
    },
    book_movie_tickets: {
        slots: ['movie_name'],
        defaults: { theater: 'Nearest Theater', tickets: 2 },
        prompts: {
            movie_name: 'Which movie would you like to watch?'
        }
    },
    book_cab: {
        slots: ['destination'],
        defaults: { cab_type: 'economy' },
        prompts: {
            destination: 'Where should I book the cab to?'
        }
    },
    schedule_meeting: {
        slots: ['title', 'date', 'time'],
        defaults: { duration: '1 hour' },
        prompts: {
            title: 'What is the meeting about?',
            date: 'Which date should I schedule it for?',
            time: 'What time works for you?'
        }
    },
    emergency_camera: {
        slots: ['user_consent'],
        defaults: { reason: 'Emergency assessment' },
        prompts: {
            user_consent: 'Emergency detected. I need to activate the camera for visual assessment. Do I have your permission? Say yes or proceed to confirm.'
        }
    }
};

// ─── WhatsApp Logger ─────────────────────────────────────────────────────────
async function logToWhatsApp(toolName, args) {
    if (!waSocket || !process.env.WHATSAPP_TARGET_NUMBER) return;
    const ts = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const jid = `${process.env.WHATSAPP_TARGET_NUMBER}@s.whatsapp.net`;

    const ICONS = {
        log_vitals: '🩺', administer_medication: '💊',
        trigger_trauma_alert: '🚑', dispatch_medevac: '🚁',
        book_movie_tickets: '🎬', play_device_music: '🎵',
        book_cab: '🚕', schedule_appointment: '📋',
        check_discharge_status: '🏥', activate_camera_triage: '📸'
    };
    const icon = ICONS[toolName] || '⚙️';

    let body = `${EMERGENCY_TOOLS.includes(toolName) ? '🚨 *AEGIS CODE RED*' : '🤖 *AEGIS CIVILIAN*'}\n`;
    body += `_${ts}_\n\n${icon} *${toolName.replace(/_/g, ' ').toUpperCase()}*\n`;
    body += Object.entries(args).map(([k, v]) => `• ${k}: ${v}`).join('\n');

    try {
        await waSocket.sendMessage(jid, { text: body });
        console.log('[WhatsApp] ✅ Sent');
    } catch (e) {
        console.error('[WhatsApp] Send failed:', e.message);
    }
}

// ─── WebSocket Connection Handler ─────────────────────────────────────────────
wss.on('connection', (ws) => {
    console.log('\n[Server] ✅ Client connected');

    const conversationHistory = [];
    let isProcessing = false;

    // ── Slot-Filling State Machine ────────────────────────────────────────────
    let slotState = null;  // { task: 'book_train', collected: { destination: 'Delhi' }, pending: ['date', 'class'] }

    function initSlotFilling(taskName, initialArgs = {}) {
        const def = SLOT_DEFINITIONS[taskName];
        if (!def) return false;

        const collected = { ...def.defaults, ...initialArgs };
        const pending = def.slots.filter(s => !collected[s] || collected[s] === '');

        if (pending.length === 0) {
            // All slots already filled → execute immediately
            return false;
        }

        slotState = { task: taskName, collected, pending };
        console.log(`[SlotFill] Started: ${taskName} | Collected: ${JSON.stringify(collected)} | Missing: ${pending}`);

        // Ask for first missing slot
        const firstMissing = pending[0];
        const prompt = def.prompts[firstMissing];
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: prompt }));
        sendToCartesia(prompt);
        return true;
    }

    function fillSlot(transcript) {
        if (!slotState) return false;

        const lower = transcript.toLowerCase();
        const { task, collected, pending } = slotState;

        // Cancel check
        if (lower.includes('cancel') || lower.includes('never mind') || lower.includes('forget it')) {
            slotState = null;
            const msg = 'Alright, I have cancelled that request.';
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: msg }));
            sendToCartesia(msg);
            return true;
        }

        // Special case: emergency_camera consent
        if (task === 'emergency_camera' && pending.includes('user_consent')) {
            if (lower.includes('yes') || lower.includes('proceed') || lower.includes('go ahead') || lower.includes('confirm')) {
                collected.user_consent = 'granted';
            } else if (lower.includes('no') || lower.includes('deny') || lower.includes('don\'t')) {
                slotState = null;
                const msg = 'Camera activation cancelled. Your privacy is preserved.';
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: msg }));
                sendToCartesia(msg);
                return true;
            } else {
                const msg = 'Please say yes or no to confirm camera activation.';
                sendToCartesia(msg);
                return true;
            }
        }

        // Extract value for current pending slot
        const currentSlot = pending[0];
        if (currentSlot && currentSlot !== 'user_consent') {
            // Smart extraction based on slot type
            let value = transcript.trim();

            if (currentSlot === 'date') {
                // Try to extract date-like patterns
                const dateMatch = value.match(/(\d{1,2}[\s/-]\w+|tomorrow|today|next \w+|\d{1,2}(?:st|nd|rd|th)?\s*(?:of\s*)?\w+)/i);
                value = dateMatch ? dateMatch[0] : value;
            }
            if (currentSlot === 'time') {
                const timeMatch = value.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?)/i);
                value = timeMatch ? timeMatch[0] : value;
            }
            if (currentSlot === 'class') {
                if (lower.includes('1a') || lower.includes('first')) value = '1A';
                else if (lower.includes('2a') || lower.includes('second')) value = '2A';
                else if (lower.includes('3a') || lower.includes('third')) value = '3A';
                else if (lower.includes('sleeper')) value = 'SL';
                else value = value.toUpperCase();
            }

            collected[currentSlot] = value;
        }

        // Remove filled slot from pending
        const idx = pending.indexOf(currentSlot);
        if (idx !== -1) pending.splice(idx, 1);

        console.log(`[SlotFill] Filled "${currentSlot}" = "${collected[currentSlot]}" | Remaining: ${pending}`);

        // Check if all slots are filled
        if (pending.length === 0) {
            console.log(`[SlotFill] ✅ All slots filled for ${task}:`, collected);
            slotState = null;
            executeSlotFilledTask(task, collected);
            return true;
        }

        // Ask for next missing slot
        const nextSlot = pending[0];
        const def = SLOT_DEFINITIONS[task];
        const prompt = def.prompts[nextSlot];
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: prompt }));
        sendToCartesia(prompt);
        return true;
    }

    async function executeSlotFilledTask(task, args) {
        console.log(`[SlotFill] Executing: ${task}`, args);

        switch (task) {
            case 'book_train':
                bookTrainPuppeteer(args.origin || 'Bangalore', args.destination, args.date);
                await executeToolAndRespond({ name: 'book_train', args });
                break;
            case 'book_bus':
                bookBusPuppeteer(args.origin || 'Bangalore', args.destination, args.date);
                await executeToolAndRespond({ name: 'book_bus', args });
                break;
            case 'book_movie_tickets':
                bookMovieTicketsPuppeteer(args.movie_name);
                await executeToolAndRespond({ name: 'book_movie_tickets', args });
                break;
            case 'book_cab':
                await executeToolAndRespond({ name: 'book_cab', args });
                break;
            case 'schedule_meeting': {
                const title = encodeURIComponent(args.title);
                const details = encodeURIComponent(`Scheduled via Aegis Guardian AI`);
                const calUrl = `https://calendar.google.com/calendar/r/eventedit?text=${title}&details=${details}&dates=${args.date}`;
                if (!browserInstance || !browserInstance.isConnected()) {
                    browserInstance = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
                }
                const pages = await browserInstance.pages();
                const page = pages.length > 0 ? pages[0] : await browserInstance.newPage();
                await page.goto(calUrl, { waitUntil: 'domcontentloaded' });
                await executeToolAndRespond({ name: 'schedule_meeting', args });
                break;
            }
            case 'emergency_camera':
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'activate_camera', reason: args.reason }));
                    ws.send(JSON.stringify({ type: 'action_log', tool: 'activate_camera_triage', details: JSON.stringify(args) }));
                }
                const camMsg = 'Camera activated. Point your device at the area of concern.';
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: camMsg }));
                sendToCartesia(camMsg);
                break;
        }
    }

    // ── Cartesia WS (TTS) ────────────────────────────────────────────────────
    const cartesiaUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${process.env.CARTESIA_API_KEY}&cartesia_version=2024-06-10`;
    let cartesiaWs = null;

    function connectCartesia() {
        cartesiaWs = new WebSocket(cartesiaUrl);
        cartesiaWs.on('open', () => console.log('[Cartesia] ✅ Connected'));
        cartesiaWs.on('error', (e) => console.error('[Cartesia] Error:', e.message));
        cartesiaWs.on('close', () => {
            console.log('[Cartesia] Disconnected. Reconnecting in 2s...');
            if (ws.readyState === WebSocket.OPEN) setTimeout(connectCartesia, 2000);
        });

        cartesiaWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'chunk' && msg.data) {
                    const audioBuf = Buffer.from(msg.data, 'base64');
                    if (ws.readyState === WebSocket.OPEN) ws.send(audioBuf);
                } else if (msg.type === 'error') {
                    console.error('[Cartesia] API error:', msg.error);
                }
            } catch (_) {
                // Binary frame — forward directly
                if (ws.readyState === WebSocket.OPEN) ws.send(data);
            }
        });
    }
    connectCartesia();

    function sendToCartesia(text) {
        if (!cartesiaWs || cartesiaWs.readyState !== WebSocket.OPEN) {
            console.error('[Cartesia] Not open — cannot send TTS.');
            return;
        }
        console.log(`[Cartesia] TTS → "${text.slice(0, 80)}..."`);
        cartesiaWs.send(JSON.stringify({
            model_id: 'sonic-english',
            transcript: text,
            voice: { mode: 'id', id: process.env.CARTESIA_VOICE_ID },
            output_format: {
                container: 'raw',
                encoding: 'pcm_f32le',   // MUST match frontend Float32Array expectation
                sample_rate: 44100,       // Cartesia's native rate
            },
            context_id: `msg-${Date.now()}`,
        }));
    }

    // ── Tool Execution Engine ─────────────────────────────────────────────────
    function executeTool(name, args) {
        console.log(`[Tool] ▶ ${name}`, args);
        switch (name) {
            case 'log_vitals':
                return { status: 'Vitals logged', ...args };
            case 'administer_medication':
                return { status: 'Medication logged', drug: args.drug_name, dose: args.dosage };
            case 'trigger_trauma_alert':
                return { status: 'Trauma alert sent to casualty ward', eta: args.eta_minutes };
            case 'dispatch_medevac': {
                const code = (args.auth_code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                if (['sigmaniner', 'sigma9', 'sigmanine'].includes(code)) {
                    return { status: 'MEDEVAC DISPATCHED', destination: args.coordinates, auth: 'VERIFIED' };
                }
                return { status: 'ACCESS DENIED — invalid auth code' };
            }
            case 'book_movie_tickets':
                bookMovieTicketsPuppeteer(args.movie_name);
                return { status: 'Booked', confirmation: 'BMS-' + Math.floor(Math.random() * 90000 + 10000), ...args };
            case 'amazon_shopping':
                amazonShoppingPuppeteer(args.product);
                return { status: 'Opened Amazon' };
            case 'play_device_music':
                playYouTubeVideo(args.song_name);
                return { status: 'Playing', song: args.song_name };
            case 'book_cab': {
                const eta = Math.floor(Math.random() * 8) + 3;
                return { status: 'Cab booked', eta_minutes: eta, destination: args.destination };
            }
            case 'schedule_appointment':
                return { status: 'Appointment scheduled', id: 'APT-' + Math.floor(Math.random() * 90000 + 10000) };
            case 'check_discharge_status':
                return {
                    status: 'Retrieved', pipeline: {
                        billing: { status: 'Cleared', amount: '₹12,450' },
                        insurance: { status: 'Pending', note: '2 patients ahead' },
                        pharmacy: { status: 'Ready', note: 'Counter 3' },
                        lab: { status: 'Cleared', note: 'Reports uploaded' }
                    }
                };
            case 'activate_camera_triage':
                return { status: 'Camera activated' };
            case 'lock_pc':
                exec('rundll32.exe user32.dll,LockWorkStation');
                return { status: 'Locked' };
            case 'open_application':
                exec(`start "" "${args.app_name}"`);
                return { status: 'Opened' };
            case 'save_note':
                const notePath = path.join(os.homedir(), 'Desktop', 'Aegis_Notes.txt');
                fs.appendFileSync(notePath, `\n[${new Date().toLocaleString()}] ${args.note_content}`);
                return { status: 'Saved' };
            case 'close_browser':
                if (browserInstance) {
                    browserInstance.close().catch(() => {});
                    browserInstance = null;
                    console.log('[Puppeteer] ✅ Browser closed');
                }
                return { status: 'Closed browser' };
            case 'book_train':
                return { status: 'Train search opened', route: `${args.origin || 'Bangalore'} → ${args.destination}`, date: args.date, class: args.class };
            case 'book_bus':
                return { status: 'Bus search opened', route: `${args.origin || 'Bangalore'} → ${args.destination}`, date: args.date };
            case 'schedule_meeting':
                return { status: 'Meeting scheduled', title: args.title, date: args.date, time: args.time };
            default:
                return { status: 'Unknown tool' };
        }
    }

    // ── Execute tool and send all notifications ──────────────────────────────
    async function executeToolAndRespond(call) {
        const result = executeTool(call.name, call.args);

        // Mode switch
        if (ws.readyState === WebSocket.OPEN) {
            if (EMERGENCY_TOOLS.includes(call.name)) ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
            if (CIVILIAN_TOOLS.includes(call.name)) ws.send(JSON.stringify({ type: 'mode_switch', mode: 'civilian' }));

            // Action log
            ws.send(JSON.stringify({ type: 'action_log', tool: call.name, details: JSON.stringify(call.args) }));

            // Hardware actions for frontend
            if (call.name === 'play_device_music') {
                ws.send(JSON.stringify({ type: 'hardware_action', action: 'play_music', song: call.args.song_name }));
            } else if (call.name === 'book_cab') {
                ws.send(JSON.stringify({ type: 'hardware_action', action: 'cab_booked', eta: result.eta_minutes, destination: call.args.destination }));
            } else if (call.name === 'book_movie_tickets') {
                ws.send(JSON.stringify({ type: 'hardware_action', action: 'movie_booked', movie: call.args.movie_name }));
            } else if (call.name === 'schedule_appointment') {
                ws.send(JSON.stringify({ type: 'hardware_action', action: 'appointment_booked', doctor: call.args.doctor_type, hospital: 'Partner Hospital' }));
            } else if (call.name === 'check_discharge_status') {
                ws.send(JSON.stringify({ type: 'discharge_update', statuses: result.pipeline }));
            } else if (call.name === 'activate_camera_triage') {
                ws.send(JSON.stringify({ type: 'activate_camera', reason: call.args.reason }));
            }
        }

        // WhatsApp log
        await logToWhatsApp(call.name, call.args);

        // Voice confirmation
        const confirmations = {
            play_device_music: `Playing ${call.args.song_name} for you now!`,
            book_cab: `Your cab to ${call.args.destination} is booked! Arriving in about ${result.eta_minutes} minutes.`,
            book_movie_tickets: `I have opened BookMyShow to search for ${call.args.movie_name}. Please authenticate and complete the payment on your screen.`,
            schedule_appointment: `Your ${call.args.doctor_type} appointment has been scheduled.`,
            check_discharge_status: `Discharge status: Billing cleared, insurance pending, pharmacy ready at counter 3, lab reports cleared.`,
            log_vitals: `Vitals logged. Heart rate ${call.args.heart_rate} BPM, BP ${call.args.blood_pressure}, oxygen ${call.args.oxygen_level} percent.`,
            trigger_trauma_alert: `Trauma alert sent. ETA ${call.args.eta_minutes} minutes for ${call.args.injury_type}.`,
            activate_camera_triage: `Camera triage activated. Point your camera at the injury.`,
            dispatch_medevac: `Medevac dispatched to ${call.args.coordinates}.`,
            administer_medication: `${call.args.drug_name} ${call.args.dosage} administered and logged.`,
            lock_pc: 'Locking your computer now.',
            open_application: `Opening ${call.args.app_name} for you.`,
            save_note: 'Note saved to your desktop.',
            amazon_shopping: `I've opened Amazon and searched for ${call.args.product}. You can add it to your cart.`,
            close_browser: `I have closed the automated browser window.`,
            book_train: `I've opened a train search for ${call.args.destination} on ${call.args.date} in ${call.args.class || 'Sleeper'} class. Please authenticate on IRCTC to continue.`,
            book_bus: `I've opened RedBus for your journey to ${call.args.destination} on ${call.args.date}. Please select your preferred bus.`,
            schedule_meeting: `Your meeting "${call.args.title}" has been scheduled for ${call.args.date} at ${call.args.time}. I have opened Google Calendar for you.`
        };

        const voiceReply = confirmations[call.name] || `Done. ${call.name} completed.`;
        console.log(`[Voice] "${voiceReply}"`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: voiceReply }));
        sendToCartesia(voiceReply);
    }

    // ── Keyword Intent Engine (instant, bypasses LLM) ─────────────────────────
    function detectIntent(text) {
        const lower = text.toLowerCase();

        // Stop / Close priority
        if (lower.includes('stop') || lower.includes('close') || lower.includes('shut down') || lower.includes('quit')) {
            if (lower.includes('music') || lower.includes('youtube') || lower.includes('browser') || lower.includes('amazon') || lower.includes('video') || lower.includes('window')) {
                return { name: 'close_browser', args: {} };
            }
        }

        // Play music
        if ((lower.includes('play') || lower.includes('song') || lower.includes('music')) && !lower.includes('code red')) {
            let songName = text.replace(/^.*?(play|put on|start|listen to)\s*/i, '').replace(/\s*(on youtube|on spotify|please|for me|in the youtube|in youtube|on my phone|songs?|music).*$/gi, '').trim();
            if (!songName || songName.length < 2 || ['a', 'some', 'the', 'my'].includes(songName.toLowerCase())) {
                songName = 'Arijit Singh top songs';
            }
            return { name: 'play_device_music', args: { song_name: songName } };
        }
        // Book cab — slot-fill if no destination
        if (lower.includes('cab') || lower.includes('uber') || lower.includes('ola') || lower.includes('taxi') || lower.includes('ride')) {
            const dest = text.replace(/^.*?(to|for|towards)\s*/i, '').replace(/\s*(please|now|quickly).*$/i, '').trim();
            if (dest && dest.length > 2 && dest.toLowerCase() !== 'cab' && dest.toLowerCase() !== 'book') {
                return { name: 'book_cab', args: { destination: dest, cab_type: 'economy' } };
            }
            return { name: '__SLOT_FILL__', task: 'book_cab', initialArgs: {} };
        }
        // Book train — always slot-fill
        if (lower.includes('train') || lower.includes('irctc') || lower.includes('railway')) {
            const destMatch = text.match(/(?:to|for)\s+([\w\s]+?)(?:\s*(?:on|please|tomorrow|today|$))/i);
            const initialArgs = {};
            if (destMatch && destMatch[1].trim().length > 2) initialArgs.destination = destMatch[1].trim();
            return { name: '__SLOT_FILL__', task: 'book_train', initialArgs };
        }
        // Book bus — always slot-fill
        if (lower.includes('bus') || lower.includes('redbus')) {
            const destMatch = text.match(/(?:to|for)\s+([\w\s]+?)(?:\s*(?:on|please|tomorrow|today|$))/i);
            const initialArgs = {};
            if (destMatch && destMatch[1].trim().length > 2) initialArgs.destination = destMatch[1].trim();
            return { name: '__SLOT_FILL__', task: 'book_bus', initialArgs };
        }
        // Book movie — slot-fill if no movie name
        if (lower.includes('movie') || lower.includes('ticket') || lower.includes('cinema') || lower.includes('book my show')) {
            const movie = text.replace(/^.*?(for|of|to see|watch)\s*/i, '').replace(/\s*(please|at|in|ticket|movie).*$/i, '').trim();
            if (movie && movie.length > 2 && !['book', 'a', 'the', 'some'].includes(movie.toLowerCase())) {
                return { name: 'book_movie_tickets', args: { movie_name: movie, theater: 'Nearest Theater', tickets: 2 } };
            }
            return { name: '__SLOT_FILL__', task: 'book_movie_tickets', initialArgs: {} };
        }
        // Schedule meeting — always slot-fill
        if (lower.includes('meeting') || lower.includes('calendar') || lower.includes('block') || (lower.includes('schedule') && !lower.includes('appointment'))) {
            const titleMatch = text.match(/(?:for|about|called|titled)\s+(.+?)(?:\s*(?:on|at|tomorrow|today|please|$))/i);
            const initialArgs = {};
            if (titleMatch && titleMatch[1].trim().length > 2) initialArgs.title = titleMatch[1].trim();
            return { name: '__SLOT_FILL__', task: 'schedule_meeting', initialArgs };
        }
        // Schedule appointment
        if (lower.includes('appointment') || lower.includes('schedule') || (lower.includes('doctor') && lower.includes('book'))) {
            const docType = lower.includes('cardio') ? 'Cardiologist' : lower.includes('ortho') ? 'Orthopedic' : 'General Physician';
            return { name: 'schedule_appointment', args: { doctor_type: docType, preferred_date: 'Next available' } };
        }
        // Discharge status
        if (lower.includes('discharge') || lower.includes('billing') || lower.includes('insurance') || lower.includes('pharmacy status')) {
            return { name: 'check_discharge_status', args: {} };
        }
        // Code Red
        if (lower.includes('code red') || lower.includes('initiate code red')) {
            return '__CODE_RED__';
        }
        // Log vitals
        if (lower.includes('vitals') || lower.includes('heart rate') || lower.includes('blood pressure') || lower.includes('oxygen')) {
            return { name: 'log_vitals', args: { heart_rate: 82, blood_pressure: '120/80', oxygen_level: 97 } };
        }
        // Trauma alert
        if (lower.includes('trauma') || lower.includes('accident') || lower.includes('crash')) {
            return { name: 'trigger_trauma_alert', args: { eta_minutes: 8, injury_type: 'Road traffic accident' } };
        }
        // Camera triage — now uses permission-based slot-fill
        if (lower.includes('camera') || lower.includes('triage') || lower.includes('see the injury') || lower.includes('wound') || lower.includes('look at')) {
            return { name: '__SLOT_FILL__', task: 'emergency_camera', initialArgs: { reason: 'Visual injury assessment' } };
        }
        // Web Search
        if (lower.includes('search') || lower.includes('look up') || lower.includes('what is the score') || lower.includes('who is')) {
            const query = text.replace(/^.*?(search for|look up|what is the|who is)\s*/i, '').trim();
            if (query.length > 2) return { name: 'web_search', args: { query } };
        }
        
        // --- NEW PC & API TOOLS ---
        if (lower.includes('lock my pc') || lower.includes('lock my computer') || lower.includes('lock the computer')) {
            return { name: 'lock_pc', args: {} };
        }
        if (lower.includes('open ') || lower.includes('launch ')) {
            const app = text.replace(/^.*?(open|launch)\s*/i, '').trim();
            if (!['youtube', 'google', 'browser', 'swiggy', 'zomato', 'amazon', 'bookmyshow', 'uber'].includes(app.toLowerCase())) {
                return { name: 'open_application', args: { app_name: app } };
            }
        }
        if (lower.includes('take a note') || lower.includes('save a note') || lower.includes('write down')) {
            const note = text.replace(/^.*?(take a note|save a note|write down|note that)\s*/i, '').replace(/please/i, '').trim();
            return { name: 'save_note', args: { note_content: note } };
        }
        if (lower.includes('weather in') || lower.includes('weather for')) {
            const location = text.replace(/^.*?(weather in|weather for|weather at)\s*/i, '').trim();
            return { name: 'check_weather', args: { location } };
        }
        if ((lower.includes('price of') || lower.includes('how much is')) && (lower.includes('bitcoin') || lower.includes('crypto') || lower.includes('stock'))) {
            const asset = text.replace(/^.*?(price of|how much is)\s*/i, '').trim();
            return { name: 'crypto_price', args: { asset } };
        }
        if (lower.includes('calculate') || (lower.includes('what is') && (lower.includes('percent') || lower.includes('plus') || lower.includes('minus') || lower.includes('times')))) {
            return { name: 'math_calculator', args: { equation: text } };
        }
        if (lower.includes('top news') || lower.includes('latest news') || lower.includes('headlines')) {
            return { name: 'top_news', args: {} };
        }
        if (lower.includes('amazon')) {
            const product = text.replace(/^.*?(on amazon|amazon for|buy)\s*/i, '').replace(/amazon/i, '').trim();
            return { name: 'amazon_shopping', args: { product } };
        }
        
        // MCP Memory
        if (lower.includes('remember that') || lower.includes('keep in mind') || lower.includes('memorize')) {
            const fact = text.replace(/^.*?(remember that|keep in mind|memorize)\s*/i, '').trim();
            return { name: 'memorize_fact', args: { fact } };
        }

        return null; // No keyword match → send to LLM
    }

    // ── Main LLM Processing ──────────────────────────────────────────────────
    async function processTranscript(transcript) {
        if (isProcessing) {
            console.log(`[Server] Busy — dropped: "${transcript}"`);
            return;
        }

        isProcessing = true;
        try {
            // 0. SLOT-FILLING CHECK — if we are in the middle of a dialogue, fill the next slot
            if (slotState) {
                console.log(`[SlotFill] Active (${slotState.task}) — processing: "${transcript}"`);
                fillSlot(transcript);
                return;  // fillSlot handles everything
            }

            // 1. Check keyword intent first (instant, no LLM needed)
            const intent = detectIntent(transcript);

            // 1.5 SLOT-FILL TRIGGER — start a multi-turn dialogue
            if (intent && intent.name === '__SLOT_FILL__') {
                console.log(`[SlotFill] Triggered: ${intent.task}`);
                const started = initSlotFilling(intent.task, intent.initialArgs || {});
                if (!started) {
                    // All slots were already filled from the initial utterance
                    await executeSlotFilledTask(intent.task, { ...SLOT_DEFINITIONS[intent.task].defaults, ...intent.initialArgs });
                }
                return;
            }

            if (intent === '__CODE_RED__') {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                const reply = 'Code Red activated. I am now in emergency mode. Report the situation.';
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: reply }));
                sendToCartesia(reply);
                return;
            }

            if (intent) {
                console.log(`[Intent] Detected: "${intent.name}" from keywords`);
                
                if (intent.name === 'web_search') {
                    console.log(`[Search] Query: ${intent.args.query}`);
                    try {
                        const searchResults = await search(intent.args.query, { safeSearch: "off" });
                        const topResult = searchResults.results[0] ? searchResults.results[0].description : "No results found.";
                        
                        const prompt = `The user asked: "${transcript}". The web search returned: "${topResult}". Provide a short 1-sentence answer based on this search result.`;
                        const response = await queryOllama([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }]);
                        
                        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: response }));
                        sendToCartesia(response);
                    } catch(e) {
                        const fallback = "Sorry, I couldn't search the web right now.";
                        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: fallback }));
                        sendToCartesia(fallback);
                    }
                    return;
                }
                
                if (['check_weather', 'crypto_price', 'top_news', 'math_calculator'].includes(intent.name)) {
                    try {
                        let prompt = "";
                        const controller = new AbortController();
                        const fetchTimeout = setTimeout(() => controller.abort(), 10000);
                        
                        if (intent.name === 'check_weather') {
                            const res = await fetch(`https://wttr.in/${encodeURIComponent(intent.args.location)}?format=3`, { signal: controller.signal });
                            clearTimeout(fetchTimeout);
                            const data = await res.text();
                            prompt = `User asked: "${transcript}". Live weather data: "${data}". Answer in 1 short sentence.`;
                        } else if (intent.name === 'crypto_price') {
                            const searchResults = await search(`price of ${intent.args.asset}`, { safeSearch: "off" });
                            prompt = `User asked for price of ${intent.args.asset}. Search result: "${searchResults.results[0]?.description || 'Not found'}". Answer in 1 short sentence.`;
                        } else if (intent.name === 'top_news') {
                            const searchResults = await search(`latest news headlines`, { safeSearch: "off" });
                            const headlines = searchResults.results.slice(0, 2).map(r => r.title).join(", ");
                            prompt = `User asked for news. Headlines: "${headlines}". Read them naturally in 2 sentences.`;
                        } else if (intent.name === 'math_calculator') {
                            prompt = `User asked math question: "${intent.args.equation}". Calculate and state the answer quickly in one sentence.`;
                        }
                        
                        const response = await queryOllama([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }]);
                        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: response }));
                        sendToCartesia(response);
                    } catch(e) {
                        console.error('[DynamicTool] Error:', e);
                        sendToCartesia("Sorry, I could not fetch that information right now.");
                    }
                    return;
                }
                
                if (intent.name === 'memorize_fact') {
                    try {
                        if (!mcpConnected) throw new Error("MCP not connected");
                        
                        // Extract entities using a fast Ollama prompt
                        const prompt = `Extract the main subject and the fact from this sentence. Output ONLY valid JSON in this format: {"entities": [{"name": "subject_name", "entityType": "person_or_object", "observations": ["the fact"]}]}. Sentence: "${intent.args.fact}"`;
                        
                        const res = await queryOllama([{role: 'user', content: prompt}]);
                        const match = res.match(/\{[\s\S]*\}/);
                        if (match) {
                            const parsed = JSON.parse(match[0]);
                            await mcpClient.callTool({ name: "create_entities", arguments: parsed });
                            sendToCartesia("Got it, I will remember that.");
                        } else {
                            throw new Error("Invalid LLM JSON for memory");
                        }
                    } catch(e) {
                        console.error('[MCP] Save failed', e.message);
                        sendToCartesia("Sorry, my memory module is offline.");
                    }
                    return;
                }
                
                await executeToolAndRespond(intent);
                return;
            }

            // 2. No keyword match → send to Llama 3 for conversational reply
            conversationHistory.push({ role: 'user', content: transcript });

            // Keep history manageable
            if (conversationHistory.length > 12) {
                conversationHistory.splice(0, conversationHistory.length - 6);
            }

            const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversationHistory];

            console.log(`[Ollama] Sending to ${OLLAMA_MODEL}: "${transcript}"`);
            let response = await queryOllama(messages);

            // Clean up any thinking tags (just in case)
            response = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

            if (!response || response.length === 0) {
                response = "I'm here! How can I help you? I can play music, book cabs, or check your discharge status.";
            }

            console.log(`[Ollama] Reply: "${response}"`);
            conversationHistory.push({ role: 'assistant', content: response });

            // Send to frontend
            if (ws.readyState === WebSocket.OPEN) {
                const lowerReply = response.toLowerCase();
                if (lowerReply.includes('code red') || lowerReply.includes('emergency')) {
                    ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                }
                ws.send(JSON.stringify({ type: 'ai_transcript', text: response }));
            }
            sendToCartesia(response);

        } catch (error) {
            console.error('[LLM] Error:', error.message);
            const fallback = "I hit a snag. Try again.";
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: fallback }));
            sendToCartesia(fallback);
        } finally {
            isProcessing = false;
        }
    }

    // ── Deepgram Live STT ─────────────────────────────────────────────────────
    const dgConnection = deepgram.listen.live({
        model: 'nova-2',
        language: 'en-IN',           // Indian English accent tuning
        smart_format: true,
        interim_results: true,
        endpointing: 300,            // ms of silence before marking utterance final
        vad_events: true,
    });

    let keepAliveInterval;

    dgConnection.on('open', () => {
        console.log('[Deepgram] ✅ Connected');
        // Keepalive: send empty packet every 8s to prevent 10s timeout
        keepAliveInterval = setInterval(() => {
            if (dgConnection.getReadyState() === 1) {
                dgConnection.keepAlive();
            }
        }, 8000);
    });

    dgConnection.on('Results', async (data) => {
        const alt = data.channel?.alternatives?.[0];
        const transcript = alt?.transcript?.trim();
        if (!transcript) return;

        if (!data.is_final) {
            // Interim = user started speaking → barge-in: kill AI audio
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'clear_buffer' }));
            }
            return;
        }

        // Ignore very short noise fragments
        if (transcript.length < 3) return;

        console.log(`[Deepgram] ✅ Final: "${transcript}"`);
        await processTranscript(transcript);
    });

    dgConnection.on('error', (e) => console.error('[Deepgram] Error:', e));
    dgConnection.on('close', () => {
        console.log('[Deepgram] Disconnected');
        clearInterval(keepAliveInterval);
    });

    // ── Handle incoming messages from React ───────────────────────────────────
    let audioChunkCount = 0;
    ws.on('message', async (message, isBinary) => {
        if (!isBinary) {
            const str = message.toString();
            try {
                const data = JSON.parse(str);
                if (data.type === 'camera_frame') {
                    console.log(`[Vision] Received camera frame for: ${data.reason}`);
                    if (!process.env.VISION_API_KEY) {
                        const noKeyMsg = "I cannot analyze the image. Please add your Vision API key to the environment file.";
                        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: noKeyMsg }));
                        sendToCartesia(noKeyMsg);
                        return;
                    }
                    const genAI = new GoogleGenerativeAI(process.env.VISION_API_KEY);
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                    const base64Data = data.image.replace(/^data:image\/(png|jpeg);base64,/, "");
                    
                    const prompt = `You are Aegis, an emergency AI assistant. The user activated camera triage for: ${data.reason}. Look at the image and provide immediate, concise first-aid instructions in max 3 short sentences. Speak aloud.`;
                    
                    const result = await model.generateContent([prompt, { inlineData: { data: base64Data, mimeType: "image/jpeg" } }]);
                    const response = result.response.text();
                    console.log(`[Vision] AI says: ${response}`);
                    
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'ai_transcript', text: response }));
                    }
                    sendToCartesia(response);
                }
            } catch(e) { console.error('[WS] Parse error', e.message); }
            return;
        }

        if (Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
            // Log every 20th chunk to avoid console flooding
            audioChunkCount++;
            if (audioChunkCount % 20 === 0) {
                console.log(`[Audio] ${audioChunkCount} chunks received (${message.byteLength} bytes latest)`);
            }
            if (dgConnection.getReadyState() === 1) {
                dgConnection.send(message);
            }
        }
    });

    // ── Cleanup on disconnect ─────────────────────────────────────────────────
    ws.on('close', () => {
        console.log('[Server] Client disconnected — cleaning up.');
        clearInterval(keepAliveInterval);
        try { dgConnection.finish(); } catch (_) {}
        if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) cartesiaWs.close();
    });

    ws.on('error', (e) => console.error('[Server] WS error:', e.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8081;
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║   AEGIS PROTOCOL — Backend Running       ║
║   Port  : ${PORT}                           ║
║   LLM   : Ollama ${OLLAMA_MODEL} (LOCAL)            ║
║   STT   : Deepgram Nova-2               ║
║   TTS   : Cartesia Sonic                ║
╚══════════════════════════════════════════╝
`);
});
