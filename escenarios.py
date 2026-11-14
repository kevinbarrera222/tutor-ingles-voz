"""Escenarios de práctica y niveles.

Para agregar un escenario nuevo, copia uno de los existentes en ESCENARIOS
y cambia sus textos. La interfaz lo muestra automáticamente.

Las fotos son retratos de Unsplash (licencia gratuita de Unsplash). Para cambiar una,
abre la foto en unsplash.com, copia su enlace "images.unsplash.com/photo-..." y pega
solo el identificador "photo-..." en el campo `foto`.
"""

# Voz de OpenAI según el personaje: marin y coral suenan femeninas; cedar y ash, masculinas
VOCES = {"femenino": ["marin", "coral"], "masculino": ["cedar", "ash"]}


def url_foto(identificador: str, tamano: int = 160) -> str:
    """Enlace a un retrato de Unsplash recortado en cuadrado y centrado en la cara."""
    return (f"https://images.unsplash.com/{identificador}"
            f"?w={tamano}&h={tamano}&fit=crop&crop=faces&auto=format&q=70")


# Fotos para los personajes que crea el estudiante (se elige una según el género)
FOTOS_PERSONALIZADOS = {
    "femenino": ["photo-1621130668430-e7794ba3d9dd", "photo-1758691737587-7630b4d31d16"],
    "masculino": ["photo-1758598497635-48cbbb1f6555", "photo-1612186001725-36c96d7e46f8"],
}

ESCENARIOS = {
    "entrevista": {
        "personaje": "Sarah",
        "genero": "femenino",
        "voz": "marin",
        "foto": "photo-1758518727888-ffa196002e59",
        "color": "#15803D",  # color del avatar (iniciales)
        "papel": "Entrevistadora de recursos humanos",
        "titulo": "Entrevista de trabajo",
        "icono": "💼",
        "descripcion": "Responde preguntas de un entrevistador como en una entrevista real.",
        "objetivos": [  # misiones que se marcan solas durante la llamada
            "Preséntate y di a qué te dedicas",
            "Cuenta un logro o una experiencia de trabajo",
            "Menciona una de tus fortalezas",
            "Haz una pregunta sobre el trabajo",
        ],
        "rol": (
            "You are Sarah, a friendly but professional HR interviewer at a tech company. "
            "You are interviewing the student for a job they are interested in. "
            "Start by greeting them and asking them to introduce themselves. Then ask typical "
            "interview questions one at a time: experience, strengths and weaknesses, a challenge "
            "they solved, why they want the job, salary expectations, and if they have questions."
        ),
    },
    "restaurante": {
        "personaje": "Mike",
        "genero": "masculino",
        "voz": "cedar",
        "foto": "photo-1585813597615-19a076b2724a",
        "color": "#2563EB",  # color del avatar (iniciales)
        "papel": "Mesero del restaurante",
        "titulo": "Pedir en un restaurante",
        "icono": "🍽️",
        "descripcion": "Pide comida, pregunta por el menú y paga la cuenta.",
        "objetivos": [  # misiones que se marcan solas durante la llamada
            "Pide una bebida",
            "Haz una pregunta sobre el menú",
            "Ordena un plato",
            "Pide la cuenta y di cómo vas a pagar",
        ],
        "rol": (
            "You are Mike, a cheerful waiter at an American diner. Greet the student, offer them "
            "a table and drinks, describe today's specials (a cheeseburger, a grilled chicken salad "
            "and a vegetarian pasta), answer questions about the menu, take their order, and later "
            "bring the check and ask how they want to pay."
        ),
    },
    "hotel": {
        "personaje": "Emma",
        "genero": "femenino",
        "voz": "coral",
        "foto": "photo-1573497160825-0d94a2724d40",
        "color": "#0F766E",  # color del avatar (iniciales)
        "papel": "Recepcionista del hotel",
        "titulo": "Check-in en un hotel",
        "icono": "🏨",
        "descripcion": "Haz el check-in, pregunta por servicios y resuelve un problema.",
        "objetivos": [  # misiones que se marcan solas durante la llamada
            "Da tu nombre y los datos de tu reserva",
            "Pregunta por el desayuno o el Wi-Fi",
            "Negocia con amabilidad una habitación alternativa",
            "Pregunta a qué hora es el check-out",
        ],
        "rol": (
            "You are Emma, a receptionist at a hotel in New York. Help the student check in: ask "
            "for their name and reservation, ID and payment card, explain breakfast hours, Wi-Fi "
            "and check-out time. Halfway through, mention that their room type is not available "
            "and offer an alternative, so they have to negotiate politely."
        ),
    },
}

NIVELES = {
    "basico": {
        "titulo": "Básico",
        "descripcion": "Frases cortas y vocabulario sencillo",
        "guia": (
            "The student is a BEGINNER (A1-A2). Use very simple words and short sentences. "
            "Speak slowly and clearly. If they don't understand, rephrase with simpler words."
        ),
        "velocidad": 0.85,
    },
    "intermedio": {
        "titulo": "Intermedio",
        "descripcion": "Conversación natural con algo de apoyo",
        "guia": (
            "The student is INTERMEDIATE (B1-B2). Use natural, everyday English and common "
            "expressions, but avoid rare idioms."
        ),
        "velocidad": 1.0,
    },
    "avanzado": {
        "titulo": "Avanzado",
        "descripcion": "Ritmo real, expresiones y preguntas difíciles",
        "guia": (
            "The student is ADVANCED (C1). Speak at a natural native pace, use idioms and "
            "phrasal verbs, and ask follow-up questions that require detailed answers."
        ),
        "velocidad": 1.05,
    },
}

REGLAS_GENERALES = """
Rules:
- Speak ONLY in English. Stay in character for the whole conversation.
- Keep each of your turns short (1 to 3 sentences) and ask ONE question at a time,
  so the student speaks more than you.
- Do NOT correct the student's grammar during the conversation; a detailed evaluation
  is given at the end. Only if you truly cannot understand them, politely ask them to repeat.
- If the student speaks Spanish, kindly encourage them to try in English and give them
  a short hint of how to say it.
- Start the conversation yourself right away with a greeting in character.
"""


def construir_instrucciones(escenario: dict, nivel: str) -> str:
    """Arma las instrucciones (system prompt) para el modelo de voz.

    `escenario` es uno de ESCENARIOS o un escenario personalizado con los mismos campos.
    """
    objetivos = "\n".join(f"- {o}" for o in escenario.get("objetivos", []))
    guia_objetivos = (
        "\nDuring the conversation, naturally give the student chances to do these things "
        f"(listed in Spanish; do not read them aloud):\n{objetivos}\n"
        if objetivos else ""
    )
    return f"{escenario['rol']}\n\n{NIVELES[nivel]['guia']}\n{REGLAS_GENERALES}{guia_objetivos}"
