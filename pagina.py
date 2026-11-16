"""Página de Streamlit que muestra el tutor (servido en /tutor/) a pantalla completa."""

import streamlit as st

st.set_page_config(page_title="Tutor de inglés por voz", page_icon="🗣️", layout="wide",
                   initial_sidebar_state="collapsed")

# Quita los márgenes y la barra de Streamlit para que el tutor ocupe toda la ventana
st.html("""
<style>
  header[data-testid="stHeader"], [data-testid="stToolbar"], [data-testid="stDecoration"] { display: none !important; }
  .block-container, [data-testid="stMainBlockContainer"] { padding: 0 !important; max-width: 100% !important; }
  [data-testid="stIFrame"], iframe[title="st.iframe"] { height: 100dvh !important; border: 0; display: block; }
</style>
""")

# El tutor vive en la subruta "tutor/" de esta misma app. La ruta se calcula en el navegador
# porque en Streamlit Community Cloud la app está dentro de una subruta (no en la raíz).
st.iframe(
    """<!DOCTYPE html><html><body style="margin:0;font-family:sans-serif;color:#7A4E45;background:#FFF3EB">
    <p style="padding:24px">Cargando el tutor…</p>
    <script>
      const pagina = new URL(window.parent.location.href);
      const carpeta = pagina.pathname.endsWith("/") ? pagina.pathname : pagina.pathname + "/";
      window.location.replace(new URL(carpeta + "tutor/", pagina.origin).href);
    </script></body></html>""",
    height=800,
)
