"""The ``dolmir`` command-line interface and V1 composition root.

This module is the single wiring point of the CLI delivery adapter (Core
Architecture §19): it reads validated configuration and constructs the
object graph explicitly, by constructor injection — no DI framework, no
service locator, no globals. A future API delivery adapter gets its own
composition root and reuses the same construction pattern.

Commands: ``version`` and ``doctor`` (Phase 1), ``analyze`` and
``trace show`` (Phase 2B — the first vertical slice).

Exit codes: ``0`` success, ``1`` unexpected/usage failure, ``2`` configuration
error (including a missing API key).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import sys
from collections.abc import Sequence
from pathlib import Path

import structlog

from dolmir import __version__
from dolmir.delivery.cli.composition import MissingApiKeyError, build_trading_runtime
from dolmir.delivery.cli.render import render_analysis, render_trace
from dolmir.kernel.clock import SystemClock
from dolmir.kernel.config import DolmirSettings, InvalidConfigurationError, load_settings
from dolmir.kernel.event_bus import InMemoryEventBus
from dolmir.kernel.logging import configure_logging
from dolmir.kernel.plugin_system import (
    Plugin,
    PluginContext,
    PluginRegistrationError,
    PluginRegistry,
)
from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.sqlite_repository import SqliteReasoningTraceRepository
from dolmir.providers.vision import ChartImage

__all__ = ["entrypoint", "main"]

_EXIT_OK = 0
_EXIT_FAILURE = 1
_EXIT_CONFIG_ERROR = 2

_logger = structlog.get_logger(__name__)

# V1 plugin discovery is an explicit list at the composition root (CA §13);
# entry_points discovery arrives in a later phase and feeds this same list.
_PLUGIN_CANDIDATES: tuple[Plugin, ...] = ()

_IMAGE_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def _build_parser() -> argparse.ArgumentParser:
    """Declare the CLI surface."""
    parser = argparse.ArgumentParser(
        prog="dolmir",
        description=(
            "DOLMIR — an AI-native Trader Operating System. "
            "Design law: Docs/architecture/DOLMIR_FOUNDATION.md"
        ),
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    subcommands.add_parser("version", help="Print the DOLMIR version and exit.")

    doctor = subcommands.add_parser(
        "doctor",
        help="Boot the system with zero external infrastructure and report health.",
    )
    doctor.add_argument(
        "--env-file",
        default=".env",
        help="Dotenv file layered beneath process environment variables (default: .env).",
    )

    analyze = subcommands.add_parser(
        "analyze",
        help="Analyze a chart image end-to-end and persist the reasoning trace.",
    )
    analyze.add_argument("--image", required=True, help="Path to the chart image to analyze.")
    analyze.add_argument("--env-file", default=".env", help="Dotenv file (default: .env).")

    trace = subcommands.add_parser("trace", help="Inspect persisted reasoning traces.")
    trace_sub = trace.add_subparsers(dest="trace_command", required=True)
    show = trace_sub.add_parser("show", help="Render a persisted trace by id.")
    show.add_argument("--id", required=True, dest="trace_id", help="The trace id to show.")
    show.add_argument("--env-file", default=".env", help="Dotenv file (default: .env).")

    return parser


def _run_version() -> int:
    """Print the package version."""
    print(f"dolmir {__version__}")
    return _EXIT_OK


def _load_or_report(env_file: str) -> DolmirSettings | None:
    """Load settings, printing a loud config error and returning ``None`` on failure."""
    try:
        return load_settings(env_file=env_file)
    except InvalidConfigurationError as exc:
        print("dolmir: FAIL — configuration invalid", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return None


def _run_doctor(env_file: str) -> int:
    """Execute the boot sequence and print a health report."""
    settings = _load_or_report(env_file)
    if settings is None:
        return _EXIT_CONFIG_ERROR

    configure_logging(settings)
    print(f"config      OK  (environment={settings.environment}, log_level={settings.log_level})")

    event_bus = InMemoryEventBus()
    print("event bus   OK  (in-memory adapter)")

    registry = PluginRegistry(allowlist=settings.plugins.enabled)
    context = PluginContext(event_bus=event_bus)
    try:
        report = registry.register_all(_PLUGIN_CANDIDATES, context)
    except PluginRegistrationError as exc:
        print("dolmir doctor: FAIL — plugin registration failed", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return _EXIT_FAILURE
    print(
        "plugins     OK  "
        f"(registered={len(report.registered)}, "
        f"skipped={len(report.skipped_not_allowlisted)}, "
        f"allowlisted_but_absent={len(report.allowlisted_but_absent)})"
    )
    for name in report.allowlisted_but_absent:
        print(f"            WARN allowlisted plugin not installed: {name}")

    print("dolmir doctor: OK — kernel boots with zero external infrastructure")
    _logger.info(
        "doctor completed",
        environment=settings.environment,
        plugins_registered=report.registered,
    )
    return _EXIT_OK


def _run_analyze(image: str, env_file: str) -> int:
    """Run the trading fast loop on a chart image and print the analysis."""
    settings = _load_or_report(env_file)
    if settings is None:
        return _EXIT_CONFIG_ERROR
    configure_logging(settings)

    chart = _load_chart(image)
    if chart is None:
        return _EXIT_FAILURE

    try:
        runtime = build_trading_runtime(settings, clock=SystemClock())
    except MissingApiKeyError as exc:
        print(f"dolmir analyze: FAIL — {exc}", file=sys.stderr)
        return _EXIT_CONFIG_ERROR

    try:
        state = asyncio.run(runtime.session.run(runtime.graph, seeds=(chart,)))
    finally:
        runtime.close()

    print(render_analysis(state, runtime.ledger))
    return _EXIT_OK


def _run_trace_show(trace_id: str, env_file: str) -> int:
    """Render a persisted reasoning trace by id."""
    settings = _load_or_report(env_file)
    if settings is None:
        return _EXIT_CONFIG_ERROR

    try:
        identity = EntityId.from_string(trace_id)
    except ValueError:
        print(f"dolmir trace show: FAIL — {trace_id!r} is not a valid trace id", file=sys.stderr)
        return _EXIT_FAILURE

    repository = SqliteReasoningTraceRepository.open(settings.persistence.trace_db_path)
    try:
        trace = asyncio.run(repository.get(identity))
    finally:
        repository.close()

    if trace is None:
        print(f"dolmir trace show: no trace found with id {trace_id}", file=sys.stderr)
        return _EXIT_FAILURE

    print(render_trace(trace))
    return _EXIT_OK


def _load_chart(image: str) -> ChartImage | None:
    """Read and base64-encode a chart image, or print why it cannot be used."""
    path = Path(image)
    if not path.is_file():
        print(f"dolmir analyze: FAIL — no such image file: {image}", file=sys.stderr)
        return None
    media_type = _IMAGE_MEDIA_TYPES.get(path.suffix.lower())
    if media_type is None:
        supported = ", ".join(sorted(_IMAGE_MEDIA_TYPES))
        print(
            f"dolmir analyze: FAIL — unsupported image type {path.suffix!r}; "
            f"use one of: {supported}",
            file=sys.stderr,
        )
        return None
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return ChartImage(source_ref=path.name, media_type=media_type, data_base64=data)


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI and return a process exit code."""
    args = _build_parser().parse_args(argv)

    if args.command == "version":
        return _run_version()
    if args.command == "doctor":
        return _run_doctor(env_file=args.env_file)
    if args.command == "analyze":
        return _run_analyze(image=args.image, env_file=args.env_file)
    if args.command == "trace" and args.trace_command == "show":
        return _run_trace_show(trace_id=args.trace_id, env_file=args.env_file)

    # argparse(required=True) prevents reaching here; kept as a loud guard
    # (Core Architecture §16: never fail silently).
    msg = f"unhandled command: {args.command!r}"
    raise AssertionError(msg)


def entrypoint() -> None:
    """Console-script entry point (``dolmir = ...:entrypoint``)."""
    sys.exit(main())


if __name__ == "__main__":
    entrypoint()
