"""
PAIVoice - Personal AI Voice notification server for Linux with ElevenLabs
"""

import os
import json
import asyncio
import tempfile
import subprocess
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, Optional, Any
import re

import httpx
from fastapi import FastAPI, HTTPException, Request, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
import uvicorn


# Load .env from voice-server directory
load_dotenv(Path(__file__).parent / '.env')

PORT = int(os.environ.get('PORT', '8001'))

# ElevenLabs configuration - MUST be set in .env
ELEVENLABS_API_KEY = os.environ.get('ELEVENLABS_API_KEY')
ELEVENLABS_VOICE_ID = os.environ.get('ELEVENLABS_VOICE_ID', 'jqcCZkN6Knx8BJ5TBdYR')

if not ELEVENLABS_API_KEY:
    print("⚠️  Warning: ELEVENLABS_API_KEY not found in .env")
    print("   Voice features will fall back to Linux TTS (espeak-ng)")
    print("   To enable ElevenLabs voices, add to .env:")
    print("   ELEVENLABS_API_KEY=your_api_key_here")


# OpenAI-compatible models
class OpenAITTSRequest(BaseModel):
    model: str  # tts-1, tts-1-hd, gpt-4o-mini-tts
    input: str  # Text to synthesize (max 4096 chars)
    voice: str  # alloy, echo, fable, onyx, nova, shimmer
    response_format: Optional[str] = "mp3"  # mp3, opus, aac, flac, wav, pcm
    speed: Optional[float] = 1.0  # 0.25 to 4.0


# Initialize FastAPI app
app = FastAPI(title="PAIVoice Server", version="2.0.0")

# Add CORS middleware - restricted to localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://127.0.0.1"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


async def generate_speech_openai(openai_request: OpenAITTSRequest) -> Optional[bytes]:
    """
    Generate speech using ElevenLabs API (OpenAI-compatible endpoint)
    Translates OpenAI TTS request to ElevenLabs format

    Args:
        openai_request: OpenAI TTS request

    Returns:
        Audio bytes if successful, None otherwise
    """
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=500, detail="ElevenLabs API key not configured")

    # Validate input length (OpenAI limit is 4096 chars)
    if len(openai_request.input) > 4096:
        raise HTTPException(status_code=400, detail="Input text exceeds 4096 character limit")

    # Map OpenAI model to ElevenLabs model
    model_mapping = {
        "tts-1": "eleven_turbo_v2_5",
        "tts-1-hd": "eleven_turbo_v2_5",  # Use same model for HD
        "gpt-4o-mini-tts": "eleven_turbo_v2_5"
    }
    elevenlabs_model = model_mapping.get(openai_request.model, "eleven_turbo_v2_5")

    # Always use configured ElevenLabs voice (ignore OpenAI voice parameter)
    voice_to_use = ELEVENLABS_VOICE_ID

    # Map speed to voice settings (ElevenLabs doesn't have direct speed control)
    # We'll use the style parameter as a proxy
    style_value = min(1.0, max(0.0, (openai_request.speed - 0.5) / 2.0))

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{voice_to_use}",
                headers={
                    "Accept": "audio/mpeg",
                    "Content-Type": "application/json",
                    "xi-api-key": ELEVENLABS_API_KEY
                },
                json={
                    "text": openai_request.input,
                    "model_id": elevenlabs_model,
                    "voice_settings": {
                        "stability": 0.75,
                        "similarity_boost": 0.75,
                        "style": style_value,
                        "use_speaker_boost": True
                    }
                },
                timeout=30.0
            )

            if response.status_code != 200:
                error_detail = f"ElevenLabs API error: {response.status_code}"
                print(error_detail)
                raise HTTPException(status_code=response.status_code, detail=error_detail)

            return response.content

    except httpx.RequestError as error:
        print(f"ElevenLabs request error: {error}")
        raise HTTPException(status_code=500, detail=f"ElevenLabs API request failed: {str(error)}")
    except HTTPException:
        raise
    except Exception as error:
        print(f"ElevenLabs error: {error}")
        raise HTTPException(status_code=500, detail=f"Speech generation failed: {str(error)}")


