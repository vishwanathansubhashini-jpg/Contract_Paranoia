"""
PersistenceService — SQLite-based storage for Contract Paranoia.

Stores documents, chat history, clauses, risk scores, and metrics.
ADK session state is handled separately by SqliteSessionService.
"""

import logging
import os
import time
import uuid

import aiosqlite

from .base import BasePersistenceService
from .models import (
    ClauseRecord,
    Document,
    Message,
    Metrics,
    RiskScore,
    SessionRecord,
)

logger = logging.getLogger("para.persistence")

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size_bytes INTEGER,
    upload_source TEXT NOT NULL DEFAULT 'upload',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    document_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    started_at REAL NOT NULL,
    ended_at REAL,
    duration_seconds INTEGER,
    parent_session_id TEXT,
    FOREIGN KEY (document_id) REFERENCES documents(id),
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    clause_id TEXT,
    created_at REAL NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS clauses (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    document_id TEXT,
    clause_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    analysis TEXT NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS risk_scores (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    document_id TEXT,
    score INTEGER NOT NULL,
    grade TEXT NOT NULL,
    total_clauses INTEGER NOT NULL,
    red_count INTEGER NOT NULL,
    yellow_count INTEGER NOT NULL,
    green_count INTEGER NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_document ON sessions(document_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_clauses_session ON clauses(session_id);
CREATE INDEX IF NOT EXISTS idx_clauses_document ON clauses(document_id);
CREATE INDEX IF NOT EXISTS idx_clauses_severity ON clauses(severity);
"""


class PersistenceService(BasePersistenceService):
    def __init__(
        self,
        db_path: str | None = None,
        uploads_dir: str | None = None,
    ):
        data_dir = os.environ.get("DATA_DIR", "data")
        self.db_path = db_path or os.path.join(data_dir, "app.db")
        self.uploads_dir = uploads_dir or os.path.join(data_dir, "uploads")
        self._db: aiosqlite.Connection | None = None

    async def initialize(self):
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        os.makedirs(self.uploads_dir, exist_ok=True)

        self._db = await aiosqlite.connect(self.db_path)
        self._db.row_factory = aiosqlite.Row
        # WAL mode: faster writes on Cloud Run's /tmp filesystem
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA synchronous=NORMAL")
        await self._db.executescript(SCHEMA)
        await self._db.commit()
        logger.info("Database initialized: %s", self.db_path)

    async def close(self):
        if self._db:
            await self._db.close()
            self._db = None

    @property
    def db(self) -> aiosqlite.Connection:
        if not self._db:
            raise RuntimeError("PersistenceService not initialized")
        return self._db

    # ── Documents ─────────────────────────────────────────────────────────

    async def create_document(
        self,
        filename: str,
        file_path: str,
        file_type: str,
        file_size_bytes: int | None = None,
        upload_source: str = "upload",
    ) -> Document:
        now = time.time()
        doc = Document(
            id=str(uuid.uuid4()),
            filename=filename,
            file_path=file_path,
            file_type=file_type,
            file_size_bytes=file_size_bytes,
            upload_source=upload_source,
            created_at=now,
            updated_at=now,
        )
        await self.db.execute(
            "INSERT INTO documents (id, filename, file_path, file_type, file_size_bytes, upload_source, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (doc.id, doc.filename, doc.file_path, doc.file_type, doc.file_size_bytes, doc.upload_source, doc.created_at, doc.updated_at),
        )
        await self.db.commit()
        return doc

    async def get_document(self, doc_id: str) -> Document | None:
        async with self.db.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)) as cur:
            row = await cur.fetchone()
            return Document(**dict(row)) if row else None

    async def list_documents(self, limit: int = 50, offset: int = 0) -> list[Document]:
        async with self.db.execute(
            "SELECT * FROM documents ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ) as cur:
            rows = await cur.fetchall()
            return [Document(**dict(r)) for r in rows]

    # ── Sessions ──────────────────────────────────────────────────────────

    async def create_session(
        self,
        session_id: str,
        user_id: str,
        document_id: str | None = None,
        parent_session_id: str | None = None,
    ) -> SessionRecord:
        session = SessionRecord(
            id=session_id,
            user_id=user_id,
            document_id=document_id,
            status="resumed" if parent_session_id else "active",
            started_at=time.time(),
            parent_session_id=parent_session_id,
        )
        await self.db.execute(
            "INSERT INTO sessions (id, user_id, document_id, status, started_at, parent_session_id) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session.id, session.user_id, session.document_id, session.status, session.started_at, session.parent_session_id),
        )
        await self.db.commit()
        return session

    async def end_session(self, session_id: str, duration_seconds: int) -> None:
        await self.db.execute(
            "UPDATE sessions SET status = 'completed', ended_at = ?, duration_seconds = ? WHERE id = ?",
            (time.time(), duration_seconds, session_id),
        )
        await self.db.commit()

    async def get_session(self, session_id: str) -> SessionRecord | None:
        async with self.db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)) as cur:
            row = await cur.fetchone()
            return SessionRecord(**dict(row)) if row else None

    async def list_sessions(self, document_id: str | None = None, limit: int = 50) -> list[SessionRecord]:
        if document_id:
            query = "SELECT * FROM sessions WHERE document_id = ? ORDER BY started_at DESC LIMIT ?"
            params = (document_id, limit)
        else:
            query = "SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?"
            params = (limit,)
        async with self.db.execute(query, params) as cur:
            rows = await cur.fetchall()
            return [SessionRecord(**dict(r)) for r in rows]

    async def delete_session(self, session_id: str) -> None:
        await self.db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        await self.db.execute("DELETE FROM clauses WHERE session_id = ?", (session_id,))
        await self.db.execute("DELETE FROM risk_scores WHERE session_id = ?", (session_id,))
        await self.db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        await self.db.commit()

    async def get_session_preview(self, session_id: str) -> str | None:
        """Get a preview name: first para message or first clause type."""
        async with self.db.execute(
            "SELECT text FROM messages WHERE session_id = ? AND role = 'para' ORDER BY created_at ASC LIMIT 1",
            (session_id,),
        ) as cur:
            row = await cur.fetchone()
            if row:
                text = row[0]
                return text[:60].strip()
        async with self.db.execute(
            "SELECT clause_type FROM clauses WHERE session_id = ? ORDER BY created_at ASC LIMIT 1",
            (session_id,),
        ) as cur:
            row = await cur.fetchone()
            if row:
                return row[0]
        return None

    async def link_document(self, session_id: str, document_id: str) -> None:
        await self.db.execute(
            "UPDATE sessions SET document_id = ? WHERE id = ?",
            (document_id, session_id),
        )
        await self.db.commit()

    # ── Messages ──────────────────────────────────────────────────────────

    async def save_message(
        self,
        session_id: str,
        role: str,
        text: str,
        clause_id: str | None = None,
    ) -> Message:
        msg = Message(
            id=str(uuid.uuid4()),
            session_id=session_id,
            role=role,
            text=text,
            clause_id=clause_id,
            created_at=time.time(),
        )
        await self.db.execute(
            "INSERT INTO messages (id, session_id, role, text, clause_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (msg.id, msg.session_id, msg.role, msg.text, msg.clause_id, msg.created_at),
        )
        await self.db.commit()
        return msg

    async def get_messages(self, session_id: str) -> list[Message]:
        async with self.db.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC",
            (session_id,),
        ) as cur:
            rows = await cur.fetchall()
            return [Message(**dict(r)) for r in rows]

    # ── Clauses ───────────────────────────────────────────────────────────

    async def save_clause(
        self,
        clause_data: dict,
        session_id: str,
        document_id: str | None = None,
    ) -> None:
        await self.db.execute(
            "INSERT OR IGNORE INTO clauses (id, session_id, document_id, clause_type, severity, raw_text, analysis, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                clause_data["id"],
                session_id,
                document_id,
                clause_data["clause_type"],
                clause_data["severity"],
                clause_data["raw_text"],
                clause_data["analysis"],
                clause_data.get("timestamp", time.time()),
            ),
        )
        await self.db.commit()

    async def get_clauses(
        self,
        session_id: str | None = None,
        document_id: str | None = None,
    ) -> list[ClauseRecord]:
        if session_id:
            query = "SELECT * FROM clauses WHERE session_id = ? ORDER BY created_at ASC"
            params = (session_id,)
        elif document_id:
            query = "SELECT * FROM clauses WHERE document_id = ? ORDER BY created_at ASC"
            params = (document_id,)
        else:
            query = "SELECT * FROM clauses ORDER BY created_at DESC LIMIT 100"
            params = ()
        async with self.db.execute(query, params) as cur:
            rows = await cur.fetchall()
            return [ClauseRecord(**dict(r)) for r in rows]

    # ── Risk Scores ───────────────────────────────────────────────────────

    async def save_risk_score(
        self,
        session_id: str,
        score_data: dict,
        document_id: str | None = None,
    ) -> None:
        await self.db.execute(
            "INSERT INTO risk_scores (id, session_id, document_id, score, grade, total_clauses, red_count, yellow_count, green_count, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                session_id,
                document_id,
                score_data.get("score", 0),
                score_data.get("grade", "UNKNOWN"),
                score_data.get("total_clauses", 0),
                score_data.get("red_count", 0),
                score_data.get("yellow_count", 0),
                score_data.get("green_count", 0),
                time.time(),
            ),
        )
        await self.db.commit()

    # ── Metrics ───────────────────────────────────────────────────────────

    async def get_metrics(self) -> Metrics:
        async with self.db.execute("SELECT COUNT(*) FROM sessions") as cur:
            total_sessions = (await cur.fetchone())[0]
        async with self.db.execute("SELECT COUNT(*) FROM documents") as cur:
            total_documents = (await cur.fetchone())[0]
        async with self.db.execute("SELECT COUNT(*) FROM clauses") as cur:
            total_clauses = (await cur.fetchone())[0]
        async with self.db.execute(
            "SELECT severity, COUNT(*) FROM clauses GROUP BY severity"
        ) as cur:
            rows = await cur.fetchall()
            by_severity = {r[0]: r[1] for r in rows}
        async with self.db.execute("SELECT AVG(score) FROM risk_scores") as cur:
            avg_score = (await cur.fetchone())[0]
        async with self.db.execute("SELECT COUNT(*) FROM risk_scores") as cur:
            total_reviews = (await cur.fetchone())[0]

        return Metrics(
            total_sessions=total_sessions,
            total_documents=total_documents,
            total_clauses=total_clauses,
            clauses_by_severity=by_severity,
            avg_risk_score=round(avg_score, 1) if avg_score else None,
            total_reviews=total_reviews,
        )
