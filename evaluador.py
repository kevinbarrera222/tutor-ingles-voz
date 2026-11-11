"""Evaluación de la conversación al terminar la práctica."""

from pydantic import BaseModel, Field

from escenarios import ESCENARIOS, NIVELES


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


def evaluar(cliente, modelo: str, escenario: str, nivel: str, turnos: list[dict]) -> Evaluacion:
    """Envía la transcripción a un modelo de texto y devuelve la evaluación estructurada."""
    contexto = (
        f"Escenario: {ESCENARIOS[escenario]['titulo']}\n"
        f"Nivel del estudiante: {NIVELES[nivel]['titulo']}\n\n"
        f"Transcripción:\n{armar_transcripcion(turnos)}"
    )
    respuesta = cliente.responses.parse(
        model=modelo,
        reasoning={"effort": "low"},
        input=[
            {"role": "system", "content": INSTRUCCIONES_EVALUADOR},
            {"role": "user", "content": contexto},
        ],
        text_format=Evaluacion,
    )
    return respuesta.output_parsed