async def transcribe_audio_openai(
    audio_file: UploadFile,
    model: str,
    language: Optional[str] = None,
    response_format: str = "json",
    temperature: Optional[float] = None
) -> Dict[str, Any]:
    """
    Transcribe audio using ElevenLabs API (OpenAI-compatible endpoint)
    Translates OpenAI STT request to ElevenLabs format

    Args:
        audio_file: Audio file to transcribe
        model: Model name (whisper-1, gpt-4o-transcribe, etc.)
        language: Optional language code
        response_format: Response format (json, text, srt, verbose_json, vtt)
        temperature: Optional temperature parameter

    Returns:
        Transcription response in OpenAI format
    """
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=500, detail="ElevenLabs API key not configured")

    try:
        # Read audio file content
        audio_content = await audio_file.read()

        # Prepare multipart form data for ElevenLabs
        files = {
            'file': (audio_file.filename, audio_content, audio_file.content_type or 'audio/mpeg')
        }

        data = {
            'model_id': 'scribe_v1'  # ElevenLabs STT model
        }

        # Add optional language parameter
        if language:
            data['language_code'] = language

        # Add temperature if provided
        if temperature is not None:
            data['temperature'] = temperature

        # Call ElevenLabs STT API
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.elevenlabs.io/v1/speech-to-text",
                headers={
                    "xi-api-key": ELEVENLABS_API_KEY
                },
                files=files,
                data=data,
                timeout=60.0  # Longer timeout for transcription
            )

            if response.status_code != 200:
                error_detail = f"ElevenLabs STT API error: {response.status_code}"
                print(error_detail)
                try:
                    error_body = response.json()
                    print(f"Error body: {error_body}")
                except:
                    pass
                raise HTTPException(status_code=response.status_code, detail=error_detail)

            elevenlabs_result = response.json()

        # Translate ElevenLabs response to OpenAI format
        openai_response = {
            "text": elevenlabs_result.get("text", "")
        }

        # Add verbose fields if requested
        if response_format == "verbose_json":
            openai_response.update({
                "task": "transcribe",
                "language": elevenlabs_result.get("language_code", language or "en"),
                "duration": 0.0,  # ElevenLabs doesn't provide duration directly
                "segments": []
            })

            # Map ElevenLabs words to OpenAI segments if available
            if "words" in elevenlabs_result:
                words = elevenlabs_result["words"]
                if words:
                    # Create a single segment with all the text
                    openai_response["segments"] = [{
                        "id": 0,
                        "seek": 0,
                        "start": 0.0,
                        "end": 0.0,
                        "text": elevenlabs_result.get("text", ""),
                        "tokens": [],
                        "temperature": temperature or 0.0,
                        "avg_logprob": 0.0,
                        "compression_ratio": 1.0,
                        "no_speech_prob": 0.0
                    }]

        # Handle different response formats
        if response_format == "text":
            return {"text": openai_response["text"]}
        elif response_format in ["srt", "vtt"]:
            # For subtitle formats, return basic text (proper formatting would require timestamps)
            return {"text": openai_response["text"]}
        else:
            # json or verbose_json
            return openai_response

    except httpx.RequestError as error:
        print(f"ElevenLabs STT request error: {error}")
        raise HTTPException(status_code=500, detail=f"ElevenLabs STT API request failed: {str(error)}")
    except HTTPException:
        raise
    except Exception as error:
        print(f"ElevenLabs STT error: {error}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(error)}")




# Rate limiting
request_counts: Dict[str, Dict[str, Any]] = {}
RATE_LIMIT = 10  # 10 requests per minute
RATE_WINDOW = 60  # 1 minute in seconds


