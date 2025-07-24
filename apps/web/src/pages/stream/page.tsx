import { useState, useRef, useEffect, useCallback } from 'react';

const WebRTCApp = () => {
  // State
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callId, setCallId] = useState('');
  const [isWebcamStarted, setIsWebcamStarted] = useState(false);
  const [isCallActive, setIsCallActive] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [messages, setMessages] = useState([]);

  // Refs
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const wsRef = useRef<WebSocket | null>(null);

  // WebRTC configuration
  const servers = {
    iceServers: [
      {
        urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
      },
    ],
    iceCandidatePoolSize: 10,
  };

  // Initialize WebSocket connection
  useEffect(() => {
    const connectWebSocket = () => {
      wsRef.current = new WebSocket('ws://localhost:3001');
      
      wsRef.current.onopen = () => {
        setConnectionStatus('Connected');
        console.log('WebSocket connected');
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      wsRef.current.onclose = () => {
        setConnectionStatus('Disconnected');
        console.log('WebSocket disconnected');
        // Attempt to reconnect after 3 seconds
        setTimeout(connectWebSocket, 3000);
      };

      wsRef.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        setConnectionStatus('Error');
      };
    };

    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  // Handle WebSocket messages
  const handleWebSocketMessage = useCallback((data) => {
    setMessages(prev => [...prev, data]);

    switch (data.type) {
      case 'offer':
        handleReceiveOffer(data);
        break;
      case 'answer':
        handleReceiveAnswer(data);
        break;
      case 'ice-candidate':
        handleReceiveIceCandidate(data);
        break;
      case 'call-ended':
        handleCallEnded();
        break;
      default:
        console.log('Unknown message type:', data.type);
    }
  }, []);

  // Send message via WebSocket
  const sendWebSocketMessage = (message) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected');
    }
  };

  // Initialize peer connection
  const initializePeerConnection = () => {
    if (pcRef.current) {
      pcRef.current.close();
    }

    pcRef.current = new RTCPeerConnection(servers);

    // Add local stream tracks to peer connection
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pcRef.current.addTrack(track, localStream);
      });
    }

    // Handle remote stream
    pcRef.current.ontrack = (event) => {
      const [remoteStream] = event.streams;
      setRemoteStream(remoteStream);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
    };

    // Handle ICE candidates
    pcRef.current.onicecandidate = (event) => {
      if (event.candidate) {
        sendWebSocketMessage({
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
          callId: callId
        });
      }
    };

    // Handle connection state changes
    pcRef.current.onconnectionstatechange = () => {
      console.log('Connection state:', pcRef.current.connectionState);
      if (pcRef.current.connectionState === 'connected') {
        setIsCallActive(true);
      } else if (pcRef.current.connectionState === 'disconnected' || 
                 pcRef.current.connectionState === 'failed') {
        setIsCallActive(false);
      }
    };
  };

  // Start webcam
  const startWebcam = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: true, 
        audio: true 
      });
      
      setLocalStream(stream);
      setIsWebcamStarted(true);
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (error) {
      console.error('Error accessing webcam:', error);
      alert('Error accessing webcam. Please ensure you have granted camera and microphone permissions.');
    }
  };

  // Create call (offer)
  const createCall = async () => {
    if (!localStream) {
      alert('Please start your webcam first');
      return;
    }

    const newCallId = Math.random().toString(36).substring(7);
    setCallId(newCallId);

    initializePeerConnection();

    try {
      const offer = await pcRef.current.createOffer();
      await pcRef.current.setLocalDescription(offer);

      sendWebSocketMessage({
        type: 'offer',
        offer: offer,
        callId: newCallId
      });

      console.log('Call created with ID:', newCallId);
    } catch (error) {
      console.error('Error creating call:', error);
    }
  };

  // Answer call
  const answerCall = async () => {
    if (!localStream) {
      alert('Please start your webcam first');
      return;
    }

    if (!callId) {
      alert('Please enter a call ID');
      return;
    }

    initializePeerConnection();

    sendWebSocketMessage({
      type: 'join-call',
      callId: callId
    });
  };

  // Handle received offer
  const handleReceiveOffer = async (data) => {
    if (!pcRef.current) {
      initializePeerConnection();
    }

    try {
      await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pcRef.current.createAnswer();
      await pcRef.current.setLocalDescription(answer);

      sendWebSocketMessage({
        type: 'answer',
        answer: answer,
        callId: data.callId
      });
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  };

  // Handle received answer
  const handleReceiveAnswer = async (data) => {
    if (!pcRef.current.currentRemoteDescription) {
      try {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (error) {
        console.error('Error handling answer:', error);
      }
    }
  };

  // Handle received ICE candidate
  const handleReceiveIceCandidate = async (data) => {
    if (pcRef.current && pcRef.current.remoteDescription) {
      try {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (error) {
        console.error('Error adding ICE candidate:', error);
      }
    }
  };

  // Handle call ended
  const handleCallEnded = () => {
    hangup();
  };

  // Hangup call
  const hangup = () => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    if (remoteStream) {
      remoteStream.getTracks().forEach(track => track.stop());
      setRemoteStream(null);
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    setIsCallActive(false);

    if (callId) {
      sendWebSocketMessage({
        type: 'end-call',
        callId: callId
      });
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
      if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
      }
      if (pcRef.current) {
        pcRef.current.close();
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [localStream, remoteStream]);

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white min-h-screen">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800 mb-2">WebRTC Video Call</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">WebSocket Status:</span>
          <span className={`px-2 py-1 rounded text-xs font-medium ${
            connectionStatus === 'Connected' ? 'bg-green-100 text-green-800' :
            connectionStatus === 'Error' ? 'bg-red-100 text-red-800' :
            'bg-yellow-100 text-yellow-800'
          }`}>
            {connectionStatus}
          </span>
        </div>
      </div>

      <div className="space-y-8">
        {/* Step 1: Webcam */}
        <section className="border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">1. Start your Webcam</h2>
          <div className="grid md:grid-cols-2 gap-6 mb-4">
            <div>
              <h3 className="font-medium mb-2">Local Stream</h3>
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full bg-gray-900 rounded-lg aspect-video"
              />
            </div>
            <div>
              <h3 className="font-medium mb-2">Remote Stream</h3>
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="w-full bg-gray-900 rounded-lg aspect-video"
              />
            </div>
          </div>
          <button
            onClick={startWebcam}
            disabled={isWebcamStarted}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {isWebcamStarted ? 'Webcam Started' : 'Start Webcam'}
          </button>
        </section>

        {/* Step 2: Create Call */}
        <section className="border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">2. Create a new Call</h2>
          <button
            onClick={createCall}
            disabled={!isWebcamStarted || isCallActive}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            Create Call (offer)
          </button>
          {callId && (
            <div className="mt-4 p-3 bg-gray-100 rounded-lg">
              <p className="text-sm font-medium">Call ID:</p>
              <p className="font-mono text-lg">{callId}</p>
              <p className="text-xs text-gray-600 mt-1">Share this ID with the person you want to call</p>
            </div>
          )}
        </section>

        {/* Step 3: Join Call */}
        <section className="border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">3. Join a Call</h2>
          <p className="text-gray-600 mb-4">Enter the call ID from another user</p>
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={callId}
              onChange={(e) => setCallId(e.target.value)}
              placeholder="Enter call ID"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={answerCall}
              disabled={!isWebcamStarted || !callId || isCallActive}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              Answer Call
            </button>
          </div>
        </section>

        {/* Step 4: Hangup */}
        <section className="border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">4. End Call</h2>
          <button
            onClick={hangup}
            disabled={!isCallActive}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            Hang Up
          </button>
          {isCallActive && (
            <div className="mt-2 text-sm text-green-600 font-medium">
              ✅ Call is active
            </div>
          )}
        </section>

        {/* Debug Messages */}
        <section className="border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">Debug Messages</h2>
          <div className="bg-gray-100 rounded-lg p-4 max-h-60 overflow-y-auto">
            {messages.length === 0 ? (
              <p className="text-gray-500 text-sm">No messages yet...</p>
            ) : (
              messages.slice(-10).map((msg, index) => (
                <div key={index} className="text-xs mb-2 font-mono">
                  <span className="text-gray-500">[{msg.timestamp || 'N/A'}]</span>
                  <span className="ml-2 font-medium">{msg.type}:</span>
                  <span className="ml-1">{JSON.stringify(msg, null, 2).substring(0, 100)}...</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

export default WebRTCApp;