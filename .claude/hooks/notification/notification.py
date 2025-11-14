"""
Notification hook - Sends tool permission requests to voice server
Filters out idle input alerts and only notifies on permission requests
"""

import sys
import os
import json
import urllib.request
import urllib.error
import tempfile
import subprocess
from typing import Optional


#########################[ start is_permission_request ]#####################
def is_permission_request(message: str) -> bool:
    """
    Determine if notification is a tool permission request vs idle alert

    Args:
        message: The notification message

    Returns:
        True if it's a permission request, False if idle alert
    """
    # Exclude idle/waiting messages
    idle_patterns = [
        "waiting for your input",
        "waiting for input",
        "idle"
    ]

    message_lower = message.lower()
    for pattern in idle_patterns:
        if pattern in message_lower:
            return False

    # Include permission requests
    permission_patterns = [
        "permission",
        "needs your permission",
        "requires permission",
        "approve"
    ]

    for pattern in permission_patterns:
        if pattern in message_lower:
            return True

    # Default: if it mentions a tool name, likely a permission request
    # Common tool names that might appear
    tool_names = [
        "bash", "edit", "write", "read", "task", "grep", "glob",
        "notebook", "web", "fetch", "search"
    ]

    for tool in tool_names:
        if tool in message_lower:
            return True

    # Default to False (don't notify unless we're sure it's a permission)
    return False


#########################[ end is_permission_request ]#######################

#########################[ start play_audio ]################################
def play_audio(audio_file: str) -> bool:
    """
    Play audio file using mpg123 (headless console-only player)
    mpg123 is truly headless with no GUI components, preventing any windows from appearing

    Args:
        audio_file: Path to the audio file

    Returns:
        True if successful, False otherwise
    """
    try:
        # mpg123: Console-only MP3 player with no GUI dependencies
        # -q flag: quiet mode (suppresses terminal output)
        result = subprocess.run(
            ['mpg123', '-q', audio_file],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        return result.returncode == 0
    except Exception as e:
        print(f"⚠️  Failed to play audio with mpg123: {e}", file=sys.stderr)
        return False


#########################[ end play_audio ]##################################

#########################[ start send_to_voice_server ]######################
def send_to_voice_server(message: str, port: str = "8001") -> bool:
    """
    Send permission request to voice server (OpenAI TTS endpoint)

    Args:
        message: The notification message to send
        port: The port of the voice server (from VOICE_SERVER_PORT env var)

    Returns:
        True if successful, False otherwise
    """
    try:
        url = f"http://127.0.0.1:{port}/v1/audio/speech"
        payload = {
            "model": "tts-1",
            "input": f"Penny Permission Request: {message}",
            "voice": "alloy",
            "response_format": "mp3"
        }

        # Create request with urllib
        req = urllib.request.Request(url, method='POST')
        req.add_header('Content-Type', 'application/json')
        data = json.dumps(payload).encode('utf-8')

        response = urllib.request.urlopen(req, data=data, timeout=10)

        if response.status == 200:
            # Save audio to temp file
            with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as f:
                f.write(response.read())
                audio_file = f.name

            # Play the audio
            played = play_audio(audio_file)

            # Send desktop notification
            try:
                subprocess.run(['notify-send', 'Penny Permission Request', message],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except:
                pass

            # Clean up temp file
            try:
                os.unlink(audio_file)
            except:
                pass

            if played:
                print(f"✅ Sent permission request to voice server: {message}", file=sys.stderr)
                return True
            else:
                print(f"⚠️  Audio generated but playback failed", file=sys.stderr)
                return False
        else:
            print(f"⚠️  Voice server responded with status {response.status}", file=sys.stderr)
            return False

    except urllib.error.HTTPError as e:
        print(f"⚠️  Voice server error (HTTP {e.code}): {e.reason}", file=sys.stderr)
        return False
    except urllib.error.URLError as e:
        print(f"⚠️  Could not reach voice server: {e.reason}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"❌ Error sending to voice server: {e}", file=sys.stderr)
        return False


#########################[ end send_to_voice_server ]########################

#########################[ start main ]######################################
def main():
    """
    Main hook function
    Reads notification payload and sends permission requests to voice server
    """
    try:
        # Read JSON payload from stdin
        hook_data = json.load(sys.stdin)

        # Extract message from payload
        message = hook_data.get('message', '')
        if not message:
            return 0

        # Filter: only send permission requests, not idle alerts
        if not is_permission_request(message):
            print(f"⏭️  Skipping non-permission notification: {message}", file=sys.stderr)
            return 0

        # Get voice server port from environment
        port = os.environ.get("VOICE_SERVER_PORT", "8001")

        # Send to voice server
        send_to_voice_server(message, port)

        return 0

    except json.JSONDecodeError as e:
        print(f"❌ Failed to parse JSON payload: {e}", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"❌ Notification hook error: {e}", file=sys.stderr)
        return 0  # Don't fail the hook even if there's an error


#########################[ end main ]########################################

if __name__ == "__main__":
    sys.exit(main())

