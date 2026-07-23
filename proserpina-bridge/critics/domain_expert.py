import re
from typing import List

from .base import Critic, Finding


class DomainExpert(Critic):
    name = "domain_expert"

    ACQUIRE_RE = re.compile(
        r"\b(selectFrame|createObject|acquireResource)\s*\(", re.IGNORECASE
    )
    ADVANCED_RE = re.compile(
        r"\b(RealTimeMCX|ZSL|AIStream|RealTimeStream|HDRCapture|NeuralEngine)(?:\b|[_\(])",
        re.IGNORECASE,
    )
    FALLBACK_RE = re.compile(
        r"\b("
        r"fallback|onError|try\s*\{|catch\s*\(|except\s+|"
        r"err\s*=|throw\s+|recover(y|ies)|"
        r"\.catch\s*\(|promise\.catch"
        r")\b",
        re.IGNORECASE,
    )
    RELEASE_BALANCE_RE = re.compile(
        r"\b("
        r"releaseFrame|releaseObject|releaseResource|"
        r"\.release\s*\(|->release\s*\(|\.reset\s*\(|->reset\s*\("
        r")",
        re.IGNORECASE,
    )

    def analyze(self, document: str, context: str = "") -> List[Finding]:
        findings: List[Finding] = []

        acquires = list(self.ACQUIRE_RE.finditer(document))
        if acquires:
            release_count = len(self.RELEASE_BALANCE_RE.findall(document))
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
                            suggested=(
                                "verify a matching releaseFrame / releaseObject / "
                                "releaseResource call"
                            ),
                        )
                    )
                    flagged += 1

        advanced_features_seen = False
        for m in self.ADVANCED_RE.finditer(document):
            advanced_features_seen = True
            line_no = document[: m.start()].count("\n") + 1
            feature = m.group(1)
            if not self.FALLBACK_RE.search(document):
                findings.append(
                    Finding(
                        critic=self.name,
                        severity="major",
                        title=f"advanced feature '{feature}' lacks fallback / error handling",
                        location=f"line {line_no}",
                        quote=feature,
                        suggested=(
                            "add explicit try/catch (or equivalent) and a fallback path"
                        ),
                    )
                )
                break

        return findings
