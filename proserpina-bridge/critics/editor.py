import re
from typing import List

from .base import Critic, Finding


class Editor(Critic):
    name = "editor"

    LOG_RE = re.compile(r"\bLOG[IWEDV]?\s*\(([^)]*)\)", re.IGNORECASE)
    LOG_BARE_INSIDE_RE = re.compile(r'^\s*"([^"{}]*?)"\s*$')
    HAS_FORMAT_RE = re.compile(r"[{}]|%[sdifgxXoeE]")
    TYPOS_RE = re.compile(
        r"\b(recieve|seperate|occured|untill|definately|alot|teh|wich|acheive|begining)\b",
        re.IGNORECASE,
    )

    TYPO_FIXES = {
        "recieve": "receive",
        "seperate": "separate",
        "occured": "occurred",
        "untill": "until",
        "definately": "definitely",
        "alot": "a lot",
        "teh": "the",
        "wich": "which",
        "acheive": "achieve",
        "begining": "beginning",
    }

    def _is_bare_log(self, args: str) -> bool:
        m = self.LOG_BARE_INSIDE_RE.match(args)
        if not m:
            return False
        body = m.group(1)
        return not self.HAS_FORMAT_RE.search(body)

    def analyze(self, document: str, context: str = "") -> List[Finding]:
        findings: List[Finding] = []

        for m in self.LOG_RE.finditer(document):
            args = m.group(1)
            if self._is_bare_log(args):
                line_no = document[: m.start()].count("\n") + 1
                findings.append(
                    Finding(
                        critic=self.name,
                        severity="minor",
                        title="log call with only a literal string",
                        location=f"line {line_no}",
                        quote=m.group(0)[:80],
                        suggested=(
                            "include variable values or a context tag in the log message"
                        ),
                    )
                )

        for m in self.TYPOS_RE.finditer(document):
            bad = m.group(0)
            fixed = self.TYPO_FIXES.get(bad.lower(), bad)
            line_no = document[: m.start()].count("\n") + 1
            findings.append(
                Finding(
                    critic=self.name,
                    severity="minor",
                    title=f"common typo: '{bad}' -> '{fixed}'",
                    location=f"line {line_no}",
                    quote=bad,
                    suggested=fixed,
                )
            )

        return findings
