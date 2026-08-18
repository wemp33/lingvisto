"""Generate golden vectors from the reference FSRS implementation.

Fuzzing is off so the sequence is deterministic; the JS port is checked against
these exact numbers.
"""
import json
from datetime import datetime, timezone, timedelta
from fsrs import Scheduler, Card, Rating, State

s = Scheduler(enable_fuzzing=False)

# Every rating sequence worth checking: pure success, pure failure, lapse and
# recovery, and a long mature interval.
SEQS = [
    [3, 3, 3, 3, 3],
    [1, 3, 3, 4, 3],
    [4, 4, 4],
    [2, 2, 3, 1, 3, 3],
    [3, 1, 1, 3, 4],
]

t0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
out = []

for seq in SEQS:
    card = Card()
    # A fresh py-fsrs Card is due "now"; pin it so elapsed time is deterministic.
    card.due = t0
    now = t0
    steps = []
    for r in seq:
        # Advance the clock to when the card is actually due, so elapsed_days
        # matches what a real learner would produce.
        now = max(now, card.due)
        card, _log = s.review_card(card, Rating(r), review_datetime=now)
        steps.append({
            "rating": r,
            "at": now.isoformat(),
            "stability": card.stability,
            "difficulty": card.difficulty,
            "state": card.state.name.lower(),
            "step": card.step,
            "dueOffsetMs": int((card.due - t0).total_seconds() * 1000),
        })
    out.append({"seq": seq, "steps": steps})

# Retrievability spot checks.
retr = []
c = Card()
c.due = t0
c, _ = s.review_card(c, Rating(3), review_datetime=t0)
c, _ = s.review_card(c, Rating(3), review_datetime=t0 + timedelta(minutes=10))
c, _ = s.review_card(c, Rating(3), review_datetime=t0 + timedelta(days=1))
for d in [0, 1, 3, 7, 30, 100]:
    retr.append({
        "days": d,
        "r": s.get_card_retrievability(c, current_datetime=c.last_review + timedelta(days=d)),
    })

print(json.dumps({
    "t0": t0.isoformat(),
    "params": list(s.parameters),
    "decay": s._DECAY,
    "factor": s._FACTOR,
    "sequences": out,
    "matureCard": {
        "stability": c.stability,
        "difficulty": c.difficulty,
        "state": c.state.name.lower(),
    },
    "retrievability": retr,
}, indent=1))
