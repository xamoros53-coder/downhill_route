// 19-ajustes.js (líneas 2870-2928 del index.html original)
// ---- Configuración: caché de bajadas ----
const cfgEl = document.getElementById("config");
const cfgOrient = document.getElementById("cfgOrient");
cfgOrient.value = orientMapa;
cfgOrient.addEventListener("change", () => {
  orientMapa = cfgOrient.value === "marcha" ? "marcha" : "norte";
  try { localStorage.setItem("orientMapa", orientMapa); } catch (e) {}
  if (typeof siguiendo !== "undefined" && siguiendo) {   // se aplica al momento si estás siguiendo la ruta
    if (orientMapa === "marcha") ubic.mover(); else map.easeTo({ bearing: 0, duration: 500 });
  }
});
// Aviso al incluir senderos sin etiqueta MTB (la casilla arranca siempre desmarcada)
(function () {
  const chk = document.getElementById("modoAmplio"), aviso = document.getElementById("avisoAmplio");
  if (!chk || !aviso) return;
  const sync = () => { aviso.hidden = !chk.checked; };
  chk.addEventListener("change", sync);
  document.getElementById("avisoAmplioCerrar").addEventListener("click", () => { aviso.hidden = true; });   // vuelve a salir al volver a marcar la casilla
  sync();
})();
function fmtBytes(b) {
  if (!b) return "0 KB";
  if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + " KB";
  return (b / 1048576).toFixed(1).replace(".", ",") + " MB";
}
async function actualizarConfig() {
  const n = porId.size;
  let txt = n ? `${n.toLocaleString("es-ES")} bajada${n === 1 ? "" : "s"} en caché` : "Caché vacía";
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      if (e.usage) txt += ` · la app ocupa ≈${fmtBytes(e.usage)}`;
    }
  } catch (e) {}
  document.getElementById("cfgInfo").textContent = txt;
}
cfgEl.addEventListener("toggle", () => { if (cfgEl.open) actualizarConfig(); });

document.getElementById("cfgLimpiar").addEventListener("click", async () => {
  if (cargandoZona) { setEstado("Espera a que termine la carga de la zona para limpiar."); return; }
  const enRuta = new Set(miRuta.filter(id => !esPunto(id)));
  if (!confirm("¿Vaciar la caché de bajadas?" + (enRuta.size ? ` Se conservan las ${enRuta.size} de tu ruta.` : "") + " Se volverán a cargar solas al mover el mapa.")) return;
  let n = 0;
  for (const id of [...porId.keys()]) {
    if (enRuta.has(id)) continue;
    porId.delete(id); tramosPorId.delete(id); tiempoCarga.delete(id); n++;
  }
  descartadas = new Set();
  try { localStorage.removeItem(STORAGE_DESCARTADAS); } catch (e) {}
  if (seleccionada && !enRuta.has(seleccionada)) deseleccionar();
  actualizarMapa();
  await volcarBajadasLocal();
  celdasCargadas.clear();
  setEstado(`${n} bajada${n === 1 ? "" : "s"} borrada${n === 1 ? "" : "s"} de la caché. Mueve el mapa para volver a cargarlas.`);
  actualizarConfig();
});

// ---- Mapa guardado para uso sin conexión (lo gestiona sw.js: el mapa y el relieve que ya has visto) ----
async function infoMapaGuardado() {
  const el = document.getElementById("cfgMapaInfo");
  if (!el) return;
  try {
    if (!window.caches) { el.textContent = "No disponible en este navegador"; return; }
    let n = 0;
    for (const k of (await caches.keys()).filter(k => k.startsWith("ride-mapa-"))) n += (await (await caches.open(k)).keys()).length;
    el.textContent = n ? `${n.toLocaleString("es-ES")} trozos de mapa guardados` : "Aún no hay mapa guardado: se guarda lo que ves con conexión";
  } catch (e) { el.textContent = ""; }
}
cfgEl.addEventListener("toggle", () => { if (cfgEl.open) infoMapaGuardado(); });
document.getElementById("cfgLimpiarMapa").addEventListener("click", async () => {
  if (!window.caches || !confirm("¿Borrar el mapa guardado para usar sin conexión? Se vuelve a guardar solo al verlo con cobertura.")) return;
  for (const k of (await caches.keys()).filter(k => k.startsWith("ride-mapa-"))) await caches.delete(k);
  setEstado("Mapa guardado borrado.");
  infoMapaGuardado();
});
