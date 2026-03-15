"""
Session Notes Tool
==================
Lets Para save notes during the conversation and retrieve them later.
Useful for tracking what the user has told Para about their situation.
"""

import time
from google.adk.tools import ToolContext


def save_note(note: str, tool_context: ToolContext) -> dict:
    """Save a note about the user's situation or contract context.

    Call this when the user shares important context about their contract,
    their role, or what they're looking for. This helps you remember details
    throughout the session.

    Args:
        note: The note to save (e.g. "User is a freelancer, concerned about IP rights").
        tool_context: Provided by ADK framework.

    Returns:
        Confirmation that the note was saved.
    """
    notes = tool_context.state.get("notes", [])
    notes.append({"text": note, "timestamp": time.time()})
    tool_context.state["notes"] = notes

    return {"status": "saved", "total_notes": len(notes)}


def get_notes(tool_context: ToolContext) -> dict:
    """Retrieve all saved session notes.

    Call this to review what you've learned about the user's situation so far.

    Args:
        tool_context: Provided by ADK framework.

    Returns:
        All saved notes from this session.
    """
    notes = tool_context.state.get("notes", [])
    return {"notes": notes, "total": len(notes)}
