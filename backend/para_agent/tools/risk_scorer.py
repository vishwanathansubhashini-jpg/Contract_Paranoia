"""
Risk Scorer Tool
================
Calculates an overall risk score based on all flagged clauses.
"""

from google.adk.tools import ToolContext


def score_risk(tool_context: ToolContext) -> dict:
    """Calculate the overall contract risk score based on all flagged clauses.

    Call this tool when the user asks for a summary, risk score, or when you've
    finished reviewing the document.

    Args:
        tool_context: Provided by ADK framework.

    Returns:
        Risk score summary with counts and top risks.
    """
    clauses = tool_context.state.get("clauses", [])

    red = [c for c in clauses if c["severity"] == "RED"]
    yellow = [c for c in clauses if c["severity"] == "YELLOW"]
    green = [c for c in clauses if c["severity"] == "GREEN"]

    total = len(clauses)
    if total == 0:
        score = 100
        grade = "No clauses reviewed yet"
    else:
        # Deduct points: RED = -20, YELLOW = -5, GREEN = +2
        score = max(0, min(100, 100 - (len(red) * 20) - (len(yellow) * 5) + (len(green) * 2)))
        if score >= 80:
            grade = "LOW RISK"
        elif score >= 50:
            grade = "MODERATE RISK"
        else:
            grade = "HIGH RISK"

    summary = {
        "score": score,
        "grade": grade,
        "total_clauses": total,
        "red_count": len(red),
        "yellow_count": len(yellow),
        "green_count": len(green),
        "top_risks": [
            {"type": c["clause_type"], "severity": c["severity"], "analysis": c["analysis"]}
            for c in (red + yellow)[:5]
        ],
        "negotiate_points": [
            f"Push back on: {c['clause_type']}"
            for c in red[:3]
        ],
    }

    # Store summary in session state
    tool_context.state["risk_summary"] = summary

    return summary
