from __future__ import annotations

import json
from typing import Any


def pipeline_log(component: str, event: str, **fields: Any) -> None:
    payload = {"component": component, "event": event, **fields}
    print(
        f"[pipeline] {json.dumps(payload, ensure_ascii=False, separators=(',', ':'), default=str)}",
        flush=True,
    )
