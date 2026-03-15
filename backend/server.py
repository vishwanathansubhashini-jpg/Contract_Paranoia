"""
server.py — Contract Paranoia Backend (ADK + REST)
====================================================
Full backend: ADK Runner.run_live() WebSocket + REST API for persistence.

Architecture:
  Browser <--WebSocket--> This Server (ADK Runner) <--ADK--> Gemini Live API
  Browser <--REST--> This Server (persistence, judge eval, reports)

Run:
    uvicorn server:app --host 0.0.0.0 --port 8000 --reload
"""

import asyncio
import base64
import json
import logging
import os
import pathlib
import time
import uuid
from contextlib import asynccontextmanager

import aiofiles
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from google import genai
from google.genai import types

from google.adk import Runner
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig
from google.adk.sessions.in_memory_session_service import InMemorySessionService

from para_agent import para_agent, AGENT_MODEL
from config.secrets import get_secret
from persistence import create_persistence_service

# Lazy imports
try:
    from services.pdf_report import PdfReportService
    HAS_PDF = True
except ImportError:
    HAS_PDF = False

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────
GCP_PROJECT_ID = os.environ.get("GCP_PROJECT", "")
GOOGLE_API_KEY = get_secret("GOOGLE_API_KEY", GCP_PROJECT_ID) or os.environ.get("GOOGLE_API_KEY", "")
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")
DATA_DIR = os.environ.get("DATA_DIR", "data")
VOICE_NAME = os.environ.get("PARA_VOICE", "Charon")
ACCESS_PIN = os.environ.get("ACCESS_PIN", "para2026")
APP_NAME = "contract_paranoia"
GREETING_PROMPT = "Session started. Greet the user."
RESUME_PROMPT = "Session resumed after reconnection. Do NOT greet again. Just say 'I'm back, where were we?' in one short sentence and continue."

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("para")

# ─────────────────────────────────────────────────────────────────────────────
# SERVICES
# ─────────────────────────────────────────────────────────────────────────────
os.makedirs(DATA_DIR, exist_ok=True)
persistence = create_persistence_service()
pdf_service = PdfReportService(bucket_name=os.environ.get("GCS_BUCKET")) if HAS_PDF else None

GOOGLE_CLOUD_LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")

# Use Vertex AI if project is set, otherwise fall back to Gemini API
if GCP_PROJECT_ID:
    genai_client = genai.Client(
        vertexai=True,
        project=GCP_PROJECT_ID,
        location="global",
    )
    logger.info("Using Vertex AI (project=%s, location=global)", GCP_PROJECT_ID)
else:
    genai_client = genai.Client(
        api_key=GOOGLE_API_KEY,
        http_options={"api_version": "v1beta"},
    )
    logger.info("Using Gemini API (api_key)")

# ADK services
session_service = InMemorySessionService()
runner = Runner(
    agent=para_agent,
    app_name=APP_NAME,
    session_service=session_service,
)

# Active WebSocket sessions
active_sessions: dict[str, dict] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    await persistence.initialize()
    logger.info("Contract Paranoia (ADK) starting")
    logger.info("Agent: %s | Model: %s | Key: %s", para_agent.name, AGENT_MODEL, "set" if GOOGLE_API_KEY else "MISSING")
    yield
    await persistence.close()
    active_sessions.clear()


# ─────────────────────────────────────────────────────────────────────────────
# APP
# ─────────────────────────────────────────────────────────────────────────────
app = FastAPI(title="Contract Paranoia", version="5.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# HEALTH
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "model": AGENT_MODEL,
        "agent": para_agent.name,
        "framework": "google-adk",
        "active_sessions": len(active_sessions),
        "has_api_key": bool(GOOGLE_API_KEY),
    }


# "/" is served by StaticFiles mount (frontend dist/) in production.
# If dist/ doesn't exist (dev mode), fall back to JSON info.
@app.get("/app-info")
async def app_info():
    return {"app": "Contract Paranoia", "version": "5.0.0", "framework": "Google ADK"}


