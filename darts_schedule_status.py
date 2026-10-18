"""Re-evaluate time-dependent fixture labels when serving stored schedules."""
from copy import deepcopy
from datetime import datetime, timezone


def current_schedule(payload, now, field="matches"):
    result = deepcopy(payload)

    def age(item):
        if item.get("kind") not in ("upcoming", "live"):
            return item
        try:
            planned = datetime.fromisoformat(str(item.get("plannedAt")).replace("Z", "+00:00"))
            planned = planned.replace(tzinfo=timezone.utc) if planned.tzinfo is None else planned
            if (now - planned).total_seconds() > 8 * 3600:
                item["kind"] = "pending"
                if "text" in item:
                    item["text"] = f"{item.get('home', '')} gegen {item.get('away', '')} · Vorläufig beendet – Bestätigung ausstehend"
        except (ValueError, TypeError):
            pass
        return item

    result[field] = [age(item) for item in result.get(field, [])]
    for team in result.get("teams", []):
        if "matches" not in team:
            continue
        team["matches"] = [age(item) for item in team.get("matches", [])]
        team["nextMatch"] = next((item for item in team["matches"] if item.get("kind") in ("upcoming", "live")), None)
    return result
