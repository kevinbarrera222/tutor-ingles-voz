"""Tutor de inglés por voz — servidor (FastAPI).

El navegador habla directamente con la API Realtime de OpenAI por WebRTC.
Este servidor:
  1. crea una clave temporal para cada llamada (la API Key nunca llega al navegador),
  2. crea escenarios personalizados, revisa las misiones y da pistas durante la llamada,
  3. evalúa la conversación al final y verifica las frases que el estudiante repite.
"""

import base64
import os
import random
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

from escenarios import ESCENARIOS, FOTOS_PERSONALIZADOS, NIVELES, VOCES, construir_instrucciones, url_foto
from evaluador import Evaluacion, Pista, crear_escenario, dar_pista, evaluar, revisar_misiones
from practica import ResultadoFrase, comparar, transcribir

load_dotenv()

MODELO_VOZ = os.getenv("MODELO_VOZ", "gpt-realtime-2.1-mini")
MODELO_TRANSCRIPCION = os.getenv("MODELO_TRANSCRIPCION", "gpt-transcribe")
MODELO_EVALUACION = os.getenv("MODELO_EVALUACION", "gpt-6-luna")
MAX_MINUTOS_SESION = float(os.getenv("MAX_MINUTOS_SESION", "5"))
MAX_SESIONES_POR_DIA = int(os.getenv("MAX_SESIONES_POR_DIA", "20"))
# Pistas, misiones, escenarios personalizados y frases verificadas (cada tipo por separado)
MAX_AYUDAS_POR_DIA = int(os.getenv("MAX_AYUDAS_POR_DIA", "300"))
# Qué tan rápido responde el tutor cuando dejas de hablar: high (rápido), medium o low (espera más)
RAPIDEZ_RESPUESTA = os.getenv("RAPIDEZ_RESPUESTA", "high")

COLORES_PERSONALIZADOS = ["#7C3AED", "#C2410C", "#BE185D", "#0369A1", "#4D7C0F"]
CARPETA_STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Tutor de inglés por voz")
app.mount("/static", StaticFiles(directory=CARPETA_STATIC), name="static")


@app.middleware("http")
async def sin_cache(request: Request, call_next):
    """Evita que el navegador muestre una versión vieja de la página después de actualizar."""
    respuesta = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        respuesta.headers["Cache-Control"] = "no-cache"
    return respuesta


def cliente_openai() -> OpenAI:
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=500,
            detail="Falta la API Key de OpenAI. Ponla en el archivo .env (OPENAI_API_KEY=sk-...) y reinicia el servidor.",
        )
    return OpenAI()


# -----------------------------
# Límites por día (por IP), para cuidar el saldo
# -----------------------------
_lock = threading.Lock()
_uso: dict[tuple[str, str], int] = {}
_dia = date.today()


def limitar(request: Request, tipo: str, maximo: int, mensaje: str) -> None:
    global _dia
    ip = request.client.host if request.client else "desconocido"
    with _lock:
        if date.today() != _dia:
            _dia = date.today()
            _uso.clear()
        if _uso.get((ip, tipo), 0) >= maximo:
            raise HTTPException(status_code=429, detail=mensaje)
        _uso[(ip, tipo)] = _uso.get((ip, tipo), 0) + 1


def limitar_ayuda(request: Request, tipo: str) -> None:
    limitar(request, tipo, MAX_AYUDAS_POR_DIA, "Llegaste al límite de uso de hoy para esta función. Vuelve mañana.")


# -----------------------------
# Escenarios (predefinidos o personalizados)
# -----------------------------
class EscenarioPersonalizado(BaseModel):
    personaje: str = Field(min_length=1, max_length=30)
    papel: str = Field(max_length=80)
    titulo: str = Field(max_length=80)
    descripcion: str = Field(max_length=240)
    rol: str = Field(min_length=10, max_length=1500)
    objetivos: list[str] = Field(default_factory=list, max_length=5)
    color: str = Field(default="#7C3AED", pattern=r"^#[0-9A-Fa-f]{6}$")
    genero: Literal["femenino", "masculino"] = "femenino"
    voz: str = ""
    foto: str = ""


