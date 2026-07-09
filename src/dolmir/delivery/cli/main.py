"""The ``dolmir`` command-line interface and V1 composition root.

This module is the single wiring point of the CLI delivery adapter (Core
Architecture §19): it reads validated configuration and constructs the
object graph explicitly, by constructor injection — no DI framework, no
service locator, no globals. A future API delivery adapter gets its own
composition root and reuses the same construction pattern.

Boot sequence implemented by ``doctor`` (Core Architecture §20, as far as
the system exists in Phase 1):

    load + validate config -> configure logging -> event bus ->
    plugin registry (explicit candidates, allowlist-enforced) -> report.

Exit codes: ``0`` success, ``1`` unexpected failure, ``2`` configuration
error.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

import structlog

from dolmir import __version__
from dolmir.kernel.config import InvalidConfigurationError, load_settings
from dolmir.kernel.event_bus import InMemoryEventBus
from dolmir.kernel.logging import configure_logging
from dolmir.kernel.plugin_system import (
    Plugin,
    PluginContext,
    PluginRegistrationError,
    PluginRegistry,
)

__all__ = ["entrypoint", "main"]

_EXIT_OK = 0
_EXIT_FAILURE = 1
_EXIT_CONFIG_ERROR = 2

_logger = structlog.get_logger(__name__)

# V1 plugin discovery is an explicit list at the composition root (CA §13);
# entry_points discovery arrives in a later phase and feeds this same list.
_PLUGIN_CANDIDATES: tuple[Plugin, ...] = ()


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

    return parser


def _run_version() -> int:
    """Print the package version."""
    print(f"dolmir {__version__}")
    return _EXIT_OK


def _run_doctor(env_file: str) -> int:
    """Execute the boot sequence and print a health report."""
    try:
        settings = load_settings(env_file=env_file)
    except InvalidConfigurationError as exc:
        print("dolmir doctor: FAIL — configuration invalid", file=sys.stderr)
        print(str(exc), file=sys.stderr)
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


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI and return a process exit code."""
    args = _build_parser().parse_args(argv)

    if args.command == "version":
        return _run_version()
    if args.command == "doctor":
        return _run_doctor(env_file=args.env_file)

    # argparse(required=True) prevents reaching here; kept as a loud guard
    # (Core Architecture §16: never fail silently).
    msg = f"unhandled command: {args.command!r}"
    raise AssertionError(msg)


def entrypoint() -> None:
    """Console-script entry point (``dolmir = ...:entrypoint``)."""
    sys.exit(main())


if __name__ == "__main__":
    entrypoint()
