// Tutor de inglés por voz — lógica del navegador.
// Flujo: pedir clave temporal al servidor → conectar con OpenAI por WebRTC →
// mostrar la transcripción en vivo → al terminar, pedir la evaluación al servidor.

// Precios de gpt-realtime-2.1-mini (US$ por millón de tokens), solo para estimar el costo
const PRECIOS = {
  audioEntrada: 10, audioEntradaCache: 0.3, audioSalida: 20,
  textoEntrada: 0.6, textoEntradaCache: 0.06, textoSalida: 2.4,
};

const estado = {
  config: null,
  escenario: null,
  nivel: "intermedio",
  pc: null,          // RTCPeerConnection
  canal: null,       // data channel "oai-events"
  microfono: null,   // MediaStream del micrófono
  silenciado: false,
  inicio: null,
  intervalo: null,
  costo: 0,
  turnos: [],        // [{id, rol: "usuario"|"tutor", texto}]
  terminado: false,
};

const $ = (id) => document.getElementById(id);

// ---------- Utilidades de interfaz ----------
function mostrarPantalla(nombre) {
  document.querySelectorAll(".pantalla").forEach((p) => p.classList.remove("activa"));
  $(`pantalla-${nombre}`).classList.add("activa");
  window.scrollTo(0, 0);
}

function mostrarError(id, mensaje) {
  const caja = $(id);
  caja.textContent = mensaje;
  caja.classList.remove("oculto");
}

function ocultar(id) { $(id).classList.add("oculto"); }

function cambiarEstado(clase, texto) {
  const caja = $("estado");
  caja.className = `estado ${clase}`;
  $("texto-estado").textContent = texto;
}

function formatoTiempo(segundos) {
  const s = Math.max(0, Math.floor(segundos));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function escapar(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML;
}

async function pedirJSON(url, opciones = {}) {
  const respuesta = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opciones,
  });
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    const detalle = typeof datos.detail === "string" ? datos.detail : "Error inesperado del servidor.";
    throw new Error(detalle);
  }
  return datos;
}

// ---------- Pantalla de inicio ----------
async function cargarConfiguracion() {
  try {
    estado.config = await pedirJSON("/api/config");
  } catch (e) {
    mostrarError("error-inicio", `No se pudo cargar la configuración: ${e.message}`);
    return;
  }
  const { escenarios, niveles, max_minutos } = estado.config;

  $("escenarios").innerHTML = Object.entries(escenarios).map(([clave, e]) => `
    <button class="tarjeta" data-escenario="${clave}">
      <div class="icono">${e.icono}</div>
      <div class="titulo">${escapar(e.titulo)}</div>
      <div class="desc">${escapar(e.descripcion)}</div>
    </button>`).join("");

  $("niveles").innerHTML = Object.entries(niveles).map(([clave, n]) => `
    <button class="nivel ${clave === estado.nivel ? "elegido" : ""}" data-nivel="${clave}">
      <div class="titulo">${escapar(n.titulo)}</div>
      <div class="desc">${escapar(n.descripcion)}</div>
    </button>`).join("");

  $("nota-limite").textContent =
    `Cada sesión dura máximo ${formatoTiempo(max_minutos * 60)} minutos para controlar el gasto.`;

  document.querySelectorAll(".tarjeta").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tarjeta").forEach((x) => x.classList.remove("elegida"));
    b.classList.add("elegida");
    estado.escenario = b.dataset.escenario;
    $("btn-empezar").disabled = false;
  }));
  document.querySelectorAll(".nivel").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".nivel").forEach((x) => x.classList.remove("elegido"));
    b.classList.add("elegido");
    estado.nivel = b.dataset.nivel;
  }));
}

