"""The DOLMIR kernel — shared substrate every other package builds on.

This is the highest-change-control package in the codebase (Core
Architecture §5): every engine imports it, so every change here has maximal
blast radius. Additions require deliberate justification; when an engine
needs something *almost* like a kernel type, it maps at its own boundary
instead of widening the shared type.

The kernel imports nothing from the rest of ``dolmir`` — enforced by the
"Kernel is self-contained" import-linter contract.
"""

__all__: list[str] = []
