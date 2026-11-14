// Tutor de inglés por voz — lógica del navegador.
// Flujo de una llamada: pedir clave temporal al servidor → conectar con OpenAI por WebRTC →
// transcripción en vivo y misiones → al colgar, evaluación y práctica de las correcciones.
// El historial y el vocabulario se guardan en este navegador (localStorage).

// Precios de gpt-realtime-2.1-mini (US$ por millón de tokens), solo para estimar el costo
const PRECIOS = {
  audioEntrada: 10, audioEntradaCache: 0.3, audioSalida: 20,
  textoEntrada: 0.6, textoEntradaCache: 0.06, textoSalida: 2.4,
};
const DIAS_REPASO = [0, 1, 3, 7, 14, 30]; // días hasta el próximo repaso según la "caja" (1 a 5)

const estado = {
  config: null,
  escenario: null,       // clave de un escenario predefinido, o "personalizado"
  personalizado: null,   // escenario creado por el estudiante
  nivel: "intermedio",
  pc: null, canal: null, microfono: null,
  silenciado: false,
  inicio: null, intervalo: null,
  costo: 0,
  turnos: [],            // [{id, rol: "usuario"|"tutor", texto}]
  misiones: [],          // [true/false] por cada objetivo
  revisando: null,       // promesa de la revisión de misiones en curso
  revisarDeNuevo: false,
  terminado: false,
  hablando: null,
  audioCtx: null, analizadorMic: null, analizadorTutor: null,
  animacion: null, nivelSuave: 0,
  grabacion: null,       // grabación en curso al practicar una frase
};

const $ = (id) => document.getElementById(id);
const icono = (nombre) => `<svg class="ico" aria-hidden="true"><use href="#i-${nombre}"/></svg>`;

function escapar(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML.replace(/"/g, "&quot;");
}

function formatoTiempo(segundos) {
  const s = Math.max(0, Math.floor(segundos));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function pedirJSON(url, opciones = {}) {
  const respuesta = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opciones });
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    throw new Error(typeof datos.detail === "string" ? datos.detail : "Error inesperado del servidor.");
  }
  return datos;
}

const enviar = (url, cuerpo) => pedirJSON(url, { method: "POST", body: JSON.stringify(cuerpo) });

// Guardado en el navegador (puede fallar en modo privado: entonces no se guarda y ya)
const almacen = {
  leer(clave, defecto) {
    try { return JSON.parse(localStorage.getItem(clave)) ?? defecto; } catch { return defecto; }
  },
  guardar(clave, valor) {
    try { localStorage.setItem(clave, JSON.stringify(valor)); } catch {}
  },
};

// ---------- Avatares: foto real del personaje, con su inicial si la foto no carga ----------
function contenidoAvatar(esc) {
  const inicial = escapar((esc?.personaje || "?")[0]);
  const plantilla = estado.config?.url_fotos;
  if (!esc?.foto || !plantilla) return inicial;
  const url = plantilla.replace("{foto}", encodeURIComponent(esc.foto));
  return `${inicial}<img src="${escapar(url)}" alt="" loading="lazy" onerror="this.remove()">`;
}
const avatar = (esc, clase = "avatar-contacto") =>
  `<span class="${clase}" style="--color-personaje:${escapar(esc?.color || "#15803D")}">${contenidoAvatar(esc)}</span>`;

// ---------- Escenario actual ----------
function escenarioActual() {
  if (estado.escenario === "personalizado") return estado.personalizado;
  return estado.config?.escenarios[estado.escenario] || null;
}
const personajeActual = () => escenarioActual()?.personaje || "Tu tutor";

// Lo que se envía al servidor para identificar el escenario
function cuerpoEscenario() {
  return estado.escenario === "personalizado"
    ? { personalizado: estado.personalizado, nivel: estado.nivel }
    : { escenario: estado.escenario, nivel: estado.nivel };
}

