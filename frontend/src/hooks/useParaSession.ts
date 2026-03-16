import { useState, useRef, useCallback, useEffect } from 'react'
import { SessionStatus, Clause, ChatMessage, PerformanceMetrics, JudgeEvaluation } from '../lib/types'

/** Word-overlap similarity between two strings (0-1) */
function _similarity(a: string, b: string): number {
  if (a === b) return 1
  const wordsA = new Set(a.split(/\s+/).filter(Boolean))
  const wordsB = new Set(b.split(/\s+/).filter(Boolean))
  if (wordsA.size === 0 && wordsB.size === 0) return 1
  let overlap = 0
  for (const w of wordsA) if (wordsB.has(w)) overlap++
  return overlap / Math.max(wordsA.size, wordsB.size)
}

const API_BASE = import.meta.env.VITE_API_URL || ''
const WS_BASE = import.meta.env.VITE_WS_URL || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
const PLAYBACK_RATE = 24000
const FRAME_INTERVAL = 3000
const VIDEO_WIDTH = 512
const VIDEO_HEIGHT = 384
// JPEG quality set inline in camera frame (0.4)

export function useParaSession() {
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [clauses, setClauses] = useState<Clause[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [videoFrame, setVideoFrame] = useState<string | null>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [micActive, setMicActive] = useState(false)
  const [duration, setDuration] = useState(0)
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [userSpeaking, setUserSpeaking] = useState(false)
  const [perfMetrics, setPerfMetrics] = useState<PerformanceMetrics>({
    latencyMs: 0, avgLatencyMs: 0, tokensPerSec: 0, totalTokens: 0,
    wsLatencyMs: 0, framesSent: 0, uptime: 0,
  })
  const [paranoiaMode, setParanoiaMode] = useState<'standard' | 'full'>('standard')
  const paranoiaModeRef = useRef<'standard' | 'full'>('standard')
  const [judgeEval, setJudgeEval] = useState<JudgeEvaluation | null>(null)
  const [judgeLoading, setJudgeLoading] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const micCtxRef = useRef<AudioContext | null>(null)
  const nextPlayTimeRef = useRef(0)
  const videoTimerRef = useRef<number | null>(null)
  const durationTimerRef = useRef<number | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const camStreamRef = useRef<MediaStream | null>(null)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const audioChunkCountRef = useRef(0)
  const clausesRef = useRef<Clause[]>([])
  const lastInputTextRef = useRef('')
  const intentionalDisconnectRef = useRef(false)
  const reconnectCountRef = useRef(0)
  const isReconnectingRef = useRef(false)
  const userSpeakingRef = useRef(false)
  const paraSpeakingRef = useRef(false)
  const interruptedRef = useRef(false)
  const lastParaAudioEndRef = useRef(0)
  const cameraCooldownRef = useRef(0)
  const MAX_RECONNECTS = 3

  // Perf tracking refs
  const userStopSpeakingAtRef = useRef(0)
  const latencyHistoryRef = useRef<number[]>([])
  const tokenCountRef = useRef(0)
  const tokenWindowStartRef = useRef(0)
  const framesSentRef = useRef(0)
  const sessionStartRef = useRef(0)

  // ── Audio playback ──────────────────────────────────────────────────────
  const playPCM = useCallback((pcmBase64: string) => {
    const ctx = audioCtxRef.current
    if (!ctx || ctx.state === 'closed') return
    if (ctx.state === 'suspended') ctx.resume()

    try {
      const raw = atob(pcmBase64)
      const buf = new ArrayBuffer(raw.length)
      const view = new Uint8Array(buf)
      for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)

      const samples = new Int16Array(buf)
      const floats = new Float32Array(samples.length)
      for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768

      const audioBuf = ctx.createBuffer(1, floats.length, PLAYBACK_RATE)
      audioBuf.getChannelData(0).set(floats)

      const src = ctx.createBufferSource()
      src.buffer = audioBuf
      src.connect(ctx.destination)

      const now = ctx.currentTime
      const startAt = Math.max(now + 0.01, nextPlayTimeRef.current)
      src.start(startAt)
      nextPlayTimeRef.current = startAt + audioBuf.duration

      audioChunkCountRef.current++
      if (audioChunkCountRef.current <= 3 || audioChunkCountRef.current % 100 === 0) {
        console.log(`[Para] Audio #${audioChunkCountRef.current} (${samples.length} samples)`)
      }
    } catch (err) {
      console.error('[Para] Audio playback error:', err)
    }
  }, [])

  const stopAudio = useCallback(() => {
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close()
    }
    audioCtxRef.current = new AudioContext({ sampleRate: PLAYBACK_RATE })
    nextPlayTimeRef.current = 0
    audioChunkCountRef.current = 0
  }, [])

  // ── Add message ─────────────────────────────────────────────────────────
  const addMessage = useCallback(
    (partial: Omit<ChatMessage, 'id' | 'timestamp'>, append = false) => {
      setMessages(prev => {
        if (append && prev.length > 0) {
          const last = prev[prev.length - 1]
          if (last.role === partial.role) {
            const newText = partial.text.trim()
            if (!newText) return prev
            // Skip if this text is already in the message (duplicate from transcription)
            if (last.text.includes(newText) || newText.length > 20 && last.text.endsWith(newText.slice(-20))) return prev
            const updated = [...prev]
            updated[updated.length - 1] = {
              ...last,
              text: last.text.trimEnd() + ' ' + newText,
              citations: partial.citations || last.citations,
            }
            return updated
          }
        }
        return [
          ...prev,
          { ...partial, id: crypto.randomUUID(), timestamp: Date.now() },
        ]
      })
    },
    []
  )

  // ── Flush user input transcription ──────────────────────────────────────
  const lastFlushedUserTextRef = useRef('')

  const flushInputTranscription = useCallback(() => {
    const text = lastInputTextRef.current.trim()
    if (text.length > 1) {
      addMessage({ role: 'user', text })
      lastFlushedUserTextRef.current = text.replace(/\s+/g, ' ').toLowerCase()
    }
    lastInputTextRef.current = ''
  }, [addMessage])

  // ── Handle WebSocket messages from backend ─────────────────────────────
  const handleWsMessage = useCallback((event: MessageEvent) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }

    const type = msg.type as string

    switch (type) {
      case 'status': {
        const s = msg.status as string
        if (s === 'scanning') setStatus('scanning')
        else if (s === 'connecting') {
          setStatus('connecting')
          // Backend sends session_id on connect
          if (msg.session_id) setSessionId(msg.session_id as string)
        }
        break
      }

      case 'audio': {
        // Skip audio if we're in interrupted state (stale chunks still arriving)
        if (interruptedRef.current) break
        // Measure TTFB
        if (userStopSpeakingAtRef.current > 0) {
          const ttfb = performance.now() - userStopSpeakingAtRef.current
          userStopSpeakingAtRef.current = 0
          latencyHistoryRef.current.push(ttfb)
          if (latencyHistoryRef.current.length > 20) latencyHistoryRef.current.shift()
          const avg = latencyHistoryRef.current.reduce((a, b) => a + b, 0) / latencyHistoryRef.current.length
          setPerfMetrics(prev => ({ ...prev, latencyMs: Math.round(ttfb), avgLatencyMs: Math.round(avg) }))
        }
        playPCM(msg.data as string)
        setStatus('speaking')
        paraSpeakingRef.current = true
        break
      }

      case 'interrupted':
        stopAudio()
        interruptedRef.current = true
        setStatus('interrupted')
        paraSpeakingRef.current = false
        userStopSpeakingAtRef.current = performance.now()
        break

      case 'turn_complete':
        flushInputTranscription()
        setStatus('scanning')
        paraSpeakingRef.current = false
        interruptedRef.current = false
        lastParaAudioEndRef.current = Date.now()
        tokenCountRef.current = 0
        tokenWindowStartRef.current = 0
        audioChunkCountRef.current = 0
        break

      case 'transcript': {
        const role = msg.role as string
        const text = (msg.text as string || '').trim()
        if (!text) break

        if (role === 'para') {
          addMessage({ role: 'para', text }, true)
          // Token velocity tracking
          const wordCount = text.split(/\s+/).length
          tokenCountRef.current += wordCount
          const now = performance.now()
          if (tokenWindowStartRef.current === 0) tokenWindowStartRef.current = now
          const elapsed = (now - tokenWindowStartRef.current) / 1000
          if (elapsed > 0.5) {
            setPerfMetrics(prev => ({
              ...prev,
              tokensPerSec: Math.round(tokenCountRef.current / elapsed),
              totalTokens: prev.totalTokens + wordCount,
            }))
          }
        } else if (role === 'user') {
          // Check if this is a final/clean version of already-flushed text
          const normalized = text.replace(/\s+/g, ' ').toLowerCase()
          if (lastFlushedUserTextRef.current && _similarity(normalized, lastFlushedUserTextRef.current) > 0.7) {
            // Replace the last user message with the clean version
            setMessages(prev => {
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].role === 'user') {
                  const updated = [...prev]
                  updated[i] = { ...updated[i], text }
                  return updated
                }
              }
              return prev
            })
            lastFlushedUserTextRef.current = ''
          } else if (lastInputTextRef.current.length > 0) {
            lastInputTextRef.current += ' ' + text
          } else {
            lastInputTextRef.current = text
          }
        }
        break
      }

      case 'clause': {
        const clauseData = msg.clause as Record<string, unknown>
        if (!clauseData) break
        const clause: Clause = {
          id: String(clauseData.id || crypto.randomUUID()),
          clause_type: String(clauseData.clause_type || ''),
          severity: (String(clauseData.severity || 'YELLOW').toUpperCase() as Clause['severity']),
          raw_text: String(clauseData.raw_text || ''),
          analysis: String(clauseData.analysis || ''),
          citations: [],
          timestamp: Date.now(),
        }
        clausesRef.current = [clause, ...clausesRef.current]
        setClauses(prev => [clause, ...prev])
        addMessage({
          role: 'clause',
          text: clause.analysis,
          severity: clause.severity,
          clause,
        })
        console.log(`[Para] Clause: ${clause.clause_type} [${clause.severity}]`)
        break
      }

      case 'summary': {
        const data = msg.data as Record<string, unknown>
        setSummary(data)
        addMessage({ role: 'system', text: `Risk Score: ${data?.score || '?'}/100 — ${data?.grade || ''}` })
        break
      }

      case 'note_saved': {
        const data = msg.data as Record<string, unknown>
        addMessage({ role: 'system', text: `Noted (${data?.total_notes || 0} notes saved)` })
        break
      }

      case 'citations': {
        const citations = msg.citations as Array<{ title: string; url: string }>
        if (citations && citations.length > 0) {
          setMessages(prev => {
            const updated = [...prev]
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'para') {
                updated[i] = { ...updated[i], citations }
                break
              }
            }
            return updated
          })
        }
        break
      }

      case 'error': {
        const errText = String(msg.text || '')
        console.error('[Para] Server error:', errText)

        if (errText.includes('1008') || errText.includes('policy')) {
          // Policy violation (bad frame/audio) — Gemini session is dead, reconnect silently
          console.log('[Para] Policy error — silent reconnect')
          paraSpeakingRef.current = false
          interruptedRef.current = false
          if (!intentionalDisconnectRef.current) reconnect()
        } else if (errText.includes('1007')) {
          // Invalid argument — usually bad frame data, reconnect
          console.log('[Para] Invalid argument — silent reconnect')
          paraSpeakingRef.current = false
          interruptedRef.current = false
          if (!intentionalDisconnectRef.current) reconnect()
        } else if (!intentionalDisconnectRef.current) {
          reconnect()
        }
        break
      }
    }
  }, [playPCM, stopAudio, addMessage, flushInputTranscription])

  // ── Reconnect ──────────────────────────────────────────────────────────
  const reconnect = useCallback(async () => {
    if (isReconnectingRef.current) return
    if (reconnectCountRef.current >= MAX_RECONNECTS) {
      addMessage({ role: 'system', text: 'Connection lost. Max reconnect attempts reached.' })
      setStatus('idle')
      return
    }

    isReconnectingRef.current = true
    reconnectCountRef.current++
    console.log(`[Para] Reconnecting (attempt ${reconnectCountRef.current}/${MAX_RECONNECTS})...`)

    await new Promise(r => setTimeout(r, 1500))

    try {
      const ws = new WebSocket(`${WS_BASE}/ws/session`)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[Para] Reconnected')
        isReconnectingRef.current = false
        paraSpeakingRef.current = false
        interruptedRef.current = false
        userStopSpeakingAtRef.current = 0
        lastParaAudioEndRef.current = Date.now()  // Block camera after reconnect
        setStatus('scanning')
        // Send clause history + recent chat for context recovery
        const clauseHistory = clausesRef.current.map(c =>
          `[${c.severity}] ${c.clause_type}: ${c.analysis.slice(0, 120)}`
        ).join('\n')
        // Get recent messages for context (use current state via closure)
        setMessages(prev => {
          const recentChat = prev.slice(-8).map(m =>
            `${m.role}: ${m.text.slice(0, 100)}`
          ).join('\n')
          ws.send(JSON.stringify({
            type: 'reconnect',
            clauses: clauseHistory,
            chat: recentChat,
          }))
          return prev  // Don't modify messages
        })
      }
      ws.onmessage = handleWsMessage
      ws.onerror = () => {
        console.error('[Para] WS error on reconnect')
        isReconnectingRef.current = false
      }
      ws.onclose = (e) => {
        console.log('[Para] WS closed:', e.code)
        if (!intentionalDisconnectRef.current && reconnectCountRef.current < MAX_RECONNECTS) {
          reconnect()
        }
      }
    } catch (err) {
      console.error('[Para] Reconnect failed:', err)
      isReconnectingRef.current = false
    }
  }, [addMessage, handleWsMessage])

  // ── Start session ───────────────────────────────────────────────────────
  const startSession = useCallback(async () => {
    setStatus('connecting')
    setClauses([])
    setMessages([])
    setDuration(0)
    setVideoFrame(null)
    setSummary(null)
    setCameraActive(false)
    setMicActive(false)
    setJudgeEval(null)
    clausesRef.current = []
    lastInputTextRef.current = ''
    audioChunkCountRef.current = 0
    userStopSpeakingAtRef.current = 0
    latencyHistoryRef.current = []
    tokenCountRef.current = 0
    tokenWindowStartRef.current = 0
    framesSentRef.current = 0
    sessionStartRef.current = Date.now()
    reconnectCountRef.current = 0
    isReconnectingRef.current = false
    intentionalDisconnectRef.current = false
    setPerfMetrics({ latencyMs: 0, avgLatencyMs: 0, tokensPerSec: 0, totalTokens: 0, wsLatencyMs: 0, framesSent: 0, uptime: 0 })

    // Audio context for playback
    audioCtxRef.current = new AudioContext({ sampleRate: PLAYBACK_RATE })
    await audioCtxRef.current.resume()
    nextPlayTimeRef.current = 0

    try {
      // Connect WebSocket to backend ADK server
      const wsUrl = `${WS_BASE}/ws/session`
      console.log('[Para] Connecting to', wsUrl)
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      // Set ALL handlers before connection opens
      ws.onmessage = handleWsMessage
      ws.onclose = (e) => {
        console.log('[Para] WS closed:', e.code, e.reason)
        if (!intentionalDisconnectRef.current) {
          reconnect()
        }
      }
      ws.onerror = (e) => {
        console.error('[Para] WS error:', e)
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000)
        ws.addEventListener('open', () => {
          console.log('[Para] WebSocket connected to backend')
          clearTimeout(timeout)
          resolve()
        }, { once: true })
        ws.addEventListener('error', () => {
          clearTimeout(timeout)
          reject(new Error('WebSocket error'))
        }, { once: true })
      })

      addMessage({ role: 'system', text: 'Connected to Para.' })

      // Auto-start mic
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        micStreamRef.current = stream
        const micCtx = new AudioContext()
        micCtxRef.current = micCtx
        await micCtx.resume()
        console.log(`[Para] Mic rate: ${micCtx.sampleRate}Hz`)

        await micCtx.audioWorklet.addModule('/mic-processor.js?v=' + Date.now())
        const source = micCtx.createMediaStreamSource(stream)
        const worklet = new AudioWorkletNode(micCtx, 'mic-processor')

        let micSending = false
        worklet.port.onmessage = (ev: MessageEvent) => {
          const sock = wsRef.current
          if (!sock || sock.readyState !== WebSocket.OPEN) return

          if (ev.data?.type === 'vad') {
            micSending = ev.data.speaking
            if (ev.data.speaking) {
              setUserSpeaking(true)
              userSpeakingRef.current = true
              // Stop Para's audio immediately when user speaks
              if (paraSpeakingRef.current) {
                stopAudio()
                paraSpeakingRef.current = false
              }
              interruptedRef.current = false
              sock.send(JSON.stringify({ type: 'activity_start' }))
              console.log('[Para] → activity_start (rms:', ev.data.rms?.toFixed(3), 'thresh:', ev.data.threshold?.toFixed(3), ')')
            } else {
              setUserSpeaking(false)
              userSpeakingRef.current = false
              userStopSpeakingAtRef.current = performance.now()
              sock.send(JSON.stringify({ type: 'activity_end' }))
              // Show "thinking" while waiting for Para to respond
              if (!paraSpeakingRef.current) {
                setStatus('thinking')
              }
              console.log('[Para] → activity_end')
            }
            return
          }
          if (ev.data?.type === 'audio') {
            // Only send mic audio when VAD says we're speaking
            if (!micSending) return
            const bytes = new Uint8Array(ev.data.data as ArrayBuffer)
            if (bytes.length === 0) return
            let binary = ''
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
            sock.send(JSON.stringify({ type: 'audio', data: btoa(binary) }))
          }
        }

        source.connect(worklet)
        setMicActive(true)
        console.log('[Para] Mic active')
      } catch {
        console.log('[Para] Mic denied')
      }

      // Duration timer
      const start = Date.now()
      durationTimerRef.current = window.setInterval(() => {
        const secs = Math.floor((Date.now() - start) / 1000)
        setDuration(secs)
        setPerfMetrics(prev => ({ ...prev, uptime: secs }))
      }, 1000)
    } catch (err) {
      console.error('[Para] Connection error:', err)
      addMessage({ role: 'system', text: `Connection failed: ${err}` })
      setStatus('idle')
    }
  }, [handleWsMessage, addMessage, reconnect])

  // ── Camera toggle ───────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, facingMode: 'environment' },
      })
      camStreamRef.current = stream

      const video = document.createElement('video')
      video.srcObject = stream
      video.playsInline = true
      video.muted = true
      await video.play()
      videoElRef.current = video

      const canvas = document.createElement('canvas')
      canvas.width = VIDEO_WIDTH
      canvas.height = VIDEO_HEIGHT
      canvasRef.current = canvas
      const ctx2d = canvas.getContext('2d')!

      videoTimerRef.current = window.setInterval(() => {
        // 1. NEVER during ANY speech
        if (paraSpeakingRef.current || interruptedRef.current || userSpeakingRef.current) return
        // 2. NEVER during 5s cooldown after Para finishes
        if (Date.now() - lastParaAudioEndRef.current < 5000) return
        // 3. NEVER right after session start (let greeting finish)
        if (Date.now() - sessionStartRef.current < 10000) return
        // 4. Rate limit: 1 frame per 5s max
        if (Date.now() - cameraCooldownRef.current < 5000) return

        if (video.readyState >= 2 && ws.readyState === WebSocket.OPEN) {
          ctx2d.drawImage(video, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT)
          const jpeg = canvas.toDataURL('image/jpeg', 0.4).split(',')[1]
          ws.send(JSON.stringify({ type: 'frame', data: jpeg }))
          setVideoFrame(jpeg)
          framesSentRef.current++
          cameraCooldownRef.current = Date.now()
          setPerfMetrics(prev => ({ ...prev, framesSent: framesSentRef.current }))
          console.log('[Para] Frame sent (safe window)')
        }
      }, FRAME_INTERVAL)

      setCameraActive(true)
      addMessage({ role: 'system', text: 'Camera on — show Para your document.' })
    } catch {
      addMessage({ role: 'system', text: 'Camera access denied.' })
    }
  }, [addMessage])

  const stopCamera = useCallback(() => {
    if (videoTimerRef.current) { clearInterval(videoTimerRef.current); videoTimerRef.current = null }
    if (camStreamRef.current) { camStreamRef.current.getTracks().forEach(t => t.stop()); camStreamRef.current = null }
    if (videoElRef.current) { videoElRef.current.pause(); videoElRef.current.srcObject = null; videoElRef.current = null }
    setCameraActive(false)
    setVideoFrame(null)
  }, [])

  const toggleCamera = useCallback(() => {
    if (cameraActive) stopCamera()
    else startCamera()
  }, [cameraActive, startCamera, stopCamera])

  // ── Resume mic on tab focus (browser suspends AudioWorklet when hidden) ──
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && micCtxRef.current) {
        if (micCtxRef.current.state === 'suspended') {
          micCtxRef.current.resume().then(() => {
            console.log('[Para] Mic AudioContext resumed after tab switch')
          }).catch(() => {})
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  // ── Mic toggle ──────────────────────────────────────────────────────────
  const stopMic = useCallback(() => {
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null }
    if (micCtxRef.current && micCtxRef.current.state !== 'closed') { micCtxRef.current.close(); micCtxRef.current = null }
    setMicActive(false)
  }, [])

  const toggleMic = useCallback(() => {
    if (micActive) stopMic()
    // Re-starting mic mid-session not supported — restart session
  }, [micActive, stopMic])

  // ── Stop session ────────────────────────────────────────────────────────
  const stopSession = useCallback(() => {
    intentionalDisconnectRef.current = true
    // Notify backend before closing
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'activity_end' }))
    }
    stopCamera()
    stopMic()
    if (durationTimerRef.current) { clearInterval(durationTimerRef.current); durationTimerRef.current = null }
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') { audioCtxRef.current.close(); audioCtxRef.current = null }
    // Reset all refs
    paraSpeakingRef.current = false
    interruptedRef.current = false
    userStopSpeakingAtRef.current = 0
    setUserSpeaking(false)
    setStatus('idle')
  }, [stopCamera, stopMic])

  // ── Send text ───────────────────────────────────────────────────────────
  const sendMessage = useCallback((text: string) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'text', data: text }))
    addMessage({ role: 'user', text })
  }, [addMessage])

  const requestSummary = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'text', data: 'Please give me a risk summary. Call score_risk.' }))
  }, [])

  // ── Paranoia mode switch ────────────────────────────────────────────────
  const switchParanoiaMode = useCallback((mode: 'standard' | 'full') => {
    setParanoiaMode(mode)
    paranoiaModeRef.current = mode
    // Mode is handled by the agent's instruction on the backend
    // For now, just update the UI indicator
  }, [])

  // ── Judge Agent evaluation ──────────────────────────────────────────────
  const runJudgeEval = useCallback(async (overrideSessionId?: string) => {
    const sid = overrideSessionId || sessionId
    if (!sid || judgeLoading) return
    setJudgeLoading(true)
    setJudgeEval(null)
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sid}/evaluate`, { method: 'POST' })
      if (!res.ok) { console.error('[Para] Judge error'); return }
      const data: JudgeEvaluation = await res.json()
      setJudgeEval(data)
      console.log('[Para] Judge:', data.overall_grade, data.overall_score)
    } catch (err) {
      console.error('[Para] Judge failed:', err)
    } finally {
      setJudgeLoading(false)
    }
  }, [sessionId, judgeLoading])

  // ── Upload document (image/PDF → virtual camera feed) ────────────────
  const [pdfPages, setPdfPages] = useState<string[]>([])  // base64 JPEG per page
  const [pdfPage, setPdfPage] = useState(0)
  const pdfPagesRef = useRef<string[]>([])

  const sendFrameToWs = useCallback((jpeg: string, label: string) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'frame', data: jpeg }))
    setVideoFrame(jpeg)
    framesSentRef.current++
    setPerfMetrics(prev => ({ ...prev, framesSent: framesSentRef.current }))
    console.log('[Para] Frame sent:', label)
  }, [])

  const renderCanvasToJpeg = (source: HTMLImageElement | HTMLCanvasElement, quality = 0.6): string => {
    const canvas = document.createElement('canvas')
    canvas.width = 768
    canvas.height = 1024
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 768, 1024)
    const sw = 'naturalWidth' in source ? (source as HTMLImageElement).naturalWidth || source.width : source.width
    const sh = 'naturalHeight' in source ? (source as HTMLImageElement).naturalHeight || source.height : source.height
    const scale = Math.min(768 / sw, 1024 / sh)
    const w = sw * scale
    const h = sh * scale
    ctx.drawImage(source, (768 - w) / 2, (1024 - h) / 2, w, h)
    return canvas.toDataURL('image/jpeg', quality).split(',')[1]
  }

  const goToPdfPage = useCallback((pageNum: number) => {
    // Special: negative value = close PDF
    if (pageNum < -1) {
      pdfPagesRef.current = []
      setPdfPages([])
      setPdfPage(0)
      setVideoFrame(null)
      return
    }
    const pages = pdfPagesRef.current
    if (pageNum < 0 || pageNum >= pages.length) return
    setPdfPage(pageNum)
    setVideoFrame(pages[pageNum])
    sendFrameToWs(pages[pageNum], `PDF page ${pageNum + 1}/${pages.length}`)
    addMessage({ role: 'system', text: `Viewing page ${pageNum + 1} of ${pages.length}` })
  }, [sendFrameToWs, addMessage])

  const uploadDocument = useCallback(async (file: File) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    if (file.type.startsWith('image/')) {
      const img = new Image()
      img.onload = () => {
        const jpeg = renderCanvasToJpeg(img)
        sendFrameToWs(jpeg, file.name)
        addMessage({ role: 'system', text: `Document uploaded: ${file.name}` })
      }
      img.src = URL.createObjectURL(file)
    } else if (file.type === 'application/pdf') {
      addMessage({ role: 'system', text: `Loading PDF: ${file.name}...` })
      try {
        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

        const arrayBuffer = await file.arrayBuffer()
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
        const totalPages = pdf.numPages
        const pages: string[] = []

        // Render all pages to JPEG
        for (let i = 1; i <= totalPages; i++) {
          const page = await pdf.getPage(i)
          const viewport = page.getViewport({ scale: 1.5 })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          const ctx = canvas.getContext('2d')!
          await page.render({ canvasContext: ctx, viewport, canvas } as never).promise
          pages.push(renderCanvasToJpeg(canvas, 0.6))
        }

        pdfPagesRef.current = pages
        setPdfPages(pages)
        setPdfPage(0)

        // Send first page as frame + tell Para the filename
        sendFrameToWs(pages[0], `PDF page 1/${totalPages}`)
        ws.send(JSON.stringify({
          type: 'text',
          data: `I just uploaded "${file.name}" — a ${totalPages}-page document. You can see page 1 now. Mention the filename and page count when you respond. Analyze what you see.`,
        }))
        addMessage({ role: 'system', text: `PDF loaded: ${file.name} (${totalPages} pages) — use arrows to navigate` })
      } catch (err) {
        console.error('[Para] PDF render error:', err)
        addMessage({ role: 'system', text: `PDF error: ${err}` })
      }
    }
  }, [addMessage, sendFrameToWs])

  // Cleanup on unmount
  const stopRef = useRef(stopSession)
  stopRef.current = stopSession
  useEffect(() => () => stopRef.current(), [])

  return {
    status,
    clauses,
    messages,
    videoFrame,
    cameraActive,
    micActive,
    userSpeaking,
    duration,
    summary,
    sessionId,
    perfMetrics,
    paranoiaMode,
    switchParanoiaMode,
    startSession,
    stopSession,
    sendMessage,
    toggleCamera,
    toggleMic,
    requestSummary,
    judgeEval,
    judgeLoading,
    runJudgeEval,
    uploadDocument,
    pdfPages,
    pdfPage,
    goToPdfPage,
  }
}
