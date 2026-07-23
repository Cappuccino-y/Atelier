import os
from typing import List, Optional
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from critics.devils_advocate import DevilsAdvocate
from critics.methodologist import Methodologist
from critics.red_team import RedTeam
from critics.domain_expert import DomainExpert
from critics.editor import Editor

app = FastAPI(title="Proserpina Bridge", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ALL_CRITICS = [DevilsAdvocate(), Methodologist(), RedTeam(), DomainExpert(), Editor()]

class CritiqueRequest(BaseModel):
    document: str
    panel: str = "default"
    context: Optional[str] = ""

@app.get("/health")
def health():
    return {"status": "ok", "critics": [c.name for c in ALL_CRITICS]}

@app.post("/critique")
def critique(req: CritiqueRequest):
    findings = []
    critics = ALL_CRITICS
    if req.panel == "duo":
        critics = [c for c in ALL_CRITICS if c.name in ("red_team", "methodologist")]
    elif req.panel == "panel":
        critics = ALL_CRITICS

    for critic in critics:
        try:
            for f in critic.analyze(req.document, req.context or ""):
                findings.append(f.to_dict())
        except Exception as e:
            findings.append({"critic": critic.name, "severity": "minor", "title": f"critic error: {e}"})

    summary_counts = {"critical": 0, "major": 0, "minor": 0}
    for f in findings:
        if f["severity"] in summary_counts:
            summary_counts[f["severity"]] += 1
    summary = f"{summary_counts['critical']} critical, {summary_counts['major']} major, {summary_counts['minor']} minor"

    return {
        "findings": findings,
        "summary": summary,
        "criticCount": len(critics),
        "mode": req.panel,
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