// ---------- Navegación y utilidades de interfaz ----------
function mostrarPantalla(nombre) {
  document.querySelectorAll(".pantalla").forEach((p) => p.classList.remove("activa"));
  $(`pantalla-${nombre}`).classList.add("activa");
  document.querySelectorAll(".enlace-nav").forEach((b) => {
    if (b.dataset.ir === nombre) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  document.body.classList.toggle("en-llamada", nombre === "conversacion");
  window.scrollTo(0, 0);
}

function irA(nombre) {
  detenerGrabacion();
  window.speechSynthesis?.cancel();
  if (nombre === "progreso") pintarProgreso();
  if (nombre === "vocabulario") pintarVocabulario();
  if (nombre === "inicio") actualizarBotonLlamar();
  mostrarPantalla(nombre);
}

function mostrarError(id, mensaje) {
  const caja = $(id);
  caja.textContent = mensaje;
  caja.classList.remove("oculto");
}
function ocultar(id) { $(id).classList.add("oculto"); }

function cambiarEstado(clase, texto) {
  $("estado").className = `estado ${clase}`;
  $("texto-estado").textContent = texto;
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
      ${avatar(e)}
      <span>
        <span class="quien-es"><span class="nombre-contacto">${escapar(e.personaje)}</span><span class="rol">${escapar(e.papel)}</span></span>
        <span class="escenario"><b>${escapar(e.titulo)}.</b> <span class="detalle">${escapar(e.descripcion)}</span></span>
      </span>
      <span class="seleccion">${icono("check")}</span>
    </button>`).join("") + `
    <button class="contacto contacto-nuevo" role="radio" aria-checked="false" data-escenario="personalizado">
      <span class="avatar-contacto avatar-nuevo">${icono("plus")}</span>
      <span>
        <span class="quien-es"><span class="nombre-contacto">Crear mi propia situación</span></span>
        <span class="escenario"><span class="detalle">Describe lo que quieres practicar y creamos un personaje para ti.</span></span>
      </span>
      <span class="seleccion">${icono("check")}</span>
    </button>`;

  $("niveles").innerHTML = Object.entries(niveles).map(([clave, n]) => `
    <button class="segmento" role="radio" aria-checked="${clave === estado.nivel}" data-nivel="${clave}">${escapar(n.titulo)}</button>`).join("");
  $("descripcion-nivel").textContent = niveles[estado.nivel].descripcion + ".";
  $("nota-limite").textContent = `Cada llamada dura máximo ${Math.round(max_minutos)} minutos.`;

  document.querySelectorAll(".contacto").forEach((b) => b.addEventListener("click", () => elegirEscenario(b.dataset.escenario)));
  document.querySelectorAll(".segmento").forEach((b) => b.addEventListener("click", () => elegirNivel(b.dataset.nivel)));
  actualizarBotonLlamar();
}

function elegirNivel(nivel) {
  estado.nivel = nivel;
  document.querySelectorAll(".segmento").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.nivel === nivel)));
  $("descripcion-nivel").textContent = estado.config.niveles[nivel].descripcion + ".";
}

function elegirEscenario(clave) {
  estado.escenario = clave;
  document.querySelectorAll(".contacto").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.escenario === clave)));
  const esPersonalizado = clave === "personalizado";
  $("panel-personalizado").classList.toggle("oculto", !esPersonalizado);
  if (esPersonalizado && !estado.personalizado) $("descripcion-personalizada").focus();
  actualizarBotonLlamar();
}

function actualizarBotonLlamar() {
  const esc = escenarioActual();
  const boton = $("btn-empezar");
  boton.disabled = !esc;
  boton.innerHTML = esc
    ? `${icono("phone")}<span>Llamar a ${escapar(esc.personaje)}</span>`
    : `${icono("phone")}<span>${estado.escenario === "personalizado" ? "Primero crea tu personaje" : "Elige con quién practicar"}</span>`;
}

// ---------- Escenario personalizado ----------
async function crearPersonaje() {
  const descripcion = $("descripcion-personalizada").value.trim();
  if (descripcion.length < 5) return;
  const boton = $("btn-crear-personaje");
  const rotulo = boton.querySelector("span") || boton;
  boton.disabled = true;
  rotulo.textContent = "Creando personaje…";
  ocultar("error-inicio");
  try {
    estado.personalizado = await enviar("/api/escenario-personalizado", { descripcion, nivel: estado.nivel });
    pintarVistaPersonaje();
  } catch (e) {
    mostrarError("error-inicio", e.message);
  } finally {
    boton.disabled = false;
    rotulo.textContent = estado.personalizado ? "Crear otro personaje" : "Crear personaje";
    actualizarBotonLlamar();
  }
}

function pintarVistaPersonaje() {
  const p = estado.personalizado;
  $("vista-personaje").innerHTML = `
    <div class="personaje">
      ${avatar(p)}
      <div>
        <div class="quien-es"><span class="nombre-contacto">${escapar(p.personaje)}</span><span class="rol">${escapar(p.papel)}</span></div>
        <div class="escenario"><b>${escapar(p.titulo)}.</b> <span class="detalle">${escapar(p.descripcion)}</span></div>
      </div>
    </div>
    <p class="etiqueta-campo">Tus misiones en esta llamada</p>
    <ul class="misiones-previas">${p.objetivos.map((o) => `<li>${icono("flag")}<span>${escapar(o)}</span></li>`).join("")}</ul>`;
  $("vista-personaje").classList.remove("oculto");
}

// ---------- Llamada ----------
async function empezar() {
  const esc = escenarioActual();
  if (!esc) return;
  detenerGrabacion();
  window.speechSynthesis?.cancel();
  ocultar("error-inicio");
  $("btn-empezar").disabled = true;
  Object.assign(estado, {
    turnos: [], costo: 0, terminado: false, silenciado: false, hablando: null,
    misiones: (esc.objetivos || []).map(() => false), revisando: null, revisarDeNuevo: false,
  });
  $("transcripcion").innerHTML = `<p class="vacio" id="transcripcion-vacia">Aquí aparece todo lo que se dice en la llamada.</p>`;
  $("costo").textContent = "US$0.000";
  $("cronometro").textContent = "0:00";
  $("sub-tutor").textContent = "";
  $("sub-usuario").textContent = "";
  $("anillo-progreso").style.strokeDashoffset = 0;
  $("anillo-progreso").classList.remove("poco");
  pintarSilencio();
  pintarMisiones();
  ["panel-pista", "error-conversacion", "aviso-tiempo"].forEach(ocultar);

  try {
    try {
      estado.microfono = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      throw new Error(e.name === "NotAllowedError"
        ? "No diste permiso para usar el micrófono. Haz clic en el candado de la barra de direcciones, permite el micrófono y vuelve a intentarlo."
        : `No se pudo acceder al micrófono: ${e.message}`);
    }

    const sesion = await enviar("/api/sesion", cuerpoEscenario());

    $("avatar").innerHTML = contenidoAvatar(esc);
    $("avatar").style.setProperty("--color-personaje", esc.color);
    $("nombre-personaje").textContent = esc.personaje;
    $("titulo-conversacion").textContent = `${esc.papel}, nivel ${estado.config.niveles[estado.nivel].titulo.toLowerCase()}`;
    $("rotulo-tiempo").textContent = `de ${formatoTiempo(sesion.max_minutos * 60)}`;
    mostrarPantalla("conversacion");
    cambiarEstado("", `Conectando con ${esc.personaje}…`);

    iniciarOrbe();
    await conectar(sesion.clave);
    iniciarCronometro(sesion.max_minutos);
  } catch (e) {
    detenerTodo();
    mostrarPantalla("inicio");
    mostrarError("error-inicio", e.message);
    actualizarBotonLlamar();
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
    canal.send(JSON.stringify({ type: "response.create" })); // el personaje saluda primero
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
      if (t.texto) revisarMisiones();
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

function turnosParaEnviar(cantidad) {
  return estado.turnos
    .filter((t) => t.texto && t.texto !== "(no se pudo transcribir)")
    .slice(-cantidad)
    .map((t) => ({ rol: t.rol, texto: t.texto.slice(0, 2000) }));
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

// ---------- Misiones ----------
function pintarMisiones() {
  const objetivos = escenarioActual()?.objetivos || [];
  $("panel-misiones").classList.toggle("oculto", !objetivos.length);
  $("lista-misiones").innerHTML = objetivos.map((o, i) => `
    <li class="mision ${estado.misiones[i] ? "cumplida" : ""}" id="mision-${i}">
      <span class="marca-mision">${icono("check")}</span><span>${escapar(o)}</span>
    </li>`).join("");
  const hechas = estado.misiones.filter(Boolean).length;
  $("cuenta-misiones").textContent = objetivos.length ? `${hechas} de ${objetivos.length}` : "";
}

// Revisa en segundo plano qué misiones ya cumplió el estudiante (una revisión a la vez)
function revisarMisiones() {
  if (estado.revisando) { estado.revisarDeNuevo = true; return estado.revisando; }
  const pendientes = estado.misiones.map((hecha, i) => (hecha ? null : i)).filter((i) => i !== null);
  if (!pendientes.length) return Promise.resolve();
  const misiones = estado.misiones; // si empieza otra llamada, esta respuesta ya no aplica
  estado.revisando = enviar("/api/misiones", { ...cuerpoEscenario(), pendientes, turnos: turnosParaEnviar(14) })
    .then(({ cumplidas }) => {
      if (misiones !== estado.misiones) return;
      const nuevas = (cumplidas || []).filter((i) => misiones[i] === false);
      nuevas.forEach((i) => { misiones[i] = true; });
      if (nuevas.length) {
        pintarMisiones();
        nuevas.forEach((i) => {
          const item = $(`mision-${i}`);
          item?.classList.add("recien");
          confeti(item?.querySelector(".marca-mision"));
        });
        sonar("mision");
        sumarXP(nuevas.length * XP.mision, nuevas.length === 1 ? "Misión cumplida" : `${nuevas.length} misiones cumplidas`);
      }
    })
    .catch((e) => console.warn("No se pudieron revisar las misiones:", e.message))
    .finally(() => {
      if (misiones !== estado.misiones) return;
      estado.revisando = null;
      if (estado.revisarDeNuevo && !estado.terminado) { estado.revisarDeNuevo = false; revisarMisiones(); }
    });
  return estado.revisando;
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
  const segundos = estado.inicio ? (Date.now() - estado.inicio) / 1000 : 0;
  estado.inicio = null;
  detenerTodo();

  mostrarPantalla("evaluacion");
  $("cargando-evaluacion").classList.remove("oculto");
  ["evaluacion", "error-evaluacion", "acciones-final"].forEach(ocultar);

  try {
    // Última revisión de misiones antes de evaluar (si tarda o falla, seguimos sin ella)
    const espera = new Promise((r) => setTimeout(r, 6000));
    await Promise.race([Promise.resolve(estado.revisando).then(() => revisarMisiones()), espera]);
    const evaluacion = await enviar("/api/evaluar", { ...cuerpoEscenario(), turnos: turnosParaEnviar(200) });
    guardarPractica(evaluacion, segundos);
    const premio = registrarLlamadaEnJuego(evaluacion);
    mostrarEvaluacion(evaluacion, segundos, premio);
    celebrarPremio(premio);
  } catch (e) {
    mostrarError("error-evaluacion", e.message);
  } finally {
    ocultar("cargando-evaluacion");
    $("texto-repetir").textContent = `Repetir con ${personajeActual()}`;
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

// ---------- Pistas ----------
async function pedirPista() {
  const panel = $("panel-pista");
  const turnos = turnosParaEnviar(6);
  panel.classList.remove("oculto");
  if (!turnos.some((t) => t.rol === "tutor")) {
    panel.innerHTML = `<p class="vacio">Espera a que ${escapar(personajeActual())} diga algo y vuelve a pedir la pista.</p>`;
    return;
  }
  $("btn-pista").disabled = true;
  panel.innerHTML = `<p class="vacio">Preparando tu pista…</p>`;
  try {
    const pista = await enviar("/api/pista", { ...cuerpoEscenario(), turnos });
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

// ---------- Practicar frases: escuchar y repetir ----------
function bloquePractica(frase) {
  return `
    <div class="practicar" data-frase="${escapar(frase)}">
      <div class="botones-practica">
        <button class="mini" data-accion="escuchar">${icono("volume")}<span>Escuchar</span></button>
        <button class="mini" data-accion="repetir">${icono("mic")}<span>Repetir</span></button>
      </div>
      <div class="resultado-frase" aria-live="polite"></div>
    </div>`;
}

function escucharEnIngles(texto) {
  const voz = window.speechSynthesis;
  if (!voz) return;
  voz.cancel();
  const frase = new SpeechSynthesisUtterance(texto);
  const voces = voz.getVoices();
  const ingles = voces.find((v) => /^en[-_]US/i.test(v.lang)) || voces.find((v) => /^en/i.test(v.lang));
  if (ingles) frase.voice = ingles;
  frase.lang = ingles?.lang || "en-US";
  frase.rate = 0.92;
  voz.speak(frase);
}

function activarPractica(contenedor) {
  contenedor.querySelectorAll(".practicar").forEach((bloque) => {
    const frase = bloque.dataset.frase;
    bloque.querySelector('[data-accion="escuchar"]').addEventListener("click", () => escucharEnIngles(frase));
    bloque.querySelector('[data-accion="repetir"]').addEventListener("click", () => alternarGrabacion(bloque, frase));
  });
}

function detenerGrabacion() {
  const g = estado.grabacion;
  if (g && g.grabador.state === "recording") { g.descartar = true; g.grabador.stop(); }
}

async function alternarGrabacion(bloque, frase) {
  const boton = bloque.querySelector('[data-accion="repetir"]');
  const resultado = bloque.querySelector(".resultado-frase");

  // Si esta frase ya se está grabando, detener y revisar
  if (estado.grabacion?.bloque === bloque) { estado.grabacion.grabador.stop(); return; }
  detenerGrabacion(); // solo una grabación a la vez
  window.speechSynthesis?.cancel();

  if (!window.MediaRecorder) {
    resultado.innerHTML = `<p class="vacio">Este navegador no permite grabar. Prueba con Chrome o Edge.</p>`;
    return;
  }
  let microfono;
  try {
    microfono = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    resultado.innerHTML = `<p class="vacio">Permite el micrófono para practicar la frase.</p>`;
    return;
  }
  const tipo = ["audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
  const grabador = new MediaRecorder(microfono, tipo ? { mimeType: tipo } : undefined);
  const partes = [];
  const grabacion = { bloque, grabador, descartar: false, limite: null };
  grabador.ondataavailable = (e) => { if (e.data.size) partes.push(e.data); };
  grabador.onstop = async () => {
    clearTimeout(grabacion.limite);
    microfono.getTracks().forEach((t) => t.stop());
    if (estado.grabacion === grabacion) estado.grabacion = null;
    boton.classList.remove("grabando");
    boton.innerHTML = `${icono("mic")}<span>Repetir</span>`;
    if (grabacion.descartar) { resultado.innerHTML = ""; return; }
    const blob = new Blob(partes, { type: grabador.mimeType || tipo || "audio/webm" });
    resultado.innerHTML = `<p class="vacio">Revisando lo que dijiste…</p>`;
    try {
      pintarResultadoFrase(resultado, await verificarFrase(frase, blob));
    } catch (e) {
      resultado.innerHTML = `<p class="vacio">${escapar(e.message)}</p>`;
    }
  };

  grabador.start();
  grabacion.limite = setTimeout(() => { if (grabador.state === "recording") grabador.stop(); }, 10000);
  estado.grabacion = grabacion;
  boton.classList.add("grabando");
  boton.innerHTML = `${icono("mic")}<span>Detener</span>`;
  resultado.innerHTML = `<p class="vacio">Grabando. Di la frase y toca Detener.</p>`;
}

async function verificarFrase(frase, blob) {
  const base64 = await new Promise((resolver, rechazar) => {
    const lector = new FileReader();
    lector.onload = () => resolver(String(lector.result).split(",")[1] || "");
    lector.onerror = () => rechazar(new Error("No se pudo leer la grabación."));
    lector.readAsDataURL(blob);
  });
  const formato = (blob.type.match(/audio\/(webm|mp4|ogg|wav|mpeg)/) || [null, "webm"])[1];
  return enviar("/api/verificar-frase", { frase, audio_base64: base64, formato });
}

function pintarResultadoFrase(caja, datos) {
  const bloque = caja.closest(".practicar");
  if (datos.correcto && bloque && !bloque.dataset.premiada) {
    bloque.dataset.premiada = "1";
    sonar("frase");
    confeti(bloque.querySelector('[data-accion="repetir"]'), 16);
    sumarXP(XP.frase, "Frase bien dicha");
    const medalla = ganarMedalla("buena-pronunciacion");
    if (medalla) setTimeout(() => mostrarAvisoXP("Medalla nueva", medalla.nombre), 2300);
  }
  const palabras = datos.palabras.map((p) => `<span class="${p.ok ? "" : "falta"}">${escapar(p.palabra)}</span>`).join(" ");
  const escuchado = datos.transcripcion ? `Escuchamos: «${escapar(datos.transcripcion)}»` : "No escuchamos ninguna palabra";
  caja.innerHTML = datos.correcto
    ? `<p class="bien">${icono("check")}<span>Bien dicho. ${escuchado}</span></p>`
    : `<p class="casi">Casi. Repasa las palabras marcadas:</p>
       <p class="palabras-frase">${palabras}</p>
       <p class="vacio">${escuchado}. Toca Escuchar y vuelve a intentarlo.</p>`;
}

// ---------- Evaluación ----------
function mostrarEvaluacion(ev, segundos, premio = null) {
  const titulo = ev.nota >= 9 ? "Excelente trabajo." : ev.nota >= 7 ? "Muy bien." : ev.nota >= 5 ? "Vas por buen camino." : "Sigue practicando.";
  const respuestas = estado.turnos.filter((t) => t.rol === "usuario" && t.texto).length;
  const errores = ev.errores || [], frases = ev.mejores_frases || [], vocab = ev.vocabulario || [];
  const totalMisiones = estado.misiones.length, hechas = estado.misiones.filter(Boolean).length;
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

    ${premio ? bloqueJuego(premio) : ""}

    <dl class="estadisticas">
      <div><dt>Duración</dt><dd>${formatoTiempo(segundos)}</dd></div>
      <div><dt>Respuestas</dt><dd>${respuestas}</dd></div>
      ${totalMisiones ? `<div><dt>Misiones</dt><dd>${hechas} de ${totalMisiones}</dd></div>` : ""}
      <div><dt>Correcciones</dt><dd>${errores.length}</dd></div>
      <div><dt>Costo</dt><dd>US$${estado.costo.toFixed(3)}</dd></div>
    </dl>

    <div class="pestanas" role="tablist">
      ${pestana("p-errores", "Correcciones", errores.length, true)}
      ${pestana("p-frases", "Frases más naturales", frases.length, false)}
      ${pestana("p-vocab", "Vocabulario", vocab.length, false)}
      ${totalMisiones ? pestana("p-misiones", "Misiones", `${hechas}/${totalMisiones}`, false) : ""}
      ${pestana("p-consejos", "Consejos", null, false)}
    </div>

    <div id="p-errores" class="panel-eval activo" role="tabpanel">
      ${errores.length ? `
        <p class="ayuda-vocab">Escucha cada frase corregida y repítela en voz alta para fijarla.</p>
        <div class="lista-correcciones">${errores.map((e) => `
          <div class="correccion">
            <div class="linea-correccion antes">${icono("close")}<span>${escapar(e.original)}</span></div>
            <div class="linea-correccion despues">${icono("check")}<span>${escapar(e.correccion)}</span></div>
            <p class="explicacion">${escapar(e.explicacion)}</p>
            ${bloquePractica(e.correccion)}
          </div>`).join("")}</div>` : `<p class="vacio">No encontramos errores importantes en esta llamada.</p>`}
    </div>

    <div id="p-frases" class="panel-eval" role="tabpanel">
      ${frases.length ? `<div class="lista-correcciones">${frases.map((f) => `
        <div class="correccion">
          <p class="dijiste">Dijiste: ${escapar(f.original)}</p>
          <div class="linea-correccion despues">${icono("check")}<span>${escapar(f.mejor)}</span></div>
          ${f.explicacion ? `<p class="explicacion">${escapar(f.explicacion)}</p>` : ""}
          ${bloquePractica(f.mejor)}
        </div>`).join("")}</div>` : `<p class="vacio">Tus frases sonaron naturales.</p>`}
    </div>

    <div id="p-vocab" class="panel-eval" role="tabpanel">
      ${vocab.length ? `
        <p class="ayuda-vocab">Toca una tarjeta para ver su significado. Estas palabras quedan guardadas en Mi vocabulario.</p>
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

    ${totalMisiones ? `
    <div id="p-misiones" class="panel-eval" role="tabpanel">
      <ul class="lista-misiones resumen-misiones">${escenarioActual().objetivos.map((o, i) => `
        <li class="mision ${estado.misiones[i] ? "cumplida" : ""}">
          <span class="marca-mision">${icono("check")}</span><span>${escapar(o)}</span>
        </li>`).join("")}</ul>
      ${hechas < totalMisiones ? `<p class="vacio">En la próxima llamada intenta las misiones que faltaron.</p>` : ""}
    </div>` : ""}

    <div id="p-consejos" class="panel-eval" role="tabpanel">
      <ul class="consejos">${(ev.consejos || []).map((c) => `<li>${icono("check")}<span>${escapar(c)}</span></li>`).join("")}</ul>
    </div>`;
  $("evaluacion").classList.remove("oculto");

  document.querySelectorAll("#evaluacion .pestana").forEach((p) => p.addEventListener("click", () => {
    document.querySelectorAll("#evaluacion .pestana").forEach((x) => x.setAttribute("aria-selected", String(x === p)));
    document.querySelectorAll("#evaluacion .panel-eval").forEach((x) => x.classList.toggle("activo", x.id === p.getAttribute("aria-controls")));
  }));
  document.querySelectorAll("#evaluacion .flip").forEach((f) => f.addEventListener("click", () => f.classList.toggle("volteada")));
  activarPractica($("evaluacion"));
  animarNota(ev.nota);
}

function animarNota(nota) {
  const pocoMovimiento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duracion = pocoMovimiento ? 0 : 1100, inicio = performance.now();
  const paso = (ahora) => {
    const avance = duracion ? Math.min(1, (ahora - inicio) / duracion) : 1;
    const suave = 1 - Math.pow(1 - avance, 3);
    if (!$("numero-nota")) return;
    $("numero-nota").textContent = Math.round(nota * suave);
    $("circulo-nota").style.setProperty("--p", nota * 10 * suave);
    if (avance < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

// ---------- Guardar la práctica (historial y vocabulario) ----------
// Fechas en hora local, como "2026-11-11"
function diaLocal(fecha = new Date()) {
  const d = new Date(fecha);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const hoy = () => diaLocal();
function sumarDias(dia, dias) {
  const d = new Date(`${dia}T12:00:00`);
  d.setDate(d.getDate() + dias);
  return diaLocal(d);
}

function guardarPractica(ev, segundos) {
  const esc = escenarioActual();
  const historial = almacen.leer("tutor.historial", []);
  historial.push({
    fecha: new Date().toISOString(),
    escenario: estado.escenario,
    personalizado: estado.escenario === "personalizado" ? estado.personalizado : null,
    titulo: esc.titulo, personaje: esc.personaje, color: esc.color, foto: esc.foto || "",
    nivel: estado.nivel, nota: ev.nota, segundos: Math.round(segundos),
    respuestas: estado.turnos.filter((t) => t.rol === "usuario" && t.texto).length,
    misiones: [estado.misiones.filter(Boolean).length, estado.misiones.length],
    errores: (ev.errores || []).map((e) => ({ original: e.original, correccion: e.correccion })),
    costo: Number(estado.costo.toFixed(4)),
  });
  almacen.guardar("tutor.historial", historial.slice(-200));

  const vocabulario = almacen.leer("tutor.vocabulario", []);
  for (const v of ev.vocabulario || []) {
    if (!v.palabra || vocabulario.some((x) => x.palabra.toLowerCase() === v.palabra.toLowerCase())) continue;
    vocabulario.push({
      palabra: v.palabra, significado: v.significado, ejemplo: v.ejemplo,
      origen: esc.titulo, agregada: hoy(), caja: 1, proximo: hoy(),
    });
  }
  almacen.guardar("tutor.vocabulario", vocabulario);
}


// ---------- Juego: puntos (XP), niveles, racha y medallas ----------
// Todo se guarda en este navegador, igual que el historial.
const XP = { llamada: 20, mision: 10, porPuntoDeNota: 3, frase: 5, palabra: 2 };
const NIVELES_JUEGO = [
  [0, "Principiante"], [100, "Explorador"], [250, "Viajero"], [450, "Conversador"],
  [700, "Seguro"], [1000, "Fluido"], [1400, "Bilingüe"],
];
const MEDALLAS = [
  { id: "primera-llamada", nombre: "Primera llamada", como: "Termina tu primera llamada", icono: "phone", color: "verde" },
  { id: "mision-cumplida", nombre: "Misión cumplida", como: "Cumple todas las misiones de una llamada", icono: "flag", color: "azul" },
  { id: "sobresaliente", nombre: "Sobresaliente", como: "Saca 9 o más en una llamada", icono: "star", color: "ambar" },
  { id: "en-racha", nombre: "En racha", como: "Practica 3 días seguidos", icono: "flame", color: "ambar" },
  { id: "imparable", nombre: "Imparable", como: "Practica 7 días seguidos", icono: "flame", color: "rojo" },
  { id: "conversador", nombre: "Conversador", como: "Completa 10 llamadas", icono: "chat", color: "azul" },
  { id: "buena-pronunciacion", nombre: "Buena pronunciación", como: "Repite bien una frase corregida", icono: "mic", color: "verde" },
  { id: "sociable", nombre: "Sociable", como: "Habla con Sarah, Mike y Emma", icono: "users", color: "morado" },
  { id: "creativo", nombre: "Creativo", como: "Practica una situación creada por ti", icono: "sparkle", color: "morado" },
  { id: "coleccionista", nombre: "Coleccionista", como: "Guarda 20 palabras en tu vocabulario", icono: "cards", color: "verde" },
];

function leerJuego() {
  let juego = almacen.leer("tutor.juego", null);
  if (!juego) {
    // Si ya tenías llamadas de antes, te damos los puntos que habrías ganado
    const historial = almacen.leer("tutor.historial", []);
    juego = { xp: 0, medallas: {} };
    for (const h of historial) juego.xp += XP.llamada + (h.misiones?.[0] || 0) * XP.mision + Math.round(h.nota) * XP.porPuntoDeNota;
    almacen.guardar("tutor.juego", juego);
  }
  return juego;
}

function nivelDe(xp) {
  let n = 0;
  while (n + 1 < NIVELES_JUEGO.length && xp >= NIVELES_JUEGO[n + 1][0]) n++;
  // Después de Bilingüe, un nivel nuevo cada 500 XP
  const extra = n === NIVELES_JUEGO.length - 1 ? Math.floor((xp - NIVELES_JUEGO[n][0]) / 500) : 0;
  const numero = n + 1 + extra;
  const desde = NIVELES_JUEGO[n][0] + extra * 500;
  const hasta = n + 1 < NIVELES_JUEGO.length ? NIVELES_JUEGO[n + 1][0] : desde + 500;
  const siguiente = n + 1 < NIVELES_JUEGO.length ? NIVELES_JUEGO[n + 1][1] : "Bilingüe";
  return { numero, nombre: NIVELES_JUEGO[n][1], desde, hasta, siguiente, avance: (xp - desde) / (hasta - desde) };
}

// Suma XP y devuelve si subiste de nivel
function sumarXP(cantidad, motivo) {
  const juego = leerJuego();
  const antes = nivelDe(juego.xp).numero;
  juego.xp += cantidad;
  almacen.guardar("tutor.juego", juego);
  const subio = nivelDe(juego.xp).numero > antes;
  pintarMarcadores();
  if (motivo) mostrarAvisoXP(`+${cantidad} XP`, motivo);
  return subio;
}

function ganarMedalla(id) {
  const juego = leerJuego();
  if (juego.medallas[id]) return null;
  juego.medallas[id] = new Date().toISOString();
  almacen.guardar("tutor.juego", juego);
  return MEDALLAS.find((m) => m.id === id);
}

function pintarMarcadores() {
  const juego = leerJuego();
  $("valor-xp").textContent = juego.xp;
  $("valor-racha").textContent = rachaDeDias(almacen.leer("tutor.historial", []));
  pintarTarjetaNivel();
}

function barraNivel(xp, id = "") {
  const n = nivelDe(xp);
  return `
    <div class="barra-nivel" ${id ? `id="${id}"` : ""} role="progressbar" aria-valuemin="${n.desde}" aria-valuemax="${n.hasta}" aria-valuenow="${xp}"
      aria-label="Avance al nivel ${n.numero + 1}">
      <span style="width:${Math.round(Math.min(1, n.avance) * 100)}%"></span>
    </div>
    <p class="falta-nivel">${n.hasta - xp} XP para el nivel ${n.numero + 1}${n.siguiente !== n.nombre ? `: ${n.siguiente}` : ""}</p>`;
}

function pintarTarjetaNivel() {
  const caja = $("tarjeta-nivel");
  if (!caja) return;
  const juego = leerJuego();
  const n = nivelDe(juego.xp);
  const historial = almacen.leer("tutor.historial", []);
  const medallas = Object.keys(juego.medallas).length;
  $("ventajas").classList.toggle("oculto", historial.length > 0);
  caja.innerHTML = `
    <div class="cabeza-nivel">
      <span class="insignia-nivel" aria-hidden="true">${n.numero}</span>
      <div>
        <div class="nombre-nivel">Nivel ${n.numero}: ${n.nombre}</div>
        <div class="detalle">${juego.xp} XP en total</div>
      </div>
    </div>
    ${barraNivel(juego.xp)}
    <div class="datos-nivel">
      <span>${icono("flame")}<b>${rachaDeDias(historial)}</b> ${rachaDeDias(historial) === 1 ? "día seguido" : "días seguidos"}</span>
      <span>${icono("medal")}<b>${medallas}</b> de ${MEDALLAS.length} medallas</span>
    </div>`;
}

// Mensaje flotante "+10 XP"
let temporizadorAviso = null;
function mostrarAvisoXP(titulo, detalle) {
  const aviso = $("aviso-xp");
  aviso.innerHTML = `${icono("bolt")}<b>${escapar(titulo)}</b><span>${escapar(detalle)}</span>`;
  aviso.classList.remove("visible");
  void aviso.offsetWidth; // reinicia la animación
  aviso.classList.add("visible");
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => aviso.classList.remove("visible"), 2200);
}

// Confeti hecho con elementos simples (sin librerías)
function confeti(origen, cantidad = 26) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = origen?.getBoundingClientRect?.() || { left: innerWidth / 2, top: innerHeight / 3, width: 0, height: 0 };
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const colores = ["#22C55E", "#2563EB", "#F59E0B", "#38BDF8", "#A855F7", "#F43F5E"];
  for (let i = 0; i < cantidad; i++) {
    const p = document.createElement("span");
    p.className = "confeti";
    p.style.left = `${x}px`; p.style.top = `${y}px`;
    p.style.background = colores[i % colores.length];
    document.body.appendChild(p);
    const ang = Math.random() * Math.PI * 2, dist = 60 + Math.random() * 120;
    p.animate([
      { transform: "translate(-50%, -50%) rotate(0deg)", opacity: 1 },
      { transform: `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist - 40}px) rotate(${Math.random() * 540}deg)`, opacity: 1, offset: 0.7 },
      { transform: `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist + 60}px) rotate(${Math.random() * 720}deg)`, opacity: 0 },
    ], { duration: 900 + Math.random() * 500, easing: "cubic-bezier(.2,.8,.3,1)" }).onfinish = () => p.remove();
  }
}

// Sonidos cortos generados en el navegador (sin archivos)
let contextoSonido = null;
const sonidosActivos = () => almacen.leer("tutor.sonidos", true);
function sonar(tipo) {
  if (!sonidosActivos()) return;
  try {
    contextoSonido = contextoSonido || new AudioContext();
    const notas = { mision: [784, 1047], nivel: [523, 659, 784, 1047], frase: [659, 880] }[tipo] || [880];
    notas.forEach((f, i) => {
      const t = contextoSonido.currentTime + i * 0.11;
      const osc = contextoSonido.createOscillator(), gan = contextoSonido.createGain();
      osc.type = "triangle"; osc.frequency.value = f;
      gan.gain.setValueAtTime(0.0001, t);
      gan.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gan.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gan).connect(contextoSonido.destination);
      osc.start(t); osc.stop(t + 0.3);
    });
  } catch {}
}
function pintarBotonSonido() {
  const activo = sonidosActivos();
  $("btn-sonido").setAttribute("aria-pressed", String(activo));
  $("btn-sonido").innerHTML = icono(activo ? "volume" : "volume-off");
  $("btn-sonido").title = activo ? "Sonidos activados" : "Sonidos desactivados";
}

// Al terminar una llamada: XP de la llamada, medallas nuevas y subida de nivel
function registrarLlamadaEnJuego(ev) {
  const xpAntes = leerJuego().xp;
  const hechas = estado.misiones.filter(Boolean).length;
  const desglose = [
    ["Llamada terminada", XP.llamada],
    ["Tu nota", Math.round(ev.nota) * XP.porPuntoDeNota],
  ];
  const nuevas = desglose.reduce((s, [, v]) => s + v, 0);
  sumarXP(nuevas);
  if (hechas) desglose.splice(1, 0, [`${hechas} ${hechas === 1 ? "misión" : "misiones"}`, hechas * XP.mision]);
  const total = desglose.reduce((s, [, v]) => s + v, 0);

  const historial = almacen.leer("tutor.historial", []);
  const medallas = [];
  const dar = (id) => { const m = ganarMedalla(id); if (m) medallas.push(m); };
  dar("primera-llamada");
  if (estado.misiones.length && hechas === estado.misiones.length) dar("mision-cumplida");
  if (ev.nota >= 9) dar("sobresaliente");
  if (rachaDeDias(historial) >= 3) dar("en-racha");
  if (rachaDeDias(historial) >= 7) dar("imparable");
  if (historial.length >= 10) dar("conversador");
  if (["entrevista", "restaurante", "hotel"].every((k) => historial.some((h) => h.escenario === k))) dar("sociable");
  if (estado.escenario === "personalizado") dar("creativo");
  if (almacen.leer("tutor.vocabulario", []).length >= 20) dar("coleccionista");

  const xpAhora = leerJuego().xp;
  // El XP de las misiones ya se sumó durante la llamada
  const xpInicioLlamada = xpAntes - hechas * XP.mision;
  pintarMarcadores();
  return { total, desglose, xpInicioLlamada, xpAhora, medallas,
    subio: nivelDe(xpAhora).numero > nivelDe(xpInicioLlamada).numero };
}

function bloqueJuego(r) {
  const n = nivelDe(r.xpAhora);
  return `
    <section class="premio" aria-label="Puntos ganados">
      <div class="cabeza-premio">
        <span class="xp-grande">${icono("bolt")}+${r.total} XP</span>
        <div class="desglose">${r.desglose.map(([t, v]) => `<span>${escapar(t)} <b>+${v}</b></span>`).join("")}</div>
      </div>
      ${r.subio ? `<p class="subiste">${icono("star")}<span>Subiste al nivel ${n.numero}: ${n.nombre}</span></p>` : `<p class="nivel-actual">Nivel ${n.numero}: ${n.nombre}</p>`}
      ${barraNivel(r.xpAhora, "barra-premio")}
      ${r.medallas.length ? `
        <div class="medallas-nuevas">
          ${r.medallas.map((m) => `
            <div class="medalla ganada color-${m.color}">
              <span class="disco">${icono(m.icono)}</span>
              <div><b>Medalla nueva: ${escapar(m.nombre)}</b><span>${escapar(m.como)}</span></div>
            </div>`).join("")}
        </div>` : ""}
    </section>`;
}

function celebrarPremio(r) {
  const barra = document.querySelector("#barra-premio span");
  if (barra) {
    // La barra arranca donde estabas antes de la llamada y avanza
    const final = barra.style.width;
    const nAntes = nivelDe(r.xpInicioLlamada), nAhora = nivelDe(r.xpAhora);
    barra.style.width = nAntes.numero === nAhora.numero ? `${Math.round(nAntes.avance * 100)}%` : "0%";
    requestAnimationFrame(() => requestAnimationFrame(() => { barra.style.width = final; }));
  }
  if (r.subio || r.medallas.length) {
    setTimeout(() => { confeti(document.querySelector(".premio"), 46); sonar(r.subio ? "nivel" : "mision"); }, 500);
  }
}

function pintarMedallas() {
  const juego = leerJuego();
  return `
    <h2 class="titulo-bloque">Medallas <span class="tenue">${Object.keys(juego.medallas).length} de ${MEDALLAS.length}</span></h2>
    <div class="vitrina">${MEDALLAS.map((m) => {
      const ganada = juego.medallas[m.id];
      return `
        <div class="medalla ${ganada ? "ganada" : "bloqueada"} color-${m.color}">
          <span class="disco">${icono(ganada ? m.icono : "lock")}</span>
          <div><b>${escapar(m.nombre)}</b><span>${escapar(m.como)}</span></div>
        </div>`;
    }).join("")}</div>`;
}

// ---------- Mi progreso ----------
function rachaDeDias(historial) {
  const dias = new Set(historial.map((h) => diaLocal(h.fecha)));
  let racha = 0, dia = hoy();
  if (!dias.has(dia)) dia = sumarDias(dia, -1); // si hoy no ha practicado, la racha sigue viva hasta mañana
  while (dias.has(dia)) { racha++; dia = sumarDias(dia, -1); }
  return racha;
}

const fechaCorta = (iso) => new Date(iso).toLocaleDateString("es", { day: "numeric", month: "short" });

function graficoNotas(historial) {
  const datos = historial.slice(-20);
  const movil = window.matchMedia("(max-width: 640px)").matches;
  const ancho = movil ? 360 : 640, alto = movil ? 220 : 220, m = { arriba: 16, derecha: 36, abajo: 30, izquierda: 30 };
  const ix = (i) => m.izquierda + (datos.length === 1 ? 0.5 : i / (datos.length - 1)) * (ancho - m.izquierda - m.derecha);
  const iy = (n) => m.arriba + (1 - n / 10) * (alto - m.arriba - m.abajo);
  const linea = datos.map((h, i) => `${i ? "L" : "M"}${ix(i).toFixed(1)},${iy(h.nota).toFixed(1)}`).join(" ");
  const ultimo = datos[datos.length - 1];
  return `
    <figure class="grafico">
      <figcaption>${datos.length === 1 ? "Tu nota en tu primera llamada" : `Tu nota en las últimas ${datos.length} llamadas`}</figcaption>
      <div class="lienzo-grafico">
        <svg viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="Notas de tus llamadas. La más reciente: ${ultimo.nota} de 10.">
          ${[0, 5, 10].map((n) => `
            <line x1="${m.izquierda}" x2="${ancho - m.derecha}" y1="${iy(n)}" y2="${iy(n)}" class="guia"/>
            <text x="${m.izquierda - 10}" y="${iy(n) + 4}" class="eje" text-anchor="end">${n}</text>`).join("")}
          ${datos.length > 1 ? `<path d="${linea}" class="linea-nota"/>` : ""}
          ${datos.map((h, i) => `
            <g class="punto-nota" tabindex="0" data-punto="${i}" data-x="${(ix(i) / ancho * 100).toFixed(2)}" data-y="${(iy(h.nota) / alto * 100).toFixed(2)}">
              <circle cx="${ix(i)}" cy="${iy(h.nota)}" r="13" class="objetivo"/>
              <circle cx="${ix(i)}" cy="${iy(h.nota)}" r="4.5" class="marca"/>
            </g>`).join("")}
          <text x="${ix(datos.length - 1) + 12}" y="${iy(ultimo.nota) + 5}" class="etiqueta-ultima">${ultimo.nota}</text>
          <text x="${ix(0)}" y="${alto - 6}" class="eje" text-anchor="${datos.length === 1 ? "middle" : "start"}">${fechaCorta(datos[0].fecha)}</text>
          ${datos.length > 1 ? `<text x="${ix(datos.length - 1)}" y="${alto - 6}" class="eje" text-anchor="end">${fechaCorta(ultimo.fecha)}</text>` : ""}
        </svg>
        <div class="globo-grafico oculto" role="status"></div>
      </div>
    </figure>`;
}

function activarGrafico(caja, historial) {
  const datos = historial.slice(-20);
  const globo = caja.querySelector(".globo-grafico");
  if (!globo) return;
  const mostrar = (g) => {
    const h = datos[Number(g.dataset.punto)];
    globo.innerHTML = `<b>${h.nota} de 10</b><span>${escapar(h.titulo)}, ${fechaCorta(h.fecha)}</span>`;
    globo.style.left = `${g.dataset.x}%`;
    globo.style.top = `${g.dataset.y}%`;
    globo.classList.toggle("a-la-derecha", Number(g.dataset.x) < 25);
    globo.classList.toggle("a-la-izquierda", Number(g.dataset.x) > 75);
    globo.classList.toggle("abajo", Number(g.dataset.y) < 30);
    globo.classList.remove("oculto");
  };
  caja.querySelectorAll(".punto-nota").forEach((g) => {
    g.addEventListener("pointerenter", () => mostrar(g));
    g.addEventListener("focus", () => mostrar(g));
    g.addEventListener("click", () => mostrar(g));
    g.addEventListener("pointerleave", () => globo.classList.add("oculto"));
    g.addEventListener("blur", () => globo.classList.add("oculto"));
  });
}

function pintarProgreso() {
  const historial = almacen.leer("tutor.historial", []);
  const caja = $("contenido-progreso");
  if (!historial.length) {
    caja.innerHTML = `
      <div class="vacio-grande">
        <p>Todavía no tienes llamadas. Haz tu primera práctica y aquí verás tu avance.</p>
        <button class="boton principal" data-ir="inicio">${icono("phone")}<span>Practicar ahora</span></button>
      </div>`;
    activarEnlaces(caja);
    return;
  }
  const promedio = historial.reduce((s, h) => s + h.nota, 0) / historial.length;
  const minutos = historial.reduce((s, h) => s + h.segundos, 0) / 60;
  const vistas = new Set();
  const recientes = historial.slice(-8).reverse().flatMap((h) => h.errores || [])
    .filter((e) => !vistas.has(e.correccion) && vistas.add(e.correccion)).slice(0, 5);
  const fechaLarga = (iso) => new Date(iso).toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" });

  const juego = leerJuego(), nivel = nivelDe(juego.xp);
  caja.innerHTML = `
    <div class="tarjeta-nivel ancha">
      <div class="cabeza-nivel">
        <span class="insignia-nivel" aria-hidden="true">${nivel.numero}</span>
        <div><div class="nombre-nivel">Nivel ${nivel.numero}: ${nivel.nombre}</div><div class="detalle">${juego.xp} XP en total</div></div>
      </div>
      ${barraNivel(juego.xp)}
    </div>

    <dl class="estadisticas">
      <div><dt>Llamadas</dt><dd>${historial.length}</dd></div>
      <div><dt>Nota promedio</dt><dd>${promedio.toFixed(1)}</dd></div>
      <div><dt>Minutos hablando</dt><dd>${Math.round(minutos)}</dd></div>
      <div><dt>Días seguidos</dt><dd>${rachaDeDias(historial)}</dd></div>
    </dl>

    ${graficoNotas(historial)}

    ${pintarMedallas()}

    ${recientes.length ? `
      <h2 class="titulo-bloque">Practica otra vez tus correcciones recientes</h2>
      <div class="lista-correcciones">${recientes.map((e) => `
        <div class="correccion">
          <div class="linea-correccion antes">${icono("close")}<span>${escapar(e.original)}</span></div>
          <div class="linea-correccion despues">${icono("check")}<span>${escapar(e.correccion)}</span></div>
          ${bloquePractica(e.correccion)}
        </div>`).join("")}</div>` : ""}

    <h2 class="titulo-bloque">Historial</h2>
    <div class="historial">${historial.slice().reverse().slice(0, 30).map((h, i) => `
      <div class="fila-historial">
        ${avatar(h)}
        <div class="texto-historial">
          <div class="titulo-historial">${escapar(h.titulo)}</div>
          <div class="detalle">${fechaLarga(h.fecha)}, con ${escapar(h.personaje)}, ${formatoTiempo(h.segundos)} min${h.misiones?.[1] ? `, ${h.misiones[0]} de ${h.misiones[1]} misiones` : ""}</div>
        </div>
        <span class="nota-historial">${h.nota}<span class="tenue"> de 10</span></span>
        <button class="mini" data-repetir="${historial.length - 1 - i}">${icono("refresh")}<span>Repetir</span></button>
      </div>`).join("")}</div>`;

  activarPractica(caja);
  activarGrafico(caja, historial);
  caja.querySelectorAll("[data-repetir]").forEach((b) => b.addEventListener("click", () => {
    const h = historial[Number(b.dataset.repetir)];
    const existe = h.escenario === "personalizado" ? Boolean(h.personalizado) : Boolean(estado.config?.escenarios[h.escenario]);
    if (!existe) { irA("inicio"); return; }
    if (h.escenario === "personalizado") {
      estado.personalizado = h.personalizado;
      pintarVistaPersonaje();
    }
    if (estado.config.niveles[h.nivel]) elegirNivel(h.nivel);
    elegirEscenario(h.escenario);
    irA("inicio");
    $("btn-empezar").focus();
  }));
}

// ---------- Mi vocabulario ----------
function pintarVocabulario() {
  const vocabulario = almacen.leer("tutor.vocabulario", []);
  const caja = $("contenido-vocabulario");
  if (!vocabulario.length) {
    caja.innerHTML = `
      <div class="vacio-grande">
        <p>Aún no tienes palabras guardadas. Las palabras útiles de cada llamada aparecen aquí.</p>
        <button class="boton principal" data-ir="inicio">${icono("phone")}<span>Practicar ahora</span></button>
      </div>`;
    activarEnlaces(caja);
    return;
  }
  const pendientes = vocabulario.filter((v) => v.proximo <= hoy());
  const etapa = (c) => (c >= 4 ? "Dominada" : c >= 2 ? "Aprendiendo" : "Nueva");

  caja.innerHTML = `
    <div class="cabecera-vocab">
      <p><b>${vocabulario.length}</b> ${vocabulario.length === 1 ? "palabra guardada" : "palabras guardadas"}. ${pendientes.length
        ? `<b>${pendientes.length}</b> para repasar hoy.` : "No tienes repasos pendientes hoy."}</p>
      ${pendientes.length ? `<button class="boton principal" id="btn-repasar">${icono("cards")}<span>Repasar ahora</span></button>` : ""}
    </div>
    <div id="zona-repaso"></div>
    <div class="lista-vocab" id="lista-vocab">${vocabulario.map((v, i) => `
      <div class="fila-vocab">
        <div>
          <div class="palabra-vocab">${escapar(v.palabra)} <span class="etapa etapa-${etapa(v.caja).toLowerCase()}">${etapa(v.caja)}</span></div>
          <div>${escapar(v.significado)}</div>
          <div class="ejemplo">${escapar(v.ejemplo)}</div>
        </div>
        <div class="acciones-vocab">
          <button class="mini solo-icono" data-oir="${i}" aria-label="Escuchar ${escapar(v.palabra)}">${icono("volume")}</button>
          <button class="mini solo-icono" data-borrar="${i}" aria-label="Eliminar ${escapar(v.palabra)}">${icono("trash")}</button>
        </div>
      </div>`).join("")}</div>`;

  caja.querySelectorAll("[data-oir]").forEach((b) => b.addEventListener("click", () => escucharEnIngles(vocabulario[Number(b.dataset.oir)].palabra)));
  caja.querySelectorAll("[data-borrar]").forEach((b) => b.addEventListener("click", () => {
    vocabulario.splice(Number(b.dataset.borrar), 1);
    almacen.guardar("tutor.vocabulario", vocabulario);
    pintarVocabulario();
  }));
  $("btn-repasar")?.addEventListener("click", () => iniciarRepaso(vocabulario, pendientes.slice()));
}

function iniciarRepaso(vocabulario, cola) {
  const total = cola.length;
  let sabidas = 0;
  const zona = $("zona-repaso");
  ocultar("btn-repasar");
  ocultar("lista-vocab");

  const mostrar = () => {
    if (!cola.length) {
      zona.innerHTML = `
        <div class="tarjeta-repaso">
          <p class="palabra">Repaso terminado</p>
          <p class="vacio">Repasaste ${total} ${total === 1 ? "palabra" : "palabras"}. Vuelven a aparecer aquí cuando toque repasarlas.</p>
          <div class="botones-repaso"><button class="boton secundario" id="btn-fin-repaso">Ver mis palabras</button></div>
        </div>`;
      $("btn-fin-repaso").addEventListener("click", pintarVocabulario);
      return;
    }
    const v = cola[0];
    zona.innerHTML = `
      <div class="tarjeta-repaso">
        <p class="progreso-repaso">${sabidas} de ${total} repasadas</p>
        <p class="palabra">${escapar(v.palabra)}</p>
        <button class="mini" id="oir-repaso">${icono("volume")}<span>Escuchar</span></button>
        <div id="respuesta-repaso" class="respuesta-repaso oculto">
          <p><b>${escapar(v.significado)}</b></p>
          <p class="ejemplo">${escapar(v.ejemplo)}</p>
        </div>
        <div class="botones-repaso" id="botones-mostrar">
          <button class="boton secundario" id="btn-mostrar">Ver significado</button>
        </div>
        <div class="botones-repaso oculto" id="botones-calificar">
          <button class="boton secundario" id="btn-no-sabia">Todavía no</button>
          <button class="boton principal" id="btn-sabia">${icono("check")}<span>La sabía</span></button>
        </div>
      </div>`;
    $("oir-repaso").addEventListener("click", () => escucharEnIngles(v.palabra));
    $("btn-mostrar").addEventListener("click", () => {
      ["respuesta-repaso", "botones-calificar"].forEach((id) => $(id).classList.remove("oculto"));
      ocultar("botones-mostrar");
      $("btn-sabia").focus();
    });
    const calificar = (sabia) => {
      cola.shift();
      if (sabia) {
        // Si antes falló en este mismo repaso, vuelve mañana en vez de subir de caja
        v.caja = v.fallo ? 1 : Math.min(5, (v.caja || 1) + 1);
        v.proximo = sumarDias(hoy(), DIAS_REPASO[v.caja]);
        delete v.fallo;
        sabidas++;
        sumarXP(XP.palabra, "Palabra repasada");
      } else {
        v.caja = 1;
        v.proximo = hoy();
        v.fallo = true;
        cola.push(v); // vuelve a salir al final de este repaso
      }
      almacen.guardar("tutor.vocabulario", vocabulario);
      mostrar();
    };
    $("btn-sabia").addEventListener("click", () => calificar(true));
    $("btn-no-sabia").addEventListener("click", () => calificar(false));
  };
  mostrar();
}

// ---------- Eventos ----------
function activarEnlaces(contenedor) {
  contenedor.querySelectorAll("[data-ir]").forEach((b) => b.addEventListener("click", () => irA(b.dataset.ir)));
}

activarEnlaces(document.querySelector(".navegacion"));
$("btn-empezar").addEventListener("click", empezar);
$("btn-silenciar").addEventListener("click", alternarSilencio);
$("btn-pista").addEventListener("click", pedirPista);
$("btn-terminar").addEventListener("click", terminar);
$("btn-repetir").addEventListener("click", empezar);
$("btn-otra").addEventListener("click", () => irA("inicio"));
$("btn-crear-personaje").addEventListener("click", crearPersonaje);
$("descripcion-personalizada").addEventListener("input", (e) => {
  $("contador-personalizado").textContent = `${e.target.value.length} de 300`;
  $("btn-crear-personaje").disabled = e.target.value.trim().length < 5;
});
window.addEventListener("beforeunload", detenerTodo);
$("btn-sonido").addEventListener("click", () => {
  almacen.guardar("tutor.sonidos", !sonidosActivos());
  pintarBotonSonido();
  sonar("frase");
});
pintarBotonSonido();
pintarMarcadores();

cargarConfiguracion();
