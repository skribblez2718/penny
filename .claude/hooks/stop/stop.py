"""
Stop hook - Sends task summary to voice notification server
Reads JSON payload, parses transcript file, and extracts SUMMARY section
"""

import sys
import os
import re
import json
import urllib.request
import urllib.error
import tempfile
import subprocess
from typing import Optional
from pathlib import Path


#########################[ start read_transcript ]###########################
def read_transcript(transcript_path: str) -> Optional[str]:
    """
    Read transcript JSONL file and extract last assistant message

    Args:
        transcript_path: Path to the transcript JSONL file

    Returns:
        The last assistant message text if found, None otherwise
    """
    try:
        if not os.path.exists(transcript_path):
            print(f"⚠️  Transcript file not found: {transcript_path}", file=sys.stderr)
            return None

        # Read JSONL file line by line
        last_assistant_message = None
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    entry = json.loads(line.strip())
                    # Look for assistant messages (use 'type' not 'role')
                    if entry.get('type') == 'assistant':
                        # Extract message object first
                        message = entry.get('message', {})
                        # Extract text from message.content array
                        content = message.get('content', [])
                        if isinstance(content, list):
                            for item in content:
                                if isinstance(item, dict) and item.get('type') == 'text':
                                    last_assistant_message = item.get('text', '')
                        elif isinstance(content, str):
                            last_assistant_message = content
                except json.JSONDecodeError:
                    continue

        return last_assistant_message

    except Exception as e:
        print(f"❌ Error reading transcript: {e}", file=sys.stderr)
        return None


#########################[ end read_transcript ]#############################

#########################[ start generate_summary ]##########################
def clean_list_item(text: str) -> str:
    """
    Clean list items and convert to natural sentence fragments

    Args:
        text: Text that may contain list formatting

    Returns:
        Cleaned text without list markers
    """
    # Remove numbered lists (1., 2., a., b., etc.)
    text = re.sub(r'^\s*\d+[\.)]\s*', '', text)
    text = re.sub(r'^\s*[a-z][\.)]\s*', '', text, flags=re.IGNORECASE)

    # Remove all bullet types
    text = re.sub(r'^[-*•◦▪▫]\s*', '', text)

    # Remove checkbox markers
    text = re.sub(r'^\[[ xX]\]\s*', '', text)

    # Remove emoji prefixes
    text = re.sub(r'^[✅❌⚠️🔍📋⚡📊➡️🎯]+\s*', '', text)

    return text.strip()


def extract_sentences_from_text(text: str, max_sentences: int = 5) -> list:
    """
    Extract clean sentences from text, avoiding list items

    Args:
        text: Input text
        max_sentences: Maximum number of sentences to extract

    Returns:
        List of clean sentence strings
    """
    # Clean all list formatting first
    lines = text.split('\n')
    cleaned_lines = []

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Clean list markers
        cleaned = clean_list_item(line)
        if cleaned:
            cleaned_lines.append(cleaned)

    # Rejoin and split by sentence boundaries
    full_text = ' '.join(cleaned_lines)

    # Remove all markdown and emoji
    full_text = re.sub(r'[#*`_]', '', full_text)
    full_text = re.sub(r'[\U0001F300-\U0001F9FF\u2600-\u26FF\u2700-\u27BF]+', '', full_text)

    # Split into sentences
    sentences = re.split(r'(?<=[.!?])\s+', full_text.strip())

    # Filter meaningful sentences
    result = []
    for sentence in sentences[:max_sentences * 2]:  # Check more to find good ones
        sentence = sentence.strip()
        # Must have at least 3 words and not be fragment
        if sentence and len(sentence.split()) >= 3 and sentence[0].isupper():
            result.append(sentence)
            if len(result) >= max_sentences:
                break

    return result


