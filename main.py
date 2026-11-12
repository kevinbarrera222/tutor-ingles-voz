"""Tutor de inglés por voz — servidor (FastAPI).

El navegador habla directamente con la API Realtime de OpenAI por WebRTC.
Este servidor solo:
  1. crea una clave temporal para cada sesión (la API Key nunca llega al navegador),
  2. evalúa la conversación al final con un modelo de texto.
"""

import os
import threading
from datetime import date
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pydantic import BaseModel, Field

from escenarios import ESCENARIOS, NIVELES, construir_instrucciones
from evaluador import Evaluacion, Pista, dar_pista, evaluar

load_dotenv()

MODELO_VOZ = os.getenv("MODELO_VOZ", "gpt-realtime-2.1-mini")
MODELO_TRANSCRIPCION = os.getenv("MODELO_TRANSCRIPCION", "gpt-transcribe")
MODELO_EVALUACION = os.getenv("MODELO_EVALUACION", "gpt-6-luna")
VOZ = os.getenv("VOZ", "marin")
MAX_MINUTOS_SESION = float(os.getenv("MAX_MINUTOS_SESION", "5"))
MAX_SESIONES_POR_DIA = int(os.getenv("MAX_SESIONES_POR_DIA", "20"))
# Qué tan rápido responde el tutor cuando dejas de hablar: high (rápido), medium o low (espera más)
RAPIDEZ_RESPUESTA = os.getenv("RAPIDEZ_RESPUESTA", "high")

CARPETA_STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Tutor de inglés por voz")
app.mount("/static", StaticFiles(directory=CARPETA_STATIC), name="static")


def cliente_openai() -> OpenAI:
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=500,
            detail="Falta la API Key de OpenAI. Ponla en el archivo .env (OPENAI_API_KEY=sk-...) y reinicia el servidor.",
        )
    return OpenAI()


# -----------------------------
# Límite simple de sesiones por día (por IP), para cuidar el saldo
# -----------------------------
_lock = threading.Lock()
_uso: dict[str, int] = {}
_dia = date.today()


def registrar_sesion(ip: str) -> None:
    global _dia
    with _lock:
        if date.today() != _dia:
            _dia = date.today()
            _uso.clear()
        if _uso.get(ip, 0) >= MAX_SESIONES_POR_DIA:
            raise HTTPException(
                status_code=429,
                detail=f"Llegaste al límite de {MAX_SESIONES_POR_DIA} sesiones por hoy. Vuelve mañana.",
            )
        _uso[ip] = _uso.get(ip, 0) + 1


# -----------------------------
# Rutas
# -----------------------------
@app.get("/")
def inicio():
    return FileResponse(CARPETA_STATIC / "index.html")


@app.get("/api/config")
def configuracion():
    """Escenarios, niveles y límites para armar la pantalla de inicio."""
    return {
        "escenarios": {k: {c: v[c] for c in ("titulo", "icono", "descripcion", "personaje", "papel", "avatar")} for k, v in ESCENARIOS.items()},
        "niveles": {k: {c: v[c] for c in ("titulo", "descripcion")} for k, v in NIVELES.items()},
        "max_minutos": MAX_MINUTOS_SESION,
        "modelo_voz": MODELO_VOZ,
    }


class PedidoSesion(BaseModel):
    escenario: str
    nivel: str


@app.post("/api/sesion")
def crear_sesion(pedido: PedidoSesion, request: Request):
    """Crea una clave temporal de OpenAI con la configuración de la conversación."""
    if pedido.escenario not in ESCENARIOS or pedido.nivel not in NIVELES:
        raise HTTPException(status_code=400, detail="Escenario o nivel no válido.")
    cliente = cliente_openai()
    registrar_sesion(request.client.host if request.client else "desconocido")

    sesion = {
        "type": "realtime",
        "model": MODELO_VOZ,
        "instructions": construir_instrucciones(pedido.escenario, pedido.nivel),
        "audio": {
            "input": {
                "transcription": {"model": MODELO_TRANSCRIPCION, "language": "en"},
                "turn_detection": {"type": "semantic_vad", "eagerness": RAPIDEZ_RESPUESTA},
                "noise_reduction": {"type": "near_field"},
            },
            "output": {"voice": VOZ, "speed": NIVELES[pedido.nivel]["velocidad"]},
        },
    }
    try:
        secreto = cliente.realtime.client_secrets.create(session=sesion)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"OpenAI rechazó la sesión: {e}") from e

    return {
        "clave": secreto.value,
        "max_minutos": MAX_MINUTOS_SESION,
        "modelo": MODELO_VOZ,
    }


class Turno(BaseModel):
    rol: Literal["usuario", "tutor"]
    texto: str = Field(max_length=2000)


class PedidoEvaluacion(BaseModel):
    escenario: str
    nivel: str
    turnos: list[Turno] = Field(max_length=200)


@app.post("/api/evaluar", response_model=Evaluacion)
def evaluar_conversacion(pedido: PedidoEvaluacion):
    if pedido.escenario not in ESCENARIOS or pedido.nivel not in NIVELES:
        raise HTTPException(status_code=400, detail="Escenario o nivel no válido.")
    turnos = [t.model_dump() for t in pedido.turnos if t.texto.strip()]
    if sum(t["rol"] == "usuario" for t in turnos) < 2:
        raise HTTPException(
            status_code=400,
            detail="Habla un poco más (al menos 2 respuestas) para poder evaluarte.",
        )
    cliente = cliente_openai()
    try:
        return evaluar(cliente, MODELO_EVALUACION, pedido.escenario, pedido.nivel, turnos)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"No se pudo generar la evaluación: {e}") from e


class PedidoPista(BaseModel):
    escenario: str
    nivel: str
    turnos: list[Turno] = Field(max_length=12)


@app.post("/api/pista", response_model=Pista)
def pedir_pista(pedido: PedidoPista):
    """Traduce lo último que dijo el tutor y sugiere qué responder."""
    if pedido.escenario not in ESCENARIOS or pedido.nivel not in NIVELES:
        raise HTTPException(status_code=400, detail="Escenario o nivel no válido.")
    turnos = [t.model_dump() for t in pedido.turnos if t.texto.strip()]
    if not any(t["rol"] == "tutor" for t in turnos):
        raise HTTPException(status_code=400, detail="Espera a que el tutor diga algo para pedir una pista.")
    cliente = cliente_openai()
    try:
        return dar_pista(cliente, MODELO_EVALUACION, pedido.escenario, pedido.nivel, turnos)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"No se pudo generar la pista: {e}") from e
