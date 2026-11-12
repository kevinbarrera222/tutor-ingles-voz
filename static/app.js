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
  hablando: null,    // "tutor" | "usuario" | null (según los eventos de OpenAI)
  audioCtx: null,
  analizadorMic: null,
  analizadorTutor: null,
  animacion: null,
  nivelSuave: 0,
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

const icono = (nombre) => `<svg class="ico" aria-hidden="true"><use href="#i-${nombre}"/></svg>`;
const personajeActual = () => estado.config?.escenarios[estado.escenario]?.personaje || "Tu tutor";

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
    <button class="contacto" role="radio" aria-checked="false" data-escenario="${clave}">
      <span class="avatar-contacto" style="--color-personaje:${e.color}">${escapar(e.personaje[0])}</span>
      <span>
        <span class="quien-es"><span class="nombre-contacto">${escapar(e.personaje)}</span><span class="rol">${escapar(e.papel)}</span></span>
        <span class="escenario" style="display:block"><b>${escapar(e.titulo)}.</b> <span class="detalle">${escapar(e.descripcion)}</span></span>
      </span>
      <span class="seleccion">${icono("check")}</span>
    </button>`).join("");

  $("niveles").innerHTML = Object.entries(niveles).map(([clave, n]) => `
    <button class="segmento" role="radio" aria-checked="${clave === estado.nivel}" data-nivel="${clave}">${escapar(n.titulo)}</button>`).join("");
  $("descripcion-nivel").textContent = niveles[estado.nivel].descripcion + ".";

  $("nota-limite").textContent = `Cada llamada dura máximo ${Math.round(max_minutos)} minutos.`;

  document.querySelectorAll(".contacto").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".contacto").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    estado.escenario = b.dataset.escenario;
    $("btn-empezar").innerHTML = `${icono("phone")}<span>Llamar a ${escapar(personajeActual())}</span>`;
    $("btn-empezar").disabled = false;
  }));
  document.querySelectorAll(".segmento").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".segmento").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    estado.nivel = b.dataset.nivel;
    $("descripcion-nivel").textContent = niveles[estado.nivel].descripcion + ".";
  }));
}

// ---------- Conversación ----------
async function empezar() {
  ocultar("error-inicio");
  $("btn-empezar").disabled = true;
  Object.assign(estado, { turnos: [], costo: 0, terminado: false, silenciado: false });
  $("transcripcion").innerHTML = `<p class="vacio" id="transcripcion-vacia">Aquí aparece todo lo que se dice en la llamada.</p>`;
  $("costo").textContent = "US$0.000";
  $("cronometro").textContent = "0:00";
  $("sub-tutor").textContent = "";
  $("sub-usuario").textContent = "";
  pintarSilencio();
  $("anillo-progreso").style.strokeDashoffset = 0;
  $("anillo-progreso").classList.remove("poco");
  estado.hablando = null;
  ocultar("panel-pista");
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
    $("avatar").textContent = esc.personaje[0];
    $("avatar").style.setProperty("--color-personaje", esc.color);
    $("nombre-personaje").textContent = esc.personaje;
    $("titulo-conversacion").textContent = `${esc.papel}, nivel ${estado.config.niveles[estado.nivel].titulo.toLowerCase()}`;
    $("rotulo-tiempo").textContent = `de ${formatoTiempo(sesion.max_minutos * 60)}`;
    mostrarPantalla("conversacion");
    cambiarEstado("", `Conectando con ${esc.personaje}…`);

    // 3. Conexión WebRTC con OpenAI
    iniciarOrbe();
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

  pc.ontrack = (e) => {
    $("audio-tutor").srcObject = e.streams[0];
    estado.analizadorTutor = crearAnalizador(e.streams[0]);
  };
  pc.addTrack(estado.microfono.getTracks()[0]);
  estado.analizadorMic = crearAnalizador(estado.microfono);

  const canal = pc.createDataChannel("oai-events");
  estado.canal = canal;
  canal.addEventListener("message", (e) => manejarEvento(JSON.parse(e.data)));
  canal.addEventListener("open", () => {
    cambiarEstado("escuchando", `En llamada con ${personajeActual()}`);
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
    div.innerHTML = `<div class="quien">${rol === "usuario" ? "Tú" : escapar(personajeActual())}</div><div class="texto">${rol === "usuario" ? "…" : ""}</div>`;
    $("transcripcion-vacia")?.remove();
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
      estado.hablando = "usuario";
      cambiarEstado("usuario", "Te escucho");
      burbuja(ev.item_id, "usuario");
      $("sub-usuario").textContent = "…";
      ocultar("panel-pista");
      break;
    case "input_audio_buffer.speech_stopped":
      estado.hablando = null;
      cambiarEstado("escuchando", `${personajeActual()} está pensando`);
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
      $("sub-usuario").textContent = t.texto ? `Tú: ${t.texto}` : "";
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
      $("sub-tutor").textContent = t.texto;
      break;
    }
    case "response.output_audio_transcript.done": {
      const t = burbuja(ev.item_id, "tutor");
      if (ev.transcript) t.texto = ev.transcript;
      actualizarBurbuja(t);
      $("sub-tutor").textContent = t.texto;
      break;
    }
    case "output_audio_buffer.started":
      estado.hablando = "tutor";
      cambiarEstado("tutor", `${personajeActual()} está hablando`);
      break;
    case "output_audio_buffer.cleared":
    case "output_audio_buffer.stopped":
      estado.hablando = null;
      if (!estado.silenciado) cambiarEstado("escuchando", "Tu turno, responde en inglés");
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
    $("anillo-progreso").style.strokeDashoffset = 904.8 * Math.min(1, transcurrido / limite);
    $("anillo-progreso").classList.toggle("poco", restante <= 30);
    if (restante <= 30 && restante > 0) {
      $("aviso-tiempo").textContent = `Quedan ${Math.ceil(restante)} segundos de llamada.`;
      $("aviso-tiempo").classList.remove("oculto");
    }
    if (restante <= 0) terminar();
  }, 500);
}

function alternarSilencio() {
  if (!estado.microfono) return;
  estado.silenciado = !estado.silenciado;
  estado.microfono.getTracks().forEach((t) => { t.enabled = !estado.silenciado; });
  pintarSilencio();
  cambiarEstado(estado.silenciado ? "silenciado" : "escuchando",
    estado.silenciado ? "Micrófono silenciado" : "Tu turno, responde en inglés");
}

function pintarSilencio() {
  const b = $("btn-silenciar");
  b.setAttribute("aria-pressed", String(estado.silenciado));
  b.querySelector(".circulo").innerHTML = icono(estado.silenciado ? "mic-off" : "mic");
  b.querySelector(".rotulo-control").textContent = estado.silenciado ? "Activar" : "Silenciar";
}

function detenerTodo() {
  clearInterval(estado.intervalo);
  cancelAnimationFrame(estado.animacion);
  try { estado.audioCtx?.close(); } catch {}
  Object.assign(estado, { audioCtx: null, analizadorMic: null, analizadorTutor: null, hablando: null });
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
  ocultar("acciones-final");

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
    $("acciones-final").classList.remove("oculto");
  }
}

// ---------- Orbe animado (reacciona al volumen real de tu voz y la del tutor) ----------
function crearAnalizador(stream) {
  try {
    estado.audioCtx = estado.audioCtx || new AudioContext();
    const analizador = estado.audioCtx.createAnalyser();
    analizador.fftSize = 256;
    estado.audioCtx.createMediaStreamSource(stream).connect(analizador);
    return analizador;
  } catch {
    return null; // sin analizador, el orbe usa una animación genérica
  }
}

function volumen(analizador) {
  if (!analizador) return null;
  const datos = new Uint8Array(analizador.fftSize);
  analizador.getByteTimeDomainData(datos);
  let suma = 0;
  for (const v of datos) { const x = (v - 128) / 128; suma += x * x; }
  return Math.min(1, Math.sqrt(suma / datos.length) * 4);
}

// [color del centro, color del borde] para cada estado del orbe
const COLORES_ORBE = {
  tutor: [[34, 197, 94], [59, 130, 246]],        // verde → azul
  usuario: [[59, 130, 246], [56, 189, 248]],     // azul → celeste
  quieto: [[148, 163, 184], [203, 213, 225]],    // gris
  silenciado: [[245, 158, 11], [251, 191, 36]],  // ámbar
};

function iniciarOrbe() {
  const lienzo = $("orbe");
  const ctx = lienzo.getContext("2d");
  const escala = window.devicePixelRatio || 1;
  lienzo.width = lienzo.height = 300 * escala;
  const pocoMovimiento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let centro = [...COLORES_ORBE.quieto[0]], borde = [...COLORES_ORBE.quieto[1]];

  const cuadro = () => {
    const t = pocoMovimiento ? 0 : performance.now() / 1000;
    const volMic = estado.silenciado ? 0 : volumen(estado.analizadorMic);
    const volTutor = volumen(estado.analizadorTutor);
    const generico = 0.35 + 0.25 * Math.sin(t * 9);

    // ¿Quién suena ahora? El micrófono se refleja al instante, sin esperar a OpenAI
    let quien = "quieto", nivel = 0.04;
    if (estado.hablando === "tutor" || (volTutor ?? 0) > 0.06) { quien = "tutor"; nivel = volTutor ?? generico; }
    else if (estado.hablando === "usuario" || (volMic ?? 0) > 0.08) { quien = "usuario"; nivel = volMic ?? generico; }
    else if (estado.silenciado) quien = "silenciado";

    estado.nivelSuave += (nivel - estado.nivelSuave) * 0.2;
    centro = centro.map((c, i) => c + (COLORES_ORBE[quien][0][i] - c) * 0.12);
    borde = borde.map((c, i) => c + (COLORES_ORBE[quien][1][i] - c) * 0.12);
    const [r, g, b] = centro.map(Math.round);
    const [r2, g2, b2] = borde.map(Math.round);

    ctx.setTransform(escala, 0, 0, escala, 0, 0);
    ctx.clearRect(0, 0, 300, 300);
    for (let capa = 2; capa >= 0; capa--) {
      // Tamaños calculados para que el orbe nunca se salga del anillo (radio 144)
      const base = 50 + capa * 14 + estado.nivelSuave * (12 + capa * 8);
      const onda = 2 + estado.nivelSuave * (6 + capa * 3);
      ctx.beginPath();
      for (let k = 0; k <= 72; k++) {
        const ang = (k / 72) * Math.PI * 2;
        const radio = base
          + Math.sin(ang * 3 + t * (1.4 + capa * 0.5)) * onda
          + Math.sin(ang * 5 - t * (1.1 + capa * 0.3)) * onda * 0.5;
        const x = 150 + Math.cos(ang) * radio, y = 150 + Math.sin(ang) * radio;
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      const degradado = ctx.createRadialGradient(150, 150, 10, 150, 150, base + onda);
      const alfa = [0.95, 0.3, 0.14][capa];
      degradado.addColorStop(0, `rgba(${r},${g},${b},${alfa})`);
      degradado.addColorStop(1, `rgba(${r2},${g2},${b2},${alfa * 0.8})`);
      ctx.fillStyle = degradado;
      ctx.fill();
    }
    estado.animacion = requestAnimationFrame(cuadro);
  };
  cancelAnimationFrame(estado.animacion);
  cuadro();
}

// ---------- Pistas: traducción de lo que dijo el tutor + qué responder ----------
async function pedirPista() {
  const panel = $("panel-pista");
  const turnos = estado.turnos
    .filter((t) => t.texto && t.texto !== "(no se pudo transcribir)")
    .slice(-6)
    .map((t) => ({ rol: t.rol, texto: t.texto.slice(0, 2000) }));
  if (!turnos.some((t) => t.rol === "tutor")) {
    panel.innerHTML = `<p class="vacio">Espera a que ${escapar(personajeActual())} diga algo y vuelve a pedir la pista.</p>`;
    panel.classList.remove("oculto");
    return;
  }
  $("btn-pista").disabled = true;
  panel.innerHTML = `<p class="vacio">Preparando tu pista…</p>`;
  panel.classList.remove("oculto");
  try {
    const pista = await pedirJSON("/api/pista", {
      method: "POST",
      body: JSON.stringify({ escenario: estado.escenario, nivel: estado.nivel, turnos }),
    });
    panel.innerHTML = `
      <button class="cerrar-pista" aria-label="Cerrar pista" onclick="document.getElementById('panel-pista').classList.add('oculto')">${icono("close")}</button>
      <h3>${escapar(personajeActual())} dijo</h3>
      <p class="traduccion">${escapar(pista.traduccion)}</p>
      <h3>Podrías responder</h3>
      ${pista.sugerencias.map((s) => `
        <div class="sugerencia">
          <div class="ing">${escapar(s.ingles)}</div>
          <div class="esp">${escapar(s.espanol)}</div>
        </div>`).join("")}`;
  } catch (e) {
    panel.innerHTML = `<p class="vacio">${escapar(e.message)}</p>`;
  } finally {
    $("btn-pista").disabled = false;
  }
}

// ---------- Evaluación ----------

function mostrarEvaluacion(ev) {
  const minutos = estado.inicio ? (Date.now() - estado.inicio) / 60000 : 0;
  const titulo = ev.nota >= 9 ? "Excelente trabajo." : ev.nota >= 7 ? "Muy bien." : ev.nota >= 5 ? "Vas por buen camino." : "Sigue practicando.";
  const respuestas = estado.turnos.filter((t) => t.rol === "usuario" && t.texto).length;
  const errores = ev.errores || [], frases = ev.mejores_frases || [], vocab = ev.vocabulario || [];
  const pestana = (id, texto, cuenta, activa) => `
    <button class="pestana" role="tab" id="tab-${id}" aria-controls="${id}" aria-selected="${activa}">
      ${texto}${cuenta != null ? `<span class="cuenta">${cuenta}</span>` : ""}
    </button>`;

  $("evaluacion").innerHTML = `
    <div class="resultado">
      <div class="circulo-nota" id="circulo-nota" style="--p:0" role="img" aria-label="Nota ${ev.nota} de 10">
        <div class="interior"><div><span class="numero" id="numero-nota">0</span><span class="de">de 10</span></div></div>
      </div>
      <div>
        <h1>${titulo}</h1>
        <p class="resumen">${escapar(ev.resumen)}</p>
      </div>
    </div>

    <dl class="estadisticas">
      <div><dt>Duración</dt><dd>${formatoTiempo(minutos * 60)}</dd></div>
      <div><dt>Respuestas</dt><dd>${respuestas}</dd></div>
      <div><dt>Correcciones</dt><dd>${errores.length}</dd></div>
      <div><dt>Costo</dt><dd>US$${estado.costo.toFixed(3)}</dd></div>
    </dl>

    <div class="pestanas" role="tablist">
      ${pestana("p-errores", "Correcciones", errores.length, true)}
      ${pestana("p-frases", "Frases más naturales", frases.length, false)}
      ${pestana("p-vocab", "Vocabulario", vocab.length, false)}
      ${pestana("p-consejos", "Consejos", null, false)}
    </div>

    <div id="p-errores" class="panel-eval activo" role="tabpanel">
      ${errores.length ? `<div class="lista-correcciones">${errores.map((e) => `
        <div class="correccion">
          <div class="linea-correccion antes">${icono("close")}<span>${escapar(e.original)}</span></div>
          <div class="linea-correccion despues">${icono("check")}<span>${escapar(e.correccion)}</span></div>
          <p class="explicacion">${escapar(e.explicacion)}</p>
        </div>`).join("")}</div>` : `<p class="vacio">No encontramos errores importantes en esta llamada.</p>`}
    </div>

    <div id="p-frases" class="panel-eval" role="tabpanel">
      ${frases.length ? `<div class="lista-correcciones">${frases.map((f) => `
        <div class="correccion">
          <p class="dijiste">Dijiste: ${escapar(f.original)}</p>
          <div class="linea-correccion despues">${icono("check")}<span>${escapar(f.mejor)}</span></div>
        </div>`).join("")}</div>` : `<p class="vacio">Tus frases sonaron naturales.</p>`}
    </div>

    <div id="p-vocab" class="panel-eval" role="tabpanel">
      ${vocab.length ? `
        <p class="ayuda-vocab">Toca una tarjeta para ver su significado y un ejemplo.</p>
        <div class="tarjetas-vocab">${vocab.map((v) => `
          <button class="flip" aria-label="Ver significado de ${escapar(v.palabra)}">
            <span class="cara frente">
              <span class="palabra">${escapar(v.palabra)}</span>
              <span class="girar">${icono("translate")}Ver significado</span>
            </span>
            <span class="cara reverso">
              <b>${escapar(v.significado)}</b>
              <span class="ejemplo">${escapar(v.ejemplo)}</span>
            </span>
          </button>`).join("")}</div>` : `<p class="vacio">Sin vocabulario sugerido para esta llamada.</p>`}
    </div>

    <div id="p-consejos" class="panel-eval" role="tabpanel">
      <ul class="consejos">${(ev.consejos || []).map((c) => `<li>${icono("check")}<span>${escapar(c)}</span></li>`).join("")}</ul>
    </div>`;
  $("evaluacion").classList.remove("oculto");
  $("texto-repetir").textContent = `Repetir con ${personajeActual()}`;

  // Pestañas
  document.querySelectorAll(".pestana").forEach((p) => p.addEventListener("click", () => {
    document.querySelectorAll(".pestana").forEach((x) => x.setAttribute("aria-selected", String(x === p)));
    document.querySelectorAll(".panel-eval").forEach((x) => x.classList.toggle("activo", x.id === p.getAttribute("aria-controls")));
  }));
  // Tarjetas de vocabulario que se voltean
  document.querySelectorAll(".flip").forEach((f) => f.addEventListener("click", () => f.classList.toggle("volteada")));

  animarNota(ev.nota);
}

function animarNota(nota) {
  const pocoMovimiento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duracion = pocoMovimiento ? 0 : 1100, inicio = performance.now();
  const paso = (ahora) => {
    const avance = duracion ? Math.min(1, (ahora - inicio) / duracion) : 1;
    const suave = 1 - Math.pow(1 - avance, 3);
    $("numero-nota").textContent = Math.round(nota * suave);
    $("circulo-nota").style.setProperty("--p", nota * 10 * suave);
    if (avance < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

// ---------- Eventos de botones ----------
$("btn-empezar").addEventListener("click", empezar);
$("btn-silenciar").addEventListener("click", alternarSilencio);
$("btn-pista").addEventListener("click", pedirPista);
$("btn-terminar").addEventListener("click", terminar);
$("btn-repetir").addEventListener("click", () => empezar());
$("btn-otra").addEventListener("click", () => {
  mostrarPantalla("inicio");
  $("btn-empezar").disabled = !estado.escenario;
});
window.addEventListener("beforeunload", detenerTodo);

cargarConfiguracion();
