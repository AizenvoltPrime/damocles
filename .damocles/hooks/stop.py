#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "python-dotenv",
#     "requests",
# ]
# ///
"""Damocles `agent_end` hook — port of CC Stop.

Fires when the agent finishes a turn. Observe-only: logs the payload, optionally dumps the
transcript to logs/chat.json (--chat), and pings Telegram. The Damocles payload carries
`session_id`, `transcript_path`, `cwd`, and a `messages` snapshot.
"""

import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path

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


def get_completion_messages():
    return ["Work complete!", "All done!", "Task finished!", "Job complete!", "Ready for next task!"]


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


def get_llm_completion_message():
    script_dir = Path(__file__).parent
    llm_dir = script_dir / "utils" / "llm"

    if os.getenv("OPENAI_API_KEY"):
        oai_script = llm_dir / "oai.py"
        if oai_script.exists():
            try:
                result = subprocess.run(
                    ["uv", "run", str(oai_script), "--completion"],
                    capture_output=True, text=True, timeout=10,
                )
                if result.returncode == 0 and result.stdout.strip():
                    return result.stdout.strip()
            except (subprocess.TimeoutExpired, subprocess.SubprocessError):
                pass

    if os.getenv("ANTHROPIC_API_KEY"):
        anth_script = llm_dir / "anth.py"
        if anth_script.exists():
            try:
                result = subprocess.run(
                    ["uv", "run", str(anth_script), "--completion"],
                    capture_output=True, text=True, timeout=10,
                )
                if result.returncode == 0 and result.stdout.strip():
                    return result.stdout.strip()
            except (subprocess.TimeoutExpired, subprocess.SubprocessError):
                pass

    return random.choice(get_completion_messages())


def announce_completion():
    try:
        send_telegram_message(f"Task Complete\n\n{get_llm_completion_message()}")
    except Exception:
        pass


def dump_transcript(input_data, log_dir):
    transcript_path = input_data.get("transcript_path")
    if not transcript_path or not os.path.exists(transcript_path):
        return
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


def main():
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--chat", action="store_true", help="Copy transcript to chat.json")
        args = parser.parse_args()

        input_data = json.load(sys.stdin)

        log_dir = os.path.join(project_dir(input_data), "logs")
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, "stop.json")

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
            dump_transcript(input_data, log_dir)

        announce_completion()
    except json.JSONDecodeError:
        pass
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
