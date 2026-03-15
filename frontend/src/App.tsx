import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useParaSession } from './hooks/useParaSession'
import { Severity, ChatMessage, Clause } from './lib/types'

const API_BASE = import.meta.env.VITE_API_URL || ''

function PinGate({ onAuth }: { onAuth: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Check if already authed
  useEffect(() => {
    if (sessionStorage.getItem('cp_auth') === '1') onAuth()
  }, [onAuth])

  const submit = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
      if (res.ok) {
        sessionStorage.setItem('cp_auth', '1')
        onAuth()
      } else {
        setError('Wrong PIN')
      }
    } catch {
      setError('Server unreachable')
    }
    setLoading(false)
  }

  return (
    <div className="pin-gate">
      <div className="pin-box">
        <div className="logo-mark" style={{ width: 40, height: 40, margin: '0 auto 16px' }}>
          <svg width="18" height="18" viewBox="0 0 14 14" fill="none">
            <path d="M1 1h5v5H1zM8 1h5v5H8zM1 8h5v5H1z" fill="white" opacity="0.9" />
            <rect x="8.5" y="8.5" width="4" height="4" rx="1" fill="white" opacity="0.35" />
          </svg>
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--txt)', margin: '0 0 4px', letterSpacing: '-0.02em' }}>
          Contract<em style={{ color: 'var(--accent)', fontStyle: 'normal' }}>Paranoia</em>
        </h2>
        <p style={{ fontSize: 12, color: 'var(--txt3)', margin: '0 0 20px' }}>Enter access PIN to continue</p>
        <input
          className="pin-input"
          type="password"
          value={pin}
          onChange={e => setPin(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="PIN"
          autoFocus
        />
        {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
        <button className="pin-btn" onClick={submit} disabled={loading || !pin}>
          {loading ? 'Checking...' : 'Enter'}
        </button>
      </div>
    </div>
  )
}

interface PastSession {
  id: string
  preview: string | null
  status: string
  started_at: number
  ended_at: number | null
  duration_seconds: number | null
  messages: ChatMessage[]
  clauses: Clause[]
}

export default function App() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem('cp_auth') === '1')

  if (!authed) {
    return <PinGate onAuth={() => setAuthed(true)} />
  }

  return <MainApp />
}