// ---------- Conversación ----------
async function empezar() {
  ocultar("error-inicio");
  $("btn-empezar").disabled = true;
  Object.assign(estado, { turnos: [], costo: 0, terminado: false, silenciado: false });
  $("transcripcion").innerHTML = "";
  $("costo").textContent = "US$0.000";
  ocultar("error-conversacion");
  ocultar("aviso-tiempo");

  try {
    // 1. Micrófono (primero, para que el navegador pida permiso)
    try {
      estado.microfono = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      throw new Error(e.name === "NotAllowedError"
        ? "No diste permiso para usar el micrófono. Haz clic en el candado de la barra de direcciones, permite el micrófono y vuelve a intentarlo."
        : `No se pudo acceder al micrófono: ${e.message}`);
    }

    // 2. Clave temporal desde nuestro servidor
    const sesion = await pedirJSON("/api/sesion", {
      method: "POST",
      body: JSON.stringify({ escenario: estado.escenario, nivel: estado.nivel }),
    });

    const esc = estado.config.escenarios[estado.escenario];
    $("titulo-conversacion").textContent = `${esc.icono} ${esc.titulo} · ${estado.config.niveles[estado.nivel].titulo}`;
    $("rotulo-tiempo").textContent = `de ${formatoTiempo(sesion.max_minutos * 60)}`;
    mostrarPantalla("conversacion");
    cambiarEstado("", "Conectando con tu tutor…");

    // 3. Conexión WebRTC con OpenAI
    await conectar(sesion.clave);
    iniciarCronometro(sesion.max_minutos);
  } catch (e) {
    detenerTodo();
    mostrarPantalla("inicio");
    mostrarError("error-inicio", e.message);
    $("btn-empezar").disabled = false;
  }
}

async function conectar(claveTemporal) {
  const pc = new RTCPeerConnection();
  estado.pc = pc;

  pc.ontrack = (e) => { $("audio-tutor").srcObject = e.streams[0]; };
  pc.addTrack(estado.microfono.getTracks()[0]);

  const canal = pc.createDataChannel("oai-events");
  estado.canal = canal;
  canal.addEventListener("message", (e) => manejarEvento(JSON.parse(e.data)));
  canal.addEventListener("open", () => {
    cambiarEstado("escuchando", "Conectado. Tu tutor va a empezar…");
    // Pedimos al tutor que salude primero
    canal.send(JSON.stringify({ type: "response.create" }));
  });

  pc.addEventListener("connectionstatechange", () => {
    if (["failed", "disconnected"].includes(pc.connectionState) && !estado.terminado) {
      mostrarError("error-conversacion", "Se perdió la conexión. Puedes terminar para evaluar lo que alcanzaste a hablar.");
    }
  });

  const oferta = await pc.createOffer();
  await pc.setLocalDescription(oferta);

  const respuesta = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    body: oferta.sdp,
    headers: { Authorization: `Bearer ${claveTemporal}`, "Content-Type": "application/sdp" },
  });
  if (!respuesta.ok) {
    throw new Error(`No se pudo conectar con OpenAI (${respuesta.status}). Revisa tu API Key y tu saldo.`);
  }
  await pc.setRemoteDescription({ type: "answer", sdp: await respuesta.text() });
}

// ---------- Transcripción en vivo ----------
function burbuja(id, rol) {
  let turno = estado.turnos.find((t) => t.id === id);
  if (!turno) {
    turno = { id, rol, texto: "" };
    estado.turnos.push(turno);
    const div = document.createElement("div");
    div.className = `mensaje ${rol} ${rol === "usuario" ? "pendiente" : ""}`;
    div.id = `msg-${id}`;
    div.innerHTML = `<div class="quien">${rol === "usuario" ? "Tú" : "Tutor"}</div><div class="texto">${rol === "usuario" ? "…" : ""}</div>`;
    $("transcripcion").appendChild(div);
  }
  return turno;
}

function actualizarBurbuja(turno) {
  const div = $(`msg-${turno.id}`);
  if (!div) return;
  div.querySelector(".texto").textContent = turno.texto || "…";
  if (turno.rol === "usuario" && turno.texto) div.classList.remove("pendiente");
  const caja = $("transcripcion");
  caja.scrollTop = caja.scrollHeight;
}