@app.post("/api/auth")
async def auth(body: dict):
    """Simple PIN-based access gate."""
    pin = body.get("pin", "")
    if pin == ACCESS_PIN:
        return {"ok": True}
    logger.warning("Auth failed: wrong PIN from client")
    return JSONResponse(status_code=401, content={"ok": False, "error": "Invalid PIN"})


# ─────────────────────────────────────────────────────────────────────────────
# WEBSOCKET SESSION — ADK Runner.run_live()
# ─────────────────────────────────────────────────────────────────────────────
@app.websocket("/ws/session")
async def websocket_session(ws: WebSocket):
    await ws.accept()
    sid = str(uuid.uuid4())[:8]
    user_id = f"user_{sid}"
    session_id = f"session_{sid}"
    logger.info("[%s] Client connected", sid)

    if not GOOGLE_API_KEY:
        await ws.send_json({"type": "error", "text": "Server missing GOOGLE_API_KEY"})
        await ws.close()
        return

    # Create ADK session
    adk_session = await session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )
    logger.info("[%s] ADK session: %s", sid, adk_session.id)

    # Persist session
    await persistence.create_session(session_id=session_id, user_id=user_id)

    # Create live request queue for bidirectional streaming
    live_queue = LiveRequestQueue()

    # Configure for voice output
    run_config = RunConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name=VOICE_NAME
                )
            )
        ),
        realtime_input_config=types.RealtimeInputConfig(
            automaticActivityDetection=types.AutomaticActivityDetection(
                disabled=True,
            ),
            activityHandling="START_OF_ACTIVITY_INTERRUPTS",
            turnCoverage="TURN_INCLUDES_ALL_INPUT",
        ),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=15000,
            sliding_window=types.SlidingWindow(target_tokens=8000),
        ),
    )

    await ws.send_json({"type": "status", "status": "connecting", "session_id": session_id})
    active_sessions[sid] = {"started": time.time(), "user_id": user_id, "session_id": session_id}

    try:
        # ── Browser → ADK (via LiveRequestQueue) ─────────────────────
        async def forward_to_adk():
            frame_count = 0
            audio_in_count = 0
            is_reconnect = False
            clause_history = ""
            chat_history = ""
            try:
                # Check if first message is a reconnect signal
                try:
                    first_raw = await asyncio.wait_for(ws.receive_text(), timeout=1.0)
                    first_msg = json.loads(first_raw)
                    if first_msg.get("type") == "reconnect":
                        is_reconnect = True
                        clause_history = first_msg.get("clauses", "")
                        chat_history = first_msg.get("chat", "")
                        logger.info("[%s] Reconnect — %d chars clauses, %d chars chat", sid, len(clause_history), len(chat_history))
                except (asyncio.TimeoutError, json.JSONDecodeError):
                    pass

                await asyncio.sleep(0.3)

                # Send greeting or resume prompt with full context
                if is_reconnect and (clause_history or chat_history):
                    parts = ["Session resumed after brief reconnection. You were analyzing a contract."]
                    if chat_history:
                        parts.append(f"Recent conversation:\n{chat_history}")
                    if clause_history:
                        parts.append(f"Clauses already flagged (DO NOT re-analyze):\n{clause_history}")
                    parts.append(
                        "Continue the conversation naturally from where you left off. "
                        "Say something like 'Still here, looking at your document' in ONE short sentence. "
                        "Reference the document name or last topic if you can see it in the context. "
                        "NEVER say 'Hey I'm Para'. NEVER greet. NEVER start over. NEVER re-analyze flagged clauses. NEVER ask what contract."
                    )
                    prompt = "\n\n".join(parts)
                elif is_reconnect:
                    prompt = RESUME_PROMPT
                else:
                    prompt = GREETING_PROMPT
                live_queue.send_content(
                    types.Content(
                        role="user",
                        parts=[types.Part(text=prompt)],
                    )
                )
                logger.info("[%s] Sent %s prompt", sid, "resume+history" if clause_history else "resume" if is_reconnect else "greeting")

                async for raw in ws.iter_text():
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    t = msg.get("type")

                    if t == "audio":
                        audio_bytes = base64.b64decode(msg["data"])
                        if len(audio_bytes) > 0:
                            audio_in_count += 1
                            if audio_in_count <= 3 or audio_in_count % 200 == 0:
                                logger.info("[%s] Mic audio #%d (%d bytes)", sid, audio_in_count, len(audio_bytes))
                            live_queue.send_realtime(
                                types.Blob(data=audio_bytes, mime_type="audio/pcm;rate=16000")
                            )

                    elif t == "frame":
                        try:
                            frame_bytes = base64.b64decode(msg["data"])
                            frame_count += 1
                            if frame_count <= 3 or frame_count % 30 == 0:
                                logger.info("[%s] Frame #%d (%d bytes)", sid, frame_count, len(frame_bytes))
                            live_queue.send_realtime(
                                types.Blob(data=frame_bytes, mime_type="image/jpeg")
                            )
                        except Exception as e:
                            logger.warning("[%s] Frame send failed (skipping): %s", sid, e)

                    elif t == "text":
                        text = msg.get("data", "").strip()
                        if text:
                            logger.info("[%s] User text: %s", sid, text[:80])
                            live_queue.send_content(
                                types.Content(
                                    role="user",
                                    parts=[types.Part(text=text)],
                                )
                            )

                    elif t == "activity_start":
                        logger.info("[%s] Activity START", sid)
                        live_queue.send_activity_start()

                    elif t == "activity_end":
                        logger.info("[%s] Activity END", sid)
                        live_queue.send_activity_end()

            except WebSocketDisconnect:
                logger.info("[%s] Client disconnected", sid)
            except Exception as e:
                logger.error("[%s] Forward error: %s", sid, e, exc_info=True)
            finally:
                live_queue.close()

        # ── ADK → Browser (events from Runner.run_live) ──────────────
        async def forward_from_adk():
            audio_chunk_count = 0
            last_output_text = ""
            total_output_sent = ""  # all text sent this turn (for dedup)
            last_input_text = ""
            try:
                await ws.send_json({"type": "status", "status": "scanning"})

                async for event in runner.run_live(
                    user_id=user_id,
                    session_id=session_id,
                    live_request_queue=live_queue,
                    run_config=run_config,
                ):
                    # Interruption
                    if event.interrupted:
                        await ws.send_json({"type": "interrupted"})
                        continue

                    # Process content parts
                    if event.content and event.content.parts:
                        for part in event.content.parts:
                            # Audio → browser
                            if part.inline_data and part.inline_data.data:
                                mime = part.inline_data.mime_type or ""
                                if "audio" in mime:
                                    audio_chunk_count += 1
                                    raw_data = part.inline_data.data
                                    b64 = base64.b64encode(raw_data).decode() if isinstance(raw_data, bytes) else raw_data
                                    await ws.send_json({"type": "audio", "data": b64})
                                    if audio_chunk_count <= 3 or audio_chunk_count % 100 == 0:
                                        logger.info("[%s] Audio #%d", sid, audio_chunk_count)

                            # Function response → clause/summary
                            if part.function_response:
                                await _handle_tool_response(ws, sid, session_id, part.function_response)

                    # State delta — risk summary
                    if event.actions and event.actions.state_delta:
                        state = event.actions.state_delta
                        if "risk_summary" in state:
                            await ws.send_json({"type": "summary", "data": state["risk_summary"]})

                    # Output transcription
                    if event.output_transcription and event.output_transcription.text:
                        out_text = event.output_transcription.text.strip()
                        if out_text:
                            # Compute delta — handle cumulative, delta, and repeat transcriptions
                            normalized = out_text.replace("  ", " ")
                            norm_sent = total_output_sent.replace("  ", " ")
                            if out_text.startswith(last_output_text) and last_output_text:
                                # Cumulative: extract only new suffix
                                delta = out_text[len(last_output_text):]
                            elif normalized in norm_sent or norm_sent.endswith(normalized):
                                # Already sent (final repeat or overlap) — skip
                                delta = ""
                            else:
                                delta = out_text
                            last_output_text = out_text
                            if delta.strip():
                                total_output_sent += " " + delta
                                await ws.send_json({"type": "transcript", "role": "para", "text": delta})

                    # Input transcription (send delta, not cumulative)
                    if event.input_transcription and event.input_transcription.text:
                        user_text = event.input_transcription.text.strip()
                        ascii_ratio = sum(1 for c in user_text if ord(c) < 128) / max(len(user_text), 1)
                        # Filter non-English: check for non-ASCII chars, diacritics, or very short text
                        has_non_english = any(ord(c) > 127 for c in user_text)
                        is_noise = (
                            len(user_text) < 2
                            or ascii_ratio < 0.8
                            or has_non_english
                            or "<noise>" in user_text.lower()
                        )
                        if not is_noise:
                            if user_text.startswith(last_input_text) and last_input_text:
                                delta = user_text[len(last_input_text):]
                            else:
                                delta = user_text
                            last_input_text = user_text
                            if delta.strip():
                                await ws.send_json({"type": "transcript", "role": "user", "text": delta.strip()})

                    # Grounding / citations
                    if event.grounding_metadata:
                        citations = _extract_citations(event.grounding_metadata)
                        if citations:
                            await ws.send_json({"type": "citations", "citations": citations})

                    # Turn complete
                    if event.turn_complete:
                        logger.info("[%s] Turn complete (%d audio chunks)", sid, audio_chunk_count)
                        await ws.send_json({"type": "turn_complete"})
                        # Persist Para's transcription before resetting
                        if last_output_text:
                            await persistence.save_message(session_id, "para", last_output_text)
                        audio_chunk_count = 0
                        last_output_text = ""
                        total_output_sent = ""
                        last_input_text = ""

            except Exception as e:
                err_str = str(e)
                # 1000 = normal close (browser disconnected) — not an error
                if "1000" in err_str:
                    logger.info("[%s] Gemini session closed normally", sid)
                else:
                    logger.error("[%s] ADK receive error: %s", sid, e, exc_info=True)
                    try:
                        await ws.send_json({"type": "error", "text": err_str})
                    except Exception:
                        pass

        await asyncio.gather(forward_to_adk(), forward_from_adk(), return_exceptions=True)

    except Exception as e:
        logger.error("[%s] Session error: %s", sid, e, exc_info=True)
    finally:
        active_sessions.pop(sid, None)
        await persistence.end_session(session_id, int(time.time() - active_sessions.get(sid, {}).get("started", time.time())))
        logger.info("[%s] Session ended", sid)


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS — Tool responses & citations
# ─────────────────────────────────────────────────────────────────────────────
async def _handle_tool_response(ws: WebSocket, sid: str, session_id: str, func_response):
    """Handle function responses from ADK tool calls."""
    try:
        name = getattr(func_response, "name", "")
        response = getattr(func_response, "response", None)

        if name == "flag_clause" and response:
            result = response if isinstance(response, dict) else {}
            clause = result.get("clause")
            if clause:
                await ws.send_json({"type": "clause", "clause": clause})
                logger.info("[%s] Flagged: %s [%s]", sid, clause.get("clause_type"), clause.get("severity"))
                # Persist clause
                await persistence.save_clause(clause, session_id)

        elif name == "score_risk" and response:
            result = response if isinstance(response, dict) else {}
            await ws.send_json({"type": "summary", "data": result})
            logger.info("[%s] Risk score: %s", sid, result.get("grade"))

        elif name == "save_note" and response:
            result = response if isinstance(response, dict) else {}
            await ws.send_json({"type": "note_saved", "data": result})

    except Exception as e:
        logger.warning("[%s] Tool response error: %s", sid, e)


