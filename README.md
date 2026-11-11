# 🎙️ Tutor de inglés por voz (prototipo)

Practica conversaciones en inglés **hablando en voz alta** con un tutor de IA que hace un papel (entrevistador, mesero, recepcionista). Al terminar recibes una **evaluación en español**: nota, errores con su corrección, frases más naturales, vocabulario útil y consejos.

- 🗣️ Conversación por voz en tiempo real (OpenAI Realtime API por WebRTC)
- 📝 Transcripción en vivo de lo que dices tú y el tutor
- 🎚️ 3 escenarios y 3 niveles (Básico, Intermedio, Avanzado); en Básico el tutor habla más despacio
- ✅ Evaluación final con un modelo de texto (`gpt-6-luna`)
- 💸 Control de costos: duración máxima por sesión, límite de sesiones por día y costo estimado en vivo
- 🔐 Tu API Key nunca llega al navegador: el servidor crea una clave temporal para cada sesión

| Conversación | Evaluación |
|---|---|
| ![Conversación](docs/conversacion.png) | ![Evaluación](docs/evaluacion.png) |

---

## 🪟 Cómo ejecutarlo en Windows (VS Code)

Necesitas **Python 3.10 o superior**, una **API Key de OpenAI** con saldo y un navegador moderno (Chrome o Edge).

**1. Clona el proyecto** (en la terminal de VS Code: `Terminal → New Terminal`):

```powershell
cd C:\
git clone https://github.com/kevinbarrera222/tutor-ingles-voz
cd tutor-ingles-voz
```

**2. Crea el entorno virtual e instala las librerías:**

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

> Si PowerShell no deja activar el entorno, ejecuta una vez:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` y vuelve a intentarlo.

**3. Configura tu API Key:** copia `.env.example` como `.env` y pon tu clave:

```powershell
copy .env.example .env
```

Abre `.env` en VS Code y cambia `OPENAI_API_KEY=sk-...` por tu clave real. El archivo `.env` está en `.gitignore`: **nunca se sube a GitHub**.

**4. Arranca el servidor:**

```powershell
uvicorn main:app --reload
```

**5. Abre http://localhost:8000**, elige un escenario y un nivel, y dale a **Empezar conversación**. La primera vez el navegador te pedirá permiso para usar el micrófono.

> 🎧 Usa audífonos: así el micrófono no capta la voz del tutor.

---

## ⚙️ Configuración (`.env`)

| Variable | Qué hace | Por defecto |
|---|---|---|
| `OPENAI_API_KEY` | Tu clave de OpenAI | — |
| `MAX_MINUTOS_SESION` | Duración máxima de cada conversación | `5` |
| `MAX_SESIONES_POR_DIA` | Sesiones por día para cada visitante | `20` |
| `MODELO_VOZ` | Modelo de voz en tiempo real | `gpt-realtime-2.1-mini` |
| `MODELO_TRANSCRIPCION` | Modelo para transcribir tu voz | `gpt-transcribe` |
| `MODELO_EVALUACION` | Modelo que hace la evaluación final | `gpt-6-luna` |
| `VOZ` | Voz del tutor (`marin`, `cedar`, `alloy`, `coral`…) | `marin` |

## 💸 ¿Cuánto cuesta?

Con `gpt-realtime-2.1-mini`, una conversación cuesta del orden de **US$0,02 a 0,05 por minuto**. La app muestra el **costo estimado en vivo**, calculado con los tokens que reporta OpenAI en cada respuesta. Una sesión de 5 minutos sale aproximadamente entre US$0,10 y 0,25. La transcripción y la evaluación final suman muy poco.

---

## 🧩 Cómo funciona

```
Navegador ──(1) pide clave temporal──▶ Servidor FastAPI ──▶ OpenAI /v1/realtime/client_secrets
Navegador ◀══(2) voz en tiempo real por WebRTC══▶ OpenAI /v1/realtime/calls
Navegador ──(3) envía la transcripción──▶ Servidor ──▶ gpt-6-luna ──▶ evaluación
```

## 📁 Estructura

```
main.py            # Servidor FastAPI: clave temporal, evaluación y límites
escenarios.py      # Escenarios y niveles (agrega los tuyos aquí)
evaluador.py       # Evaluación con salida estructurada (Pydantic)
static/index.html  # Interfaz
static/app.js      # WebRTC, transcripción en vivo, cronómetro y costo
static/styles.css  # Estilos (tema oscuro)
docs/              # Capturas para este README
.env.example       # Plantilla de configuración
```

**Agregar un escenario:** copia uno de los bloques de `ESCENARIOS` en `escenarios.py`, cambia el título, el ícono, la descripción y el `rol` (en inglés), y reinicia el servidor.

## ⚠️ Limitaciones del prototipo

- Sin login ni base de datos: el historial no se guarda y los límites viven en memoria (se reinician al reiniciar el servidor).
- El corte por tiempo lo hace el navegador.
- Para publicarlo en internet se necesita HTTPS (el micrófono solo funciona en `localhost` o `https`).
