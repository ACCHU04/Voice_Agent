import React, { useState, useEffect, useRef } from 'react';
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

  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const musicRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const cameraStreamRef = useRef(null);

  useEffect(() => {
    if (mode === 'emergency') {
      document.body.classList.add('emergency-mode');
    } else {
      document.body.classList.remove('emergency-mode');
    }
    return () => document.body.classList.remove('emergency-mode');
  }, [mode]);

  useEffect(() => {
    return () => {
      stopConversation();
      stopCamera();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startConversation = async () => {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsHost = window.location.host;
      console.log(`[Frontend] Connecting to backend at: ${protocol}://${wsHost}`);
      wsRef.current = new WebSocket(`${protocol}://${wsHost}`);

      wsRef.current.onopen = () => {
        setIsConnected(true);
        setStatus('Listening');
      };

      wsRef.current.onmessage = async (event) => {
        if (typeof event.data === 'string') {
          try {
            const data = JSON.parse(event.data);

            if (data.type === 'clear_buffer') {
              if (audioContextRef.current) {
                audioContextRef.current.close();
                audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
                nextPlayTimeRef.current = audioContextRef.current.currentTime;
              }
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
              setActionLogs((prev) => [{
                time: new Date().toLocaleTimeString(),
                tool: data.tool,
                details: data.details,
                isEmergency: EMERGENCY_TOOLS.includes(data.tool)
              }, ...prev].slice(0, 10));
            }

            else if (data.type === 'hardware_action') {
              const triggerApp = (intentUrl) => {
                const iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                iframe.src = intentUrl;
                document.body.appendChild(iframe);
                setTimeout(() => iframe.remove(), 3000);
              };

              if (data.action === 'play_music') {
                setNowPlaying(data.song);
                const songQuery = encodeURIComponent(data.song);
                const ytUrl = `https://music.youtube.com/search?q=${songQuery}`;
                
                // On a laptop, open in a new tab. If blocked, navigate current tab.
                const newWindow = window.open(ytUrl, '_blank');
                if (!newWindow || newWindow.closed || typeof newWindow.closed === 'undefined') {
                  window.location.href = ytUrl;
                }
              }
              else if (data.action === 'cab_booked') {
                setCabInfo({ eta: data.eta, destination: data.destination });
                setTimeout(() => setCabInfo(null), 30000);
                const dest = encodeURIComponent(data.destination);
                triggerApp(`intent://?action=setPickup&pickup=my_location&dropoff[formatted_address]=${dest}#Intent;scheme=uber;package=com.ubercab;end;`);
              }
              else if (data.action === 'movie_booked') {
                const movie = encodeURIComponent(data.movie);
                triggerApp(`intent://explore/movies-bengaluru?q=${movie}#Intent;scheme=https;package=com.bt.bms;end;`);
              }
              else if (data.action === 'appointment_booked') {
                const title = encodeURIComponent(`Doctor: ${data.doctor}`);
                const details = encodeURIComponent(`Hospital: ${data.hospital}\nBooked via Aegis`);
                triggerApp(`intent://calendar.google.com/calendar/r/eventedit?text=${title}&details=${details}#Intent;scheme=https;package=com.google.android.calendar;end;`);
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
              setTimeout(() => setAiTranscript(''), 8000);
            }

          } catch (e) {
            console.error('Error parsing message:', e);
          }
        }
        else if (event.data instanceof Blob) {
          setStatus('AI Speaking');
          const arrayBuffer = await event.data.arrayBuffer();
          playSeamlessAudio(arrayBuffer);
          setTimeout(() => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) setStatus('Listening');
          }, 1500);
        }
      };

      wsRef.current.onclose = () => {
        setIsConnected(false);
        setStatus('Disconnected');
        setActionLogs([]);
        setNowPlaying(null);
        setMode('civilian');
      };

      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      nextPlayTimeRef.current = audioContextRef.current.currentTime;

      // Laptop-friendly microphone settings (reduces echo from speakers)
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000
        } 
      });
      mediaRecorderRef.current = new MediaRecorder(stream);
      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.data);
        }
      };
      // Send smaller chunks more frequently for lower latency and better stability
      mediaRecorderRef.current.start(250);

    } catch (error) {
      console.error('Error starting conversation:', error);
      alert('Failed to access microphone or connect to server.');
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
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
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
    } catch(e) {
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

  const playSeamlessAudio = (arrayBuffer) => {
    if (!audioContextRef.current) return;
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) float32Array[i] = int16Array[i] / 32768.0;
    const audioBuffer = audioContextRef.current.createBuffer(1, float32Array.length, 16000);
    audioBuffer.getChannelData(0).set(float32Array);
    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);
    const currentTime = audioContextRef.current.currentTime;
    if (currentTime > nextPlayTimeRef.current) nextPlayTimeRef.current = currentTime;
    source.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += audioBuffer.duration;
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
      switch(tool) {
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
    } catch(e) {
      return detailsStr;
    }
  };

  return (
    <div className={`app-container ${mode}`}>
      {mode === 'emergency' && <div className="emergency-flash" />}

      {/* Header */}
      <div className="app-header">
        <div className="header-left">
          <h2 className="header-name">Rishav Singh</h2>
          <span className="header-subtitle">MSc Data Science (2025-2027)</span>
        </div>
        <div className={`header-shield ${mode}`}>
          <span>🛡️</span>
        </div>
      </div>

      {/* Central Aegis Core */}
      <div className="aegis-core-container">
        <div className={`aegis-core ${mode} ${getStatusClass()}`}>
          <span className="core-icon">{mode === 'emergency' ? '⚠️' : '🔐'}</span>
        </div>
        <div className={`status-label ${mode}`}>
          {status === 'Disconnected' ? 'AEGIS STANDBY' : 
           status === 'Listening' ? 'AEGIS LISTENING' : 
           'AEGIS ACTIVE'}
        </div>
      </div>

      {/* Waveform */}
      <div className={`wave-container ${status === 'Listening' || status === 'AI Speaking' ? 'active' : ''}`}>
        <div className="bar"></div><div className="bar"></div><div className="bar"></div><div className="bar"></div><div className="bar"></div>
      </div>

      {/* AI Transcript */}
      {aiTranscript && (
        <div className={`ai-transcript-bubble ${mode}`}>
          <span className="transcript-label">Aegis:</span>
          <span className="transcript-text">{aiTranscript}</span>
        </div>
      )}

      {/* Camera Triage Overlay */}
      {showCamera && (
        <div className="camera-overlay">
          <div className="camera-header">
            <span>📸 Visual Triage: {cameraReason}</span>
            <button className="camera-close" onClick={stopCamera}>✕</button>
          </div>
          <video ref={videoRef} autoPlay playsInline className="camera-feed" />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          <button className="camera-capture-btn" onClick={captureAndSend}>
            📷 Capture & Analyze
          </button>
        </div>
      )}

      {/* Discharge Status Card */}
      {dischargeData && (
        <div className="discharge-card">
          <h4>📊 Discharge Pipeline</h4>
          <div className="discharge-grid">
            {Object.entries(dischargeData).map(([key, val]) => (
              <div key={key} className={`discharge-item ${val.status === 'Cleared' || val.status === 'Ready' ? 'cleared' : 'pending'}`}>
                <span className="discharge-label">{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                <span className={`discharge-status ${val.status.toLowerCase()}`}>{val.status}</span>
                {val.note && <span className="discharge-note">{val.note}</span>}
                {val.amount && <span className="discharge-note">{val.amount}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cab Info Card */}
      {cabInfo && (
        <div className="cab-card">
          <span className="cab-icon">🚕</span>
          <div className="cab-details">
            <span className="cab-title">Cab Confirmed!</span>
            <span className="cab-dest">📍 {cabInfo.destination} • ⏱️ {cabInfo.eta} min</span>
          </div>
        </div>
      )}

      {/* Music Player */}
      {nowPlaying && (
        <div className="music-bar">
          <span className="music-icon">🎵</span>
          <span className="music-text">Now Playing: {nowPlaying}</span>
          <div className="music-eq">
            <div className="eq-bar"></div><div className="eq-bar"></div><div className="eq-bar"></div><div className="eq-bar"></div>
          </div>
        </div>
      )}



      {/* Services & Bookings */}
      {isConnected && mode === 'civilian' && (
        <div className="services-card">
          <h4>Services & Bookings</h4>
          <div className="services-grid">
            <button className="service-btn" onClick={() => {
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                setAiTranscript('Asking Aegis to book a cab...');
              }
            }}>🚕 Book Cab</button>
            <button className="service-btn" onClick={() => {
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                setAiTranscript('Asking Aegis for appointment...');
              }
            }}>🏥 Appt.</button>
          </div>
        </div>
      )}

      {/* Activity Log */}
      <div className="action-log-container">
        <h4 className="log-title">{mode === 'civilian' ? '📋 System Activity Log' : '🚨 Operations Log'}</h4>
        {actionLogs.length === 0 ? (
          <p className="no-logs">
            {mode === 'civilian' ? 'Say "Book a cab to HSR Layout"' : 'Awaiting trauma input...'}
          </p>
        ) : (
          <ul className="action-log-list">
            {actionLogs.map((log, i) => (
              <li key={i} className={`action-log-item ${log.isEmergency ? 'tool-emergency' : 'tool-civilian'}`}>
                <span className="log-time">{log.time}</span>
                <span className="log-tool">
                  <span className="tool-icon">{getToolIcon(log.tool)}</span>
                  {getToolDisplayName(log.tool)}
                </span>
                <span className="log-details">{formatLogDetails(log.tool, log.details)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Controls */}
      <div className="controls">
        {!isConnected ? (
          <button className="btn-primary" onClick={startConversation}>
            Start Conversation
          </button>
        ) : (
          <>
            <button className="btn-primary btn-danger" onClick={stopConversation}>
              End Session
            </button>
            {mode === 'civilian' && (
              <button className="btn-code-red" onClick={() => {
                setMode('emergency');
                if (musicRef.current) { musicRef.current.pause(); musicRef.current = null; setNowPlaying(null); }
              }}>
                ⚠️ MANUAL CODE RED
              </button>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="app-footer">
        <span>Rishav Singh • MSc Data Science</span>
      </div>
    </div>
  );
}

export default App;
