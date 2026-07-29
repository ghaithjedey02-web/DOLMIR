"""SQLite persistence for reasoning traces — the first thing to outlive a process.

Storage is local-first (Core Architecture §11, EC §9): a single-user SQLite
file, no server. The append-only discipline of the port is enforced by the
schema itself — ``trace_id`` is the primary key and a second write of the
same id raises, so a trace is never silently overwritten (EC §9, audit
trail). Each row keeps the full ``to_document`` JSON plus a few promoted
columns for cheap listing; reads reconstruct the object through
``trace_from_document``.

SQLite calls are synchronous and, for a local single-user store, fast enough
to run inline within the async port methods; a Postgres adapter behind the
same port is the documented later swap (CA §11), not a rewrite.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.deserialization import trace_from_document
from dolmir.orchestration.trace.record import ReasoningTrace
from dolmir.orchestration.trace.serialization import to_document

__all__ = ["SqliteReasoningTraceRepository"]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS reasoning_traces (
    trace_id      TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    status        TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    completed_at  TEXT NOT NULL,
    document      TEXT NOT NULL
)
"""


class SqliteReasoningTraceRepository:
    """A ``ReasoningTraceRepositoryPort`` backed by a SQLite database."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        """Wrap an open connection and ensure the schema exists."""
        self._connection = connection
        self._connection.execute(_SCHEMA)
        self._connection.commit()

    @classmethod
    def open(cls, path: Path | str) -> SqliteReasoningTraceRepository:
        """Open (creating if needed) a file-backed repository at ``path``."""
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        return cls(sqlite3.connect(target))

    @classmethod
    def in_memory(cls) -> SqliteReasoningTraceRepository:
        """An ephemeral in-memory repository — for tests and dry runs."""
        return cls(sqlite3.connect(":memory:"))

    def close(self) -> None:
        """Close the underlying connection."""
        self._connection.close()

    async def save(self, trace: ReasoningTrace) -> None:
        """Persist ``trace``, refusing to overwrite an existing id.

        Raises:
            ValueError: If a trace with the same id is already stored —
                traces are immutable audit records (EC §9).
        """
        document = json.dumps(to_document(trace))
        try:
            self._connection.execute(
                "INSERT INTO reasoning_traces "
                "(trace_id, schema_version, status, started_at, completed_at, document) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    str(trace.trace_id),
                    ReasoningTrace.schema_version,
                    trace.status.value,
                    trace.started_at.isoformat(),
                    trace.completed_at.isoformat(),
                    document,
                ),
            )
        except sqlite3.IntegrityError as exc:
            self._connection.rollback()
            msg = f"trace {trace.trace_id} already stored; traces are immutable"
            raise ValueError(msg) from exc
        self._connection.commit()

    async def get(self, trace_id: EntityId) -> ReasoningTrace | None:
        """Return the trace with ``trace_id``, or ``None`` if unknown."""
        cursor = self._connection.execute(
            "SELECT document FROM reasoning_traces WHERE trace_id = ?", (str(trace_id),)
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return trace_from_document(json.loads(row[0]))
