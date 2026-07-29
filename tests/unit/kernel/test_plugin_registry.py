from dataclasses import dataclass, field

import pytest
import structlog.testing

from dolmir.kernel.event_bus import InMemoryEventBus
from dolmir.kernel.plugin_system import (
    PluginContext,
    PluginMetadata,
    PluginRegistrationError,
    PluginRegistry,
)


@dataclass
class FakePlugin:
    name: str
    registered_with: list[PluginContext] = field(default_factory=list)
    should_fail: bool = False

    @property
    def metadata(self) -> PluginMetadata:
        return PluginMetadata(name=self.name, version="1.0.0", description="test plugin")

    def register(self, context: PluginContext) -> None:
        if self.should_fail:
            msg = "intentional failure"
            raise RuntimeError(msg)
        self.registered_with.append(context)


def _context() -> PluginContext:
    return PluginContext(event_bus=InMemoryEventBus())


def test_allowlisted_plugin_is_registered() -> None:
    plugin = FakePlugin("alpha")
    report = PluginRegistry(allowlist=["alpha"]).register_all([plugin], _context())

    assert report.registered == ("alpha",)
    assert len(plugin.registered_with) == 1


def test_non_allowlisted_plugin_is_skipped_with_a_loud_warning() -> None:
    plugin = FakePlugin("rogue")
    with structlog.testing.capture_logs() as logs:
        report = PluginRegistry(allowlist=[]).register_all([plugin], _context())

    assert report.skipped_not_allowlisted == ("rogue",)
    assert plugin.registered_with == []
    warnings = [entry for entry in logs if entry["log_level"] == "warning"]
    assert any(entry.get("plugin") == "rogue" for entry in warnings)


def test_empty_allowlist_registers_nothing() -> None:
    report = PluginRegistry(allowlist=[]).register_all(
        [FakePlugin("a"), FakePlugin("b")], _context()
    )
    assert report.registered == ()
    assert report.skipped_not_allowlisted == ("a", "b")


def test_allowlisted_but_absent_plugin_is_reported() -> None:
    with structlog.testing.capture_logs() as logs:
        report = PluginRegistry(allowlist=["ghost"]).register_all([], _context())

    assert report.allowlisted_but_absent == ("ghost",)
    warnings = [entry for entry in logs if entry["log_level"] == "warning"]
    assert any(entry.get("plugin") == "ghost" for entry in warnings)


def test_duplicate_plugin_names_fail_the_boot() -> None:
    with pytest.raises(PluginRegistrationError, match="duplicate plugin name"):
        PluginRegistry(allowlist=["dup"]).register_all(
            [FakePlugin("dup"), FakePlugin("dup")], _context()
        )


def test_plugin_failure_during_register_fails_the_boot() -> None:
    with pytest.raises(PluginRegistrationError, match="failed during register"):
        PluginRegistry(allowlist=["bad"]).register_all(
            [FakePlugin("bad", should_fail=True)], _context()
        )


def test_metadata_rejects_empty_name() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        PluginMetadata(name="  ", version="1", description="x")
