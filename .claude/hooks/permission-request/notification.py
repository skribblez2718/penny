"""
PermissionRequest hook - Sends tool permission requests to voice server

Uses the PermissionRequest hook which fires ONLY for permission requests,
providing structured payload with tool_name and tool_input.
"""

import sys
import os
import json
import urllib.request
import urllib.error
import tempfile
import subprocess
from typing import Optional, Any


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
        print(f"Failed to play audio with mpg123: {e}", file=sys.stderr)
        return False


#########################[ end play_audio ]##################################

#########################[ start format_permission_message ]#################
def format_permission_message(tool_name: str, tool_input: Any) -> str:
    """
    Format a human-readable permission message from structured tool data

    Args:
        tool_name: Name of the tool requesting permission
        tool_input: Tool input (can be dict, string, or other)

    Returns:
        Formatted message string
    """
    # Base message
    message = f"{tool_name}"

    # Add context based on tool type
    if isinstance(tool_input, dict):
        if "command" in tool_input:
            # Bash command - show truncated command
            cmd = tool_input["command"]
            if len(cmd) > 50:
                cmd = cmd[:47] + "..."
            message = f"{tool_name}: {cmd}"
        elif "file_path" in tool_input:
            # File operations - show path
            path = tool_input["file_path"]
            message = f"{tool_name}: {path}"
        elif "pattern" in tool_input:
            # Glob/Grep - show pattern
            pattern = tool_input["pattern"]
            message = f"{tool_name}: {pattern}"
        elif "url" in tool_input:
            # Web operations - show URL
            url = tool_input["url"]
            if len(url) > 40:
                url = url[:37] + "..."
            message = f"{tool_name}: {url}"
    elif isinstance(tool_input, str) and tool_input:
        # String input - show truncated
        if len(tool_input) > 50:
            tool_input = tool_input[:47] + "..."
        message = f"{tool_name}: {tool_input}"

    return message


#########################[ end format_permission_message ]###################

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
        da_name = os.environ.get("DA_NAME", "AI Assistant")
        payload = {
            "model": "tts-1",
            "input": f"{da_name} Permission Request: {message}",
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
                subprocess.run(['notify-send', f'{da_name} Permission Request', message],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except:
                pass

            # Clean up temp file
            try:
                os.unlink(audio_file)
            except:
                pass

            if played:
                print(f"Sent permission request to voice server: {message}", file=sys.stderr)
                return True
            else:
                print(f"Audio generated but playback failed", file=sys.stderr)
                return False
        else:
            print(f"Voice server responded with status {response.status}", file=sys.stderr)
            return False

    except urllib.error.HTTPError as e:
        print(f"Voice server error (HTTP {e.code}): {e.reason}", file=sys.stderr)
        return False
    except urllib.error.URLError as e:
        print(f"Could not reach voice server: {e.reason}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error sending to voice server: {e}", file=sys.stderr)
        return False


#########################[ end send_to_voice_server ]########################

#########################[ start main ]######################################
def main():
    """
    Main hook function for PermissionRequest hook

    Reads structured permission payload and sends notification to voice server.
    PermissionRequest hook provides:
    - tool_name: Name of the tool requesting permission
    - tool_input: Tool input parameters (dict or other)
    - session_id: Current session ID
    - hook_event_name: "PermissionRequest"
    """
    try:
        # Read JSON payload from stdin
        hook_data = json.load(sys.stdin)

        # Extract structured data from PermissionRequest payload
        tool_name = hook_data.get('tool_name', 'Unknown')
        tool_input = hook_data.get('tool_input', {})

        # Format human-readable message from structured data
        message = format_permission_message(tool_name, tool_input)

        # Get voice server port from environment
        port = os.environ.get("VOICE_SERVER_PORT", "8001")

        # Send to voice server
        send_to_voice_server(message, port)

        return 0

    except json.JSONDecodeError as e:
        print(f"Failed to parse JSON payload: {e}", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"PermissionRequest hook error: {e}", file=sys.stderr)
        return 0  # Don't fail the hook even if there's an error


#########################[ end main ]########################################

if __name__ == "__main__":
    sys.exit(main())
