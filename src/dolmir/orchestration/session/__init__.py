"""Reasoning session: the orchestration entry point over the graph kernel.

``ReasoningSession`` composes the frozen graph executor, trace persistence,
and explanation rendering into one injected seam a delivery adapter calls
to reason once; ``CognitiveState`` is the immutable outcome it returns.

This layer *uses* the frozen reasoning engine (``graph`` + ``trace`` +
``agents``); it does not replace or re-implement it.
"""

from dolmir.orchestration.session.session import ReasoningSession
from dolmir.orchestration.session.state import CognitiveState

__all__ = ["CognitiveState", "ReasoningSession"]
