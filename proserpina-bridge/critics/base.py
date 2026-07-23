from typing import List


class Finding:
    def __init__(
        self,
        critic: str,
        severity: str,
        title: str,
        location: str = "",
        quote: str = "",
        suggested: str = "",
    ):
        self.critic = critic
        self.severity = severity
        self.title = title
        self.location = location
        self.quote = quote
        self.suggested = suggested

    def to_dict(self):
        return {
            "critic": self.critic,
            "severity": self.severity,
            "title": self.title,
            "location": self.location,
            "quote": self.quote,
            "suggested": self.suggested,
        }


class Critic:
    name = "base"

    def analyze(self, document: str, context: str = "") -> List[Finding]:
        raise NotImplementedError
