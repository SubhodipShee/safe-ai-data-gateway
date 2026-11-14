# ACME Payments: fraud scoring (FAKE demo code for the Safe AI Gateway)
# This file plays the role of a company's private source code.

from datetime import datetime, timedelta

HIGH_RISK_STATES = {"XX", "YY"}
VELOCITY_WINDOW = timedelta(minutes=10)


def velocity_score(transactions, now):
    recent = [t for t in transactions if now - t["created_at"] < VELOCITY_WINDOW]
    if len(recent) >= 5:
        return 40
    if len(recent) >= 3:
        return 20
    return 0


def amount_score(txn, history):
    if not history:
        return 25 if txn["amount"] > 20000 else 5
    average = sum(t["amount"] for t in history) / len(history)
    ratio = txn["amount"] / max(average, 1)
    if ratio > 8:
        return 35
    if ratio > 3:
        return 15
    return 0


def fraud_score(txn, history, device):
    now = datetime.utcnow()
    score = velocity_score(history, now) + amount_score(txn, history)
    if device.get("is_emulator"):
        score += 30
    if txn.get("billing_state") in HIGH_RISK_STATES:
        score += 10
    if device.get("first_seen") and now - device["first_seen"] < timedelta(hours=1):
        score += 15
    return min(score, 100)


def decide(txn, history, device):
    score = fraud_score(txn, history, device)
    if score >= 70:
        return {"action": "block", "score": score}
    if score >= 40:
        return {"action": "review", "score": score}
    return {"action": "allow", "score": score}
