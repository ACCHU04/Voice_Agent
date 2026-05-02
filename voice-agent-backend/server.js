require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// Ensure all environment variables are present
const requiredEnvVars = [
    'DEEPGRAM_API_KEY',
    'CARTESIA_API_KEY',
    'CARTESIA_VOICE_ID',
    'GEMINI_API_KEY'
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
                    setTimeout(connectToWhatsApp, 5000); // Increased wait time to 5s
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

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tools = [{
    functionDeclarations: [
        {
            name: 'log_vitals',
            description: 'Log patient vitals like heart rate, blood pressure, and oxygen level',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    heart_rate: { type: SchemaType.NUMBER, description: 'Heart rate in BPM' },
                    blood_pressure: { type: SchemaType.STRING, description: 'Blood pressure e.g., 120/80' },
                    oxygen_level: { type: SchemaType.NUMBER, description: 'SpO2 percentage' }
                },
                required: [],
            },
        },
        {
            name: 'administer_medication',
            description: 'Log a medication being administered',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    drug_name: { type: SchemaType.STRING, description: 'Name of the drug (e.g. Paracetamol, Adrenaline)' },
                    dosage: { type: SchemaType.STRING, description: 'Dosage (e.g. 500mg, 1 ampoule)' }
                },
                required: ['drug_name', 'dosage'],
            },
        },
        {
            name: 'trigger_trauma_alert',
            description: 'Trigger a trauma alert for the casualty ward with ETA and injury type',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    eta_minutes: { type: SchemaType.NUMBER, description: 'Estimated time of arrival in minutes' },
                    injury_type: { type: SchemaType.STRING, description: 'Type of injury (e.g. road traffic accident, blunt trauma)' }
                },
                required: ['eta_minutes', 'injury_type'],
            },
        },
        // --- Civilian / Consumer Tools ---
        {
            name: 'book_movie_tickets',
            description: 'Books movie tickets for the user.',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    movie_name: { type: SchemaType.STRING, description: 'Name of the movie' },
                    theater: { type: SchemaType.STRING, description: 'Name of the cinema or theater' },
                    tickets: { type: SchemaType.NUMBER, description: 'Number of tickets' }
                },
                required: ['movie_name', 'theater', 'tickets'],
            },
        },
        {
            name: 'play_device_music',
            description: 'Plays a requested song on the user\'s device.',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    song_name: { type: SchemaType.STRING, description: 'Name of the song or artist to play' }
                },
                required: ['song_name'],
            },
        },
        {
            name: 'book_cab',
            description: 'Books a cab (Uber/Ola) for the user to a destination.',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    destination: { type: SchemaType.STRING, description: 'Where the user wants to go (e.g., HSR Layout, Koramangala)' },
                    cab_type: { type: SchemaType.STRING, description: 'Type of cab: economy, premium, or auto' }
                },
                required: ['destination'],
            },
        },
        {
            name: 'schedule_appointment',
            description: 'Schedules a follow-up doctor appointment or hospital visit.',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    doctor_type: { type: SchemaType.STRING, description: 'Specialty like Cardiologist, General Physician, Orthopedic' },
                    preferred_date: { type: SchemaType.STRING, description: 'Preferred date like Monday, Tomorrow, Next Week' },
                    hospital: { type: SchemaType.STRING, description: 'Hospital name if specified' }
                },
                required: ['doctor_type'],
            },
        },
        {
            name: 'check_discharge_status',
            description: 'Checks the current status of a patient\'s hospital discharge process including billing, insurance clearance, pharmacy, and lab reports.',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    patient_id: { type: SchemaType.STRING, description: 'Patient ID or name' },
                    check_type: { type: SchemaType.STRING, description: 'What to check: billing, insurance, pharmacy, lab, or all' }
                },
                required: [],
            },
        },
        {
            name: 'dispatch_medevac',
            description: 'Dispatches an emergency medical evacuation helicopter to specified coordinates. Requires authorization code.',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    coordinates: { type: SchemaType.STRING, description: 'Target coordinates or location name (e.g., Alpha-6, Sector 4)' },
                    auth_code: { type: SchemaType.STRING, description: 'Authorization code for dispatch (e.g., Sigma-Niner)' }
                },
                required: ['coordinates', 'auth_code'],
            },
        },
        {
            name: 'activate_camera_triage',
            description: 'Activates the phone camera to visually assess an injury for triage. Use when user describes an injury or wound that needs visual inspection.',
            parameters: {
                type: SchemaType.OBJECT,
                properties: {
                    reason: { type: SchemaType.STRING, description: 'Reason for visual triage (e.g., deep cut, burn, swelling)' }
                },
                required: ['reason'],
            },
        }
    ]
}];

