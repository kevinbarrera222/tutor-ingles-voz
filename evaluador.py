"""Todo lo que hace el modelo de texto (gpt-6-luna): evaluación final, pistas,
escenarios personalizados y revisión de misiones.

Las funciones reciben `escenario` como diccionario (uno de ESCENARIOS o uno personalizado).
"""

from pydantic import BaseModel, Field

from escenarios import NIVELES


class Error(BaseModel):
    original: str = Field(description="Frase exacta del estudiante con el error")
    correccion: str = Field(description="La frase corregida en inglés")
    explicacion: str = Field(description="Explicación breve en español")


class MejorFrase(BaseModel):
    original: str = Field(description="Frase correcta pero mejorable del estudiante")
    mejor: str = Field(description="Una forma más natural de decirlo en inglés")


class Vocabulario(BaseModel):
    palabra: str = Field(description="Palabra o expresión en inglés")
    significado: str = Field(description="Significado en español")
    ejemplo: str = Field(description="Frase de ejemplo en inglés")


class Evaluacion(BaseModel):
    nota: int = Field(ge=1, le=10, description="Nota general del 1 al 10")
    resumen: str = Field(description="Resumen del desempeño en 2 o 3 frases, en español")
    errores: list[Error] = Field(description="Errores de gramática o vocabulario (máximo 6)")
    mejores_frases: list[MejorFrase] = Field(description="Frases que se pueden decir mejor (máximo 4)")
    vocabulario: list[Vocabulario] = Field(description="Vocabulario útil para este escenario (máximo 5)")
    consejos: list[str] = Field(description="3 consejos concretos en español para mejorar")


INSTRUCCIONES_EVALUADOR = """Eres un profesor de inglés experto y amable para hispanohablantes.
Evalúa SOLO lo que dijo el ESTUDIANTE (no al tutor) en esta práctica de conversación.
Ten en cuenta su nivel: no le exijas a un principiante lo mismo que a un avanzado.
La transcripción viene de reconocimiento de voz: ignora errores evidentes de transcripción
(puntuación, mayúsculas) y concéntrate en gramática, vocabulario y naturalidad.
Escribe todas las explicaciones en español. Sé motivador pero honesto."""


def armar_transcripcion(turnos: list[dict]) -> str:
    lineas = []
    for turno in turnos:
        quien = "ESTUDIANTE" if turno["rol"] == "usuario" else "TUTOR"
        lineas.append(f"{quien}: {turno['texto'].strip()}")
    return "\n".join(lineas)


def _preguntar(cliente, modelo: str, esfuerzo: str, instrucciones: str, contexto: str, formato):
    respuesta = cliente.responses.parse(
        model=modelo,
        reasoning={"effort": esfuerzo},
        input=[
            {"role": "system", "content": instrucciones},
            {"role": "user", "content": contexto},
        ],
        text_format=formato,
    )
    return respuesta.output_parsed


def evaluar(cliente, modelo: str, escenario: dict, nivel: str, turnos: list[dict]) -> Evaluacion:
    """Envía la transcripción a un modelo de texto y devuelve la evaluación estructurada."""
    contexto = (
        f"Escenario: {escenario['titulo']}\n"
        f"Nivel del estudiante: {NIVELES[nivel]['titulo']}\n\n"
        f"Transcripción:\n{armar_transcripcion(turnos)}"
    )
    return _preguntar(cliente, modelo, "low", INSTRUCCIONES_EVALUADOR, contexto, Evaluacion)


# -----------------------------
# Pistas durante la conversación
# -----------------------------
class Sugerencia(BaseModel):
    ingles: str = Field(description="Respuesta corta que el estudiante podría decir, en inglés")
    espanol: str = Field(description="Traducción al español")


class Pista(BaseModel):
    traduccion: str = Field(description="Traducción al español de lo último que dijo el tutor")
    sugerencias: list[Sugerencia] = Field(description="Exactamente 2 respuestas posibles, adecuadas al nivel")


