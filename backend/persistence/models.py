"""Pydantic models for persistence layer."""

from typing import Optional
from pydantic import BaseModel


class Document(BaseModel):
    id: str
    filename: str
    file_path: str
    file_type: str
    file_size_bytes: Optional[int] = None
    upload_source: str = "upload"
    created_at: float
    updated_at: float


class SessionRecord(BaseModel):
    id: str
    user_id: str
    document_id: Optional[str] = None
    status: str = "active"
    started_at: float
    ended_at: Optional[float] = None
    duration_seconds: Optional[int] = None
    parent_session_id: Optional[str] = None


class Message(BaseModel):
    id: str
    session_id: str
    role: str
    text: str
    clause_id: Optional[str] = None
    created_at: float


class ClauseRecord(BaseModel):
    id: str
    session_id: str
    document_id: Optional[str] = None
    clause_type: str
    severity: str
    raw_text: str
    analysis: str
    created_at: float


class RiskScore(BaseModel):
    id: str
    session_id: str
    document_id: Optional[str] = None
    score: int
    grade: str
    total_clauses: int
    red_count: int
    yellow_count: int
    green_count: int
    created_at: float


class Metrics(BaseModel):
    total_sessions: int
    total_documents: int
    total_clauses: int
    clauses_by_severity: dict[str, int]
    avg_risk_score: Optional[float] = None
    total_reviews: int
