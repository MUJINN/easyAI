# Claude Code Project Instructions

## Project overview
This repository is a multi-subproject AI tooling workspace.

Primary subprojects:
- `model-relay/`: Python FastAPI service that exposes an OpenAI-compatible API gateway for multiple upstream LLM providers.
- `web/`: frontend UI for admin/usage features.
- root `README.md` is product overview; use it only for project context.

## Working rules
- Prefer the smallest relevant scope. Do not scan the whole repo unless the task explicitly requires cross-project work.
- When working on backend logic, start in `model-relay/` and read the API/server files before broad repo exploration.
- When working on frontend logic, start in `web/` and read the relevant UI/components files before broader scans.
- Avoid reading generated or cache directories such as `.venv`, `.pytest_cache`, `__pycache__`, and package metadata like `.egg-info` unless required.
- Keep edits surgical and avoid unrelated refactors.

## Relevant entry points
- Backend app: `model-relay/src/model_relay/main.py`
- Auth: `model-relay/src/model_relay/auth.py`
- Config: `model-relay/src/model_relay/config.py`
- Routing/fallback: `model-relay/src/model_relay/routing.py`
- Tests: `model-relay/tests/`
- Web app: `web/src/`

## Validation
- Backend: prefer focused tests in `model-relay/tests/`.
- Typical command: `cd model-relay && pytest -q`
- For a specific module, prefer a single test file or a narrow subset, for example:
  - `cd model-relay && pytest tests/test_relay.py -q`
  - `cd model-relay && pytest tests/test_retry.py -q`

## Style guidance
- Favor direct, minimal reads and precise patches.
- Preserve existing architecture and naming conventions.
- Prefer incremental changes over large rewrites.
- When unsure, inspect the exact file and the nearest tests before proposing a fix.

## Important context
- `requirements.md` is project requirements/specification material.
- `CLAUDE.md` is the operational instruction file for AI agents; keep it short and actionable.
- The goal is to minimize unnecessary token usage by reducing context churn and keeping the working path tight.
