require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// =============================================
// OLLAMA CONFIGURATION (Local LLM on second PC)
// =============================================
const OLLAMA_HOST = process.env.OLLAMA_HOST || '10.59.197.94';
const OLLAMA_PORT = process.env.OLLAMA_PORT || '11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:1.5b';
const OLLAMA_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/chat`;

console.log(`[Ollama] Brain configured at: ${OLLAMA_URL} (Model: ${OLLAMA_MODEL})`);

// Ensure all environment variables are present
const requiredEnvVars = [
    'DEEPGRAM_API_KEY',
    'CARTESIA_API_KEY',
    'CARTESIA_VOICE_ID'
];

requiredEnvVars.forEach(envVar => {
    if (!process.env[envVar]) {
        console.warn(`[WARNING] Missing environment variable: ${envVar}`);
    }
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve Static Frontend Build
app.use(express.static(path.join(__dirname, '../voice-agent-frontend/build')));

// Fallback to index.html for SPA routing (using Regex to bypass strict parsing)
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../voice-agent-frontend/build', 'index.html'));
});

// Initialize WhatsApp (Baileys)
let waSocket = null;
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WhatsApp] Using WA v${version.join('.')}, isLatest: ${isLatest}`);
        
        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: "silent" }),
            browser: Browsers.macOS('Desktop'),
            printQRInTerminal: false
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                console.log('\n[WhatsApp] 🚨 Scan the QR code below with your WhatsApp to link the bot!');
                qrcode.generate(qr, { small: true });
            }
            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[WhatsApp] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                console.log('[WhatsApp] Connected and ready to send messages!');
                waSocket = sock;
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (error) {
        console.error('[WhatsApp] Error initializing Baileys:', error);
    }
}
connectToWhatsApp();

// Initialize Deepgram Client
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// =============================================
// SYSTEM PROMPT (Optimized for DeepSeek R1 1.5B)
// =============================================
const SYSTEM_PROMPT = `You are Aegis, a helpful voice assistant. Keep all replies to 1-2 short sentences.

If the user wants to book a cab, play music, book movies, schedule appointments, or check discharge status, use a tool.

To use a tool, reply with ONLY:
[TOOL_CALL]{"name":"tool_name","args":{...}}[/TOOL_CALL]

Tools: book_cab(destination), play_device_music(song_name), book_movie_tickets(movie_name,theater,tickets), schedule_appointment(doctor_type), check_discharge_status(), log_vitals(heart_rate,blood_pressure,oxygen_level), administer_medication(drug_name,dosage), trigger_trauma_alert(eta_minutes,injury_type), dispatch_medevac(coordinates,auth_code), activate_camera_triage(reason)

If "code red" is said, switch to emergency mode: be ultra-brief and use only medical tools.
Otherwise be friendly and conversational. Never use markdown.`;