const SYSTEM_PROMPT = `You are Aegis, an advanced dual-state voice-first guardian agent built for high-stress and everyday scenarios.

STATE 1: CIVILIAN MODE (Default)
You are a warm, efficient personal assistant and Smart Concierge. You help with:
- Booking movie tickets, cabs (Uber/Ola), and scheduling doctor appointments
- Playing music on the user's device
- Checking hospital discharge status (billing, insurance, pharmacy, lab reports)
- General conversation and questions
Speak naturally and conversationally. Be proactive - if someone books a cab, ask if they need anything else.

STATE 2: CODE RED (Emergency Override)
If the user says 'Initiate Code Red' or describes a medical emergency, INSTANTLY drop the friendly persona.
Become a military-grade, zero-latency medical orchestrator:
- Speak in ultra-concise sentences (max 10 words)
- Confirm every action immediately
- Log vitals, administer medication, trigger trauma alerts
- Ask for 'Authorization Code' before dispatching Medevac
- If you detect the user is injured and struggling to describe it, suggest activating camera triage: "I can see the injury through your camera. Permission to activate visual triage?"

SMART CONCIERGE (Hospital Discharge Context)
When a patient asks about their discharge:
1. Check billing, insurance, pharmacy, and lab status
2. Proactively inform them of bottlenecks (e.g., "Insurance clearance is pending")
3. Offer to book their ride home once cleared
4. Send updates to family via WhatsApp

VISUAL TRIAGE PROTOCOL
When activate_camera_triage is called:
- The phone camera will capture the injury
- You will receive the image for analysis
- Provide IMMEDIATE first-aid instructions based on what you see
- Classify severity: Minor, Moderate, Severe, Critical

RULES:
- Never use emergency tools in Civilian state
- Never use consumer tools in Code Red state
- If interrupted, immediately listen to the new command
- Always be brief in emergency mode, conversational in civilian mode`;

const generativeModel = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT,
    tools: tools,
});

