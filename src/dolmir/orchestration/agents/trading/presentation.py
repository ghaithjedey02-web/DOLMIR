"""Shared rendering and parsing between the trading LLM nodes.

Two problems every LLM node shares, solved once here:

1. Models cannot know the ``EntityId``s the hypothesis stage minted, so the
   set is presented with stable positional labels (``H1``, ``H2``, …) and
   the model refers to those; :func:`hypothesis_for_label` resolves a label
   back to its hypothesis.
2. Models return the confidence/stance vocabulary as free text; the parsers
   here map it onto the typed enums, defaulting conservatively (an
   unrecognized confidence is ``LOW``, an unrecognized stance ``ABSTAINS``)
   rather than guessing high.
"""

from __future__ import annotations

from dolmir.orchestration.trace.confidence import Confidence
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.opinion import Stance

__all__ = [
    "hypothesis_for_label",
    "hypothesis_label",
    "parse_confidence",
    "parse_stance",
    "render_hypotheses",
]

_CONFIDENCE_BY_NAME = {level.name.lower(): level for level in Confidence}
_STANCE_BY_NAME = {stance.value: stance for stance in Stance}


def hypothesis_label(index: int) -> str:
    """The stable positional label (``H1``, ``H2``, …) for a set index."""
    return f"H{index + 1}"


def render_hypotheses(hypotheses: HypothesisSet) -> str:
    """Render the set as a labeled list for an LLM prompt."""
    lines: list[str] = []
    for index, member in enumerate(hypotheses.members):
        marker = " [inaction]" if member.represents_inaction else ""
        lines.append(f"{hypothesis_label(index)}{marker}: {member.statement}")
        lines.append(f"    falsified if: {member.falsification_condition}")
    return "\n".join(lines)


def hypothesis_for_label(hypotheses: HypothesisSet, label: str) -> Hypothesis | None:
    """Resolve a positional label (``H1``…) back to its hypothesis."""
    digits = "".join(character for character in label if character.isdigit())
    if not digits:
        return None
    index = int(digits) - 1
    if 0 <= index < len(hypotheses.members):
        return hypotheses.members[index]
    return None


def parse_confidence(text: str) -> Confidence:
    """Map free-text confidence onto the vocabulary, defaulting to ``LOW``.

    Defaulting low is the conservative choice: an unreadable confidence must
    never be read as high conviction (Cognitive Constitution §5).
    """
    return _CONFIDENCE_BY_NAME.get(text.strip().lower(), Confidence.LOW)


def parse_stance(text: str) -> Stance:
    """Map free-text stance onto the enum, defaulting to ``ABSTAINS``."""
    return _STANCE_BY_NAME.get(text.strip().lower(), Stance.ABSTAINS)