function MainApp() {
  const {
    status,
    clauses,
    messages,
    videoFrame,
    cameraActive,
    micActive,
    userSpeaking,
    duration,
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
  } = useParaSession()

  const fileInputRef = useRef<HTMLInputElement>(null)

  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'clauses' | 'summary' | 'judge'>('clauses')
  const [sessionName, setSessionName] = useState('Untitled contract...')
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Chat history state
  const [pastSessions, setPastSessions] = useState<PastSession[]>([])
  const [viewingPastId, setViewingPastId] = useState<string | null>(null)
  const [viewingPast, setViewingPast] = useState<PastSession | null>(null)
  const [loadingPast, setLoadingPast] = useState(false)

  // Fetch past sessions on mount
  useEffect(() => {
    fetchSessions()
  }, [])

  // Refresh session list when live session ends
  useEffect(() => {
    if (status === 'idle' && sessionId) {
      fetchSessions()
    }
  }, [status, sessionId])

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions-list?limit=50`)
      if (!res.ok) return
      const data = await res.json()
      setPastSessions(data.map((s: Record<string, unknown>) => ({
        id: s.id as string,
        preview: (s.preview as string | null) || null,
        status: s.status as string,
        started_at: s.started_at as number,
        ended_at: s.ended_at as number | null,
        duration_seconds: s.duration_seconds as number | null,
        messages: [],
        clauses: [],
      })))
    } catch {
      // Backend not reachable — no past sessions
    }
  }

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${id}`, { method: 'DELETE' })
      if (!res.ok) return
      setPastSessions(prev => prev.filter(s => s.id !== id))
      if (viewingPastId === id) {
        setViewingPastId(null)
        setViewingPast(null)
      }
    } catch { /* ignore */ }
  }

  const loadPastSession = useCallback(async (id: string) => {
    if (id === viewingPastId) return
    setLoadingPast(true)
    setViewingPastId(id)
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${id}`)
      if (!res.ok) throw new Error('Failed to load session')
      const data = await res.json()
      const loadedMessages: ChatMessage[] = (data.messages || []).map((m: Record<string, unknown>) => ({
        id: m.id as string,
        role: m.role === 'para' ? 'para' : m.role === 'user' ? 'user' : 'system',
        text: m.text as string,
        timestamp: (m.created_at as number) * 1000,
      }))
      const loadedClauses: Clause[] = (data.clauses || []).map((c: Record<string, unknown>) => ({
        id: c.id as string,
        clause_type: c.clause_type as string,
        severity: c.severity as Severity,
        raw_text: c.raw_text as string,
        analysis: c.analysis as string,
        citations: [],
        timestamp: (c.created_at as number) * 1000,
      }))
      // Insert clause messages into timeline
      for (const c of loadedClauses) {
        loadedMessages.push({
          id: `clause-${c.id}`,
          role: 'clause',
          text: c.analysis,
          timestamp: c.timestamp,
          severity: c.severity,
          clause: c,
        })
      }
      loadedMessages.sort((a, b) => a.timestamp - b.timestamp)
      setViewingPast({
        id,
        preview: null,
        status: data.session?.status || 'stopped',
        started_at: data.session?.started_at || 0,
        ended_at: data.session?.ended_at || null,
        duration_seconds: data.session?.duration_seconds || null,
        messages: loadedMessages,
        clauses: loadedClauses,
      })
    } catch {
      setViewingPast(null)
      setViewingPastId(null)
    }
    setLoadingPast(false)
  }, [viewingPastId])

  const switchToLive = () => {
    setViewingPastId(null)
    setViewingPast(null)
  }

  // Determine what to display — live or past session
  const isViewingPast = viewingPast !== null
  const displayMessages = isViewingPast ? viewingPast.messages : messages
  const displayClauses = isViewingPast ? viewingPast.clauses : clauses

  const redCount = displayClauses.filter(c => c.severity === 'RED').length
  const yellowCount = displayClauses.filter(c => c.severity === 'YELLOW').length
  const greenCount = displayClauses.filter(c => c.severity === 'GREEN').length
  const msgCount = displayMessages.filter(m => m.role !== 'system').length

  const isRunning = status !== 'idle' && status !== 'connecting'
  const isLive = status !== 'idle'

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [displayMessages])

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000)
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  const handleSend = () => {
    if (isViewingPast) return
    const text = input.trim()
    if (!text) return
    sendMessage(text)
    setInput('')
  }

  const handleStop = () => {
    if (clauses.length > 0) requestSummary()
    stopSession()
  }

  const handleStart = () => {
    switchToLive()
    setError(null)
    startSession().catch(e => setError(String(e)))
  }

  // Risk score calculation
  // Match backend score_risk formula: 100 - (RED × 20) - (YELLOW × 5) + (GREEN × 2)
  const riskScore = useMemo(() => {
    if (displayClauses.length === 0) return 0
    return Math.max(0, Math.min(100, 100 - (redCount * 20) - (yellowCount * 5) + (greenCount * 2)))
  }, [redCount, yellowCount, greenCount, displayClauses.length])

  const riskColor = riskScore === 0 ? 'var(--txt3)' : riskScore >= 80 ? 'var(--green)' : riskScore >= 50 ? 'var(--amber)' : 'var(--red)'

  // Latency quality indicators
  const ttfbColor = perfMetrics.latencyMs === 0 ? 'var(--txt3)' : perfMetrics.latencyMs < 400 ? 'var(--green)' : perfMetrics.latencyMs < 800 ? 'var(--amber)' : 'var(--red)'
  const ttfbLabel = perfMetrics.latencyMs === 0 ? '—' : perfMetrics.latencyMs < 400 ? 'Elite' : perfMetrics.latencyMs < 800 ? 'Good' : 'Slow'
  const riskVerdict = riskScore === 0 ? 'No data' : riskScore >= 80 ? 'LOW RISK' : riskScore >= 50 ? 'MODERATE RISK' : 'HIGH RISK'

  const statusDotClass = isViewingPast ? '' : isRunning ? (status === 'speaking' ? 'info' : 'active') : ''
  const statusText = isViewingPast ? 'HISTORY' : !isLive ? 'OFFLINE' : status === 'connecting' ? 'CONNECTING' : status === 'thinking' ? 'ANALYZING' : status === 'speaking' ? 'SPEAKING' : status === 'interrupted' ? 'LISTENING' : 'SCANNING'

  const sevColorMap: Record<Severity, { cls: string; color: string; bg: string; label: string }> = {
    RED: { cls: 'red', color: '#ef4444', bg: 'rgba(239,68,68,0.14)', label: 'Red Flag' },
    YELLOW: { cls: 'amber', color: 'var(--amber)', bg: 'rgba(245,158,11,0.14)', label: 'Caution' },
    GREEN: { cls: 'green', color: 'var(--green)', bg: 'rgba(34,197,94,0.14)', label: 'Clear' },
  }

  const hintText = isViewingPast
    ? 'viewing past session — start a new session to chat'
    : !isLive
      ? 'start a session to activate'
      : userSpeaking
        ? 'listening to you...'
        : status === 'speaking'
          ? 'para speaking'
          : micActive
            ? 'voice mode on'
            : 'type or tap mic for voice'

  // Render a message row (shared between live and history)
  const renderMessage = (msg: ChatMessage) => {
    if (msg.role === 'system') {
      return (
        <div key={msg.id} className="msys fade-up">{msg.text}</div>
      )
    }

    if (msg.role === 'clause' && msg.clause) {
      const c = msg.clause
      const sev = sevColorMap[c.severity]
      return (
        <div key={msg.id} className="mrow fade-up">
          <div className="av av-p">P</div>
          <div className={`fc ${sev.cls}`}>
            <div className="fhead">
              <span className="fbadge" style={{ background: sev.bg, color: sev.color }}>{sev.label}</span>
              <span className="ftitle" style={{ color: sev.color }}>{c.clause_type}</span>
            </div>
            {c.raw_text && (
              <div className="fquote" style={{ borderColor: `${sev.color}44`, color: sev.color }}>
                "{c.raw_text.replace(/^"+|"+$/g, '')}"
              </div>
            )}
            <div className="ftext">{c.analysis}</div>
            {c.citations && c.citations.length > 0 && (
              <div className="cite">
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M7 2H2v12h12V9" /><path d="M10 2h4v4" /><line x1="14" y1="2" x2="7" y2="9" />
                </svg>
                {c.citations.map((cit, i) => (
                  <a key={i} href={cit.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)', textDecoration: 'none' }}>
                    {cit.title || cit.url}
                  </a>
                ))}
              </div>
            )}
            <div className="mtime">{new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        </div>
      )
    }

    if (msg.role === 'user') {
      return (
        <div key={msg.id} className="mrow user fade-up">
          <div className="bub bub-u">
            {msg.text}
            <div className="mtime" style={{ textAlign: 'right' }}>
              {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
          <div className="av av-u">U</div>
        </div>
      )
    }

    // Para message
    return (
      <div key={msg.id} className="mrow fade-up">
        <div className="av av-p">P</div>
        <div className="bub bub-p">
          <div className="blbl" style={{ color: 'var(--accent)' }}>Para</div>
          {msg.text}
          {msg.citations && msg.citations.length > 0 && (
            <div className="cite">
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M7 2H2v12h12V9" /><path d="M10 2h4v4" /><line x1="14" y1="2" x2="7" y2="9" />
              </svg>
              {msg.citations.map((cit, i) => (
                <a key={i} href={cit.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)', textDecoration: 'none', marginRight: 6 }}>
                  {cit.title || cit.url}
                </a>
              ))}
            </div>
          )}
          <div className="mtime">
            {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* NAV */}
      <nav className="cp-nav">
        <div className="logo">
          <div className="logo-mark">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1h5v5H1zM8 1h5v5H8zM1 8h5v5H1z" fill="white" opacity="0.9" />
              <rect x="8.5" y="8.5" width="4" height="4" rx="1" fill="white" opacity="0.35" />
            </svg>
          </div>
          <span className="logo-name">Contract<em>Paranoia</em></span>
          <span className="logo-tag">AI</span>
        </div>
        <div className="ndiv" />
        <input
          className="nsess"
          value={sessionName}
          onChange={e => setSessionName(e.target.value)}
          placeholder="Session name..."
        />
        <div className="nav-r">
          {/* Paranoia Mode Toggle */}
          {!isViewingPast && (
            <button
              className={`para-toggle ${paranoiaMode === 'full' ? 'full' : ''}`}
              onClick={() => switchParanoiaMode(paranoiaMode === 'standard' ? 'full' : 'standard')}
              title={paranoiaMode === 'full' ? 'Full Paranoia: flagging everything' : 'Standard: major risks only'}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              {paranoiaMode === 'full' ? 'FULL PARANOIA' : 'STANDARD'}
            </button>
          )}
          {isLive && !isViewingPast && <span className="ntimer">{formatTime(duration)}</span>}
          {isViewingPast && viewingPast.duration_seconds != null && (
            <span className="ntimer">{formatTime(viewingPast.duration_seconds)}</span>
          )}
          <div className="pill">
            <div className={`sdot ${statusDotClass}`} />
            <span>{statusText}</span>
          </div>
          {displayClauses.length > 0 && (
            <button
              className="btn"
              style={{ gap: 5, display: 'inline-flex', alignItems: 'center' }}
              onClick={async () => {
                const sid = isViewingPast ? viewingPast!.id : sessionId
                if (!sid) return
                try {
                  const res = await fetch(`${API_BASE}/api/sessions/${sid}/report`)
                  if (!res.ok) throw new Error('Report generation failed')
                  const data = await res.json()
                  const url = data.url || data.path
                  if (url) window.open(url.startsWith('http') ? url : `${API_BASE}${url}`, '_blank')
                } catch (e) {
                  console.error('[Para] PDF report error:', e)
                }
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              PDF
            </button>
          )}
          {isViewingPast ? (
            <button className="btn" onClick={switchToLive}>
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 2h12v10H9l-3 3v-3H2z" /></svg>
              Back to Live
            </button>
          ) : status === 'connecting' ? (
            <button className="btn btn-go" disabled>
              <svg width="9" height="9" viewBox="0 0 10 10"><polygon points="2,1 9,5 2,9" fill="white" /></svg>
              Connecting...
            </button>
          ) : isRunning ? (
            <button className="btn btn-halt" onClick={handleStop}>
              <svg width="8" height="8" viewBox="0 0 8 8"><rect width="8" height="8" rx="1.5" fill="currentColor" /></svg>
              Stop
            </button>
          ) : (
            <button className="btn btn-go" onClick={handleStart}>
              <svg width="9" height="9" viewBox="0 0 10 10"><polygon points="2,1 9,5 2,9" fill="white" /></svg>
              Start Session
            </button>
          )}
        </div>
      </nav>

      {/* Camera / Document PIP */}
      {videoFrame && !isViewingPast && (cameraActive || pdfPages.length > 0) && (
        <div className="cam-pip">
          <img src={`data:image/jpeg;base64,${videoFrame}`} alt="Document" style={{ width: 168, height: pdfPages.length > 0 ? 224 : 126, objectFit: 'contain', display: 'block', background: '#fff' }} />
          <div className="cbadge">
            <div className="cdot" style={pdfPages.length > 0 ? { background: 'var(--accent)' } : {}} />
            <span className="clbl">{pdfPages.length > 0 ? `PDF ${pdfPage + 1}/${pdfPages.length}` : 'LIVE'}</span>
          </div>
          {pdfPages.length > 0 && (
            <button
              onClick={() => { goToPdfPage(-999); }}
              style={{
                position: 'absolute', top: 4, right: 4, width: 20, height: 20,
                background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: '50%',
                color: '#fff', fontSize: 12, cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center', lineHeight: 1,
              }}
              title="Close PDF"
            >
              x
            </button>
          )}
          {pdfPages.length > 1 && (
            <div style={{ display: 'flex', gap: 4, padding: '4px 6px', background: 'rgba(0,0,0,0.7)', borderRadius: '0 0 8px 8px' }}>
              <button
                style={{ flex: 1, padding: '3px 0', fontSize: 11, background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', borderRadius: 4, cursor: 'pointer' }}
                onClick={() => goToPdfPage(pdfPage - 1)}
                disabled={pdfPage === 0}
              >
                Prev
              </button>
              <button
                style={{ flex: 1, padding: '3px 0', fontSize: 11, background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', borderRadius: 4, cursor: 'pointer' }}
                onClick={() => goToPdfPage(pdfPage + 1)}
                disabled={pdfPage >= pdfPages.length - 1}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* 3-COLUMN LAYOUT */}
      <div className="cp-layout">
        {/* LEFT SIDEBAR */}
        <aside className="sb">
          <div className="sb-top">
            <div className="cap">Sessions</div>
            {/* Current / new session — only show when a session is active */}
            {isLive && (
              <div
                className={`sc ${!isViewingPast ? 'on' : ''}`}
                onClick={switchToLive}
                style={{ cursor: 'pointer' }}
              >
                <div className="sc-name">
                  {sessionName}
                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--green)', fontWeight: 600, letterSpacing: '0.04em' }}>LIVE</span>
                </div>
                <div className="sc-meta">
                  <span className="sdt">{new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                  {clauses.length > 0 && (() => {
                    const lr = clauses.filter(c => c.severity === 'RED').length
                    const ly = clauses.filter(c => c.severity === 'YELLOW').length
                    const lc = '#ef4444'
                    return (
                      <span className="rbadge" style={{ background: `${lc}14`, color: lc }}>
                        {lr}R {ly}Y
                      </span>
                    )
                  })()}
                </div>
              </div>
            )}
          </div>
          <div className="slist">
            {pastSessions
              .filter(s => s.id !== sessionId)
              .map(s => {
                const isSelected = viewingPastId === s.id
                const name = s.preview || s.id.replace(/^session_/, '')
                return (
                  <div
                    key={s.id}
                    className={`sc ${isSelected ? 'on' : ''}`}
                    onClick={() => loadPastSession(s.id)}
                    style={{ cursor: 'pointer', position: 'relative' }}
                  >
                    <div className="sc-name" style={{ paddingRight: 20 }}>{name}</div>
                    <div className="sc-meta">
                      <span className="sdt">{formatDate(s.started_at)}</span>
                      {s.duration_seconds != null && s.duration_seconds > 0 && (
                        <span className="sdt">{formatTime(s.duration_seconds)}</span>
                      )}
                    </div>
                    <button
                      className="sc-del"
                      onClick={(e) => deleteSession(s.id, e)}
                      title="Delete session"
                    >
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" />
                      </svg>
                    </button>
                  </div>
                )
              })}
          </div>
          <div className="sb-bot">
            <div className="cap" style={{ marginBottom: 7 }}>
              {isViewingPast ? 'History stats' : 'Session stats'}
            </div>
            <div className="tgrid">
              <div className="tc">
                <div className="tn" style={{ color: 'var(--txt)' }}>{msgCount}</div>
                <div className="tl">Messages</div>
              </div>
              <div className="tc">
                <div className="tn" style={{ color: '#ef4444' }}>{redCount}</div>
                <div className="tl">Red</div>
              </div>
              <div className="tc">
                <div className="tn" style={{ color: 'var(--green)' }}>{greenCount}</div>
                <div className="tl">Clear</div>
              </div>
            </div>
          </div>
        </aside>

        {/* CENTER CHAT */}
        <main className="chat-col">
          {/* Scorebar */}
          <div className="scorebar">
            <div className="chip" style={{ borderColor: 'rgba(239,68,68,0.22)' }}>
              <div className="chip-n" style={{ color: '#ef4444' }}>{redCount}</div>
              <div className="chip-l" style={{ color: 'rgba(239,68,68,0.55)' }}>Red flags</div>
            </div>
            <div className="chip" style={{ borderColor: 'rgba(245,158,11,0.22)' }}>
              <div className="chip-n" style={{ color: 'var(--amber)' }}>{yellowCount}</div>
              <div className="chip-l" style={{ color: 'rgba(245,158,11,0.55)' }}>Cautions</div>
            </div>
            <div className="chip" style={{ borderColor: 'rgba(34,197,94,0.22)' }}>
              <div className="chip-n" style={{ color: 'var(--green)' }}>{greenCount}</div>
              <div className="chip-l" style={{ color: 'rgba(34,197,94,0.55)' }}>Clear</div>
            </div>
            <div className="chip">
              <div className="chip-n" style={{ color: 'var(--txt)' }}>{msgCount}</div>
              <div className="chip-l" style={{ color: 'var(--txt3)' }}>Messages</div>
            </div>
            <div className="gbox">
              <div>
                <div className="gn" style={{ color: riskColor }}>{displayClauses.length > 0 ? riskScore : '—'}</div>
                <div className="gv" style={{ color: riskColor }}>{riskVerdict}</div>
              </div>
            </div>
          </div>

          {/* Cognitive Heartbeat — Performance Strip */}
          {!isViewingPast && (
            <div className="perf-strip">
              <div className="perf-stat">
                <div className="perf-val" style={{ color: ttfbColor }}>{perfMetrics.latencyMs || '—'}</div>
                <div className="perf-lbl">TTFB <span className="perf-unit">ms</span></div>
                <div className="perf-tag" style={{ color: ttfbColor }}>{ttfbLabel}</div>
              </div>
              <div className="perf-div" />
              <div className="perf-stat">
                <div className="perf-val" style={{ color: perfMetrics.tokensPerSec > 0 ? 'var(--accent)' : 'var(--txt3)' }}>{perfMetrics.tokensPerSec || '—'}</div>
                <div className="perf-lbl">Tokens <span className="perf-unit">/s</span></div>
              </div>
              <div className="perf-div" />
              <div className="perf-stat">
                <div className="perf-val" style={{ color: perfMetrics.totalTokens > 0 ? 'var(--txt)' : 'var(--txt3)' }}>{perfMetrics.totalTokens || '—'}</div>
                <div className="perf-lbl">Total tokens</div>
              </div>
              <div className="perf-div" />
              <div className="perf-stat">
                <div className="perf-val" style={{ color: cameraActive ? 'var(--green)' : 'var(--txt3)' }}>{perfMetrics.framesSent || '—'}</div>
                <div className="perf-lbl">Frames <span className="perf-unit">sent</span></div>
              </div>
              <div className="perf-div" />
              <div className="perf-stat">
                <div className={`vad-dot ${userSpeaking ? 'speaking' : status === 'speaking' ? 'agent' : ''}`} />
                <div className="perf-lbl">{userSpeaking ? 'YOU' : status === 'speaking' ? 'PARA' : 'VAD'}</div>
              </div>
              <div className="perf-div" />
              <div className="perf-stat">
                <div className="perf-val" style={{ color: 'var(--txt2)' }}>{perfMetrics.avgLatencyMs || '—'}</div>
                <div className="perf-lbl">Avg <span className="perf-unit">ms</span></div>
              </div>
            </div>
          )}

          {/* History banner */}
          {isViewingPast && (
            <div className="msys" style={{ padding: '8px 18px', background: 'var(--bg1)', borderBottom: '1px solid var(--line)' }}>
              Viewing past session — {viewingPast.messages.length} messages, {viewingPast.clauses.length} clauses
            </div>
          )}

          {/* Messages */}
          <div className="msgs">
            {loadingPast && (
              <div className="mempty">
                <div className="etitle" style={{ fontSize: 14 }}>Loading session...</div>
              </div>
            )}

            {!loadingPast && displayMessages.length === 0 && (
              <div className="mempty">
                <div className="ering">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.22">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <div className="etitle">{isViewingPast ? 'No messages recorded' : 'Ready to scan'}</div>
                {!isViewingPast && (
                  <div className="esub">
                    Your AI legal guardian. Talk to me about your<br />
                    contract, then show me the document when you're ready.
                  </div>
                )}
                {error && (
                  <div style={{ color: 'var(--red)', fontSize: 12, fontWeight: 500, marginTop: 8 }}>{error}</div>
                )}
              </div>
            )}

            {!loadingPast && displayMessages.map(renderMessage)}

            {/* Para thinking indicator — live only */}
            {!isViewingPast && status === 'thinking' && (
              <div className="typing-row fade-up">
                <div className="av av-p">P</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.15)', borderRadius: '9px 9px 9px 3px' }}>
                  <div className="tdots"><div className="td" /><div className="td" /><div className="td" /></div>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', letterSpacing: '0.04em' }}>ANALYZING</span>
                </div>
              </div>
            )}

            {/* Para speaking indicator — live only */}
            {!isViewingPast && status === 'speaking' && (
              <div className="typing-row">
                <div className="av av-p">P</div>
                <div className="tdots"><div className="td" /><div className="td" /><div className="td" /></div>
              </div>
            )}

            {/* User speaking indicator — live only */}
            {!isViewingPast && userSpeaking && status !== 'speaking' && (
              <div className="mrow user fade-up">
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 2, height: 18,
                  padding: '10px 14px', background: 'rgba(59,130,246,0.09)',
                  border: '1px solid rgba(59,130,246,0.18)', borderRadius: '9px 3px 9px 9px',
                }}>
                  {[3, 5, 4, 6, 4].map((_, i) => (
                    <div key={i} className="vb" style={{ background: 'var(--blue)', animationDelay: `${i * 0.09}s` }} />
                  ))}
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--blue)', marginLeft: 6, letterSpacing: '0.04em' }}>LISTENING</span>
                </div>
                <div className="av av-u">U</div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Disclaimer — always visible */}
          <div className="disclaimer">
            Para is an AI assistant, not a licensed attorney. Nothing here constitutes legal advice. Always consult a qualified lawyer before signing.
          </div>

          {/* Input zone */}
          <div className="izone">
            <div className="irow">
              <button
                className={`ibtn ${micActive ? 'mic-on' : ''}`}
                onClick={toggleMic}
                disabled={!isRunning || isViewingPast}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="2" width="6" height="11" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                  <line x1="8" y1="22" x2="16" y2="22" />
                </svg>
              </button>
              <button
                className={`ibtn ${cameraActive ? 'cam-on' : ''}`}
                onClick={toggleCamera}
                disabled={!isRunning || isViewingPast}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 7l-7 5 7 5V7z" />
                  <rect x="1" y="5" width="15" height="14" rx="2" />
                </svg>
              </button>
              <button
                className="ibtn"
                onClick={() => fileInputRef.current?.click()}
                disabled={!isRunning || isViewingPast}
                title="Upload document image"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) uploadDocument(file)
                  e.target.value = ''
                }}
              />
              {micActive && userSpeaking && !isViewingPast && (
                <div className="vwave">
                  <div className="vb" /><div className="vb" /><div className="vb" /><div className="vb" /><div className="vb" />
                </div>
              )}
              <input
                className="cinput"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
                placeholder={isViewingPast ? 'Viewing past session...' : 'Ask Para anything about this contract...'}
                disabled={!isRunning || isViewingPast}
              />
              <button className="sbtn2" onClick={handleSend} disabled={!input.trim() || !isRunning || isViewingPast}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="2">
                  <path d="M14 2L2 8l5 2 2 5z" />
                </svg>
              </button>
            </div>
            <div className="ihint">{hintText}</div>
          </div>
        </main>

        {/* RIGHT PANEL */}
        <aside className="rp">
          <div className="rtabs">
            <button className={`rtab ${activeTab === 'clauses' ? 'active' : ''}`} onClick={() => setActiveTab('clauses')}>Clauses</button>
            <button className={`rtab ${activeTab === 'summary' ? 'active' : ''}`} onClick={() => setActiveTab('summary')}>Summary</button>
            <button className={`rtab ${activeTab === 'judge' ? 'active' : ''}`} onClick={() => { setActiveTab('judge'); if (!judgeEval && !judgeLoading && displayClauses.length > 0) runJudgeEval() }}>Judge</button>
          </div>

          {/* Clauses tab */}
          {activeTab === 'clauses' && (
            <div className="clist">
              {displayClauses.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px 14px', fontSize: 13, color: 'var(--txt3)', lineHeight: 1.8 }}>
                  No clauses yet<br /><span style={{ fontSize: 12, color: 'var(--txt3)', opacity: 0.7 }}>Para will list flags here as she scans</span>
                </div>
              ) : (
                displayClauses.map((c, i) => {
                  const sev = sevColorMap[c.severity]
                  return (
                    <div key={c.id} className="ccard slide-in" style={{ animationDelay: `${i * 0.05}s` }}>
                      <div className="chead">
                        <span className="fbadge" style={{ background: sev.bg, color: sev.color }}>{sev.label}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--txt)' }}>{c.clause_type}</span>
                      </div>
                      <div className="cprev">{c.analysis.slice(0, 90)}...</div>
                    </div>
                  )
                })
              )}
            </div>
          )}

          {/* Summary tab */}
          {activeTab === 'summary' && (
            <div className="sscroll">
              {displayClauses.length === 0 ? (
                <div className="sempty">Run a session<br /><span style={{ fontSize: 12, opacity: 0.7 }}>Summary appears when session ends</span></div>
              ) : (
                <>
                  <div className="ssec">Risk Score</div>
                  <div className="scard2">
                    <div className="risk-gauge">
                      <svg viewBox="0 0 120 70" width="120" height="70">
                        {/* Background arc */}
                        <path d="M 10 65 A 50 50 0 0 1 110 65" fill="none" stroke="var(--bg3)" strokeWidth="6" strokeLinecap="round" />
                        {/* Green zone (0-30) */}
                        <path d="M 10 65 A 50 50 0 0 1 40 18" fill="none" stroke="rgba(34,197,94,0.3)" strokeWidth="6" strokeLinecap="round" />
                        {/* Yellow zone (30-60) */}
                        <path d="M 40 18 A 50 50 0 0 1 80 18" fill="none" stroke="rgba(245,158,11,0.3)" strokeWidth="6" strokeLinecap="round" />
                        {/* Red zone (60-100) */}
                        <path d="M 80 18 A 50 50 0 0 1 110 65" fill="none" stroke="rgba(239,68,68,0.3)" strokeWidth="6" strokeLinecap="round" />
                        {/* Needle */}
                        <line
                          x1="60" y1="65"
                          x2={60 + 40 * Math.cos(Math.PI - (riskScore / 100) * Math.PI)}
                          y2={65 - 40 * Math.sin(Math.PI - (riskScore / 100) * Math.PI)}
                          stroke={riskColor}
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          style={{ transition: 'all 0.8s cubic-bezier(0.34,1.56,0.64,1)' }}
                        />
                        {/* Center dot */}
                        <circle cx="60" cy="65" r="4" fill={riskColor} style={{ transition: 'fill 0.5s' }} />
                        {/* Score text */}
                        <text x="60" y="56" textAnchor="middle" fill={riskColor} fontSize="18" fontWeight="800" fontFamily="var(--sans)" style={{ transition: 'fill 0.5s' }}>
                          {riskScore}
                        </text>
                      </svg>
                      <div className="sverdict" style={{ color: riskColor }}>{riskVerdict}</div>
                    </div>
                    <div className="cmini">
                      <div className="mcell"><div className="mnum" style={{ color: '#ef4444' }}>{redCount}</div><div className="mlbl">Red</div></div>
                      <div className="mcell"><div className="mnum" style={{ color: 'var(--amber)' }}>{yellowCount}</div><div className="mlbl">Amb</div></div>
                      <div className="mcell"><div className="mnum" style={{ color: 'var(--green)' }}>{greenCount}</div><div className="mlbl">OK</div></div>
                    </div>
                  </div>

                  {redCount > 0 && (
                    <>
                      <div className="ssec">Red Flags</div>
                      {displayClauses.filter(c => c.severity === 'RED').map(c => (
                        <div key={c.id} className="srow">
                          <span className="fbadge" style={{ background: 'rgba(239,68,68,0.14)', color: '#ef4444', flexShrink: 0, height: 'fit-content', marginTop: 2 }}>Red Flag</span>
                          <div>
                            <div className="stype">{c.clause_type}</div>
                            <div className="sana">{c.analysis}</div>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                  {yellowCount > 0 && (
                    <>
                      <div className="ssec">Cautions</div>
                      {displayClauses.filter(c => c.severity === 'YELLOW').map(c => (
                        <div key={c.id} className="srow">
                          <span className="fbadge" style={{ background: 'rgba(245,158,11,0.14)', color: 'var(--amber)', flexShrink: 0, height: 'fit-content', marginTop: 2 }}>Caution</span>
                          <div>
                            <div className="stype">{c.clause_type}</div>
                            <div className="sana">{c.analysis}</div>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                  {greenCount > 0 && (
                    <>
                      <div className="ssec">Clear</div>
                      {displayClauses.filter(c => c.severity === 'GREEN').map(c => (
                        <div key={c.id} className="srow">
                          <span className="fbadge" style={{ background: 'rgba(34,197,94,0.14)', color: 'var(--green)', flexShrink: 0, height: 'fit-content', marginTop: 2 }}>Clear</span>
                          <div>
                            <div className="stype">{c.clause_type}</div>
                            <div className="sana">{c.analysis}</div>
                          </div>
                        </div>
                      ))}
                    </>
                  )}

                  <div className="vbox" style={{ borderLeftColor: riskColor }}>
                    Para found <strong>{redCount} critical issue(s)</strong>.
                    {redCount > 0 ? ' Address red flags before signing.' : ' Contract appears relatively standard.'}
                    <br /><br />
                    <em style={{ fontSize: 11, color: 'var(--txt3)' }}>Para is an AI assistant, not a licensed attorney. Consult a lawyer for binding decisions.</em>
                  </div>

                </>
              )}
            </div>
          )}

          {/* Judge tab */}
          {activeTab === 'judge' && (
            <div className="sscroll">
              {judgeLoading && (
                <div style={{ textAlign: 'center', padding: '32px 14px' }}>
                  <div className="judge-spinner" />
                  <div style={{ fontSize: 13, color: 'var(--txt3)', marginTop: 12 }}>Judge Agent evaluating...</div>
                  <div style={{ fontSize: 11, color: 'var(--txt3)', opacity: 0.6, marginTop: 4 }}>Checking severity accuracy, coverage, depth...</div>
                </div>
              )}
              {!judgeLoading && !judgeEval && displayClauses.length === 0 && (
                <div className="sempty">No clauses to evaluate<br /><span style={{ fontSize: 12, opacity: 0.7 }}>Run a session first</span></div>
              )}
              {!judgeLoading && !judgeEval && displayClauses.length > 0 && (
                <div style={{ textAlign: 'center', padding: '32px 14px' }}>
                  <button className="btn" onClick={runJudgeEval} style={{ fontSize: 13 }}>Run Judge Evaluation</button>
                </div>
              )}
              {judgeEval && (
                <>
                  <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 56, height: 56, borderRadius: '50%', fontSize: 28, fontWeight: 800,
                      background: judgeEval.overall_grade === 'A' ? 'rgba(34,197,94,0.15)' : judgeEval.overall_grade === 'B' ? 'rgba(34,197,94,0.1)' : judgeEval.overall_grade === 'C' ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)',
                      color: judgeEval.overall_grade <= 'B' ? 'var(--green)' : judgeEval.overall_grade === 'C' ? 'var(--amber)' : '#ef4444',
                    }}>
                      {judgeEval.overall_grade}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6, color: 'var(--txt)' }}>Score: {judgeEval.overall_score}/100</div>
                  </div>

                  {/* Reasoning Trace */}
                  {judgeEval.reasoning_trace && judgeEval.reasoning_trace.length > 0 && (
                    <>
                      <div className="ssec">Reasoning Trace</div>
                      <div style={{ padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {judgeEval.reasoning_trace.map((step, i) => (
                          <div key={i} style={{ fontSize: 11, color: 'var(--txt2)', display: 'flex', gap: 8, lineHeight: 1.5 }}>
                            <span style={{ color: 'var(--accent)', fontWeight: 700, flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 10 }}>
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <span>{step}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  <div className="ssec">Evaluation Checks</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 12px' }}>
                    {judgeEval.checks.map((check, i) => (
                      <div key={i} className="judge-check">
                        <span className="judge-status" data-status={check.status}>
                          {check.status === 'pass' ? '\u2713' : check.status === 'warn' ? '!' : '\u2717'}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>{check.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--txt3)', lineHeight: 1.4 }}>{check.detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {judgeEval.missed_risks && (Array.isArray(judgeEval.missed_risks) ? judgeEval.missed_risks : [judgeEval.missed_risks]).length > 0 && (
                    <>
                      <div className="ssec">Missed Risks</div>
                      <div style={{ padding: '0 12px' }}>
                        {(Array.isArray(judgeEval.missed_risks) ? judgeEval.missed_risks : [judgeEval.missed_risks]).map((risk, i) => (
                          <div key={i} style={{ fontSize: 12, color: '#ef4444', padding: '4px 0', display: 'flex', gap: 6 }}>
                            <span style={{ opacity: 0.6 }}>{'\u26A0'}</span> {String(risk)}
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {/* Grounding & Hallucination checks */}
                  <div className="ssec">Validation</div>
                  <div style={{ padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {judgeEval.grounding_check && (
                      <div className="judge-check">
                        <span className="judge-status" data-status={judgeEval.grounding_check.toLowerCase().startsWith('pass') ? 'pass' : 'fail'}>
                          {judgeEval.grounding_check.toLowerCase().startsWith('pass') ? '\u2713' : '\u2717'}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>Grounding Check</div>
                          <div style={{ fontSize: 11, color: 'var(--txt3)', lineHeight: 1.4 }}>{judgeEval.grounding_check}</div>
                        </div>
                      </div>
                    )}
                    {judgeEval.persona_check && (
                      <div className="judge-check">
                        <span className="judge-status" data-status={judgeEval.persona_check.toLowerCase().startsWith('pass') ? 'pass' : 'fail'}>
                          {judgeEval.persona_check.toLowerCase().startsWith('pass') ? '\u2713' : '\u2717'}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>Persona Check</div>
                          <div style={{ fontSize: 11, color: 'var(--txt3)', lineHeight: 1.4 }}>{judgeEval.persona_check}</div>
                        </div>
                      </div>
                    )}
                    {judgeEval.bargein_grade && (
                      <div className="judge-check">
                        <span className="judge-status" data-status={judgeEval.bargein_grade.toLowerCase().startsWith('pass') ? 'pass' : 'fail'}>
                          {judgeEval.bargein_grade.toLowerCase().startsWith('pass') ? '\u2713' : '\u2717'}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>Barge-in Handling</div>
                          <div style={{ fontSize: 11, color: 'var(--txt3)', lineHeight: 1.4 }}>{judgeEval.bargein_grade}</div>
                        </div>
                      </div>
                    )}
                    <div className="judge-check">
                      <span className="judge-status" data-status={judgeEval.hallucination_detected ? 'fail' : 'pass'}>
                        {judgeEval.hallucination_detected ? '\u2717' : '\u2713'}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>Hallucination</div>
                        <div style={{ fontSize: 11, color: 'var(--txt3)', lineHeight: 1.4 }}>
                          {judgeEval.hallucination_detected ? 'Hallucination detected in output' : 'No hallucinations detected'}
                        </div>
                      </div>
                    </div>
                    {judgeEval.grounding_confidence != null && (
                      <div style={{ fontSize: 12, color: 'var(--txt2)', padding: '4px 0' }}>
                        Grounding Confidence: <strong style={{ color: judgeEval.grounding_confidence >= 0.8 ? 'var(--green)' : judgeEval.grounding_confidence >= 0.5 ? 'var(--amber)' : 'var(--red)' }}>
                          {Math.round(judgeEval.grounding_confidence * 100)}%
                        </strong>
                      </div>
                    )}
                  </div>

                  <div className="ssec">Verdict</div>
                  <div className="vbox" style={{ borderLeftColor: judgeEval.overall_grade <= 'B' ? 'var(--green)' : judgeEval.overall_grade === 'C' ? 'var(--amber)' : '#ef4444' }}>
                    {judgeEval.verdict}
                  </div>

                  <div style={{ textAlign: 'center', padding: '12px 0' }}>
                    <button className="btn" onClick={runJudgeEval} style={{ fontSize: 11, padding: '6px 14px', opacity: 0.7 }}>Re-evaluate</button>
                  </div>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  )
}
