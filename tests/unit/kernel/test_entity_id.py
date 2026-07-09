import uuid

import pytest

from dolmir.kernel.shared_kernel import EntityId


def test_generate_produces_unique_ids() -> None:
    ids = {EntityId.generate() for _ in range(100)}
    assert len(ids) == 100


def test_from_string_round_trips() -> None:
    original = EntityId.generate()
    assert EntityId.from_string(str(original)) == original


def test_from_string_rejects_garbage() -> None:
    with pytest.raises(ValueError, match="not a valid EntityId"):
        EntityId.from_string("not-a-uuid")


def test_str_is_canonical_uuid_form() -> None:
    fixed = uuid.UUID("12345678-1234-5678-1234-567812345678")
    assert str(EntityId(fixed)) == "12345678-1234-5678-1234-567812345678"


def test_equality_is_by_value() -> None:
    fixed = uuid.UUID("12345678-1234-5678-1234-567812345678")
    assert EntityId(fixed) == EntityId(fixed)