wss.on('connection', (ws) => {
    console.log('[Client] New React client connected.');

    let dgConnection = null;
    let isDeepgramReady = false;

    // 1. Initialize Cartesia Connection First (so it's ready to receive)
    const cartesiaUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${process.env.CARTESIA_API_KEY}&cartesia_version=2024-06-10`;
    const cartesiaWs = new WebSocket(cartesiaUrl);

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
        console.error('[Cartesia] WebSocket error:', error);
    });

    cartesiaWs.on('close', () => {
        console.log('[Cartesia] WebSocket connection closed.');
    });

    // 2. Initialize Gemini Chat Session
    const chatSession = generativeModel.startChat();
    let isProcessingLLM = false;

    async function processWithLLM(text) {
        if (isProcessingLLM) {
            console.log(`[Backend] Blocked concurrent LLM request to save API limits. Dropped: "${text}"`);
            return;
        }
        
        isProcessingLLM = true;
        try {
            console.log(`[Gemini] Sending user message: "${text}"`);
            let result = await chatSession.sendMessage(text);
            
            const functionCalls = result.response.functionCalls();

            if (functionCalls && functionCalls.length > 0) {
                const functionResponses = [];
                for (const call of functionCalls) {
                    console.log(`[Gemini] Called tool "${call.name}" with args:`, call.args);
                    
                    let toolResult = {};
                    if (call.name === 'log_vitals') {
                        toolResult = { status: "Vitals logged successfully" };
                    } else if (call.name === 'administer_medication') {
                        toolResult = { status: "Medication administered and logged" };
                    } else if (call.name === 'trigger_trauma_alert') {
                        toolResult = { status: "Trauma alert sent to casualty ward" };
                    } else if (call.name === 'book_movie_tickets') {
                        toolResult = { status: "Tickets booked successfully", confirmation_code: "BMS-" + Math.floor(Math.random() * 90000 + 10000) };
                    } else if (call.name === 'play_device_music') {
                        toolResult = { status: "Music playback initiated on device hardware" };
                        // Send hardware action to React UI
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'hardware_action',
                                action: 'play_music',
                                song: call.args.song_name
                            }));
                        }
                    } else if (call.name === 'book_cab') {
                        const eta = Math.floor(Math.random() * 8) + 3;
                        toolResult = { status: "Cab booked successfully", provider: "Uber", eta_minutes: eta, destination: call.args.destination, cab_type: call.args.cab_type || 'economy' };
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'hardware_action', action: 'cab_booked', eta: eta, destination: call.args.destination }));
                        }
                    } else if (call.name === 'schedule_appointment') {
                        const apptId = 'APT-' + Math.floor(Math.random() * 90000 + 10000);
                        toolResult = { status: "Appointment scheduled", appointment_id: apptId, doctor: call.args.doctor_type, date: call.args.preferred_date || 'Next available slot', hospital: call.args.hospital || 'Nearest partner hospital' };
                    } else if (call.name === 'check_discharge_status') {
                        // Simulate realistic discharge pipeline
                        const statuses = {
                            billing: { status: 'Cleared', amount: '₹12,450' },
                            insurance: { status: 'Pending', note: 'Awaiting TPA approval. 2 patients ahead.' },
                            pharmacy: { status: 'Ready', note: 'Prescriptions packed at Counter 3' },
                            lab: { status: 'Cleared', note: 'All reports uploaded to patient portal' }
                        };
                        toolResult = { status: "Discharge status retrieved", pipeline: statuses };
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'discharge_update', statuses: statuses }));
                        }
                    } else if (call.name === 'dispatch_medevac') {
                        const authCode = (call.args.auth_code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (authCode === 'sigmaniner' || authCode === 'sigma9' || authCode === 'sigmanine') {
                            toolResult = { status: "Medevac dispatched", destination: call.args.coordinates, authorization: "VERIFIED" };
                            console.log(`[MEDEVAC] 🚁 DISPATCHED to ${call.args.coordinates} - Auth: VERIFIED`);
                        } else {
                            toolResult = { status: "ACCESS DENIED", reason: "Invalid authorization code" };
                            console.log(`[MEDEVAC] ❌ ACCESS DENIED - Invalid auth code: ${call.args.auth_code}`);
                        }
                    } else if (call.name === 'activate_camera_triage') {
                        toolResult = { status: "Camera triage activated on user device", reason: call.args.reason };
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'activate_camera', reason: call.args.reason }));
                        }
                    } else {
                        toolResult = { status: "Unknown tool called" };
                    }

                    console.log(`[Gemini] Returning tool result:`, toolResult);

                    // Detect mode and send mode_switch to frontend
                    const emergencyTools = ['log_vitals', 'administer_medication', 'trigger_trauma_alert', 'dispatch_medevac', 'activate_camera_triage'];
                    const civilianTools = ['book_movie_tickets', 'play_device_music', 'book_cab', 'schedule_appointment', 'check_discharge_status'];
                    if (ws.readyState === WebSocket.OPEN) {
                        if (emergencyTools.includes(call.name)) {
                            ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                        } else if (civilianTools.includes(call.name)) {
                            ws.send(JSON.stringify({ type: 'mode_switch', mode: 'civilian' }));
                        }
                    }
                    
                    // Send real-time action log to the React Frontend
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'action_log',
                            tool: call.name,
                            details: JSON.stringify(call.args)
                        }));
                    }

                    // Send to WhatsApp via Baileys (Structured Format)
                    if (waSocket && process.env.WHATSAPP_TARGET_NUMBER) {
                        const targetJid = `${process.env.WHATSAPP_TARGET_NUMBER}@s.whatsapp.net`;
                        const timestamp = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
                        
                        let formattedDetails = '';
                        let header = '🚨 *AEGIS PROTOCOL ACTIVATED* 🚨';
                        
                        if (call.name === 'log_vitals') {
                            formattedDetails = `🩺 *Vitals Update*\n`;
                            if (call.args.heart_rate) formattedDetails += `❤️ Heart Rate: ${call.args.heart_rate} BPM\n`;
                            if (call.args.blood_pressure) formattedDetails += `🩸 BP: ${call.args.blood_pressure}\n`;
                            if (call.args.oxygen_level) formattedDetails += `🫁 SpO2: ${call.args.oxygen_level}%\n`;
                        } else if (call.name === 'administer_medication') {
                            formattedDetails = `💊 *Medication Administered*\n💉 Drug: ${call.args.drug_name}\n⚖️ Dosage: ${call.args.dosage}`;
                        } else if (call.name === 'trigger_trauma_alert') {
                            formattedDetails = `🚑 *TRAUMA ALERT TRIGGERED*\n⏱️ ETA: ${call.args.eta_minutes} mins\n⚠️ Injury: ${call.args.injury_type}`;
                        } else if (call.name === 'book_movie_tickets') {
                            header = '🎟️ *AEGIS CIVILIAN ASSISTANT* 🎟️';
                            formattedDetails = `🎬 *Movie Tickets Confirmed*\n🍿 Movie: ${call.args.movie_name}\n📍 Theater: ${call.args.theater}\n🎟️ Tickets: ${call.args.tickets}`;
                        } else if (call.name === 'play_device_music') {
                            header = '🎵 *AEGIS CIVILIAN ASSISTANT* 🎵';
                            formattedDetails = `🎧 *Playing Music*\n🎶 Track: ${call.args.song_name}`;
                        } else if (call.name === 'book_cab') {
                            header = '🚕 *AEGIS CIVILIAN ASSISTANT* 🚕';
                            formattedDetails = `🚗 *Cab Booked*\n📍 To: ${call.args.destination}\n🚘 Type: ${call.args.cab_type || 'Economy'}\n⏱️ ETA: ${toolResult.eta_minutes} mins`;
                        } else if (call.name === 'schedule_appointment') {
                            header = '🏥 *AEGIS CIVILIAN ASSISTANT* 🏥';
                            formattedDetails = `📋 *Appointment Scheduled*\n👨‍⚕️ Doctor: ${call.args.doctor_type}\n📅 Date: ${call.args.preferred_date || 'Next available'}\n🏥 Hospital: ${call.args.hospital || 'Partner hospital'}`;
                        } else if (call.name === 'check_discharge_status') {
                            header = '🏥 *AEGIS DISCHARGE UPDATE* 🏥';
                            formattedDetails = `📊 *Discharge Pipeline*\n💰 Billing: Cleared (₹12,450)\n🛡️ Insurance: Pending TPA\n💊 Pharmacy: Ready at Counter 3\n🔬 Lab: All reports cleared`;
                        } else if (call.name === 'dispatch_medevac') {
                            formattedDetails = `🚁 *MEDEVAC DISPATCHED*\n📍 Target: ${call.args.coordinates}\n🔐 Auth: ${call.args.auth_code}\n✅ Status: AIRBORNE`;
                        } else if (call.name === 'activate_camera_triage') {
                            formattedDetails = `📸 *VISUAL TRIAGE ACTIVATED*\n🔍 Reason: ${call.args.reason}\n📱 Camera feed active on patient device`;
                        }

                        const textMsg = `${header}\n_Time: ${timestamp}_\n\n${formattedDetails}\n\n_Status: System Logging Active_`;
                        
                        try {
                            await waSocket.sendMessage(targetJid, { text: textMsg });
                            console.log(`[WhatsApp] Sent formatted medical log to ${process.env.WHATSAPP_TARGET_NUMBER}`);
                        } catch (err) {
                            console.error('[WhatsApp] Failed to send message:', err);
                        }
                    }

                    functionResponses.push({
                        functionResponse: {
                            name: call.name,
                            response: toolResult
                        }
                    });
                }

                console.log(`[Gemini] Sending tool results back to model...`);
                result = await chatSession.sendMessage(functionResponses);
            }

            const finalReply = result.response.text();
            console.log(`[Gemini] Final response: "${finalReply}"`);

            if (finalReply && finalReply.trim().length > 0) {
                // Detect mode from AI's spoken response text
                const lowerReply = finalReply.toLowerCase();
                if (ws.readyState === WebSocket.OPEN) {
                    if (lowerReply.includes('code red') || lowerReply.includes('emergency') || lowerReply.includes('trauma')) {
                        ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                        console.log('[Mode] Switched to EMERGENCY based on AI response text.');
                    } else if (lowerReply.includes('civilian') || lowerReply.includes('stand down') || lowerReply.includes('normal mode')) {
                        ws.send(JSON.stringify({ type: 'mode_switch', mode: 'civilian' }));
                        console.log('[Mode] Switched to CIVILIAN based on AI response text.');
                    }
                    // Send transcript to frontend for display
                    ws.send(JSON.stringify({ type: 'ai_transcript', text: finalReply }));
                }
                sendToCartesia(finalReply);
            }

        } catch (error) {
            console.error('[Gemini] Error during LLM processing:', error);
        } finally {
            isProcessingLLM = false;
        }
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
                    // OPTIMIZATION: Ignore very short background noises to save API limits
                    if (transcript.trim().length < 5) return;
                    
                    console.log(`[Deepgram] Final Transcript: "${transcript}"`);
                    await processWithLLM(transcript);
                } else {
                    // Interim result - User is currently speaking (barge-in)
                    // Instantly send clear_buffer to the frontend to stop AI audio playback
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