// =============================================
// OLLAMA API HELPER
// =============================================
async function queryOllama(messages) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
        const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                messages: messages,
                stream: false,
                options: {
                    temperature: 0.7,
                    num_predict: 512,
                    top_p: 0.9
                }
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`Ollama responded with ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data.message?.content || '';
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            console.error('[Ollama] Request timed out (60s)');
            return 'Sorry, my brain is taking too long. Please try again.';
        }
        throw error;
    }
}

// Strip DeepSeek R1 thinking tags <think>...</think>
function stripThinking(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Parse tool calls from model output
function parseToolCall(text) {
    const match = text.match(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/);
    if (match) {
        try {
            const parsed = JSON.parse(match[1].trim());
            return { name: parsed.name, args: parsed.args || {} };
        } catch (e) {
            console.error('[Ollama] Failed to parse tool call JSON:', e.message);
            return null;
        }
    }
    return null;
}

// =============================================
// WEBSOCKET CONNECTION HANDLER
// =============================================
wss.on('connection', (ws) => {
    console.log('[Client] New React client connected.');

    let dgConnection = null;
    let isDeepgramReady = false;

    // Per-connection conversation history
    const conversationHistory = [
        { role: 'system', content: SYSTEM_PROMPT }
    ];

    // 1. Initialize Cartesia Connection with Auto-Reconnect
    const cartesiaUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${process.env.CARTESIA_API_KEY}&cartesia_version=2024-06-10`;
    let cartesiaWs = null;

    function connectCartesia() {
        cartesiaWs = new WebSocket(cartesiaUrl);

        cartesiaWs.on('open', () => {
            console.log('[Cartesia] WebSocket connection opened.');
        });

        cartesiaWs.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.type === 'chunk') {
                    const audioBuffer = Buffer.from(message.data, 'base64');
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(audioBuffer);
                    }
                } else if (message.type === 'done') {
                    console.log(`[Cartesia] Finished streaming audio for context: ${message.context_id}`);
                } else if (message.type === 'error') {
                    console.error('[Cartesia] Error from API:', message.error);
                }
            } catch (error) {
                console.error('[Cartesia] Error parsing message:', error);
            }
        });

        cartesiaWs.on('error', (error) => {
            console.error('[Cartesia] WebSocket error:', error.message);
        });

        cartesiaWs.on('close', () => {
            console.log('[Cartesia] WebSocket closed. Reconnecting in 2s...');
            if (ws.readyState === WebSocket.OPEN) {
                setTimeout(connectCartesia, 2000);
            }
        });
    }
    connectCartesia();

    // 2. LLM Processing (Ollama / DeepSeek R1)
    let isProcessingLLM = false;

    async function processWithLLM(text) {
        if (isProcessingLLM) {
            console.log(`[Backend] Blocked concurrent request. Dropped: "${text}"`);
            return;
        }
        
        isProcessingLLM = true;
        try {
            const lower = text.toLowerCase();

            // ========== KEYWORD-BASED TOOL DETECTION ==========
            let detectedTool = null;

            // Play music
            if ((lower.includes('play') || lower.includes('song') || lower.includes('music')) && !lower.includes('code red')) {
                let songName = text.replace(/^.*?(play|put on|start|listen to)\s*/i, '').replace(/\s*(on youtube|on spotify|please|for me|in the youtube|in youtube|on my phone|songs?|music).*$/gi, '').trim();
                // If only filler words remain, use the whole phrase after 'play'
                if (!songName || songName.length < 2 || ['a', 'some', 'the', 'my'].includes(songName.toLowerCase())) {
                    songName = text.replace(/^.*?(play|put on|start|listen to)\s*/i, '').replace(/\s*(on youtube|on spotify|in the youtube|in youtube|on my phone)$/gi, '').trim();
                }
                if (!songName || songName.length < 2) songName = 'Arijit Singh top songs';
                detectedTool = { name: 'play_device_music', args: { song_name: songName } };
            }
            // Book cab
            else if (lower.includes('cab') || lower.includes('uber') || lower.includes('ola') || lower.includes('taxi') || lower.includes('ride')) {
                const dest = text.replace(/^.*?(to|for|towards)\s*/i, '').replace(/\s*(please|now|quickly).*$/i, '').trim() || 'Nearest location';
                detectedTool = { name: 'book_cab', args: { destination: dest, cab_type: 'economy' } };
            }
            // Book movie
            else if (lower.includes('movie') || lower.includes('ticket') || lower.includes('cinema') || lower.includes('book my show')) {
                const movie = text.replace(/^.*?(for|of|to see|watch)\s*/i, '').replace(/\s*(please|at|in|ticket).*$/i, '').trim() || 'Latest Movie';
                detectedTool = { name: 'book_movie_tickets', args: { movie_name: movie, theater: 'Nearest Theater', tickets: 2 } };
            }
            // Schedule appointment
            else if (lower.includes('appointment') || lower.includes('schedule') || (lower.includes('doctor') && lower.includes('book'))) {
                const docType = lower.includes('cardio') ? 'Cardiologist' : lower.includes('ortho') ? 'Orthopedic' : 'General Physician';
                detectedTool = { name: 'schedule_appointment', args: { doctor_type: docType, preferred_date: 'Next available' } };
            }
            // Check discharge
            else if (lower.includes('discharge') || lower.includes('billing') || lower.includes('insurance') || lower.includes('pharmacy status')) {
                detectedTool = { name: 'check_discharge_status', args: {} };
            }
            // Code Red / Emergency
            else if (lower.includes('code red') || lower.includes('initiate code red')) {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                const reply = "Code Red activated. I am now in emergency mode. Report the situation.";
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: reply }));
                sendToCartesia(reply);
                return;
            }
            // Log vitals
            else if (lower.includes('vitals') || lower.includes('heart rate') || lower.includes('blood pressure') || lower.includes('oxygen')) {
                detectedTool = { name: 'log_vitals', args: { heart_rate: 82, blood_pressure: '120/80', oxygen_level: 97 } };
            }
            // Trauma alert
            else if (lower.includes('trauma') || lower.includes('accident') || lower.includes('crash')) {
                detectedTool = { name: 'trigger_trauma_alert', args: { eta_minutes: 8, injury_type: 'Road traffic accident' } };
            }
            // Camera triage
            else if (lower.includes('camera') || lower.includes('triage') || lower.includes('see the injury') || lower.includes('wound')) {
                detectedTool = { name: 'activate_camera_triage', args: { reason: 'Visual injury assessment' } };
            }

            // ========== EXECUTE DETECTED TOOL ==========
            if (detectedTool) {
                console.log(`[Intent] Detected tool: "${detectedTool.name}" from keywords`);
                await executeToolAndRespond(detectedTool, text);
                return;
            }

            // ========== NO TOOL — USE OLLAMA FOR CONVERSATION ==========
            conversationHistory.push({ role: 'user', content: text });
            if (conversationHistory.length > 15) {
                const sys = conversationHistory[0];
                conversationHistory.splice(1, conversationHistory.length - 7);
                conversationHistory[0] = sys;
            }

            console.log(`[Ollama] Sending to ${OLLAMA_MODEL}: "${text}"`);
            let rawResponse = await queryOllama(conversationHistory);
            let response = stripThinking(rawResponse);
            console.log(`[Ollama] Response: "${response}"`);

            if (!response || response.trim().length === 0) {
                response = "I'm here! How can I help you? I can play music, book cabs, or check your discharge status.";
            }

            // Check if model accidentally produced a tool call
            const toolCall = parseToolCall(response);
            if (toolCall) {
                await executeToolAndRespond(toolCall, text);
                return;
            }

            conversationHistory.push({ role: 'assistant', content: response });
            
            const lowerReply = response.toLowerCase();
            if (ws.readyState === WebSocket.OPEN) {
                if (lowerReply.includes('code red') || lowerReply.includes('emergency')) {
                    ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                }
                ws.send(JSON.stringify({ type: 'ai_transcript', text: response }));
            }
            sendToCartesia(response);

        } catch (error) {
            console.error('[LLM] Error:', error.message);
            const fallback = "Sorry, I had a connection issue. Please try again.";
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: fallback }));
            sendToCartesia(fallback);
        } finally {
            isProcessingLLM = false;
        }
    }

    // ========== TOOL EXECUTION ENGINE ==========
    async function executeToolAndRespond(toolCall, originalText) {
        const call = toolCall;
        let toolResult = {};

        if (call.name === 'log_vitals') {
            toolResult = { status: "Vitals logged" };
        } else if (call.name === 'administer_medication') {
            toolResult = { status: "Medication administered" };
        } else if (call.name === 'trigger_trauma_alert') {
            toolResult = { status: "Trauma alert sent" };
        } else if (call.name === 'book_movie_tickets') {
            toolResult = { status: "Tickets booked", code: "BMS-" + Math.floor(Math.random() * 90000 + 10000) };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hardware_action', action: 'movie_booked', movie: call.args.movie_name }));
        } else if (call.name === 'play_device_music') {
            toolResult = { status: "Playing now" };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hardware_action', action: 'play_music', song: call.args.song_name }));
        } else if (call.name === 'book_cab') {
            const eta = Math.floor(Math.random() * 8) + 3;
            toolResult = { status: "Cab booked", eta_minutes: eta, destination: call.args.destination };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hardware_action', action: 'cab_booked', eta, destination: call.args.destination }));
        } else if (call.name === 'schedule_appointment') {
            toolResult = { status: "Appointment scheduled", id: 'APT-' + Math.floor(Math.random() * 90000 + 10000) };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hardware_action', action: 'appointment_booked', doctor: call.args.doctor_type, hospital: call.args.hospital || 'Partner Hospital' }));
        } else if (call.name === 'check_discharge_status') {
            const statuses = { billing: { status: 'Cleared', amount: '₹12,450' }, insurance: { status: 'Pending', note: '2 patients ahead' }, pharmacy: { status: 'Ready', note: 'Counter 3' }, lab: { status: 'Cleared', note: 'Reports uploaded' } };
            toolResult = { status: "Retrieved", pipeline: statuses };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'discharge_update', statuses }));
        } else if (call.name === 'dispatch_medevac') {
            toolResult = { status: "Medevac dispatched" };
        } else if (call.name === 'activate_camera_triage') {
            toolResult = { status: "Camera activated" };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'activate_camera', reason: call.args.reason }));
        }

        // Mode switch
        const emergencyTools = ['log_vitals', 'administer_medication', 'trigger_trauma_alert', 'dispatch_medevac', 'activate_camera_triage'];
        const civilianTools = ['book_movie_tickets', 'play_device_music', 'book_cab', 'schedule_appointment', 'check_discharge_status'];
        if (ws.readyState === WebSocket.OPEN) {
            if (emergencyTools.includes(call.name)) ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
            else if (civilianTools.includes(call.name)) ws.send(JSON.stringify({ type: 'mode_switch', mode: 'civilian' }));
        }

        // Action log
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'action_log', tool: call.name, details: JSON.stringify(call.args) }));

        // WhatsApp log
        if (waSocket && process.env.WHATSAPP_TARGET_NUMBER) {
            const jid = `${process.env.WHATSAPP_TARGET_NUMBER}@s.whatsapp.net`;
            const t = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
            const msg = `🛡️ *AEGIS LOG*\n_${t}_\n\n⚡ Tool: ${call.name}\n📋 Args: ${JSON.stringify(call.args)}\n✅ Result: ${toolResult.status}`;
            try { await waSocket.sendMessage(jid, { text: msg }); } catch(e) { console.error('[WA] Error:', e.message); }
        }

        // Voice confirmation
        const confirmations = {
            play_device_music: `Playing ${call.args.song_name} for you now!`,
            book_cab: `Your cab to ${call.args.destination} is booked! It will arrive in about ${toolResult.eta_minutes} minutes.`,
            book_movie_tickets: `Done! Booked ${call.args.tickets || 2} tickets for ${call.args.movie_name}. Opening BookMyShow now.`,
            schedule_appointment: `Your ${call.args.doctor_type} appointment has been scheduled. Opening your calendar now.`,
            check_discharge_status: `Here's your discharge status. Billing is cleared, insurance is still pending, pharmacy is ready at counter 3, and lab reports are cleared.`,
            log_vitals: `Vitals logged. Heart rate ${call.args.heart_rate} BPM, BP ${call.args.blood_pressure}, oxygen ${call.args.oxygen_level} percent.`,
            trigger_trauma_alert: `Trauma alert sent. ETA ${call.args.eta_minutes} minutes for ${call.args.injury_type}.`,
            activate_camera_triage: `Camera triage activated. Point your camera at the injury.`,
            dispatch_medevac: `Medevac dispatched to ${call.args.coordinates}.`,
            administer_medication: `${call.args.drug_name} ${call.args.dosage} administered and logged.`
        };

        const voiceReply = confirmations[call.name] || `Done. ${call.name} completed successfully.`;
        console.log(`[Voice] Confirming: "${voiceReply}"`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: voiceReply }));
        sendToCartesia(voiceReply);
    }

    function sendToCartesia(text) {
        if (cartesiaWs.readyState === WebSocket.OPEN) {
            console.log(`[Cartesia] Sending text for TTS: "${text}"`);
            const request = {
                model_id: "sonic-english",
                transcript: text,
                voice: {
                    mode: "id",
                    id: process.env.CARTESIA_VOICE_ID
                },
                output_format: {
                    container: "raw",
                    encoding: "pcm_s16le",
                    sample_rate: 16000
                },
                context_id: `msg-${Date.now()}`
            };
            cartesiaWs.send(JSON.stringify(request));
        } else {
            console.error('[Cartesia] WebSocket is not open to send text.');
        }
    }

    // 3. Initialize Deepgram Connection
    try {
        dgConnection = deepgram.listen.live({
            model: 'nova-2',
            language: 'en',
            smart_format: true,
            interim_results: true
        });

        dgConnection.on('open', () => {
            console.log('[Deepgram] WebSocket connection opened.');
            isDeepgramReady = true;
        });

        dgConnection.on('Results', async (data) => {
            const transcript = data.channel?.alternatives[0]?.transcript;
            
            if (transcript && transcript.trim().length > 0) {
                if (data.is_final) {
                    // OPTIMIZATION: Ignore single character noise
                    if (transcript.trim().length < 2) return;
                    
                    console.log(`[Deepgram] Final Transcript: "${transcript}"`);
                    await processWithLLM(transcript);
                } else {
                    // Interim result - User is currently speaking (barge-in)
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "clear_buffer" }));
                    }
                }
            }
        });

        dgConnection.on('error', (error) => {
            console.error('[Deepgram] Error:', error);
        });

        dgConnection.on('close', () => {
            console.log('[Deepgram] WebSocket connection closed.');
            isDeepgramReady = false;
        });
    } catch (err) {
        console.error('[Deepgram] Initialization failed:', err);
    }

    // 4. Handle incoming messages from React Client
    ws.on('message', (message) => {
        if (Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
            console.log(`[Client -> Deepgram] Streaming audio chunk: ${message.byteLength} bytes`);
            if (dgConnection && isDeepgramReady) {
                dgConnection.send(message);
            }
        } else {
            console.log('[Client] Received non-binary message:', message.toString());
        }
    });

    ws.on('close', () => {
        console.log('[Client] Connection closed by client. Cleaning up...');
        if (dgConnection) {
            dgConnection.requestClose ? dgConnection.requestClose() : dgConnection.finish && dgConnection.finish();
        }
        if (cartesiaWs.readyState === WebSocket.OPEN) {
            cartesiaWs.close();
        }
    });

    ws.on('error', (error) => {
        console.error('[Client] WebSocket error:', error);
    });
});

const PORT = process.env.PORT || 8081;
server.listen(8081, () => {
    console.log(`[Server] WebSocket server is listening on port 8081`);
});