def _extract_citations(grounding_metadata) -> list[dict]:
    """Extract Google Search citations from grounding metadata."""
    citations = []
    try:
        chunks = getattr(grounding_metadata, "grounding_chunks", None)
        if chunks:
            for chunk in chunks:
                web = getattr(chunk, "web", None)
                if web:
                    citations.append({
                        "title": getattr(web, "title", ""),
                        "url": getattr(web, "uri", ""),
                    })
    except Exception as e:
        logger.warning("Citation error: %s", e)
    return citations


# ─────────────────────────────────────────────────────────────────────────────
# REST API — Sessions & Persistence
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/sessions")
async def list_sessions(document_id: str | None = None, limit: int = 50):
    sessions = await persistence.list_sessions(document_id=document_id, limit=limit)
    return [s.model_dump() for s in sessions]


@app.get("/api/sessions/{session_id}")
async def get_session_detail(session_id: str):
    session = await persistence.get_session(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    messages = await persistence.get_messages(session_id)
    clauses = await persistence.get_clauses(session_id=session_id)
    return {
        "session": session.model_dump(),
        "messages": [m.model_dump() for m in messages],
        "clauses": [c.model_dump() for c in clauses],
    }


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    session = await persistence.get_session(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    await persistence.delete_session(session_id)
    return {"status": "deleted"}


@app.get("/api/sessions-list")
async def list_sessions_with_preview(limit: int = 50):
    sessions = await persistence.list_sessions(limit=limit)
    result = []
    for s in sessions:
        preview = await persistence.get_session_preview(s.id)
        d = s.model_dump()
        d["preview"] = preview
        result.append(d)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# REST API — Documents
# ─────────────────────────────────────────────────────────────────────────────
@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)):
    doc_id = str(uuid.uuid4())
    safe_name = f"{doc_id}_{file.filename}"
    file_path = os.path.join(persistence.uploads_dir, safe_name)
    content = await file.read()
    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)
    doc = await persistence.create_document(
        filename=file.filename or "unknown",
        file_path=safe_name,
        file_type=file.content_type or "application/octet-stream",
        file_size_bytes=len(content),
        upload_source="upload",
    )
    return doc.model_dump()


