"""
Clause Detector Tool
====================
Gemini calls this tool when it spots a risky clause in the document.
Structures the clause data for the frontend to display.
"""

import uuid
import time
from google.adk.tools import ToolContext


def flag_clause(
    clause_type: str,
    severity: str,
    raw_text: str,
    analysis: str,
    tool_context: ToolContext,
) -> dict:
    """Flag a risky contract clause found in the document.

    Call this tool whenever you identify a clause in the contract that the user
    should know about. Provide a severity level, the exact text, and your
    plain-English analysis.

    Args:
        clause_type: Short name for the clause type (e.g. "Arbitration Waiver",
                     "Non-Compete", "Liability Cap", "IP Assignment").
        severity: Risk level — must be "RED", "YELLOW", or "GREEN".
                  RED = dangerous, YELLOW = worth noting, GREEN = safe.
        raw_text: The exact text of the clause as visible in the document.
        analysis: Your plain-English explanation of what this clause means
                  for the user and why it matters.
        tool_context: Provided by ADK framework.

    Returns:
        Confirmation dict with the flagged clause data.
    """
    severity = severity.upper()
    if severity not in ("RED", "YELLOW", "GREEN"):
        severity = "YELLOW"

    clause_data = {
        "id": str(uuid.uuid4()),
        "clause_type": clause_type,
        "severity": severity,
        "raw_text": raw_text,
        "analysis": analysis,
        "timestamp": time.time(),
    }

    # Store in session state for later summary
    clauses = tool_context.state.get("clauses", [])
    clauses.append(clause_data)
    tool_context.state["clauses"] = clauses

    return {
        "status": "flagged",
        "clause": clause_data,
        "message": f"Clause '{clause_type}' flagged as {severity}.",
    }
