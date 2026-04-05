from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlmodel import Session, select
from ..database import get_session
from ..models import User
from ..schemas import AssistantQuery, AssistantResponse, VoiceCalibration, ApiKeysUpdate
from ..llm_service import LLMService
from ..security import get_current_user
from dotenv import load_dotenv
import os
import io
import json
import wave
import audioop
from vosk import Model, KaldiRecognizer

load_dotenv()
router = APIRouter(prefix="/assistant", tags=["assistant"])


_vosk_model = None


def _get_vosk_model() -> Model:
    global _vosk_model
    if _vosk_model is not None:
        return _vosk_model

    model_path = os.getenv("VOSK_MODEL_PATH", "models/vosk-model-small-en-us-0.15")
    if not os.path.isdir(model_path):
        raise HTTPException(
            400,
            f"Missing VOSK model directory at {model_path}. Set VOSK_MODEL_PATH to a valid Vosk model folder.",
        )

    _vosk_model = Model(model_path)
    return _vosk_model


def _transcribe_with_model(audio_bytes: bytes, filename: str, user_api_keys: dict) -> str:
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
            sample_rate = wav_file.getframerate()
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            pcm_data = wav_file.readframes(wav_file.getnframes())

        if channels > 1:
            pcm_data = audioop.tomono(pcm_data, sample_width, 1, 1)

        if sample_rate != 16000:
            pcm_data, _ = audioop.ratecv(pcm_data, sample_width, 1, sample_rate, 16000, None)
            sample_rate = 16000

        model = _get_vosk_model()
        recognizer = KaldiRecognizer(model, sample_rate)
        recognizer.SetWords(False)
        recognizer.AcceptWaveform(pcm_data)
        result = json.loads(recognizer.FinalResult() or "{}")
        return (result.get("text") or "").strip()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"Transcription failed: {str(exc)}")

@router.post("/query", response_model=AssistantResponse)
def query_dogesh(
    query: AssistantQuery,
    current_email: str = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    user = session.exec(select(User).where(User.email == current_email)).first()
    if not user:
        raise HTTPException(404, "User not found")

    llm_service = LLMService(user_api_keys=user.api_keys)
    result = llm_service.send_prompt(query.text, query.history)

    if result.get("intent") == "google_search" and result.get("action") == "open_browser":
        url = f"https://www.google.com/search?q={query.text.replace(' ', '+')}"
        result["action_data"] = {"url": url}

    return AssistantResponse(
        response_text=result["response_text"],
        intent=result["intent"],
        action=result.get("action"),
        action_data=result.get("action_data")
    )

@router.post("/calibrate-voice")
def calibrate_voice(
    data: VoiceCalibration,
    current_email: str = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    user = session.exec(select(User).where(User.email == current_email)).first()
    user.is_calibrated = data.calibrated
    session.add(user)
    session.commit()
    return {"status": "Voice calibrated successfully"}

@router.put("/api-keys")
def update_api_keys(
    keys: ApiKeysUpdate,
    current_email: str = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    user = session.exec(select(User).where(User.email == current_email)).first()
    user.api_keys = keys.api_keys
    session.add(user)
    session.commit()
    return {"status": "API keys updated securely"}


@router.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    current_email: str = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.exec(select(User).where(User.email == current_email)).first()
    if not user:
        raise HTTPException(404, "User not found")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "Empty audio payload")

    try:
        text = _transcribe_with_model(audio_bytes, file.filename or "audio.webm", user.api_keys or {})
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"Transcription failed: {str(exc)}")

    return {"text": text}