class ConEscenario(BaseModel):
    """Base de los pedidos: o un escenario predefinido (clave) o uno personalizado."""
    escenario: str | None = None
    personalizado: EscenarioPersonalizado | None = None
    nivel: str

    def resolver(self) -> dict:
        if self.nivel not in NIVELES:
            raise HTTPException(status_code=400, detail="Nivel no válido.")
        if self.personalizado:
            datos = self.personalizado.model_dump()
            datos["objetivos"] = [o[:120] for o in datos["objetivos"]]
            # La voz y la foto solo pueden ser de las permitidas para ese género
            if datos["voz"] not in VOCES[datos["genero"]]:
                datos["voz"] = VOCES[datos["genero"]][0]
            if datos["foto"] not in FOTOS_PERSONALIZADOS[datos["genero"]]:
                datos["foto"] = ""
            return datos
        if self.escenario in ESCENARIOS:
            return ESCENARIOS[self.escenario]
        raise HTTPException(status_code=400, detail="Escenario no válido.")


class Turno(BaseModel):
    rol: Literal["usuario", "tutor"]
    texto: str = Field(max_length=2000)


def limpiar_turnos(turnos: list[Turno]) -> list[dict]:
    return [t.model_dump() for t in turnos if t.texto.strip()]


def preguntar_al_modelo(funcion, *args, error: str):
    cliente = cliente_openai()
    try:
        return funcion(cliente, MODELO_EVALUACION, *args)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"{error}: {e}") from e


# -----------------------------
# Rutas
# -----------------------------
@app.get("/")
def inicio():
    return FileResponse(CARPETA_STATIC / "index.html")


@app.get("/api/config")
def configuracion():
    """Escenarios, niveles y límites para armar la pantalla de inicio."""
    campos = ("titulo", "descripcion", "personaje", "papel", "color", "objetivos", "genero", "foto")
    return {
        "escenarios": {k: {c: v[c] for c in campos} for k, v in ESCENARIOS.items()},
        "url_fotos": url_foto("{foto}", 160),
        "niveles": {k: {c: v[c] for c in ("titulo", "descripcion")} for k, v in NIVELES.items()},
        "max_minutos": MAX_MINUTOS_SESION,
        "modelo_voz": MODELO_VOZ,
    }


class PedidoEscenario(BaseModel):
    descripcion: str = Field(min_length=5, max_length=300)
    nivel: str


@app.post("/api/escenario-personalizado", response_model=EscenarioPersonalizado)
def escenario_personalizado(pedido: PedidoEscenario, request: Request):
    """Crea un personaje y sus misiones a partir de la situación que describe el estudiante."""
    if pedido.nivel not in NIVELES:
        raise HTTPException(status_code=400, detail="Nivel no válido.")
    cliente_openai()
    limitar_ayuda(request, "escenario")
    generado = preguntar_al_modelo(crear_escenario, pedido.descripcion.strip(), pedido.nivel,
                                   error="No se pudo crear el escenario")
    datos = generado.model_dump()
    datos["personaje"] = (datos["personaje"].split() or ["Alex"])[0][:30]
    datos["papel"], datos["titulo"] = datos["papel"][:80], datos["titulo"][:80]
    datos["descripcion"], datos["rol"] = datos["descripcion"][:240], datos["rol"][:1500]
    datos["objetivos"] = [o[:120] for o in datos["objetivos"][:4]]
    datos["color"] = random.choice(COLORES_PERSONALIZADOS)
    datos["voz"] = random.choice(VOCES[datos["genero"]])
    datos["foto"] = random.choice(FOTOS_PERSONALIZADOS[datos["genero"]])
    return EscenarioPersonalizado(**datos)