function manejarEvento(ev) {
  switch (ev.type) {
    case "input_audio_buffer.speech_started":
      cambiarEstado("usuario", "Te estoy escuchando…");
      burbuja(ev.item_id, "usuario");
      break;
    case "input_audio_buffer.speech_stopped":
      cambiarEstado("escuchando", "Pensando…");
      break;
    case "conversation.item.input_audio_transcription.delta": {
      const t = burbuja(ev.item_id, "usuario");
      t.texto += ev.delta || "";
      actualizarBurbuja(t);
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      const t = burbuja(ev.item_id, "usuario");
      t.texto = (ev.transcript || "").trim();
      actualizarBurbuja(t);
      break;
    }
    case "conversation.item.input_audio_transcription.failed": {
      const t = burbuja(ev.item_id, "usuario");
      t.texto = t.texto || "(no se pudo transcribir)";
      actualizarBurbuja(t);
      break;
    }
    case "response.output_audio_transcript.delta": {
      const t = burbuja(ev.item_id, "tutor");
      t.texto += ev.delta || "";
      actualizarBurbuja(t);
      break;
    }
    case "response.output_audio_transcript.done": {
      const t = burbuja(ev.item_id, "tutor");
      if (ev.transcript) t.texto = ev.transcript;
      actualizarBurbuja(t);
      break;
    }
    case "output_audio_buffer.started":
      cambiarEstado("tutor", "Tu tutor está hablando…");
      break;
    case "output_audio_buffer.stopped":
      if (!estado.silenciado) cambiarEstado("escuchando", "Tu turno: habla en inglés 🎤");
      break;
    case "response.done":
      sumarCosto(ev.response?.usage);
      break;
    case "error":
      console.error("Error de OpenAI:", ev.error);
      mostrarError("error-conversacion", `OpenAI: ${ev.error?.message || "error desconocido"}`);
      break;
  }
}

function sumarCosto(uso) {
  if (!uso) return;
  const ent = uso.input_token_details || {};
  const sal = uso.output_token_details || {};
  const cache = ent.cached_tokens_details || {};
  const audioCache = cache.audio_tokens || 0;
  const textoCache = cache.text_tokens || 0;
  const costo =
    ((ent.audio_tokens || 0) - audioCache) * PRECIOS.audioEntrada +
    audioCache * PRECIOS.audioEntradaCache +
    ((ent.text_tokens || 0) - textoCache) * PRECIOS.textoEntrada +
    textoCache * PRECIOS.textoEntradaCache +
    (sal.audio_tokens || 0) * PRECIOS.audioSalida +
    (sal.text_tokens || 0) * PRECIOS.textoSalida;
  estado.costo += costo / 1_000_000;
  $("costo").textContent = `US$${estado.costo.toFixed(3)}`;
}

// ---------- Tiempo, silencio y cierre ----------
function iniciarCronometro(maxMinutos) {
  estado.inicio = Date.now();
  const limite = maxMinutos * 60;
  estado.intervalo = setInterval(() => {
    const transcurrido = (Date.now() - estado.inicio) / 1000;
    $("cronometro").textContent = formatoTiempo(transcurrido);
    const restante = limite - transcurrido;
    if (restante <= 30 && restante > 0) {
      $("aviso-tiempo").textContent = `⏳ Quedan ${Math.ceil(restante)} segundos de sesión.`;
      $("aviso-tiempo").classList.remove("oculto");
    }
    if (restante <= 0) terminar();
  }, 500);
}

function alternarSilencio() {
  if (!estado.microfono) return;
  estado.silenciado = !estado.silenciado;
  estado.microfono.getTracks().forEach((t) => { t.enabled = !estado.silenciado; });
  $("btn-silenciar").textContent = estado.silenciado ? "🎤 Activar micrófono" : "🔇 Silenciar micrófono";
  cambiarEstado(estado.silenciado ? "silenciado" : "escuchando",
    estado.silenciado ? "Micrófono silenciado" : "Tu turno: habla en inglés 🎤");
}

