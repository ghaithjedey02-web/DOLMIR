"""Hypothesis generation: the falsifiable scenario set, plus concrete trades.

Cognitive Architecture §3 stage 5. This node produces *two* artifacts at
once — the ``HypothesisSet`` and the ``ProposedTrades`` that express its
actionable members as gate-checkable trades — so it implements ``GraphNode``
directly rather than the single-artifact stage base.

Two constitutional guarantees are enforced structurally here, regardless of
what the model returns:

- **the inaction option always exists** (CC §6): if the model omits a
  no-trade scenario, this node adds one, so "do nothing" is never a fallback
  reached only when nothing else fits;
- **every actionable hypothesis is falsifiable** (CC §4): the falsification
  condition is a required field of ``Hypothesis`` itself.
"""

from __future__ import annotations

from dolmir.engines.risk_engine.domain import TradeDirection, TradeProposal
from dolmir.kernel.shared_kernel import EntityId, Err, Ok, Result
from dolmir.orchestration.agents.trading.llm_support import (
    complete_json,
    object_list,
    string_field,
)
from dolmir.orchestration.agents.trading.plan import ProposedTrades
from dolmir.orchestration.failure import FailureKind, FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.graph.node import NodeReport
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.observation import Interpretation, ObservationSet
from dolmir.providers.llm.port import LLMProviderPort
from dolmir.providers.llm.transport import JsonValue

__all__ = ["TradeHypothesisNode"]

_SYSTEM = (
    "You are an ICT/SMC hypothesis generator. From the interpretation, "
    "propose a small set of mutually exclusive, falsifiable scenarios for "
    "the next move. Include at most one LONG and one SHORT idea, each with a "
    "concrete trade (entry, stop = invalidation level, target), and ALWAYS a "
    "no-trade scenario. Prices must be coherent: LONG has stop below entry "
    "and target above; SHORT the reverse. Do not force a directional call."
)

_INACTION_FALSIFICATION = "a clean, high-conviction setup forms on this instrument"


class TradeHypothesisNode:
    """Generates the falsifiable hypothesis set and its concrete trade proposals."""

    def __init__(self, provider: LLMProviderPort) -> None:
        """Inject the generating provider."""
        self._provider = provider

    @property
    def name(self) -> str:
        """Node name."""
        return "hypothesis_generation"

    @property
    def requires(self) -> frozenset[type[object]]:
        """The interpretation and the observations it rests on."""
        return frozenset({Interpretation, ObservationSet})

    @property
    def produces(self) -> frozenset[type[object]]:
        """The hypothesis set and the trades expressing its actionable members."""
        return frozenset({HypothesisSet, ProposedTrades})

    @property
    def failure_policy(self) -> FailurePolicy:
        """No hypotheses, no reasoning: failure aborts."""
        return FailurePolicy.ABORT_RUN

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        """Generate the scenario set and its trade proposals."""
        interpretation = context.get(Interpretation)
        user = (
            "Interpretation of the chart:\n"
            + "\n".join(f"- {claim.statement}" for claim in interpretation.claims)
            + "\n\nReturn JSON:\n"
            '{"hypotheses": [{"statement": "...", "falsification": "...", '
            '"inaction": false, "symbol": "EURUSD", "direction": "long", '
            '"entry": 1.085, "stop": 1.082, "target": 1.094, "risk_fraction": 0.008}]}\n'
            "Omit the trade fields on the no-trade scenario."
        )

        match await complete_json(self._provider, system=_SYSTEM, user=user, node_name=self.name):
            case Ok(document):
                return self._assemble(document.get("hypotheses"))
            case Err(failure):
                return Err(failure)

    def _assemble(self, raw: JsonValue) -> Result[NodeReport, NodeFailure]:
        """Build the hypothesis set and proposals from parsed scenarios."""
        actionable: list[Hypothesis] = []
        inaction: list[Hypothesis] = []
        proposals: list[tuple[EntityId, TradeProposal]] = []

        for entry in object_list(raw):
            statement = string_field(entry, "statement")
            falsification = string_field(entry, "falsification")
            if not statement or not falsification:
                continue
            hypothesis = Hypothesis(
                hypothesis_id=EntityId.generate(),
                statement=statement,
                falsification_condition=falsification,
                represents_inaction=_is_true(entry.get("inaction")),
            )
            if hypothesis.represents_inaction:
                inaction.append(hypothesis)
                continue
            proposal = self._parse_proposal(entry)
            if isinstance(proposal, NodeFailure):
                return Err(proposal)
            actionable.append(hypothesis)
            proposals.append((hypothesis.hypothesis_id, proposal))

        if not actionable:
            return Err(
                NodeFailure(
                    node_name=self.name,
                    kind=FailureKind.EXTERNAL_ERROR,
                    message="no actionable hypothesis with a coherent trade was produced",
                )
            )

        members = (*actionable, inaction[0] if inaction else _default_inaction())
        hypothesis_set = HypothesisSet(members=members)
        proposed = ProposedTrades(proposals=tuple(proposals))
        return Ok(
            NodeReport(
                artifacts=(hypothesis_set, proposed),
                summary=(
                    f"generated {len(members)} scenario(s) "
                    f"({len(actionable)} actionable, 1 no-trade)"
                ),
            )
        )

    def _parse_proposal(self, entry: dict[str, JsonValue]) -> TradeProposal | NodeFailure:
        """Parse an actionable scenario's trade, or a failure if it is incoherent."""
        direction_text = string_field(entry, "direction").lower()
        if direction_text not in {"long", "short"}:
            return self._bad_trade(f"unknown trade direction {direction_text!r}")
        try:
            return TradeProposal(
                symbol=string_field(entry, "symbol", "UNKNOWN"),
                direction=TradeDirection.LONG if direction_text == "long" else TradeDirection.SHORT,
                entry=_float(entry.get("entry")),
                stop=_float(entry.get("stop")),
                target=_float(entry.get("target")),
                risk_fraction_of_equity=_float(entry.get("risk_fraction")),
            )
        except (ValueError, TypeError) as exc:
            return self._bad_trade(str(exc))

    def _bad_trade(self, detail: str) -> NodeFailure:
        """A failure for a malformed proposed trade."""
        return NodeFailure(
            node_name=self.name,
            kind=FailureKind.EXTERNAL_ERROR,
            message=f"malformed trade proposal: {detail}",
        )


def _default_inaction() -> Hypothesis:
    """The canonical no-trade hypothesis, added when the model omits one."""
    return Hypothesis(
        hypothesis_id=EntityId.generate(),
        statement="No clear edge — stand aside",
        falsification_condition=_INACTION_FALSIFICATION,
        represents_inaction=True,
    )


def _is_true(value: JsonValue) -> bool:
    """Whether a JSON value denotes truth (``true`` or the string ``"true"``)."""
    return value is True or (isinstance(value, str) and value.strip().lower() == "true")


def _float(value: JsonValue) -> float:
    """Coerce a JSON number to ``float``; raise ``TypeError`` otherwise."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        msg = f"expected a number, got {value!r}"
        raise TypeError(msg)
    return float(value)
