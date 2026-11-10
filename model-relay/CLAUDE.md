# Claude Code Instructions for model-relay

## Scope
This folder contains the Python-based model gateway service for easyAI.

Focus on these files first:
- `src/model_relay/main.py` — API entrypoints and app wiring
- `src/model_relay/config.py` — configuration loading
- `src/model_relay/auth.py` — auth and key handling
- `src/model_relay/routing.py` — model routing and fallback logic
- `src/model_relay/retrying.py` — retry policy and error handling
- `src/model_relay/limiting.py` — rate limiting
- `tests/` — validation and expected behavior

## Working constraints
- Do not search the entire repo unless the task is clearly cross-project.
- Prefer direct reads of the targeted file and its adjacent tests.
- Do not spend time on unrelated frontend or root-level docs unless the request explicitly asks for them.
- Do not inspect generated metadata like `src/easyai_model_relay.egg-info/*` unless required for packaging or debugging.
- Keep changes limited to the current service unless the bug requires cross-service coordination.

## Architecture notes
- The service exposes an OpenAI-compatible API gateway.
- It normalizes provider differences and routes requests to upstream models.
- Fallback logic should prefer the configured backend priority and retry only on appropriate transient failures.
- Account/usage tracking is a key part of the service; be careful with any change touching request lifecycle or billing logic.

## Validation
Run the smallest relevant test slice first.

Examples:
- `cd model-relay && pytest tests/test_relay.py -q`
- `cd model-relay && pytest tests/test_retry.py -q`
- `cd model-relay && pytest tests/test_auth.py -q`
- `cd model-relay && pytest -q` only when the change affects multiple areas or you need the broad baseline.

## Success criteria
- Minimal, surgical patch
- Correct behavior with no unnecessary refactor
- Tests pass for the affected area
- Context stays focused on this service instead of the whole repository
