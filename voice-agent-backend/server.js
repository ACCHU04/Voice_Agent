require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

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

// Initialize Deepgram Client
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Define the tool for Gemini
const tools = [{
    functionDeclarations: [{
        name: 'check_patient_vitals',
        description: 'Get the vitals of a patient by ID',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                patient_id: {
                    type: SchemaType.STRING,
                    description: 'The unique identifier for the patient',
                },
            },
            required: ['patient_id'],
        },
    }]
}];

const generativeModel = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
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

    async function processWithLLM(text) {
        try {
            console.log(`[Gemini] Sending user message: "${text}"`);
            let result = await chatSession.sendMessage(text);
            
            const functionCalls = result.response.functionCalls();

            if (functionCalls && functionCalls.length > 0) {
                const call = functionCalls[0];
                if (call.name === 'check_patient_vitals') {
                    const args = call.args;
                    console.log(`[Gemini] Called tool "check_patient_vitals" with args:`, args);

                    // Execute dummy function
                    const toolResult = { heart_rate: 72, blood_pressure: "120/80" };
                    console.log(`[Gemini] Returning dummy tool result:`, toolResult);

                    console.log(`[Gemini] Sending tool result back to model...`);
                    result = await chatSession.sendMessage([{
                        functionResponse: {
                            name: call.name,
                            response: toolResult
                        }
                    }]);
                }
            }

            const finalReply = result.response.text();
            console.log(`[Gemini] Final response: "${finalReply}"`);

            if (finalReply && finalReply.trim().length > 0) {
                sendToCartesia(finalReply);
            }

        } catch (error) {
            console.error('[Gemini] Error during LLM processing:', error);
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
            interim_results: false
        });

        dgConnection.on('open', () => {
            console.log('[Deepgram] WebSocket connection opened.');
            isDeepgramReady = true;
        });

        dgConnection.on('Results', async (data) => {
            const transcript = data.channel?.alternatives[0]?.transcript;
            
            if (transcript && data.is_final) {
                console.log(`[Deepgram] Final Transcript: "${transcript}"`);
                await processWithLLM(transcript);
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

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`[Server] WebSocket server is listening on port ${PORT}`);
});
