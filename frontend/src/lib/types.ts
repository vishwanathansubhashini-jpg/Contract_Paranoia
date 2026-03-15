export type Severity = 'RED' | 'YELLOW' | 'GREEN'

export type SessionStatus =
  | 'idle'
  | 'connecting'
  | 'scanning'
  | 'thinking'
  | 'speaking'
  | 'interrupted'

export interface Citation {
  title: string
  url: string
}

export interface Clause {
  id: string
  clause_type: string
  severity: Severity
  raw_text: string
  analysis: string
  citations: Citation[]
  timestamp: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'para' | 'system' | 'clause'
  text: string
  timestamp: number
  citations?: Citation[]
  severity?: Severity
  clause?: Clause
}

export interface JudgeCheck {
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

export interface JudgeEvaluation {
  overall_grade: string
  overall_score: number
  reasoning_trace?: string[]
  checks: JudgeCheck[]
  missed_risks: string[]
  grounding_check?: string
  persona_check?: string
  bargein_grade?: string
  hallucination_detected?: boolean
  grounding_confidence?: number
  verdict: string
}

export interface PerformanceMetrics {
  /** Time to first audio byte after user stops speaking (ms) */
  latencyMs: number
  /** Rolling average latency (ms) */
  avgLatencyMs: number
  /** Tokens per second (estimated from transcription output) */
  tokensPerSec: number
  /** Total tokens generated this session */
  totalTokens: number
  /** WebSocket round-trip ping (ms) */
  wsLatencyMs: number
  /** Frames sent to Gemini this session */
  framesSent: number
  /** Connection uptime in seconds */
  uptime: number
}
