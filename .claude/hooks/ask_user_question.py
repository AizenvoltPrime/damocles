#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "python-dotenv",
#     "requests",
# ]
# ///

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


def send_telegram_message(message):
    if not requests:
        return False

    bot_token = os.getenv('TELEGRAM_BOT_TOKEN')
    chat_id = os.getenv('TELEGRAM_CHAT_ID')

    if not bot_token or not chat_id:
        return False

    try:
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = {
            'chat_id': chat_id,
            'text': message,
        }
        response = requests.post(url, json=payload, timeout=10)
        return response.status_code == 200
    except Exception:
        return False


def main():
    try:
        input_data = json.loads(sys.stdin.read())

        log_dir = os.path.join(os.getcwd(), 'logs')
        os.makedirs(log_dir, exist_ok=True)
        log_file = os.path.join(log_dir, 'ask_user_question.json')

        if os.path.exists(log_file):
            with open(log_file, 'r') as f:
                try:
                    log_data = json.load(f)
                except (json.JSONDecodeError, ValueError):
                    log_data = []
        else:
            log_data = []

        log_data.append(input_data)

        with open(log_file, 'w') as f:
            json.dump(log_data, f, indent=2)

        question = input_data.get('tool_input', {}).get('question', '')
        preview = question[:80] + '...' if len(question) > 80 else question
        send_telegram_message(f"❓ Agent has a question\n\n{preview}")

        sys.exit(0)

    except Exception:
        sys.exit(0)


if __name__ == '__main__':
    main()
