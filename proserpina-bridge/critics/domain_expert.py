"""
Domain-expert critic.

By default DISABLED (no findings produced). Provide domain-specific
patterns via the env var `PROSERPINA_DOMAIN_KEYWORDS`, comma-separated,
in the form `acquire:selectFrame|createObject|releaseFrame|releaseObject,
advanced:RealTimeMCX|ZSL|HDRCapture,fallback:try|catch|except|throw`.
Without this env var the critic returns an empty list — safe default
for users on different stacks.

The intent of the heuristic: when domain code acquires a resource
(acquire: list) it should also release it (release: list, kept in sync
with acquire); when domain code calls advanced features (advanced list)
that may fail, a fallback path should exist somewhere (fallback list).
"""
from __future__ import annotations

import os
import re
from typing import List

from .base import Critic, Finding


def _parse_keywords(value: str) -> dict[str, List[str]]:
    out: dict[str, List[str]] = {"acquire": [], "release": [], "advanced": [], "fallback": []}
    for chunk in value.split(","):
        chunk = chunk.strip()
        if not chunk or ":" not in chunk:
            continue
        kind, _, rest = chunk.partition(":")
        kind = kind.strip().lower()
        if kind not in out:
            continue
        out[kind].extend(p.strip() for p in rest.split("|") if p.strip())
    return out


class DomainExpert(Critic):
    name = "domain_expert"

    def __init__(self) -> None:
        env = os.environ.get("PROSERPINA_DOMAIN_KEYWORDS", "")
        self._kw = _parse_keywords(env) if env else {"acquire": [], "release": [], "advanced": [], "fallback": []}
        active = any(self._kw.values())
        self._enabled = active
        if active:
            self.ACQUIRE_RE = re.compile(
                r"\b(" + "|".join(map(re.escape, self._kw["acquire"])) + r")\s*\(",
                re.IGNORECASE,
            ) if self._kw["acquire"] else None
            self.RELEASE_RE = re.compile(
                r"\b(" + "|".join(map(re.escape, self._kw["release"])) + r")\b",
                re.IGNORECASE,
            ) if self._kw["release"] else None
            self.ADVANCED_RE = re.compile(
                r"\b(" + "|".join(map(re.escape, self._kw["advanced"])) + r")\b",
                re.IGNORECASE,
            ) if self._kw["advanced"] else None
            self.FALLBACK_RE = re.compile(
                r"\b(" + "|".join(map(re.escape, self._kw["fallback"])) + r")\b",
                re.IGNORECASE,
            ) if self._kw["fallback"] else None
        else:
            self.ACQUIRE_RE = self.RELEASE_RE = self.ADVANCED_RE = self.FALLBACK_RE = None

    @property
    def enabled(self) -> bool:
        return self._enabled

    def analyze(self, document: str, context: str = "") -> List[Finding]:
        if not self._enabled:
            return []
        findings: List[Finding] = []

        if self.ACQUIRE_RE and self.RELEASE_RE:
            acquires = list(self.ACQUIRE_RE.finditer(document))
            if acquires:
                release_count = len(self.RELEASE_RE.findall(document))
                if release_count < len(acquires):
                    missing = len(acquires) - release_count
                    flagged = 0
                    for m in acquires:
                        if flagged >= missing:
                            break
                        func = m.group(1)
                        line_no = document[: m.start()].count("\n") + 1
                        findings.append(
                            Finding(
                                critic=self.name,
                                severity="major",
                                title=f"{func}() may lack matching release",
                                location=f"line {line_no}",
                                quote=m.group(0),
                                suggested="verify a matching release call in the same scope",
                            )
                        )
                        flagged += 1

        if self.ADVANCED_RE and self.FALLBACK_RE:
            for m in self.ADVANCED_RE.finditer(document):
                feature = m.group(1)
                line_no = document[: m.start()].count("\n") + 1
                if not self.FALLBACK_RE.search(document):
                    findings.append(
                        Finding(
                            critic=self.name,
                            severity="major",
                            title=f"advanced feature '{feature}' lacks fallback / error handling",
                            location=f"line {line_no}",
                            quote=feature,
                            suggested="add explicit error handling and a fallback path",
                        )
                    )
                    break

        return findings