def generate_summary(text: str) -> Optional[str]:
    """
    Generate intelligent 3-5 sentence voice summary from assistant response

    Strategy:
    1. Check for custom voice marker (🗣️ CUSTOM COMPLETED:)
    2. Extract 3-5 clean sentences from entire response (format-agnostic)

    Args:
        text: The full response text from Penny

    Returns:
        3-5 sentence voice-optimized summary, None if text is empty
    """
    if not text or not text.strip():
        return None

    text = text.strip()

    # Priority 1: Custom voice markers (user explicitly defined voice summary)
    voice_markers = ['🗣️ CUSTOM COMPLETED:', 'CUSTOM COMPLETED:']
    for marker in voice_markers:
        if marker in text:
            idx = text.index(marker) + len(marker)
            summary = text[idx:].split('\n')[0].strip()
            # Clean any list markers from custom summary too
            summary = clean_list_item(summary)
            return summary

    # Priority 2: Extract 3-5 sentences from entire response
    # This works regardless of response format (DA.md, Plan mode, etc.)
    sentences = extract_sentences_from_text(text, max_sentences=5)

    if sentences:
        # Take 3-5 sentences (prefer at least 3)
        if len(sentences) >= 3:
            sentences = sentences[:5]
        elif len(sentences) >= 2:
            sentences = sentences[:3]
        else:
            sentences = sentences[:2]

        summary = ' '.join(sentences)
        if not summary.endswith(('.', '!', '?')):
            summary += '.'
        return summary

    # Fallback: truncate to reasonable length
    words = text.split()[:30]
    if words:
        summary = ' '.join(words)
        if not summary.endswith('.'):
            summary += '.'
        return summary

    return None


#########################[ end generate_summary ]############################

def play_audio(audio_file: str) -> bool:
    """
    Play audio file using available Linux audio players

    Args:
        audio_file: Path to the audio file

    Returns:
        True if successful, False otherwise
    """
    audio_players = ['mpg123', 'mpv', 'ffplay', 'paplay']

    for player in audio_players:
        try:
            if player == 'paplay':
                # Convert to wav for pulseaudio
                wav_file = audio_file.replace('.mp3', '.wav')
                subprocess.run(['ffmpeg', '-y', '-i', audio_file, wav_file],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                result = subprocess.run([player, wav_file],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    os.unlink(wav_file)
                except:
                    pass
                if result.returncode == 0:
                    return True
            else:
                result = subprocess.run([player, audio_file],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if result.returncode == 0:
                    return True
        except:
            continue

    return False


#########################[ end play_audio ]##################################

#########################[ start send_to_voice_server ]######################
def send_to_voice_server(summary: str, port: str = "8001") -> bool:
    """
    Send summary to voice notification server (OpenAI TTS endpoint)

    Args:
        summary: The summary text to send
        port: The port of the voice server (from VOICE_SERVER_PORT env var)

    Returns:
        True if successful, False otherwise
    """
    try:
        url = f"http://127.0.0.1:{port}/v1/audio/speech"
        payload = {
            "model": "tts-1",
            "input": f"Penny Task Complete: {summary}",
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
                subprocess.run(['notify-send', 'Penny Task Complete', summary],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except:
                pass

            # Clean up temp file
            try:
                os.unlink(audio_file)
            except:
                pass

            if played:
                print(f"✅ Sent summary to voice server: {summary}", file=sys.stderr)
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
    Reads JSON payload from stdin, parses transcript, and sends summary to voice server
    """
    try:
        # Read JSON payload from stdin
        hook_data = json.load(sys.stdin)

        # Extract transcript path from payload
        transcript_path = hook_data.get('transcript_path')
        if not transcript_path:
            print("⚠️  No transcript_path in hook payload", file=sys.stderr)
            return 0

        # Read the transcript file
        assistant_response = read_transcript(transcript_path)
        if not assistant_response:
            return 0

        # Generate the summary
        summary = generate_summary(assistant_response)
        if not summary:
            # No summary found, exit silently
            return 0

        # Get voice server port from environment
        port = os.environ.get("VOICE_SERVER_PORT", "8001")

        # Send to voice server
        send_to_voice_server(summary, port)

        return 0

    except json.JSONDecodeError as e:
        print(f"❌ Failed to parse JSON payload: {e}", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"❌ Stop hook error: {e}", file=sys.stderr)
        return 0  # Don't fail the hook even if there's an error


#########################[ end main ]########################################

if __name__ == "__main__":
    sys.exit(main())
