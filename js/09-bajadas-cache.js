// 09-bajadas-cache.js (líneas 1178-1320 del index.html original)
// ---- Caché en el móvil: todas las bajadas cargadas se guardan en IndexedDB y reaparecen al abrir la app ----
const IDB_NOMBRE = "ridebajadas_v1";
const IDB_TTL_MS = 30 * 24 * 3600 * 1000;   // pasado este tiempo se vuelven a descargar (OSM cambia)
const tiempoCarga = new Map();               // id -> momento en que se descargó
function idbAbrir() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error("sin IndexedDB"));
    const r = indexedDB.open(IDB_NOMBRE, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("datos");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
let idbTimer = null;
let guardadoPendiente = false;
let cargaLocalTerminada = false;   // no se guarda nada hasta haber leído lo que había (evita machacarlo con un mapa vacío)
async function volcarBajadasLocal() {
  if (!cargaLocalTerminada) return;
  guardadoPendiente = false;
  try {
    const db = await idbAbrir();
    const ahora = Date.now(), o = {};
    for (const [id, f] of porId) o[id] = { t: tiempoCarga.get(id) || ahora, f, tramos: tramosPorId.get(id) || [] };
    await new Promise((res, rej) => {
      const tx = db.transaction("datos", "readwrite");
      tx.objectStore("datos").put(o, "bajadas");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error || new Error("error al escribir"));
      tx.onabort = () => rej(tx.error || new Error("escritura cancelada"));
    });
    db.close();
  } catch (e) {
    console.error("No se pudieron guardar las bajadas en el móvil:", e);
    setEstado("⚠ No se han podido guardar las bajadas en el móvil (" + (e && e.message || e) + "). Si abres la app desde otra app (WhatsApp, GitHub…) ábrela en Chrome/Safari.");
  }
}
function guardarBajadasLocal() {
  guardadoPendiente = true;
  clearTimeout(idbTimer);
  idbTimer = setTimeout(volcarBajadasLocal, 300);
}
// En el móvil, al cambiar de app o cerrar, los temporizadores se congelan: se guarda en ese momento
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && guardadoPendiente) { clearTimeout(idbTimer); volcarBajadasLocal(); } });
window.addEventListener("pagehide", () => { if (guardadoPendiente) { clearTimeout(idbTimer); volcarBajadasLocal(); } });
// Pide al navegador que no borre estos datos cuando necesite espacio
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
// Los perfiles guardados antes de usar el MDT05 del IGN (sin "fuente_elev") o calculados con el antiguo respaldo
// de Open-Meteo se recalculan al abrir la bajada.
function marcarPerfilObsoleto(f) {
  const p = f && f.properties;
  if (p && !p._precalc && p.perfil_cargado && (!p.fuente_elev || p.fuente_elev === "openmeteo")) p.perfil_cargado = false;
}
async function cargarBajadasLocales() {
  try {
    const db = await idbAbrir();
    const o = await new Promise(res => {
      const q = db.transaction("datos").objectStore("datos").get("bajadas");
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
    db.close();
    if (!o) return 0;
    const ahora = Date.now();
    let n = 0;
    for (const [id, b] of Object.entries(o)) {
      if (!b || !b.f || ahora - b.t > IDB_TTL_MS) continue;
      marcarPerfilObsoleto(b.f);
      porId.set(id, b.f); tramosPorId.set(id, b.tramos || []); tiempoCarga.set(id, b.t); n++;
    }
    return n;
  } catch (e) { console.error("No se pudieron leer las bajadas guardadas:", e); return 0; }
}

let appIniciada = false;
async function iniciarApp() {
  if (appIniciada) return;
  appIniciada = true;
  try {
    asegurarSat();   // satélite (ortofoto PNOA del IGN), bajo las capas de la app
    await cargarCapas();
    try { const rd = localStorage.getItem(STORAGE_DESCARTADAS); if (rd) descartadas = new Set(JSON.parse(rd)); } catch (e) {}
    const nLocal = await cargarBajadasLocales();
    cargaLocalTerminada = true;
    cargarMiRutaGuardado(); renderMiRuta(); actualizarBotonesRuta(); actualizarUIPuntos();
    actualizarMapa(); actualizarContornoRuta();
    if (features.length) {
      ajustarVista();
      if (nLocal) setEstado(`${nLocal} bajada${nLocal === 1 ? "" : "s"} recuperada${nLocal === 1 ? "" : "s"} de la caché. Mueve el mapa para ver más zonas.`);
    } else setEstado("Cargando las bajadas de tu zona…");
    map.on("moveend", programarCargaZona);
    cargarZona(false);
    try { ubic.centrarUnaVez(15); } catch (e) {}   // al abrir, centra el mapa en tu posición (si das permiso)
  } catch (e) {
    cargaLocalTerminada = true;
    setEstado("Error al iniciar el mapa: " + e.message);
    console.error(e);
  }
}
map.on("load", iniciarApp);
// Respaldo: si el evento "load" no llega (estilos externos), se arranca igualmente cuando el estilo está cargado
map.once("style.load", () => setTimeout(() => {
  if (!appIniciada) { console.warn("[mapa] «load» no llegó; arrancando con style.load"); iniciarApp(); }
}, 4000));

// Vuelca las bajadas cargadas (y sus trozos de color y extremos) a las capas del mapa
function actualizarMapa() {
  // Las «inferidas» (sin etiqueta MTB) solo se muestran si la casilla está marcada; las de tu ruta siempre
  const incluirInferidas = !!(document.getElementById("modoAmplio") || {}).checked;
  features = [...porId.values()].filter(f => incluirInferidas || f.properties.origen !== "inferida" || miRuta.includes(idDe(f)));
  const tr = { type: "FeatureCollection", features: [] };
  const pt = { type: "FeatureCollection", features: [] };
  for (const f of features) {
    const p = f.properties, id = idDe(f);
    for (const t of tramosPorId.get(id) || []) tr.features.push(t);
    const base = { _cat: p._cat, _osm: p._osm, _color: colorDe(p), bajada_id: id, nombre: p.nombre || "" };
    pt.features.push({ type: "Feature", geometry: { type: "Point", coordinates: p.inicio }, properties: { ...base, tipo: "inicio" } });
    pt.features.push({ type: "Feature", geometry: { type: "Point", coordinates: p.fin }, properties: { ...base, tipo: "final" } });
  }
  actualizarPasos();
  const st = map.getSource("tramos"), sp = map.getSource("puntos");
  if (st) st.setData(tr);
  if (sp) sp.setData(pt);
}

// Barra de progreso + tiempo transcurrido mientras se carga la zona (frac = null => barra indeterminada)
function iniciarProgreso() {
  const barra = document.getElementById("progresoZona"), relleno = barra.firstElementChild;
  const t0 = Date.now();
  let msg = "", frac = null;
  barra.classList.add("on");
  function pinta() {
    const seg = Math.round((Date.now() - t0) / 1000);
    setEstado(`${msg} · ${seg} s`);
    barra.classList.toggle("indet", frac === null);
    relleno.style.width = frac === null ? "" : (frac * 100).toFixed(0) + "%";
  }
  const iv = setInterval(pinta, 500);
  return {
    set(m, f) { msg = m; frac = (typeof f === "number" && isFinite(f)) ? Math.max(0, Math.min(1, f)) : null; pinta(); },
    fin() { clearInterval(iv); barra.classList.remove("on", "indet"); relleno.style.width = "0"; }
  };
}

