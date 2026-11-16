"""Punto de entrada para Streamlit Community Cloud.

Streamlit sirve dos cosas con este archivo:
  - la página de Streamlit (pagina.py), que muestra el tutor a pantalla completa, y
  - la app del tutor (main.py, FastAPI) montada en la ruta /tutor/.

Para correrlo en tu PC:  streamlit run streamlit_app.py
(La forma de siempre, uvicorn main:app --reload, sigue funcionando igual.)
"""

import os

import streamlit as st
from starlette.routing import Mount

# En la nube, la API Key se guarda en los "Secrets" de Streamlit. Los pasamos a variables
# de entorno para que main.py los lea igual que lee el archivo .env en tu PC.
try:
    for clave, valor in st.secrets.items():
        if isinstance(valor, (str, int, float, bool)):
            os.environ.setdefault(clave, str(valor))
except Exception:
    pass  # Sin secrets.toml: se usa el archivo .env

from main import app as app_tutor  # noqa: E402  (después de cargar los secretos)

app = st.App("pagina.py", routes=[Mount("/tutor", app=app_tutor)])
