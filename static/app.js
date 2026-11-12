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

function cambiarEstado(clase, texto) {
  const caja = $("estado");
  caja.className = `estado centrado ${clase}`;
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
    <button class="tarjeta" data-escenario="${clave}" aria-pressed="false">
      <div class="tarjeta-cabecera">
        <span class="avatar-tarjeta">${e.avatar}</span>
        <span class="icono-escenario">${e.icono}</span>
      </div>
      <div class="titulo">${escapar(e.titulo)}</div>
      <div class="con-quien">Hablas con <b>${escapar(e.personaje)}</b> · ${escapar(e.papel)}</div>
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
    document.querySelectorAll(".tarjeta").forEach((x) => { x.classList.remove("elegida"); x.setAttribute("aria-pressed", "false"); });
    b.classList.add("elegida");
    b.setAttribute("aria-pressed", "true");
    const e = estado.config.escenarios[b.dataset.escenario];
    $("btn-empezar").innerHTML = `<span>📞</span> Llamar a ${escapar(e.personaje)}`;
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
  $("cronometro").textContent = "0:00";
  $("sub-tutor").textContent = "";
  $("sub-usuario").textContent = "";
  $("btn-silenciar").textContent = "🔇 Silenciar";
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
    $("avatar").textContent = esc.avatar;
    $("nombre-personaje").textContent = esc.personaje;
    $("titulo-conversacion").textContent = `${esc.papel} · Nivel ${estado.config.niveles[estado.nivel].titulo}`;
    $("rotulo-tiempo").textContent = `de ${formatoTiempo(sesion.max_minutos * 60)}`;
    mostrarPantalla("conversacion");
    cambiarEstado("", "Conectando con tu tutor…");

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
      estado.hablando = "usuario";
      cambiarEstado("usuario", "Te estoy escuchando…");
      burbuja(ev.item_id, "usuario");
      $("sub-usuario").textContent = "🎤 …";
      ocultar("panel-pista");
      break;
    case "input_audio_buffer.speech_stopped":
      estado.hablando = null;
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
      cambiarEstado("tutor", `${estado.config?.escenarios[estado.escenario]?.personaje || "Tu tutor"} está hablando…`);
      break;
    case "output_audio_buffer.cleared":
    case "output_audio_buffer.stopped":
      estado.hablando = null;
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
    $("anillo-progreso").style.strokeDashoffset = 904.8 * Math.min(1, transcurrido / limite);
    $("anillo-progreso").classList.toggle("poco", restante <= 30);
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
  $("btn-silenciar").textContent = estado.silenciado ? "🎤 Activar" : "🔇 Silenciar";
  cambiarEstado(estado.silenciado ? "silenciado" : "escuchando",
    estado.silenciado ? "Micrófono silenciado" : "Tu turno: habla en inglés 🎤");
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
    panel.innerHTML = `<span class="vacio">Espera a que tu tutor diga algo y vuelve a pedir la pista.</span>`;
    panel.classList.remove("oculto");
    return;
  }
  $("btn-pista").disabled = true;
  panel.innerHTML = `<span class="vacio">Buscando una pista…</span>`;
  panel.classList.remove("oculto");
  try {
    const pista = await pedirJSON("/api/pista", {
      method: "POST",
      body: JSON.stringify({ escenario: estado.escenario, nivel: estado.nivel, turnos }),
    });
    panel.innerHTML = `
      <button class="cerrar-pista" aria-label="Cerrar pista" onclick="document.getElementById('panel-pista').classList.add('oculto')">✕</button>
      <div class="rotulo-pista">Te dijo</div>
      <div class="traduccion">${escapar(pista.traduccion)}</div>
      <div class="rotulo-pista">Puedes responder</div>
      ${pista.sugerencias.map((s) => `
        <div class="sugerencia">
          <div class="ing">${escapar(s.ingles)}</div>
          <div class="esp">${escapar(s.espanol)}</div>
        </div>`).join("")}`;
  } catch (e) {
    panel.innerHTML = `<span class="vacio">${escapar(e.message)}</span>`;
  } finally {
    $("btn-pista").disabled = false;
  }
}

// ---------- Evaluación ----------
function lista(items, plantilla, vacio) {
  return items?.length ? items.map(plantilla).join("") : `<p class="vacio">${vacio}</p>`;
}

