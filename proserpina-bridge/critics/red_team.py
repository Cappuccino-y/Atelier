import re
from typing import List

from .base import Critic, Finding


class RedTeam(Critic):
    name = "red_team"

    DANGEROUS_FUNCS_RE = re.compile(
        r"\b(strcpy|strcat|sprintf|gets|scanf)\s*\(", re.IGNORECASE
    )
    SMELL_MARKER_RE = re.compile(
        r"(//|#|/\*|\*|--)\s*(FIXME|XXX|HACK)\b", re.IGNORECASE
    )

    SAFE_ALTERNATIVES = {
        "strcpy": "strncpy / strlcpy",
        "strcat": "strncat / strlcat",
        "sprintf": "snprintf",
        "gets": "fgets",
        "scanf": "sscanf with width limit",
    }

    def analyze(self, document: str, context: str = "") -> List[Finding]:
        findings: List[Finding] = []

        for m in self.DANGEROUS_FUNCS_RE.finditer(document):
            func = m.group(1).lower()
            line_no = document[: m.start()].count("\n") + 1
            findings.append(
                Finding(
                    critic=self.name,
                    severity="critical",
                    title=f"unsafe C function: {func}()",
                    location=f"line {line_no}",
                    quote=m.group(0),
                    suggested=f"use {self.SAFE_ALTERNATIVES[func]} instead",
                )
            )

        for m in self.SMELL_MARKER_RE.finditer(document):
            marker = m.group(2).upper()
            line_no = document[: m.start()].count("\n") + 1
            findings.append(
                Finding(
                    critic=self.name,
                    severity="major",
                    title=f"code smell marker: {marker}",
                    location=f"line {line_no}",
                    quote=m.group(0),
                    suggested=f"resolve the {marker} before merging",
                )
            )

        return findings