@app.post("/api/sesion")
def crear_sesion(pedido: ConEscenario, request: Request):
    """Crea una clave temporal de OpenAI con la configuración de la llamada."""
    escenario = pedido.resolver()
    cliente = cliente_openai()
    limitar(request, "sesion", MAX_SESIONES_POR_DIA,
            f"Llegaste al límite de {MAX_SESIONES_POR_DIA} llamadas por hoy. Vuelve mañana.")

    sesion = {
        "type": "realtime",
        "model": MODELO_VOZ,
        "instructions": construir_instrucciones(escenario, pedido.nivel),
        "audio": {
            "input": {
                "transcription": {"model": MODELO_TRANSCRIPCION, "language": "en"},
                "turn_detection": {"type": "semantic_vad", "eagerness": RAPIDEZ_RESPUESTA},
                "noise_reduction": {"type": "near_field"},
            },
            "output": {"voice": escenario["voz"], "speed": NIVELES[pedido.nivel]["velocidad"]},
        },
    }
    try:
        secreto = cliente.realtime.client_secrets.create(session=sesion)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"OpenAI rechazó la sesión: {e}") from e

    return {"clave": secreto.value, "max_minutos": MAX_MINUTOS_SESION, "modelo": MODELO_VOZ}


class PedidoMisiones(ConEscenario):
    pendientes: list[int] = Field(max_length=5)
    turnos: list[Turno] = Field(max_length=16)


@app.post("/api/misiones")
def misiones(pedido: PedidoMisiones, request: Request):
    """Revisa cuáles de las misiones pendientes ya cumplió el estudiante."""
    objetivos = pedido.resolver().get("objetivos", [])
    pendientes = {n: objetivos[n] for n in pedido.pendientes if 0 <= n < len(objetivos)}
    turnos = limpiar_turnos(pedido.turnos)
    if not pendientes or not any(t["rol"] == "usuario" for t in turnos):
        return {"cumplidas": []}
    cliente_openai()
    limitar_ayuda(request, "misiones")
    cumplidas = preguntar_al_modelo(revisar_misiones, pendientes, turnos, error="No se pudieron revisar las misiones")
    return {"cumplidas": cumplidas}


class PedidoPista(ConEscenario):
    turnos: list[Turno] = Field(max_length=12)


@app.post("/api/pista", response_model=Pista)
def pedir_pista(pedido: PedidoPista, request: Request):
    """Traduce lo último que dijo el tutor y sugiere qué responder."""
    escenario = pedido.resolver()
    turnos = limpiar_turnos(pedido.turnos)
    if not any(t["rol"] == "tutor" for t in turnos):
        raise HTTPException(status_code=400, detail="Espera a que el tutor diga algo para pedir una pista.")
    cliente_openai()
    limitar_ayuda(request, "pista")
    return preguntar_al_modelo(dar_pista, escenario, pedido.nivel, turnos, error="No se pudo generar la pista")


class PedidoEvaluacion(ConEscenario):
    turnos: list[Turno] = Field(max_length=200)


@app.post("/api/evaluar", response_model=Evaluacion)
def evaluar_conversacion(pedido: PedidoEvaluacion):
    escenario = pedido.resolver()
    turnos = limpiar_turnos(pedido.turnos)
    if sum(t["rol"] == "usuario" for t in turnos) < 2:
        raise HTTPException(status_code=400, detail="Habla un poco más (al menos 2 respuestas) para poder evaluarte.")
    return preguntar_al_modelo(evaluar, escenario, pedido.nivel, turnos, error="No se pudo generar la evaluación")


class PedidoFrase(BaseModel):
    frase: str = Field(min_length=1, max_length=300)
    audio_base64: str = Field(max_length=3_000_000)  # ~2 MB de audio, unos 20 segundos
    formato: Literal["webm", "ogg", "mp4", "wav", "mpeg"] = "webm"


@app.post("/api/verificar-frase", response_model=ResultadoFrase)
def verificar_frase(pedido: PedidoFrase, request: Request):
    """Transcribe la grabación del estudiante y la compara con la frase correcta."""
    try:
        audio = base64.b64decode(pedido.audio_base64, validate=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail="La grabación llegó dañada. Inténtalo otra vez.") from e
    if len(audio) < 1000:
        raise HTTPException(status_code=400, detail="La grabación quedó vacía. Toca Repetir y di la frase completa.")
    cliente = cliente_openai()
    limitar_ayuda(request, "frase")
    try:
        dicho = transcribir(cliente, MODELO_TRANSCRIPCION, audio, pedido.formato)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"No se pudo transcribir tu grabación: {e}") from e
    return comparar(pedido.frase, dicho)
