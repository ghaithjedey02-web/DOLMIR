"""Unit coverage for the trading agents' subtle constitutional guarantees.

The integration suite proves the whole pipeline; these tests isolate the
guard rails that are easy to get wrong: the Chief's action-bias guard and
deterministic fallback (CC §6, Standing Rule 4), the hypothesis stage always
producing an inaction option (CC §6), and perception surfacing a vision
failure as a typed node failure.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

from dolmir.kernel.clock import FixedClock
from dolmir.kernel.shared_kernel import EntityId, Err, Ok
from dolmir.orchestration.agents.trading.chief import ChiefTradingDecisionNode
from dolmir.orchestration.agents.trading.hypotheses import TradeHypothesisNode
from dolmir.orchestration.agents.trading.perception import ChartPerceptionNode
from dolmir.orchestration.agents.trading.plan import ProposedTrades
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.trace.challenge import FalsificationReport
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import (
    Confidence,
    ConfidenceAssessment,
    ConfidenceReport,
)
from dolmir.orchestration.trace.epistemic import Claim, EpistemicStatus
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.observation import Interpretation, Observation, ObservationSet
from dolmir.orchestration.trace.opinion import AgentOpinion, HypothesisAssessment, Stance
from dolmir.providers.llm import LLMError, LLMErrorKind, ScriptedLLMProvider, ScriptedReply
from dolmir.providers.vision import (
    ChartImage,
    ChartReading,
    ScriptedChartVisionExtractor,
    VisionError,
)

_MOMENT = datetime(2026, 7, 29, 13, 0, tzinfo=UTC)


def _context() -> GraphContext:
    return GraphContext(run_id=EntityId.generate(), clock=FixedClock(_MOMENT))


def _hypotheses() -> HypothesisSet:
    return HypothesisSet(
        members=(
            Hypothesis(
                hypothesis_id=EntityId(uuid.UUID(int=1)),
                statement="go long the breakout",
                falsification_condition="close below 1.0810",
            ),
            Hypothesis(
                hypothesis_id=EntityId(uuid.UUID(int=2)),
                statement="stand aside",
                falsification_condition="a clean setup forms",
                represents_inaction=True,
            ),
        )
    )


def _confidence(hypotheses: HypothesisSet, long_level: Confidence) -> ConfidenceReport:
    return ConfidenceReport(
        assessments=(
            ConfidenceAssessment(
                hypothesis_id=hypotheses.members[0].hypothesis_id,
                level=long_level,
                basis="debate",
            ),
            ConfidenceAssessment(
                hypothesis_id=hypotheses.members[1].hypothesis_id,
                level=Confidence.MODERATE,
                basis="inaction is always available",
            ),
        )
    )


def _seed_chief_inputs(context: GraphContext, *, long_level: Confidence) -> HypothesisSet:
    hypotheses = _hypotheses()
    opinion = AgentOpinion(
        role="market_ict_analyst",
        strategy_version="v1",
        assessments=(
            HypothesisAssessment(
                hypothesis_id=hypotheses.members[0].hypothesis_id,
                stance=Stance.SUPPORTS,
                confidence=long_level,
                reasoning="momentum",
            ),
        ),
    )
    context._store(hypotheses)
    context._store(opinion)
    context._store(FalsificationReport.for_hypotheses(hypotheses, ()))
    context._store(_confidence(hypotheses, long_level))
    return hypotheses


async def test_chief_guards_action_bias_below_moderate() -> None:
    # The model picks the actionable long, but its synthesized confidence is
    # LOW — the guard must collapse the conclusion to inaction (CC §6).
    context = _context()
    _seed_chief_inputs(context, long_level=Confidence.LOW)
    provider = ScriptedLLMProvider(
        [
            ScriptedReply(
                match="Chief Decision Agent",
                text=json.dumps({"choice": "H1", "rationale": "momentum"}),
            )
        ]
    )

    result = await ChiefTradingDecisionNode(provider).run(context)

    assert isinstance(result, Ok)
    conclusion = result.value.artifacts[0]
    assert isinstance(conclusion, Conclusion)
    assert conclusion.is_inaction is True
    assert "below the MODERATE threshold" in conclusion.rationale


async def test_chief_honors_a_confident_actionable_pick() -> None:
    context = _context()
    _seed_chief_inputs(context, long_level=Confidence.HIGH)
    provider = ScriptedLLMProvider(
        [
            ScriptedReply(
                match="Chief Decision Agent",
                text=json.dumps({"choice": "H1", "rationale": "clean momentum long"}),
            )
        ]
    )

    result = await ChiefTradingDecisionNode(provider).run(context)

    assert isinstance(result, Ok)
    conclusion = result.value.artifacts[0]
    assert isinstance(conclusion, Conclusion)
    assert conclusion.is_inaction is False
    assert conclusion.confidence.level is Confidence.HIGH  # deterministic, not model-invented


async def test_chief_falls_back_to_deterministic_on_model_failure() -> None:
    context = _context()
    _seed_chief_inputs(context, long_level=Confidence.HIGH)
    provider = ScriptedLLMProvider(
        [
            ScriptedReply(
                match="Chief Decision Agent",
                error=LLMError(kind=LLMErrorKind.TIMEOUT, message="slow"),
            )
        ]
    )

    result = await ChiefTradingDecisionNode(provider).run(context)

    assert isinstance(result, Ok)
    assert "deterministic fallback" in result.value.summary
    assert isinstance(result.value.artifacts[0], Conclusion)


async def test_hypothesis_node_synthesizes_the_inaction_option_if_omitted() -> None:
    # The model returns only an actionable long; the node must add a no-trade
    # option so "do nothing" is always reachable (CC §6).
    context = _context()
    context._store(
        Interpretation(
            claims=(Claim(statement="bullish break", status=EpistemicStatus.ASSUMPTION),),
            interpreted_from=frozenset({_observation().observation_id}),
        )
    )
    context._store(ObservationSet(members=(_observation(),)))
    body = {
        "hypotheses": [
            {
                "statement": "long the breakout",
                "falsification": "close below 1.0810",
                "inaction": False,
                "symbol": "EURUSD",
                "direction": "long",
                "entry": 1.085,
                "stop": 1.082,
                "target": 1.094,
                "risk_fraction": 0.008,
            }
        ]
    }
    provider = ScriptedLLMProvider(
        [ScriptedReply(match="hypothesis generator", text=json.dumps(body))]
    )

    result = await TradeHypothesisNode(provider).run(context)

    assert isinstance(result, Ok)
    hypotheses = next(a for a in result.value.artifacts if isinstance(a, HypothesisSet))
    proposed = next(a for a in result.value.artifacts if isinstance(a, ProposedTrades))
    assert sum(1 for member in hypotheses if member.represents_inaction) == 1
    assert len(proposed.proposals) == 1  # only the actionable hypothesis has a trade


async def test_perception_surfaces_a_vision_failure() -> None:
    context = _context()
    context._store(_image())
    extractor = ScriptedChartVisionExtractor(
        {"chart.png": VisionError(message="the chart is unreadable")}
    )

    result = await ChartPerceptionNode(extractor).run(context)

    assert isinstance(result, Err)
    assert "unreadable" in result.error.message


async def test_perception_transcribes_features_into_observations() -> None:
    context = _context()
    context._store(_image())
    extractor = ScriptedChartVisionExtractor(
        {
            "chart.png": ChartReading(
                source_ref="chart.png",
                features=("demand block at 1.0820", "higher low"),
                symbol="EURUSD",
                timeframe="15m",
            )
        }
    )

    result = await ChartPerceptionNode(extractor).run(context)

    assert isinstance(result, Ok)
    observations = result.value.artifacts[0]
    assert isinstance(observations, ObservationSet)
    # one header (symbol/timeframe) + two features.
    assert len(observations.members) == 3


def _observation() -> Observation:
    return Observation(
        observation_id=EntityId(uuid.UUID(int=9)),
        source_ref="chart.png#feature-0",
        content="bullish break of structure",
        observed_at=_MOMENT,
    )


def _image() -> ChartImage:
    return ChartImage(source_ref="chart.png", media_type="image/png", data_base64="ZmFrZQ==")