def check_rate_limit(ip: str) -> bool:
    """Check rate limit for IP"""
    now = datetime.now()

    if ip not in request_counts:
        request_counts[ip] = {'count': 1, 'reset_time': now + timedelta(seconds=RATE_WINDOW)}
        return True

    record = request_counts[ip]

    if now > record['reset_time']:
        request_counts[ip] = {'count': 1, 'reset_time': now + timedelta(seconds=RATE_WINDOW)}
        return True

    if record['count'] >= RATE_LIMIT:
        return False

    record['count'] += 1
    return True


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Rate limiting middleware"""
    client_ip = request.headers.get('x-forwarded-for', 'localhost')

    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    response = await call_next(request)
    return response


@app.post("/v1/audio/speech")
async def openai_tts_endpoint(tts_request: OpenAITTSRequest):
    """
    OpenAI-compatible Text-to-Speech endpoint
    Translates OpenAI TTS requests to ElevenLabs and returns audio stream
    """
    try:
        print(f"🎙️  TTS request: model={tts_request.model}, voice={tts_request.voice}, format={tts_request.response_format}")

        # Generate speech using ElevenLabs
        audio_bytes = await generate_speech_openai(tts_request)

        if not audio_bytes:
            raise HTTPException(status_code=500, detail="Failed to generate speech")

        # Map response format to content type
        content_type_mapping = {
            "mp3": "audio/mpeg",
            "opus": "audio/opus",
            "aac": "audio/aac",
            "flac": "audio/flac",
            "wav": "audio/wav",
            "pcm": "audio/pcm"
        }
        content_type = content_type_mapping.get(tts_request.response_format, "audio/mpeg")

        # Return audio stream
        return StreamingResponse(
            iter([audio_bytes]),
            media_type=content_type,
            headers={
                "Content-Disposition": f"attachment; filename=speech.{tts_request.response_format}"
            }
        )

    except HTTPException:
        raise
    except Exception as error:
        print(f"TTS endpoint error: {error}")
        raise HTTPException(status_code=500, detail=str(error))


@app.post("/v1/audio/transcriptions")
async def openai_stt_endpoint(
    file: UploadFile = File(...),
    model: str = Form(...),
    language: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    response_format: str = Form("json"),
    temperature: Optional[float] = Form(None)
):
    """
    OpenAI-compatible Speech-to-Text endpoint
    Translates OpenAI STT requests to ElevenLabs and returns transcription
    """
    try:
        print(f"🎤 STT request: model={model}, language={language}, format={response_format}")

        # Transcribe using ElevenLabs
        transcription = await transcribe_audio_openai(
            audio_file=file,
            model=model,
            language=language,
            response_format=response_format,
            temperature=temperature
        )

        # Return appropriate format
        if response_format == "text":
            # Return plain text
            from fastapi.responses import PlainTextResponse
            return PlainTextResponse(content=transcription["text"])
        else:
            # Return JSON (default, verbose_json, or converted srt/vtt)
            return transcription

    except HTTPException:
        raise
    except Exception as error:
        print(f"STT endpoint error: {error}")
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/health")
async def health_endpoint():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "port": PORT,
        "elevenlabs": bool(ELEVENLABS_API_KEY)
    }


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "name": "PAIVoice Server - OpenAI → ElevenLabs Translation Layer",
        "version": "3.0.0",
        "endpoints": {
            "tts": "/v1/audio/speech",
            "stt": "/v1/audio/transcriptions",
            "health": "/health"
        }
    }


if __name__ == "__main__":
    print(f"🚀 PAIVoice Server starting on port {PORT}")
    if ELEVENLABS_API_KEY:
        print(f"🎙️  Using ElevenLabs voice: {ELEVENLABS_VOICE_ID}")
    else:
        print(f"⚠️  No ElevenLabs API key configured - please add to .env")
    print(f"\n📡 OpenAI-Compatible Endpoints:")
    print(f"   TTS: POST http://127.0.0.1:{PORT}/v1/audio/speech")
    print(f"   STT: POST http://127.0.0.1:{PORT}/v1/audio/transcriptions")
    print(f"\n🔒 Security: CORS restricted to localhost, rate limiting enabled")
    print(f"💡 Translation Layer: OpenAI API → ElevenLabs API")

    uvicorn.run(
        "server:app",
        host="127.0.0.1",
        port=PORT,
        reload=False,
        access_log=True
    )