INSTRUCCIONES_PISTA = """Ayudas a un estudiante hispanohablante que practica inglés hablado y se quedó
sin saber qué decir. Traduce al español lo ÚLTIMO que dijo el tutor y propone exactamente 2 respuestas
cortas y naturales en inglés (con su traducción) que el estudiante podría decir ahora, adecuadas a su nivel."""


def dar_pista(cliente, modelo: str, escenario: dict, nivel: str, turnos: list[dict]) -> Pista:
    contexto = (
        f"Escenario: {escenario['titulo']}\n"
        f"Nivel del estudiante: {NIVELES[nivel]['titulo']}\n\n"
        f"Conversación reciente:\n{armar_transcripcion(turnos)}"
    )
    # Sin razonamiento: la pista debe llegar rápido
    return _preguntar(cliente, modelo, "none", INSTRUCCIONES_PISTA, contexto, Pista)


# -----------------------------
# Escenario personalizado
# -----------------------------
class EscenarioGenerado(BaseModel):
    personaje: str = Field(description="Nombre de pila en inglés del personaje (una palabra)")
    papel: str = Field(description="Rol del personaje en español, corto. Ej: 'Vendedora de la tienda'")
    titulo: str = Field(description="Título corto del escenario en español. Ej: 'Devolver un producto'")
    descripcion: str = Field(description="Una frase en español: qué hará el estudiante")
    rol: str = Field(description=(
        "Instrucciones EN INGLÉS para el personaje, en segunda persona ('You are...'), 3 a 5 frases: "
        "quién es, dónde está, qué le pregunta al estudiante y una pequeña complicación realista"
    ))
    objetivos: list[str] = Field(description=(
        "Exactamente 4 misiones en español, en imperativo y cortas, que el estudiante cumple hablando"
    ))


INSTRUCCIONES_ESCENARIO = """Creas escenarios de práctica de conversación en inglés para hispanohablantes.
A partir de la situación que describe el estudiante, crea un personaje con quien practicar por voz.
El personaje habla solo en inglés y la situación debe ser realista y útil para la vida diaria o el trabajo.
Si la descripción pide algo ofensivo, sexual, peligroso o que no tiene que ver con practicar inglés,
crea en su lugar un escenario cotidiano neutro (por ejemplo, pedir indicaciones en la calle)."""


def crear_escenario(cliente, modelo: str, descripcion: str, nivel: str) -> EscenarioGenerado:
    contexto = f"Nivel del estudiante: {NIVELES[nivel]['titulo']}\nSituación que quiere practicar: {descripcion}"
    return _preguntar(cliente, modelo, "low", INSTRUCCIONES_ESCENARIO, contexto, EscenarioGenerado)


# -----------------------------
# Misiones durante la llamada
# -----------------------------
class RevisionMisiones(BaseModel):
    cumplidas: list[int] = Field(description="Números de las misiones que el ESTUDIANTE ya cumplió")


INSTRUCCIONES_MISIONES = """Revisas una práctica de conversación en inglés.
Te doy una lista numerada de misiones y la transcripción. Devuelve SOLO los números de las misiones
que el ESTUDIANTE (no el tutor) ya cumplió con lo que dijo, aunque haya cometido errores de inglés.
Si una misión no está clara o el estudiante no la cumplió, no la incluyas."""


def revisar_misiones(cliente, modelo: str, objetivos: dict[int, str], turnos: list[dict]) -> list[int]:
    """`objetivos` es {número: texto} solo con las misiones pendientes."""
    # Al modelo se le muestran numeradas desde 1, que es más natural
    lista = "\n".join(f"{n + 1}. {texto}" for n, texto in objetivos.items())
    contexto = f"Misiones:\n{lista}\n\nTranscripción:\n{armar_transcripcion(turnos)}"
    revision = _preguntar(cliente, modelo, "none", INSTRUCCIONES_MISIONES, contexto, RevisionMisiones)
    return sorted({n - 1 for n in revision.cumplidas if n - 1 in objetivos})
