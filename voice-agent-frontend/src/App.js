import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [status, setStatus] = useState('Disconnected'); // Disconnected, Listening, AI Speaking
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const nextPlayTimeRef = useRef(0);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      stopConversation();
    };
  }, []);

  const startConversation = async () => {
    try {
      // 1. Connect WebSocket
      wsRef.current = new WebSocket('ws://localhost:8080');

      wsRef.current.onopen = () => {
        setIsConnected(true);
        setStatus('Listening');
      };

      wsRef.current.onmessage = async (event) => {
        // Assume incoming binary is the AI speaking (Cartesia Audio)
        if (event.data instanceof Blob) {
          setStatus('AI Speaking');
          const arrayBuffer = await event.data.arrayBuffer();
          playSeamlessAudio(arrayBuffer);
          
          // Revert to listening after a delay (this is basic, a real app would use a "done" event from the backend)
          setTimeout(() => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              setStatus('Listening');
            }
          }, 1500); 
        }
      };

      wsRef.current.onclose = () => {
        setIsConnected(false);
        setStatus('Disconnected');
        stopConversation();
      };

      // 2. Setup AudioContext for AI speech playback
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000
      });
      nextPlayTimeRef.current = audioContextRef.current.currentTime;

      // 3. Request Microphone Access and capture using MediaRecorder
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // We use standard MediaRecorder (Note: outputs WebM/Opus by default in Chrome)
      // The backend should be configured to accept this or process it.
      mediaRecorderRef.current = new MediaRecorder(stream);

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.data);
        }
      };

      // Send audio chunks every 250ms
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
    if (wsRef.current) {
      wsRef.current.close();
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setIsConnected(false);
    setStatus('Disconnected');
  };

  const playSeamlessAudio = (arrayBuffer) => {
    if (!audioContextRef.current) return;

    // Cartesia sends raw pcm_s16le (16-bit PCM)
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    
    // Convert Int16 to Float32 for Web Audio API
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    const audioBuffer = audioContextRef.current.createBuffer(1, float32Array.length, 16000);
    audioBuffer.getChannelData(0).set(float32Array);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);

    // Schedule seamless playback
    const currentTime = audioContextRef.current.currentTime;
    if (currentTime > nextPlayTimeRef.current) {
      nextPlayTimeRef.current = currentTime;
    }
    
    source.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += audioBuffer.duration;
  };

  const getStatusClass = () => {
    if (status === 'Disconnected') return 'status-disconnected';
    if (status === 'Listening') return 'status-listening';
    if (status === 'AI Speaking') return 'status-speaking';
    return '';
  };

  return (
    <div className="app-container">
      <div className="header">
        <h1>Voice Agent Lab</h1>
        <p>Real-time Bi-directional AI</p>
      </div>

      <div className={`status-indicator ${getStatusClass()}`}>
        <div className="orb"></div>
        <span>{status}</span>
      </div>

      <div className={`wave-container ${status === 'Listening' || status === 'AI Speaking' ? 'active' : ''}`}>
        <div className="bar"></div>
        <div className="bar"></div>
        <div className="bar"></div>
        <div className="bar"></div>
        <div className="bar"></div>
      </div>

      <div className="controls">
        {!isConnected ? (
          <button className="btn-primary" onClick={startConversation}>
            Start Conversation
          </button>
        ) : (
          <button className="btn-primary btn-danger" onClick={stopConversation}>
            End Conversation
          </button>
        )}
      </div>
    </div>
  );
}

export default App;
