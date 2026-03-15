"""PostgresPersistenceService — asyncpg-based storage for Cloud SQL."""

import logging
import os
import time
import uuid

import asyncpg

from .base import BasePersistenceService
from .models import (
    ClauseRecord,
    Document,
    Message,
    Metrics,
    RiskScore,
    SessionRecord,
)

logger = logging.getLogger("para.persistence.pg")

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size_bytes INTEGER,
    upload_source TEXT NOT NULL DEFAULT 'upload',
    created_at DOUBLE PRECISION NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    document_id TEXT REFERENCES documents(id),
    status TEXT NOT NULL DEFAULT 'active',
    started_at DOUBLE PRECISION NOT NULL,
    ended_at DOUBLE PRECISION,
    duration_seconds INTEGER,
    parent_session_id TEXT REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    clause_id TEXT,
    created_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS clauses (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    document_id TEXT REFERENCES documents(id),
    clause_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    analysis TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_scores (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    document_id TEXT REFERENCES documents(id),
    score INTEGER NOT NULL,
    grade TEXT NOT NULL,
    total_clauses INTEGER NOT NULL,
    red_count INTEGER NOT NULL,
    yellow_count INTEGER NOT NULL,
    green_count INTEGER NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_document ON sessions(document_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_clauses_session ON clauses(session_id);
CREATE INDEX IF NOT EXISTS idx_clauses_document ON clauses(document_id);
CREATE INDEX IF NOT EXISTS idx_clauses_severity ON clauses(severity);
"""


class PostgresPersistenceService(BasePersistenceService):
    def __init__(self, dsn: str, uploads_dir: str | None = None):
        self._dsn = dsn
        self.uploads_dir = uploads_dir or os.path.join(
            os.environ.get("DATA_DIR", "data"), "uploads"
        )
        self._pool: asyncpg.Pool | None = None

    async def initialize(self) -> None:
        os.makedirs(self.uploads_dir, exist_ok=True)
        self._pool = await asyncpg.create_pool(dsn=self._dsn, min_size=2, max_size=10)
        async with self._pool.acquire() as conn:
            for stmt in SCHEMA.strip().split(";"):
                stmt = stmt.strip()
                if stmt:
                    await conn.execute(stmt)
        logger.info("PostgreSQL initialized: %s", self._dsn.split("@")[-1] if "@" in self._dsn else "***")

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()
            self._pool = None

    @property
    def pool(self) -> asyncpg.Pool:
        if not self._pool:
            raise RuntimeError("PostgresPersistenceService not initialized")
        return self._pool

    # ── Documents ─────────────────────────────────────────────

    async def create_document(
        self, filename: str, file_path: str, file_type: str,
        file_size_bytes: int | None = None, upload_source: str = "upload",
    ) -> Document:
        now = time.time()
        doc = Document(
            id=str(uuid.uuid4()), filename=filename, file_path=file_path,
            file_type=file_type, file_size_bytes=file_size_bytes,
            upload_source=upload_source, created_at=now, updated_at=now,
        )
        await self.pool.execute(
            "INSERT INTO documents (id, filename, file_path, file_type, file_size_bytes, upload_source, created_at, updated_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            doc.id, doc.filename, doc.file_path, doc.file_type,
            doc.file_size_bytes, doc.upload_source, doc.created_at, doc.updated_at,
        )
        return doc

    async def get_document(self, doc_id: str) -> Document | None:
        row = await self.pool.fetchrow("SELECT * FROM documents WHERE id = $1", doc_id)
        return Document(**dict(row)) if row else None

    async def list_documents(self, limit: int = 50, offset: int = 0) -> list[Document]:
        rows = await self.pool.fetch(
            "SELECT * FROM documents ORDER BY created_at DESC LIMIT $1 OFFSET $2",
            limit, offset,
        )
        return [Document(**dict(r)) for r in rows]

    # ── Sessions ──────────────────────────────────────────────

    async def create_session(
        self, session_id: str, user_id: str,
        document_id: str | None = None, parent_session_id: str | None = None,
    ) -> SessionRecord:
        session = SessionRecord(
            id=session_id, user_id=user_id, document_id=document_id,
            status="resumed" if parent_session_id else "active",
            started_at=time.time(), parent_session_id=parent_session_id,
        )
        await self.pool.execute(
            "INSERT INTO sessions (id, user_id, document_id, status, started_at, parent_session_id) "
            "VALUES ($1, $2, $3, $4, $5, $6)",
            session.id, session.user_id, session.document_id,
            session.status, session.started_at, session.parent_session_id,
        )
        return session

    async def end_session(self, session_id: str, duration_seconds: int) -> None:
        await self.pool.execute(
            "UPDATE sessions SET status = 'completed', ended_at = $1, duration_seconds = $2 WHERE id = $3",
            time.time(), duration_seconds, session_id,
        )

    async def get_session(self, session_id: str) -> SessionRecord | None:
        row = await self.pool.fetchrow("SELECT * FROM sessions WHERE id = $1", session_id)
        return SessionRecord(**dict(row)) if row else None

    async def list_sessions(self, document_id: str | None = None, limit: int = 50) -> list[SessionRecord]:
        if document_id:
            rows = await self.pool.fetch(
                "SELECT * FROM sessions WHERE document_id = $1 ORDER BY started_at DESC LIMIT $2",
                document_id, limit,
            )
        else:
            rows = await self.pool.fetch(
                "SELECT * FROM sessions ORDER BY started_at DESC LIMIT $1", limit,
            )
        return [SessionRecord(**dict(r)) for r in rows]

    async def delete_session(self, session_id: str) -> None:
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM messages WHERE session_id = $1", session_id)
                await conn.execute("DELETE FROM clauses WHERE session_id = $1", session_id)
                await conn.execute("DELETE FROM risk_scores WHERE session_id = $1", session_id)
                await conn.execute("DELETE FROM sessions WHERE id = $1", session_id)

    async def get_session_preview(self, session_id: str) -> str | None:
        row = await self.pool.fetchrow(
            "SELECT text FROM messages WHERE session_id = $1 AND role = 'para' ORDER BY created_at ASC LIMIT 1",
            session_id,
        )
        if row:
            return row["text"][:60].strip()
        row = await self.pool.fetchrow(
            "SELECT clause_type FROM clauses WHERE session_id = $1 ORDER BY created_at ASC LIMIT 1",
            session_id,
        )
        if row:
            return row["clause_type"]
        return None

    async def link_document(self, session_id: str, document_id: str) -> None:
        await self.pool.execute(
            "UPDATE sessions SET document_id = $1 WHERE id = $2",
            document_id, session_id,
        )

    # ── Messages ──────────────────────────────────────────────

    async def save_message(
        self, session_id: str, role: str, text: str, clause_id: str | None = None,
    ) -> Message:
        msg = Message(
            id=str(uuid.uuid4()), session_id=session_id,
            role=role, text=text, clause_id=clause_id, created_at=time.time(),
        )
        await self.pool.execute(
            "INSERT INTO messages (id, session_id, role, text, clause_id, created_at) "
            "VALUES ($1, $2, $3, $4, $5, $6)",
            msg.id, msg.session_id, msg.role, msg.text, msg.clause_id, msg.created_at,
        )
        return msg

    async def get_messages(self, session_id: str) -> list[Message]:
        rows = await self.pool.fetch(
            "SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC",
            session_id,
        )
        return [Message(**dict(r)) for r in rows]

    # ── Clauses ───────────────────────────────────────────────

    async def save_clause(
        self, clause_data: dict, session_id: str, document_id: str | None = None,
    ) -> None:
        await self.pool.execute(
            "INSERT INTO clauses (id, session_id, document_id, clause_type, severity, raw_text, analysis, created_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
            clause_data["id"], session_id, document_id,
            clause_data["clause_type"], clause_data["severity"],
            clause_data["raw_text"], clause_data["analysis"],
            clause_data.get("timestamp", time.time()),
        )

    async def get_clauses(
        self, session_id: str | None = None, document_id: str | None = None,
    ) -> list[ClauseRecord]:
        if session_id:
            rows = await self.pool.fetch(
                "SELECT * FROM clauses WHERE session_id = $1 ORDER BY created_at ASC",
                session_id,
            )
        elif document_id:
            rows = await self.pool.fetch(
                "SELECT * FROM clauses WHERE document_id = $1 ORDER BY created_at ASC",
                document_id,
            )
        else:
            rows = await self.pool.fetch(
                "SELECT * FROM clauses ORDER BY created_at DESC LIMIT 100",
            )
        return [ClauseRecord(**dict(r)) for r in rows]

    # ── Risk Scores ───────────────────────────────────────────

    async def save_risk_score(
        self, session_id: str, score_data: dict, document_id: str | None = None,
    ) -> None:
        await self.pool.execute(
            "INSERT INTO risk_scores (id, session_id, document_id, score, grade, total_clauses, red_count, yellow_count, green_count, created_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            str(uuid.uuid4()), session_id, document_id,
            score_data.get("score", 0), score_data.get("grade", "UNKNOWN"),
            score_data.get("total_clauses", 0), score_data.get("red_count", 0),
            score_data.get("yellow_count", 0), score_data.get("green_count", 0),
            time.time(),
        )

    # ── Metrics ───────────────────────────────────────────────

    async def get_metrics(self) -> Metrics:
        total_sessions = await self.pool.fetchval("SELECT COUNT(*) FROM sessions")
        total_documents = await self.pool.fetchval("SELECT COUNT(*) FROM documents")
        total_clauses = await self.pool.fetchval("SELECT COUNT(*) FROM clauses")
        rows = await self.pool.fetch("SELECT severity, COUNT(*) as cnt FROM clauses GROUP BY severity")
        by_severity = {r["severity"]: r["cnt"] for r in rows}
        avg_score = await self.pool.fetchval("SELECT AVG(score) FROM risk_scores")
        total_reviews = await self.pool.fetchval("SELECT COUNT(*) FROM risk_scores")

        return Metrics(
            total_sessions=total_sessions,
            total_documents=total_documents,
            total_clauses=total_clauses,
            clauses_by_severity=by_severity,
            avg_risk_score=round(avg_score, 1) if avg_score else None,
            total_reviews=total_reviews,
        )
