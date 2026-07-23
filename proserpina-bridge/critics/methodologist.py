import re
from typing import List

from .base import Critic, Finding


class Methodologist(Critic):
    name = "methodologist"

    NEW_RE = re.compile(r"\bnew\s+([A-Za-z_][\w:]*)\s*\(", re.IGNORECASE)
    DEF_RE = re.compile(
        r"^\s*(?:def|function)\s+([A-Za-z_]\w*)\s*\(",
        re.IGNORECASE | re.MULTILINE,
    )
    DELETE_RE = re.compile(r"\bdelete\b\s*(?:\[\s*\])?\s*&?[A-Za-z_]\w*", re.IGNORECASE)
    FREE_RE = re.compile(r"\bfree\s*\(\s*&?[A-Za-z_][\w.]*\s*\)", re.IGNORECASE)
    ARROW_RELEASE_RE = re.compile(r"\b[A-Za-z_]\w*\s*->\s*release\s*\(", re.IGNORECASE)
    DOT_RELEASE_RE = re.compile(r"\b[A-Za-z_]\w*\s*\.\s*release\s*\(", re.IGNORECASE)

    def _cleanup_count(self, document: str) -> int:
        return (
            sum(1 for _ in self.DELETE_RE.finditer(document))
            + sum(1 for _ in self.FREE_RE.finditer(document))
            + sum(1 for _ in self.ARROW_RELEASE_RE.finditer(document))
            + sum(1 for _ in self.DOT_RELEASE_RE.finditer(document))
        )

    def analyze(self, document: str, context: str = "") -> List[Finding]:
        findings: List[Finding] = []

        news_iter = list(self.NEW_RE.finditer(document))
        new_count = len(news_iter)
        if new_count:
            cleanup_count = self._cleanup_count(document)
            excess = max(0, new_count - cleanup_count)
            if excess > 0:
                start_index = max(0, new_count - excess)
                for m in news_iter[start_index:]:
                    name = m.group(1)
                    line_no = document[: m.start()].count("\n") + 1
                    findings.append(
                        Finding(
                            critic=self.name,
                            severity="major",
                            title=f"`new {name}()` may lack matching cleanup",
                            location=f"line {line_no}",
                            quote=m.group(0),
                            suggested=(
                                f"verify a matching delete/free/release exists "
                                f"for `{name}`"
                            ),
                        )
                    )

        matches = list(self.DEF_RE.finditer(document))
        if matches:
            total_lines = document.count("\n") + (
                0 if document.endswith("\n") else 1
            )
            for idx, m in enumerate(matches):
                start = document[: m.start()].count("\n")
                if idx + 1 < len(matches):
                    end = document[: matches[idx + 1].start()].count("\n")
                else:
                    end = total_lines
                length = end - start
                if length > 80:
                    findings.append(
                        Finding(
                            critic=self.name,
                            severity="minor",
                            title=f"function '{m.group(1)}' is {length} lines (> 80)",
                            location=f"line {start + 1}",
                            quote=f"def {m.group(1)}(...)",
                            suggested="split into smaller, single-purpose functions",
                        )
                    )

        return findings
