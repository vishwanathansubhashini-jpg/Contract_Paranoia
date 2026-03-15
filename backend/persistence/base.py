"""Abstract base class for persistence backends."""

from abc import ABC, abstractmethod

from .models import ClauseRecord, Document, Message, Metrics, SessionRecord


class BasePersistenceService(ABC):
    uploads_dir: str

    @abstractmethod
    async def initialize(self) -> None: ...

    @abstractmethod
    async def close(self) -> None: ...

    # ── Documents ──────────────────────────────────────────────
    @abstractmethod
    async def create_document(
        self, filename: str, file_path: str, file_type: str,
        file_size_bytes: int | None = None, upload_source: str = "upload",
    ) -> Document: ...

    @abstractmethod
    async def get_document(self, doc_id: str) -> Document | None: ...

    @abstractmethod
    async def list_documents(self, limit: int = 50, offset: int = 0) -> list[Document]: ...

    # ── Sessions ───────────────────────────────────────────────
    @abstractmethod
    async def create_session(
        self, session_id: str, user_id: str,
        document_id: str | None = None, parent_session_id: str | None = None,
    ) -> SessionRecord: ...

    @abstractmethod
    async def end_session(self, session_id: str, duration_seconds: int) -> None: ...

    @abstractmethod
    async def get_session(self, session_id: str) -> SessionRecord | None: ...

    @abstractmethod
    async def list_sessions(self, document_id: str | None = None, limit: int = 50) -> list[SessionRecord]: ...

    @abstractmethod
    async def delete_session(self, session_id: str) -> None: ...

    @abstractmethod
    async def get_session_preview(self, session_id: str) -> str | None: ...

    @abstractmethod
    async def link_document(self, session_id: str, document_id: str) -> None: ...

    # ── Messages ───────────────────────────────────────────────
    @abstractmethod
    async def save_message(
        self, session_id: str, role: str, text: str, clause_id: str | None = None,
    ) -> Message: ...

    @abstractmethod
    async def get_messages(self, session_id: str) -> list[Message]: ...

    # ── Clauses ────────────────────────────────────────────────
    @abstractmethod
    async def save_clause(
        self, clause_data: dict, session_id: str, document_id: str | None = None,
    ) -> None: ...

    @abstractmethod
    async def get_clauses(
        self, session_id: str | None = None, document_id: str | None = None,
    ) -> list[ClauseRecord]: ...

    # ── Risk Scores ────────────────────────────────────────────
    @abstractmethod
    async def save_risk_score(
        self, session_id: str, score_data: dict, document_id: str | None = None,
    ) -> None: ...

    # ── Metrics ────────────────────────────────────────────────
    @abstractmethod
    async def get_metrics(self) -> Metrics: ...
