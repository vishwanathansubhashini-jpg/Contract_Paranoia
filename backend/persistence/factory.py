"""Factory for selecting persistence backend at startup."""

import os

from .base import BasePersistenceService


def create_persistence_service() -> BasePersistenceService:
    db_backend = os.environ.get("DB_BACKEND", "sqlite").lower()

    if db_backend == "postgres":
        from .postgres import PostgresPersistenceService

        dsn = os.environ.get("DATABASE_URL", "")
        if not dsn:
            raise ValueError("DATABASE_URL is required when DB_BACKEND=postgres")
        return PostgresPersistenceService(dsn=dsn)

    # Default: SQLite (local dev)
    from .database import PersistenceService

    data_dir = os.environ.get("DATA_DIR", "data")
    return PersistenceService(
        db_path=os.path.join(data_dir, "app.db"),
        uploads_dir=os.path.join(data_dir, "uploads"),
    )
