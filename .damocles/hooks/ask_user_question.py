#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "python-dotenv",
#     "requests",
# ]
# ///
"""Damocles `tool_call` hook (match: AskUserQuestion) — port of CC PreToolUse:AskUserQuestion.

Damocles delivers the tool args under `input` (CC used `tool_input`). AskUserQuestion's input is
`{ questions: [{ question, header, options, ... }] }`, so pull the first question's text. Prints
nothing to stdout so the tool proceeds normally.
"""

import json
import os
import sys

try:
    import requests
except ImportError:
    requests = None

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


def project_dir(input_data):
    return input_data.get("cwd") or os.getenv("DAMOCLES_PROJECT_DIR") or os.getcwd()


def append_log(input_data, name):
    try:
        log_dir = os.path.join(project_dir(input_data), "logs")
        os.makedirs(log_dir, exist_ok=True)
        log_file = os.path.join(log_dir, name)
        if os.path.exists(log_file):
            with open(log_file, "r") as f:
                try:
                    log_data = json.load(f)
                except (json.JSONDecodeError, ValueError):
                    log_data = []
        else:
            log_data = []
        log_data.append(input_data)
        with open(log_file, "w") as f:
            json.dump(log_data, f, indent=2)
    except Exception:
        pass


def send_telegram_message(message):
    if not requests:
        return False
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if not bot_token or not chat_id:
        return False
    try:
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        response = requests.post(url, json={"chat_id": chat_id, "text": message}, timeout=10)
        return response.status_code == 200
    except Exception:
        return False


def first_question(tool_input):
    if not isinstance(tool_input, dict):
        return ""
    questions = tool_input.get("questions")
    if isinstance(questions, list) and questions:
        first = questions[0]
        if isinstance(first, dict):
            return first.get("question", "") or ""
    # Fallback for a flat shape.
    return tool_input.get("question", "") or ""


def main():
    try:
        input_data = json.loads(sys.stdin.read())
        append_log(input_data, "ask_user_question.json")
        question = first_question(input_data.get("input", {}))
        preview = question[:80] + "..." if len(question) > 80 else question
        send_telegram_message(f"Agent has a question\n\n{preview}")
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
