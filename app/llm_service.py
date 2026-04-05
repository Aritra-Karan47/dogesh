import json
import os
from typing import Dict, Any, Optional, List
from llmsays import llmsays

class LLMService:
    def __init__(self, user_api_keys: Optional[Dict] = None):
        self.user_api_keys = user_api_keys or {}
        self.history: List[Dict[str, str]] = []

        # Backward compatibility for a common misspelling in env/user keys.
        typo_env = os.getenv("NIVIDIA_API_KEY")
        if not os.getenv("NVIDIA_API_KEY") and typo_env:
            os.environ["NVIDIA_API_KEY"] = typo_env

        typo_user = self.user_api_keys.get("NIVIDIA_API_KEY")
        if "NVIDIA_API_KEY" not in self.user_api_keys and typo_user:
            self.user_api_keys["NVIDIA_API_KEY"] = typo_user

        # Promote any user-scoped provider keys into env vars expected by llmsays.
        # Existing process env vars take precedence to avoid accidental overrides.
        for env_key in [
            "GROQ_API_KEY",
            "OPENROUTER_API_KEY",
            "NVIDIA_API_KEY",
            "FIREWORKSAI_API_KEY",
            "BASETEN_API_KEY",
        ]:
            if not os.getenv(env_key) and self.user_api_keys.get(env_key):
                os.environ[env_key] = str(self.user_api_keys[env_key])

    def _build_system_prompt(self) -> str:
        return '''You are Dogesh, a friendly voice assistant like Google Assistant.
        ALWAYS respond with valid JSON only:
        {
            "intent": "general_qa" or "google_search",
            "response_text": "spoken response for TTS",
            "action": null or "open_browser",
            "action_data": {"url": "..."} or null
        }
        Be concise and natural.'''

    def add_to_history(self, role: str, content: str):
        self.history.append({"role": role, "content": content})

    def send_prompt(self, prompt: str, history: Optional[List[Dict]] = None) -> Dict[str, Any]:
        if history:
            self.history = history.copy()
        self.add_to_history("user", prompt)

        full_prompt = f"{self._build_system_prompt()}\n\nHistory:\n{json.dumps(self.history[-10:], indent=2)}\n\nUser: {prompt}\nDogesh:"

        raw_response = llmsays(full_prompt)

        try:
            start = raw_response.find("{")
            end = raw_response.rfind("}") + 1
            json_str = raw_response[start:end]
            structured = json.loads(json_str)
        except Exception:
            structured = {
                "intent": "general_qa",
                "response_text": raw_response.strip(),
                "action": None,
                "action_data": None
            }

        self.add_to_history("assistant", structured["response_text"])
        return structured
