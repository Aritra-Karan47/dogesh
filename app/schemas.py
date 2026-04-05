from pydantic import BaseModel, EmailStr
from typing import List, Optional, Dict, Any

class UserCreate(BaseModel):
    email: EmailStr
    password: str

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    email: Optional[str] = None

class VoiceCalibration(BaseModel):
    calibrated: bool = True

class ApiKeysUpdate(BaseModel):
    api_keys: Dict[str, str]

class AssistantQuery(BaseModel):
    text: str
    history: Optional[List[Dict[str, str]]] = None

class AssistantResponse(BaseModel):
    response_text: str
    intent: str
    action: Optional[str] = None
    action_data: Optional[Dict] = None