@app.get("/api/documents")
async def list_documents(limit: int = 50, offset: int = 0):
    docs = await persistence.list_documents(limit=limit, offset=offset)
    return [d.model_dump() for d in docs]


@app.get("/api/documents/{doc_id}")
async def get_document(doc_id: str):
    doc = await persistence.get_document(doc_id)
    if not doc:
        return JSONResponse({"error": "Document not found"}, status_code=404)
    clauses = await persistence.get_clauses(document_id=doc_id)
    sessions = await persistence.list_sessions(document_id=doc_id)
    return {
        "document": doc.model_dump(),
        "clauses": [c.model_dump() for c in clauses],
        "sessions": [s.model_dump() for s in sessions],
    }


# ─────────────────────────────────────────────────────────────────────────────
# REST API — PDF Reports
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/sessions/{session_id}/report")
async def generate_report(session_id: str):
    if not pdf_service:
        return JSONResponse({"error": "PDF not available"}, status_code=501)
    session = await persistence.get_session(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    clauses = await persistence.get_clauses(session_id=session_id)
    if not clauses:
        return JSONResponse({"error": "No clauses"}, status_code=404)
    red = sum(1 for c in clauses if c.severity == "RED")
    yellow = sum(1 for c in clauses if c.severity == "YELLOW")
    green = sum(1 for c in clauses if c.severity == "GREEN")
    # Match score_risk tool formula: 100 - (RED × 20) - (YELLOW × 5) + (GREEN × 2)
    risk_score = max(0, min(100, 100 - (red * 20) - (yellow * 5) + (green * 2)))
    risk_grade = "HIGH RISK" if risk_score < 50 else "MODERATE RISK" if risk_score < 80 else "LOW RISK"
    return await pdf_service.generate_and_upload(session, clauses, risk_score, risk_grade)


# ─────────────────────────────────────────────────────────────────────────────
# REST API — Judge Agent Evaluation
# ─────────────────────────────────────────────────────────────────────────────
JUDGE_MODEL = "gemini-2.5-flash"

JUDGE_PROMPT = """You are the Supreme Auditor for Para, a real-time AI Legal Guardian.
Perform a deep Chain-of-Thought (CoT) analysis on the provided session data.

TASK 1: Legal CoT Validation
- Verify Para extracted the correct clauses (e.g., Liability Waiver, Auto-Renewal, Arbitration).
- Check that severity ratings (RED/YELLOW/GREEN) are justified by the clause text.
- Validate that the risk score is consistent with the flagged clauses.

TASK 2: Barge-in Logic Audit
- Analyze the conversation logs for user interruptions.
- Barge-in Performance: Did Para stop speaking and acknowledge interruptions gracefully?
- Recovery: Did Para continue without repeating its previous long response?

TASK 3: Grounding & Hallucination Check
- Verify all legal claims reference real legal concepts (not fabricated).
- Estimate grounding confidence (fraction of verifiable claims).

Return a JSON object:

{
  "overall_grade": "A" | "B" | "C" | "D" | "F",
  "overall_score": 0-100,
  "reasoning_trace": [
    "Step 1: Extracted N clauses covering [legal categories]",
    "Step 2: Cross-referenced against [relevant law area] — severity ratings [assessment]",
    "Step 3: Barge-in audit — [how Para handled interruptions]",
    "Step 4: Plain-language quality [assessment] — actionability [assessment]",
    "Step 5: Grounding verification — [hallucination check result]"
  ],
  "checks": [
    {"name": "check name", "status": "pass" | "warn" | "fail", "detail": "one-line explanation"}
  ],
  "missed_risks": ["contract risks NOT flagged that should have been"],
  "grounding_check": "Pass/Fail - whether legal claims are backed by verifiable sources",
  "persona_check": "Pass/Fail - whether Para maintained authoritative protective tone",
  "bargein_grade": "Pass/Fail - whether Para handled user interruptions gracefully",
  "hallucination_detected": false,
  "grounding_confidence": 0.0-1.0,
  "verdict": "1-2 sentence final assessment"
}

Checks: SEVERITY_ACCURACY, COVERAGE, ANALYSIS_DEPTH, ACTIONABILITY, LEGAL_GROUNDING, COMPLETENESS, FALSE_POSITIVES, PLAIN_LANGUAGE, BARGEIN_HANDLING.

For BARGEIN_HANDLING: evaluate whether Para stopped promptly on interruption and recovered without repeating.
For grounding_confidence: estimate the fraction of claims that are factually verifiable (0.0 to 1.0).
For hallucination_detected: set to true ONLY if any flagged clause contains fabricated legal concepts.

Return ONLY valid JSON, no markdown fences."""


@app.post("/api/sessions/{session_id}/evaluate")
async def evaluate_session(session_id: str):
    session = await persistence.get_session(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    clauses = await persistence.get_clauses(session_id=session_id)
    if not clauses:
        return JSONResponse({"error": "No clauses to evaluate"}, status_code=404)
    clause_text = "\n".join(
        f"- [{c.severity}] {c.clause_type}: {c.analysis} (raw: \"{c.raw_text[:200]}\")"
        for c in clauses
    )
    # Include conversation logs for barge-in audit
    messages = await persistence.get_messages(session_id)
    convo_log = "\n".join(
        f"[{m.role}] {m.text[:150]}" for m in messages[-20:]  # Last 20 messages
    ) if messages else "No conversation logs available"
    prompt = JUDGE_PROMPT + f"\n\nCLAUSES FLAGGED:\n{clause_text}\n\nCONVERSATION LOG:\n{convo_log}"
    try:
        response = genai_client.models.generate_content(model=JUDGE_MODEL, contents=prompt)
        raw = response.text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        result = json.loads(raw)
        logger.info("Judge: grade=%s score=%s", result.get("overall_grade"), result.get("overall_score"))
        return result
    except Exception as e:
        logger.error("Judge eval failed: %s", e)
        return JSONResponse({"error": f"Evaluation failed: {e}"}, status_code=500)


# ─────────────────────────────────────────────────────────────────────────────
# REST API — Metrics
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/metrics")
async def get_metrics():
    metrics = await persistence.get_metrics()
    return metrics.model_dump()


# ─────────────────────────────────────────────────────────────────────────────
# SERVE STATIC
# ─────────────────────────────────────────────────────────────────────────────
REPORTS_DIR = pathlib.Path(DATA_DIR) / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/reports", StaticFiles(directory=str(REPORTS_DIR)), name="reports")

DIST_DIR = pathlib.Path(__file__).parent / "dist"
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
