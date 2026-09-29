# System Architecture Patterns

This file documents the architectural patterns, design patterns, and system structure used in this project. It helps developers understand the system's organization and maintain consistency when extending functionality.

## Guiding Principles

<!--
  These principles govern ALL architectural and implementation decisions.
  Agents MUST validate their work against these principles.
  Deviations require explicit justification in a creative/architecture decision document
  with a trade-off analysis referencing the specific principle being overridden.
-->

| Principle | Description |
|-----------|-------------|
| [e.g., Hub-and-Spoke Networking] | [e.g., All cross-account traffic flows through centralized transit VPCs; no local VPC endpoints] |
| [e.g., Compliance: HIPAA/SOC2] | [e.g., All data encrypted at rest and in transit; audit logging on all data access] |
| [e.g., API-First Design] | [e.g., All service interfaces defined as versioned APIs before implementation begins] |

## System Architecture

### High-Level Architecture
```
[ASCII or Mermaid diagram showing major components]

Example:
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────▶│     API     │────▶│  Database   │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   Service   │
                    └─────────────┘
```

### Component Responsibilities
- **[Component Name]**: [Primary responsibility, dependencies]
- **[Component Name]**: [Primary responsibility, dependencies]

### Data Flow Patterns

#### [Pattern Name]
```
[Diagram showing data flow]

Example:
User Input → Validation → Service → Database → Response
```
- **Trigger**: [What initiates this flow]
- **Steps**: [Key processing steps]
- **Output**: [Result or side effects]

## Design Patterns Used

### [Pattern Name] - [Context]
- **Problem**: [What problem does this solve]
- **Implementation**: [Where/how it's implemented]
- **Trade-offs**: [Benefits and drawbacks]
- **Example**: `path/to/file.ts:123`

## Integration Patterns

### [Integration Name]
- **Type**: [API, Event-driven, Batch, etc.]
- **Protocol**: [HTTP, gRPC, Message Queue, etc.]
- **Direction**: [Inbound, Outbound, Bidirectional]
- **Contract**: [Schema location or documentation]

## Code Organization Patterns

<!--
  This section records SOURCE-file conventions so an agent never has to *infer*
  a new file's language or extension at build time. It is the authoritative
  anchor: when a new file is created, its extension is resolved from the table
  below, NOT from whichever file happens to sit next to it.
  Resolve "what extension?" CATEGORICALLY (dominant extension of the target
  directory / file role), never SPATIALLY (an adjacent file of a different role).
-->

### Source Language & Default Extensions
- **Primary language**: [e.g., TypeScript — `.ts` for logic, `.tsx` for React components]
- **`.js`/`.jsx` permitted?**: [e.g., No — TS-only; or: legacy `.js` exists but new files MUST be `.ts`/`.tsx`]
- **Type-checking enforced**: [e.g., `tsc --noEmit` in CI — untyped files fail the gate]

### File Extension by Directory / Role
<!-- One row per source directory or file role. The extension here is binding for NEW files. -->

| Directory / Role | Extension | Notes |
|------------------|-----------|-------|
| [e.g., `src/hooks/`] | [e.g., `.ts`] | [e.g., React Query hooks — untyped is a convention violation] |
| [e.g., React components] | [e.g., `.tsx`] | [e.g., any file rendering JSX] |
| [e.g., `src/lib/`, schemas, utils] | [e.g., `.ts`] | [e.g., no JSX → `.ts`] |

> If a directory has a mixed history, the binding extension is the **dominant
> extension of that directory** (`git ls-files <dir> | extension-mode`), regardless
> of any single adjacent file. Pin new files explicitly in the plan/creative
> file-tree so this is never a build-time guess.

### Module Structure
- **New feature module shape**: [e.g., flat `lib/<feature>.ts` | module dir `<feature>/{service.ts,types.ts}` — match the dominant pattern]
- **Where new hooks/utilities/types live**: [e.g., hooks → `src/hooks/`, types → `src/types/` or co-located]

## Testing Patterns

### Test Organization
- **Test location**: [co-located with source (`*.test.ts` next to `*.ts`) | separate directory (`tests/`, `__tests__/`) | both]
- **File mapping**: [one test file per module/component | one test file per source file | feature-based test files]
- **Naming convention**: [e.g., `*.test.ts`, `*.spec.ts`, `test_*.py`, `*_test.go`]

### Test Grouping
- **Within-file structure**: [group by behavior/scenario | group by method/function | flat list]
- **Describe/context nesting**: [shallow (1 level) | deep (nested describes) | none]
- **Setup sharing**: [shared fixtures | per-test setup | factory functions]

### Test Framework & Style
- **Framework**: [Jest | Vitest | pytest | Go testing | etc.]
- **Assertion style**: [expect/toBe | assert | should | etc.]
- **Mocking approach**: [jest.mock | dependency injection | test doubles | etc.]

### Test Scope Preferences
- **Emphasis**: [unit-heavy | integration-heavy | balanced | E2E-first]
- **Typical test-to-source ratio**: [e.g., ~1:1 files, ~3-8 tests per function]
- **What is NOT typically tested**: [e.g., pure type definitions, framework boilerplate, simple getters/setters]

<!-- AUTO-MANAGED: c4-architecture-start -->
## C4 Architecture

<!--
  This section is auto-managed by /yay:c4. Run /yay:c4 to populate or refresh.
  Until /yay:c4 has been run for the first time, this section is a placeholder.
  Do not hand-edit between the AUTO-MANAGED markers — edits will be overwritten.
-->

C4 architecture documentation has not been generated for this project yet.

To populate this section, run `/yay:c4`. The command builds a complete bottom-up architecture model (Code → Component → Container → Context) and stores it under `memory-bank/c4/`. After it runs, this section will contain pointers to the generated docs and guidance on how agents should use them.

`/yay:c4` is idempotent — re-running only re-walks source directories whose content has changed. It is recommended for **large brownfield codebases** (≥3 components or ≥50 source files) and is auto-prompted at the end of `/yay:init` for projects that meet the threshold.

<!-- AUTO-MANAGED: c4-architecture-end -->

## Recent Architecture Changes

### [Date] - [Change Description]
- **What Changed**: [Architectural modification]
- **Reason**: [Why this pattern was chosen]
- **Trade-offs**: [What was gained vs lost]
- **Affected Components**: [List of components]

---

## Notes

- Keep this file updated during the BUILD phase when architectural changes occur
- Document patterns and trade-offs to help future developers understand design decisions
- Link to specific code locations where patterns are implemented
- Update diagrams to reflect current architecture
- Keep Guiding Principles current — add new principles when foundational patterns emerge
- When a new pattern appears to contradict an existing Guiding Principle, flag this explicitly
