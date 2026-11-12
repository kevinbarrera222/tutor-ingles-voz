"""Practicar frases: transcribe lo que dijo el estudiante y lo compara con la frase correcta."""

import difflib
import re

from pydantic import BaseModel


class PalabraRevisada(BaseModel):
    palabra: str
    ok: bool


class ResultadoFrase(BaseModel):
    transcripcion: str
    similitud: float      # 0 a 1
    correcto: bool
    palabras: list[PalabraRevisada]


def _normalizar(token: str) -> str:
    # Sin apóstrofes ni signos: "I'm" e "im" cuentan igual
    return re.sub(r"[^a-z0-9]", "", token.lower())


def comparar(frase: str, dicho: str) -> ResultadoFrase:
    """Compara palabra por palabra lo que dijo el estudiante con la frase objetivo."""
    tokens = frase.split()
    normales = [_normalizar(t) for t in tokens]
    indices = [i for i, n in enumerate(normales) if n]          # se ignoran signos sueltos
    objetivo = [normales[i] for i in indices]
    dicho_norm = [n for n in (_normalizar(t) for t in dicho.split()) if n]

    comparador = difflib.SequenceMatcher(a=objetivo, b=dicho_norm, autojunk=False)
    acertadas = [False] * len(objetivo)
    for etiqueta, i1, i2, _, _ in comparador.get_opcodes():
        if etiqueta == "equal":
            for i in range(i1, i2):
                acertadas[i] = True

    ok_por_token = [True] * len(tokens)
    for posicion, indice in enumerate(indices):
        ok_por_token[indice] = acertadas[posicion]

    similitud = comparador.ratio() if objetivo or dicho_norm else 0.0
    proporcion = sum(acertadas) / len(acertadas) if acertadas else 0.0
    return ResultadoFrase(
        transcripcion=dicho.strip(),
        similitud=round(similitud, 2),
        correcto=similitud >= 0.85 and proporcion >= 0.85,
        palabras=[PalabraRevisada(palabra=t, ok=ok) for t, ok in zip(tokens, ok_por_token)],
    )


def transcribir(cliente, modelo: str, audio: bytes, formato: str) -> str:
    """Transcribe una grabación corta. No se le da la frase esperada a propósito:
    así la transcripción refleja lo que realmente se escuchó."""
    resultado = cliente.audio.transcriptions.create(
        model=modelo,
        file=(f"frase.{formato}", audio, f"audio/{formato}"),
        language="en",
    )
    return (resultado.text or "").strip()
