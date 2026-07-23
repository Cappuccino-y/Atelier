import re
from typing import List

from .base import Critic, Finding


class DevilsAdvocate(Critic):
    name = "devils_advocate"

    ELSE_RE = re.compile(r"\belse\b", re.IGNORECASE)
    IF_ALONE_RE = re.compile(r"\bif\s*\([^)]*\)\s*$", re.IGNORECASE)
    IF_RETURN_INLINE_RE = re.compile(r"\bif\s*\([^)]*\)\s*return\b", re.IGNORECASE)
    RETURN_RE = re.compile(r"\breturn\b[^;\n]*;?", re.IGNORECASE)
    TODO_RELEASE_RE = re.compile(r"(//|#|\*|--)\s*TODO\s+release\b", re.IGNORECASE)
    XXX_RELEASE_RE = re.compile(r"(//|#|\*|--)\s*XXX\s+release\b", re.IGNORECASE)

    COMMENT_PREFIXES = ("//", "#", "--", "*", "/*")

    def _is_skippable(self, stripped: str) -> bool:
        if not stripped:
            return True
        return any(stripped.startswith(p) for p in self.COMMENT_PREFIXES)

    def _has_else_after(self, lines: List[str], start_idx: int) -> bool:
        for k in range(start_idx + 1, min(start_idx + 17, len(lines))):
            if self.ELSE_RE.search(lines[k]):
                return True
        return False

    def analyze(self, document: str, context: str = "") -> List[Finding]:
        findings: List[Finding] = []
        lines = document.split("\n")
        in_block_comment = False

        for i, line in enumerate(lines):
            stripped = line.strip()

            if in_block_comment:
                if "*/" in stripped:
                    in_block_comment = False
                continue

            if stripped.startswith("/*"):
                if "*/" not in stripped:
                    in_block_comment = True
                continue

            if self._is_skippable(stripped):
                continue

            if self.IF_ALONE_RE.search(stripped):
                for j in range(i + 1, min(i + 3, len(lines))):
                    nxt = lines[j].strip()
                    if not nxt:
                        continue
                    if any(nxt.startswith(p) for p in self.COMMENT_PREFIXES):
                        break
                    if self.RETURN_RE.search(nxt):
                        if not self._has_else_after(lines, j):
                            findings.append(
                                Finding(
                                    critic=self.name,
                                    severity="critical",
                                    title="early-return without else branch",
                                    location=f"line {i + 1}",
                                    quote=stripped[:120],
                                    suggested=(
                                        "add an explicit else branch or document "
                                        "why the early return is correct"
                                    ),
                                )
                            )
                        break
                    break

            elif self.IF_RETURN_INLINE_RE.search(stripped):
                if not self._has_else_after(lines, i):
                    findings.append(
                        Finding(
                            critic=self.name,
                            severity="critical",
                            title="early-return without else branch",
                            location=f"line {i + 1}",
                            quote=stripped[:120],
                            suggested=(
                                "add an explicit else branch or document "
                                "why the early return is correct"
                            ),
                        )
                    )

        for marker_re, title in (
            (self.TODO_RELEASE_RE, "TODO release marker"),
            (self.XXX_RELEASE_RE, "XXX release marker"),
        ):
            for m in marker_re.finditer(document):
                line_no = document[: m.start()].count("\n") + 1
                findings.append(
                    Finding(
                        critic=self.name,
                        severity="major",
                        title=title,
                        location=f"line {line_no}",
                        quote=m.group(0),
                        suggested="complete the release path before shipping",
                    )
                )

        return findings
