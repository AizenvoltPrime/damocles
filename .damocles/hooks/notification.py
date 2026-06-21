#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "python-dotenv",
#     "requests",
# ]
# ///
"""Damocles `permission_required` hook — port of CC Notification.

Fires when the agent is blocked waiting on your file/shell approval. Observe-only: logs the
payload and pings Telegram. The Damocles payload carries `message`, `tool_name`, `input`, and
`file_path`|`command`.
"""

import argparse
import json
import os
import random
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


def announce_notification():
    try:
        engineer_name = os.getenv("ENGINEER_NAME", "").strip()
        if engineer_name and random.random() < 0.3:
            message = f"{engineer_name}, your agent needs your input"
        else:
            message = "Your agent needs your input"
        send_telegram_message(message)
    except Exception:
        pass


def main():
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--notify", action="store_true", help="Enable Telegram notifications")
        args = parser.parse_args()

        input_data = json.loads(sys.stdin.read())
        append_log(input_data, "notification.json")

        if args.notify and input_data.get("message") != "Claude is waiting for your input":
            announce_notification()
    except json.JSONDecodeError:
        pass
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