function detenerTodo() {
  clearInterval(estado.intervalo);
  try { estado.canal?.close(); } catch {}
  try { estado.pc?.close(); } catch {}
  estado.microfono?.getTracks().forEach((t) => t.stop());
  Object.assign(estado, { pc: null, canal: null, microfono: null });
  $("audio-tutor").srcObject = null;
}

async function terminar() {
  if (estado.terminado) return;
  estado.terminado = true;
  detenerTodo();

  mostrarPantalla("evaluacion");
  $("cargando-evaluacion").classList.remove("oculto");
  ocultar("evaluacion");
  ocultar("error-evaluacion");
  ocultar("btn-otra");

  const turnos = estado.turnos
    .filter((t) => t.texto && t.texto !== "(no se pudo transcribir)")
    .map((t) => ({ rol: t.rol, texto: t.texto.slice(0, 2000) }));

  try {
    const evaluacion = await pedirJSON("/api/evaluar", {
      method: "POST",
      body: JSON.stringify({ escenario: estado.escenario, nivel: estado.nivel, turnos }),
    });
    mostrarEvaluacion(evaluacion);
  } catch (e) {
    mostrarError("error-evaluacion", e.message);
  } finally {
    ocultar("cargando-evaluacion");
    $("btn-otra").classList.remove("oculto");
  }
}

// ---------- Evaluación ----------
function lista(items, plantilla, vacio) {
  return items?.length ? items.map(plantilla).join("") : `<p class="vacio">${vacio}</p>`;
}

function mostrarEvaluacion(ev) {
  const minutos = estado.inicio ? (Date.now() - estado.inicio) / 60000 : 0;
  $("evaluacion").innerHTML = `
    <div class="nota-final">
      <div class="circulo-nota" style="--p:${ev.nota * 10}"><span>${ev.nota}</span></div>
      <div>
        <h2 style="margin:0 0 6px;color:var(--texto)">Tu resultado</h2>
        <div>${escapar(ev.resumen)}</div>
        <div class="explicacion" style="margin-top:6px">Duración: ${formatoTiempo(minutos * 60)} · Costo estimado: US$${estado.costo.toFixed(3)}</div>
      </div>
    </div>

    <div class="bloque">
      <h3>✏️ Errores y correcciones</h3>
      ${lista(ev.errores, (e) => `
        <div class="item">
          <div><span class="tachado">${escapar(e.original)}</span></div>
          <div class="correcto">✓ ${escapar(e.correccion)}</div>
          <div class="explicacion">${escapar(e.explicacion)}</div>
        </div>`, "¡No encontramos errores importantes! 🎉")}
    </div>

    <div class="bloque">
      <h3>💡 Dilo de forma más natural</h3>
      ${lista(ev.mejores_frases, (f) => `
        <div class="item">
          <div class="explicacion">Dijiste: ${escapar(f.original)}</div>
          <div class="correcto">Mejor: ${escapar(f.mejor)}</div>
        </div>`, "Tus frases sonaron naturales.")}
    </div>

    <div class="bloque">
      <h3>📚 Vocabulario útil</h3>
      ${lista(ev.vocabulario, (v) => `
        <div class="item">
          <div><span class="palabra">${escapar(v.palabra)}</span> — ${escapar(v.significado)}</div>
          <div class="ejemplo">"${escapar(v.ejemplo)}"</div>
        </div>`, "Sin vocabulario sugerido.")}
    </div>

    <div class="bloque">
      <h3>🎯 Consejos para mejorar</h3>
      <ul class="consejos">${(ev.consejos || []).map((c) => `<li>${escapar(c)}</li>`).join("")}</ul>
    </div>`;
  $("evaluacion").classList.remove("oculto");
}

// ---------- Eventos de botones ----------
$("btn-empezar").addEventListener("click", empezar);
$("btn-silenciar").addEventListener("click", alternarSilencio);
$("btn-terminar").addEventListener("click", terminar);
$("btn-otra").addEventListener("click", () => {
  mostrarPantalla("inicio");
  $("btn-empezar").disabled = !estado.escenario;
});
window.addEventListener("beforeunload", detenerTodo);

cargarConfiguracion();
