#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "python-dotenv",
#     "requests",
# ]
# ///
"""Damocles `subagent_end` hook — port of CC SubagentStop.

Fires whenever a subagent finishes. Observe-only: logs the payload and pings Telegram.
"""

import argparse
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


def main():
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--chat", action="store_true", help="Copy transcript to chat.json")
        args = parser.parse_args()

        input_data = json.load(sys.stdin)

        log_dir = os.path.join(project_dir(input_data), "logs")
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, "subagent_stop.json")

        if os.path.exists(log_path):
            with open(log_path, "r") as f:
                try:
                    log_data = json.load(f)
                except (json.JSONDecodeError, ValueError):
                    log_data = []
        else:
            log_data = []
        log_data.append(input_data)
        with open(log_path, "w") as f:
            json.dump(log_data, f, indent=2)

        if args.chat:
            transcript_path = input_data.get("transcript_path")
            if transcript_path and os.path.exists(transcript_path):
                chat_data = []
                try:
                    with open(transcript_path, "r") as f:
                        for line in f:
                            line = line.strip()
                            if line:
                                try:
                                    chat_data.append(json.loads(line))
                                except json.JSONDecodeError:
                                    pass
                    with open(os.path.join(log_dir, "chat.json"), "w") as f:
                        json.dump(chat_data, f, indent=2)
                except Exception:
                    pass

        send_telegram_message("Subagent Complete")
    except json.JSONDecodeError:
        pass
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
