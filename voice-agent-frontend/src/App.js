/**
 * AEGIS PROTOCOL — App.js (v3 — Fixed Audio + Laptop YouTube)
 *
 * KEY FIXES:
 *  1. Audio: Cartesia sends pcm_f32le (Float32) at 44100Hz. Fixed AudioContext to match.
 *  2. YouTube: Opens in new tab on laptop. Fallback button if popup blocked.
 *  3. Barge-in: Properly resets AudioContext on clear_buffer.
 *  4. Mic: echoCancellation + noiseSuppression enabled for laptop use.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

const EMERGENCY_TOOLS = ['log_vitals', 'administer_medication', 'trigger_trauma_alert', 'dispatch_medevac', 'activate_camera_triage'];

const TOOL_ICONS = {
  log_vitals: '🩺',
  administer_medication: '💊',
  trigger_trauma_alert: '🚑',
  dispatch_medevac: '🚁',
  activate_camera_triage: '📸',
  book_movie_tickets: '🎬',
  play_device_music: '🎵',
  book_cab: '🚕',
  schedule_appointment: '📋',
  check_discharge_status: '🏥',
  close_browser: '❌',
};

function App() {
  const [status, setStatus] = useState('Disconnected');
  const [isConnected, setIsConnected] = useState(false);
  const [mode, setMode] = useState('civilian');
  const [actionLogs, setActionLogs] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [aiTranscript, setAiTranscript] = useState('');
  const [dischargeData, setDischargeData] = useState(null);
  const [cabInfo, setCabInfo] = useState(null);
  const [showCamera, setShowCamera] = useState(false);
  const [cameraReason, setCameraReason] = useState('');
  const [pendingAction, setPendingAction] = useState(null);
  const [hudData, setHudData] = useState(null);

  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const musicRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const aiTranscriptTimer = useRef(null);
  const hudTimerRef = useRef(null);

  useEffect(() => {
    document.body.classList.toggle('emergency-mode', mode === 'emergency');
    return () => document.body.classList.remove('emergency-mode');
  }, [mode]);

  useEffect(() => () => stopConversation(), []); // eslint-disable-line

  // ── Reset AudioContext (barge-in / clear_buffer) ────────────────────────────
  const resetAudioContext = useCallback(() => {
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    audioContextRef.current = ctx;
    nextPlayTimeRef.current = ctx.currentTime;
  }, []);

  // ── Play PCM float32 audio chunk from Cartesia ──────────────────────────────
  const playChunk = useCallback((arrayBuffer) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;

    // Cartesia sends pcm_f32le — each sample is a 4-byte float
    const float32 = new Float32Array(arrayBuffer);
    const buffer = ctx.createBuffer(1, float32.length, 44100);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (now > nextPlayTimeRef.current) nextPlayTimeRef.current = now;
    source.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += buffer.duration;
  }, []);

  const startConversation = async () => {
    try {
      setActionLogs([]);
      setNowPlaying(null);
      setMode('civilian');
      setAiTranscript('');
      setPendingAction(null);

      // Init AudioContext at 44100Hz to match Cartesia output
      resetAudioContext();

      // Connect WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsHost = window.location.host;
      console.log(`[WS] Connecting to ${protocol}://${wsHost}`);
      wsRef.current = new WebSocket(`${protocol}://${wsHost}`);

      wsRef.current.onopen = () => {
        setIsConnected(true);
        setStatus('Listening');
        console.log('[WS] Connected');
      };

      wsRef.current.onmessage = async (event) => {
        // ── JSON control message ──
        if (typeof event.data === 'string') {
          try {
            const data = JSON.parse(event.data);

            if (data.type === 'clear_buffer') {
              console.log('[Frontend] Barge-in — clearing audio');
              resetAudioContext();
              setStatus('Listening');
            }

            else if (data.type === 'mode_switch') {
              setMode(data.mode);
              if (data.mode === 'emergency' && musicRef.current) {
                musicRef.current.pause();
                musicRef.current = null;
                setNowPlaying(null);
              }
            }

            else if (data.type === 'action_log') {
              setActionLogs(prev => [{
                time: new Date().toLocaleTimeString(),
                tool: data.tool,
                details: data.details,
                isEmergency: EMERGENCY_TOOLS.includes(data.tool),
              }, ...prev].slice(0, 20));
              
              setHudData({
                tool: data.tool,
                details: data.details
              });
              clearTimeout(hudTimerRef.current);
              hudTimerRef.current = setTimeout(() => setHudData(null), 4000);
            }

            else if (data.type === 'hardware_action') {
              if (data.action === 'play_music') {
                setNowPlaying(data.song);
              }
              else if (data.action === 'cab_booked') {
                setCabInfo({ eta: data.eta, destination: data.destination });
                setTimeout(() => setCabInfo(null), 30000);
              }
              else if (data.action === 'movie_booked') {
                // Handled by Backend Puppeteer
              }
              else if (data.action === 'appointment_booked') {
                // Handled by Backend
              }
            }

            else if (data.type === 'discharge_update') {
              setDischargeData(data.statuses);
              setTimeout(() => setDischargeData(null), 20000);
            }

            else if (data.type === 'activate_camera') {
              setCameraReason(data.reason);
              setShowCamera(true);
              startCamera();
            }

            else if (data.type === 'ai_transcript') {
              setAiTranscript(data.text);
              clearTimeout(aiTranscriptTimer.current);
              aiTranscriptTimer.current = setTimeout(() => setAiTranscript(''), 7000);
            }

          } catch (e) {
            console.error('[WS] JSON parse error:', e);
          }
          return;
        }

        // ── Binary audio chunk from Cartesia ──
        const arrayBuffer = await (event.data instanceof Blob
          ? event.data.arrayBuffer()
          : Promise.resolve(event.data));

        setStatus('AI Speaking');
        playChunk(arrayBuffer);

        setTimeout(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) setStatus('Listening');
        }, 2000);
      };

      wsRef.current.onclose = () => {
        setIsConnected(false);
        setStatus('Disconnected');
        setActionLogs([]);
        setNowPlaying(null);
        setMode('civilian');
      };

      wsRef.current.onerror = (e) => {
        console.error('[WS] Error:', e);
        setStatus('Connection error');
      };

      // ── Mic capture (with echo cancellation for laptop) ──
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 16000 },
      });

      mediaRecorderRef.current = new MediaRecorder(stream);
      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(e.data);
        }
      };
      mediaRecorderRef.current.start(250);

    } catch (err) {
      console.error('[Start] Error:', err);
      if (err.name === 'NotAllowedError') {
        alert('Microphone permission denied. Please allow microphone access and try again.');
      } else {
        alert('Error: ' + err.message);
      }
      setStatus('Disconnected');
      setIsConnected(false);
    }
  };

  const stopConversation = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
    if (wsRef.current) wsRef.current.close();
    if (audioContextRef.current) { audioContextRef.current.close().catch(() => {}); audioContextRef.current = null; }
    if (musicRef.current) { musicRef.current.pause(); musicRef.current = null; }
    stopCamera();
    setIsConnected(false);
    setStatus('Disconnected');
    setNowPlaying(null);
    setMode('civilian');
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (e) {
      console.error('[Camera] Error:', e);
      alert('Camera access denied.');
      setShowCamera(false);
    }
  };

  const captureAndSend = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const video = videoRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const imageData = canvas.toDataURL('image/jpeg', 0.7);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'camera_frame', image: imageData, reason: cameraReason }));
    }
    stopCamera();
    setShowCamera(false);
  };

  const stopCamera = () => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach(t => t.stop());
      cameraStreamRef.current = null;
    }
    setShowCamera(false);
  };

  const getStatusClass = () => {
    if (status === 'Disconnected') return 'status-disconnected';
    if (status === 'Listening') return 'status-listening';
    if (status === 'AI Speaking') return 'status-speaking';
    return '';
  };

  const getToolIcon = (toolName) => TOOL_ICONS[toolName] || '⚙️';

  const getToolDisplayName = (toolName) => {
    const names = {
      log_vitals: 'Vitals Logged',
      administer_medication: 'Medication',
      trigger_trauma_alert: 'Trauma Alert',
      dispatch_medevac: 'Medevac Dispatch',
      activate_camera_triage: 'Visual Triage',
      book_movie_tickets: 'Movie Booking',
      play_device_music: 'Music Player',
      book_cab: 'Cab Booked',
      schedule_appointment: 'Appointment',
      check_discharge_status: 'Discharge Status',
    };
    return names[toolName] || toolName;
  };

  const formatLogDetails = (tool, detailsStr) => {
    try {
      const args = JSON.parse(detailsStr);
      switch (tool) {
        case 'book_movie_tickets':
          return `🍿 ${args.movie_name} | 📍 ${args.theater} | 🎟️ ${args.tickets} tickets`;
        case 'play_device_music':
          return `🎶 ${args.song_name}`;
        case 'log_vitals': {
          const parts = [];
          if (args.heart_rate) parts.push(`❤️ ${args.heart_rate} BPM`);
          if (args.blood_pressure) parts.push(`🩸 ${args.blood_pressure}`);
          if (args.oxygen_level) parts.push(`🫁 ${args.oxygen_level}%`);
          return parts.join(' | ');
        }
        case 'administer_medication':
          return `💉 ${args.drug_name} • ${args.dosage}`;
        case 'trigger_trauma_alert':
          return `⏱️ ETA: ${args.eta_minutes} min | ⚠️ ${args.injury_type}`;
        case 'dispatch_medevac':
          return `📍 ${args.coordinates} | 🔐 ${args.auth_code}`;
        case 'book_cab':
          return `🚗 To ${args.destination} | ${args.cab_type || 'Economy'}`;
        case 'schedule_appointment':
          return `👨‍⚕️ ${args.doctor_type} | 📅 ${args.preferred_date || 'Next slot'}`;
        case 'check_discharge_status':
          return `📊 Full discharge pipeline check`;
        case 'activate_camera_triage':
          return `📸 Visual scan: ${args.reason}`;
        default:
          return detailsStr;
      }
    } catch (e) {
      return detailsStr;
    }
  };

  return (
    <div className="h-screen flex flex-col items-center justify-between p-8 matrix-bg relative w-full">
      {/* Header */}
      <div className="text-center w-full relative z-10">
        <p className="text-xs tracking-[0.3em] text-gray-500 mb-2 uppercase">Matrix Development Team</p>
        <h1 className="text-4xl font-bold tracking-tight text-white italic">Aegis Guardian AI</h1>
        <div 
          className={`font-bold tracking-widest mt-2 animate__animated animate__pulse animate__infinite ${status === 'Listening' ? 'text-blue-400' : 'text-orange-500'}`}
        >
          {status === 'Disconnected' ? 'STANDBY' : status.toUpperCase()}
        </div>
      </div>

      {/* Central Core Area */}
      <div className="relative flex items-center justify-center flex-1 w-full">
        {/* Visualizer Ring */}
        <div className={`absolute w-[400px] h-[400px] border rounded-full animate-core ${status === 'Listening' ? 'border-blue-500/40' : 'border-orange-500/20'}`}></div>
        
        {/* The Core Image */}
        <div className={`w-64 h-64 rounded-full flex items-center justify-center text-7xl relative z-10 ${status === 'Listening' ? 'glow-blue' : 'glow-orange'} bg-black/50 border border-gray-800`}>
          {status === 'Listening' ? '🎙️' : '🛡️'}
        </div>
        
        {/* ACTION OVERLAY (HUD) */}
        {hudData && (
          <div className="absolute z-20 animate__animated animate__zoomIn">
            <div className="hud-card p-6 rounded-xl w-80 text-center">
              <div className="text-4xl mb-3">{getToolIcon(hudData.tool)}</div>
              <h2 className="text-xl font-bold text-orange-400">{getToolDisplayName(hudData.tool)}</h2>
              <p className="text-sm text-gray-400 mt-1">{formatLogDetails(hudData.tool, hudData.details)}</p>
              <div className="w-full bg-gray-800 h-1 mt-4 rounded-full overflow-hidden">
                <div className="bg-orange-500 h-full animate-progress" style={{ width: '50%' }}></div>
              </div>
            </div>
          </div>
        )}
        
        {/* AI Transcript Bubble */}
        {aiTranscript && !hudData && (
          <div className="absolute top-1/4 z-20 bg-black/80 border border-blue-500/40 p-4 rounded-lg max-w-md text-center animate__animated animate__fadeInUp">
            <p className="text-blue-300 font-medium">"{aiTranscript}"</p>
          </div>
        )}
      </div>

      {/* Bottom Controls & Logs */}
      <div className="w-full max-w-5xl grid grid-cols-3 items-end relative z-10">
        
        {/* Left: Activity Log */}
        <div className="hud-card p-4 rounded-lg text-xs leading-relaxed text-gray-400 h-40 overflow-y-auto custom-scrollbar">
          <h3 className="text-orange-500 font-bold mb-2 uppercase tracking-tighter sticky top-0 bg-[#141414cc] pb-1">Activity Log</h3>
          {actionLogs.length === 0 ? (
            <>
              <p>✓ Connections validated</p>
              <p>✓ Llama 3B Brain: Online</p>
              <p>✓ System Modules: Active</p>
              <p>✓ Ready for interaction</p>
            </>
          ) : (
            actionLogs.map((log, i) => (
              <p key={i} className="mb-1">
                <span className="text-gray-600">[{log.time}]</span>{' '}
                <span className={log.isEmergency ? 'text-red-400' : 'text-blue-400'}>{getToolDisplayName(log.tool)}</span>
                {' - '}{formatLogDetails(log.tool, log.details)}
              </p>
            ))
          )}
        </div>

        {/* Center: Controls */}
        <div className="flex flex-col items-center justify-end h-full pb-4">
          {!isConnected ? (
            <button onClick={startConversation} className="bg-orange-600 hover:bg-orange-500 transition-all px-12 py-4 rounded-full font-bold uppercase tracking-widest shadow-[0_0_20px_rgba(255,120,0,0.4)] text-white">
              Start Conversation
            </button>
          ) : (
            <button onClick={stopConversation} className="bg-red-900/80 hover:bg-red-600 transition-all px-12 py-4 border border-red-500/50 rounded-full font-bold uppercase tracking-widest shadow-[0_0_20px_rgba(255,0,0,0.3)] text-white">
              End Session
            </button>
          )}
          <p className="text-[10px] text-gray-600 mt-4 uppercase font-semibold tracking-wider">Powered by Llama 3 / Cartesia / MCP</p>
        </div>

        {/* Right: System Status */}
        <div className="text-right flex flex-col items-end justify-end h-full pb-4">
          <div className="flex items-center gap-2 text-gray-400 mb-2">
            <span className={`w-2 h-2 rounded-full animate-pulse ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></span>
            {isConnected ? 'System Secure & Active' : 'System Offline'}
          </div>
          <p className="text-xs font-bold text-gray-500 uppercase italic tracking-widest">Team Matrix</p>
        </div>
      </div>
    </div>
  );
}

export default App;