function mostrarEvaluacion(ev) {
  const minutos = estado.inicio ? (Date.now() - estado.inicio) / 60000 : 0;
  const mensaje = ev.nota >= 9 ? "¡Excelente! 🏆" : ev.nota >= 7 ? "¡Muy bien! 💪" : ev.nota >= 5 ? "Vas por buen camino 👍" : "Sigue practicando, ¡tú puedes! 🌱";
  const turnosUsuario = estado.turnos.filter((t) => t.rol === "usuario" && t.texto).length;

  $("evaluacion").innerHTML = `
    <div class="nota-final aparecer">
      <div class="circulo-nota" id="circulo-nota" style="--p:0"><span id="numero-nota">0</span></div>
      <div>
        <div class="mensaje-nota">${mensaje}</div>
        <div>${escapar(ev.resumen)}</div>
        <div class="chips">
          <span class="chip">⏱️ ${formatoTiempo(minutos * 60)}</span>
          <span class="chip">🗣️ ${turnosUsuario} respuestas</span>
          <span class="chip">✏️ ${ev.errores?.length || 0} correcciones</span>
          <span class="chip">💸 US$${estado.costo.toFixed(3)}</span>
        </div>
      </div>
    </div>

    <div class="pestanas" role="tablist">
      <button class="pestana activa" data-panel="p-errores" role="tab">✏️ Correcciones</button>
      <button class="pestana" data-panel="p-frases" role="tab">💡 Más natural</button>
      <button class="pestana" data-panel="p-vocab" role="tab">📚 Vocabulario</button>
      <button class="pestana" data-panel="p-consejos" role="tab">🎯 Consejos</button>
    </div>

    <div id="p-errores" class="panel-eval activo">
      ${lista(ev.errores, (e, i) => `
        <div class="correccion aparecer" style="animation-delay:${i * 80}ms">
          <div class="antes">✗ ${escapar(e.original)}</div>
          <div class="despues">✓ ${escapar(e.correccion)}</div>
          <div class="explicacion">${escapar(e.explicacion)}</div>
        </div>`, "¡No encontramos errores importantes! 🎉")}
    </div>

    <div id="p-frases" class="panel-eval">
      ${lista(ev.mejores_frases, (f, i) => `
        <div class="correccion aparecer" style="animation-delay:${i * 80}ms">
          <div class="explicacion">Dijiste: ${escapar(f.original)}</div>
          <div class="despues">✨ ${escapar(f.mejor)}</div>
        </div>`, "Tus frases sonaron naturales.")}
    </div>

    <div id="p-vocab" class="panel-eval">
      <p class="ayuda-vocab">Toca cada tarjeta para ver su significado 👆</p>
      <div class="tarjetas-vocab">
        ${lista(ev.vocabulario, (v) => `
          <button class="flip" aria-label="Ver significado de ${escapar(v.palabra)}">
            <span class="cara frente"><span class="palabra">${escapar(v.palabra)}</span></span>
            <span class="cara reverso">
              <b>${escapar(v.significado)}</b>
              <span class="ejemplo">"${escapar(v.ejemplo)}"</span>
            </span>
          </button>`, "Sin vocabulario sugerido.")}
      </div>
    </div>

    <div id="p-consejos" class="panel-eval">
      <ol class="consejos">${(ev.consejos || []).map((c) => `<li>${escapar(c)}</li>`).join("")}</ol>
    </div>`;
  $("evaluacion").classList.remove("oculto");

  // Pestañas
  document.querySelectorAll(".pestana").forEach((p) => p.addEventListener("click", () => {
    document.querySelectorAll(".pestana").forEach((x) => x.classList.toggle("activa", x === p));
    document.querySelectorAll(".panel-eval").forEach((x) => x.classList.toggle("activo", x.id === p.dataset.panel));
  }));
  // Tarjetas que se voltean
  document.querySelectorAll(".flip").forEach((f) => f.addEventListener("click", () => f.classList.toggle("volteada")));

  animarNota(ev.nota);
  if (ev.nota >= 8) confeti();
}

function animarNota(nota) {
  const duracion = 1200, inicio = performance.now();
  const paso = (ahora) => {
    const avance = Math.min(1, (ahora - inicio) / duracion);
    const suave = 1 - Math.pow(1 - avance, 3);
    $("numero-nota").textContent = Math.round(nota * suave);
    $("circulo-nota").style.setProperty("--p", nota * 10 * suave);
    if (avance < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

function confeti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const lienzo = document.createElement("canvas");
  lienzo.className = "confeti";
  document.body.appendChild(lienzo);
  const ctx = lienzo.getContext("2d");
  lienzo.width = innerWidth; lienzo.height = innerHeight;
  const colores = ["#22C55E", "#3B82F6", "#FACC15", "#F472B6", "#38BDF8"];
  const piezas = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight * 0.3,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    giro: Math.random() * 6, color: colores[Math.floor(Math.random() * colores.length)],
  }));
  const inicio = performance.now();
  const cuadro = (ahora) => {
    ctx.clearRect(0, 0, lienzo.width, lienzo.height);
    for (const p of piezas) {
      p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.giro += 0.2;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.giro);
      ctx.fillStyle = p.color; ctx.fillRect(-4, -2, 8, 4); ctx.restore();
    }
    if (ahora - inicio < 2500) requestAnimationFrame(cuadro); else lienzo.remove();
  };
  requestAnimationFrame(cuadro);
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
