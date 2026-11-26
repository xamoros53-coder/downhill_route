// 10-bajadas-datos.js (líneas 1321-1466 del index.html original)
// ---- Datos precalculados: los genera generar.py (salida/<zona>/indice.json + celdas/<fila>_<col>.json) ----
// La app solo descarga las celdas (~11 km) que cubre el mapa visible; cada celda ya trae sentido, perfil y dificultad.
const DATOS_BASE = APP_CONFIG.DATOS_BASE;   // carpeta con los datos, relativa a index.html (en producción: "salida")
const DATOS_ZONAS = ["cataluna","huesca","pirineo_frances","teruel"];        // zonas disponibles (una carpeta por zona dentro de DATOS_BASE)
const MAX_CELDAS_VISTA = 60;            // con el mapa muy alejado no se cargan celdas
const zonasDatos = new Map();           // zona -> indice.json
const celdasCargadas = new Set();       // "zona/fila_col"
const diagCeldas = new Map();           // diagnóstico: de dónde vino cada celda y cuántas bajadas / sin etiqueta traía
let indicesPromesa = null;

function cargarIndices() {
  if (indicesPromesa) return indicesPromesa;
  indicesPromesa = Promise.all(DATOS_ZONAS.map(async (z) => {
    try {
      const r = await fetch(`${DATOS_BASE}/${z}/indice.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      zonasDatos.set(z, await r.json());
    } catch (e) { console.error("[datos] no se pudo leer el índice de", z, e); }
  })).then(() => { if (!zonasDatos.size) indicesPromesa = null; });   // si todo falló, se reintentará
  return indicesPromesa;
}

function incorporarBajada(b, enRuta) {
  const f = b && b.f;
  if (!f || !f.properties || !f.geometry) return false;
  const p = f.properties, id = p.id;
  // Los datos precalculados son la fuente de verdad: una «descartada» guardada por una versión antigua
  // (cuando el perfil se calculaba en el móvil) ya no debe ocultar la bajada.
  if (!id || enRuta.has(id)) return false;   // las de tu ruta se conservan tal cual
  descartadas.delete(id);
  const c = f.geometry.coordinates;
  // Por si generar.py no escribe alguno de estos campos que usa el mapa
  if (!p._cat) p._cat = catDe(p);
  if (!p.inicio && c.length) p.inicio = [c[0][0], c[0][1]];
  if (!p.fin && c.length) p.fin = [c[c.length - 1][0], c[c.length - 1][1]];
  p._precalc = true;   // perfil ya calculado en generar.py: no se pide nada al IGN
  if (!p.perfil_cargado) console.warn("[datos] bajada sin perfil_cargado:", id);
  porId.set(id, f); tramosPorId.set(id, b.tramos || []); tiempoCarga.set(id, Date.now());
  return true;
}

// manual = true cuando se pulsa el botón (avisa si no hay datos); si no, se llama sola al mover el mapa
async function cargarZona(manual, bnds) {
  if (cargandoZona) { if (manual) toast("Ya se está cargando la zona…"); return; }
  cargandoZona = true;
  let prog = null;
  try {
    await cargarIndices();
    if (!zonasDatos.size) {
      if (manual) { const m = "No se han podido leer los datos de bajadas. Comprueba la conexión."; setEstado(m); toast(m); }
      return;
    }
    const b = bnds || map.getBounds();   // bnds: área concreta (importar GPX); si no, lo que se ve en el mapa
    const S = b.getSouth(), W = b.getWest(), N = b.getNorth(), E = b.getEast();
    const pend = [];
    let cubierta = false, demasiado = false;
    for (const [z, idx] of zonasDatos) {
      const [s, w, n, e] = idx.bbox, G = idx.celda_grados || 0.1;
      if (N < s || S > n || E < w || W > e) continue;
      cubierta = true;
      const f0 = Math.floor(Math.max(S, s) / G + 1e-9), f1 = Math.floor(Math.min(N, n) / G + 1e-9);
      const c0 = Math.floor(Math.max(W, w) / G + 1e-9), c1 = Math.floor(Math.min(E, e) / G + 1e-9);
      if ((f1 - f0 + 1) * (c1 - c0 + 1) > (bnds ? 400 : MAX_CELDAS_VISTA)) { demasiado = true; continue; }
      for (let f = f0; f <= f1; f++) for (let c = c0; c <= c1; c++) {
        const nom = f + "_" + c, clave = z + "/" + nom;
        if (idx.celdas && nom in idx.celdas && !celdasCargadas.has(clave)) pend.push({ z, nom, clave });
      }
    }
    if (!pend.length) {
      if (manual) {
        const m = demasiado ? "Acerca el mapa para cargar las bajadas."
          : cubierta ? "Las bajadas de esta zona ya están cargadas." : "Todavía no hay bajadas disponibles en esta zona.";
        setEstado(m); toast(m);
      }
      return;
    }
    prog = iniciarProgreso();
    prog.set("Cargando bajadas de la zona…", 0);
    const enRuta = new Set(miRuta.filter(id => !esPunto(id)));
    let hechas = 0, nuevas = 0, fallos = 0;
    await Promise.all(pend.map(async ({ z, nom, clave }) => {
      try {
        const r = await fetch(`${DATOS_BASE}/${z}/celdas/${nom}.json`, { cache: "no-cache" });   // revalida siempre: así llegan los datos regenerados
        if (!r.ok) throw new Error("HTTP " + r.status);
        const datos = await r.json();
        let inf = 0;
        for (const bj of datos.bajadas || []) {
          if (bj && bj.f && bj.f.properties && bj.f.properties.origen === "inferida") inf++;
          if (incorporarBajada(bj, enRuta)) nuevas++;
        }
        diagCeldas.set(clave, { url: r.url, total: (datos.bajadas || []).length, inferidas: inf });
        celdasCargadas.add(clave);
      } catch (e) { fallos++; console.error("[datos] celda", clave, e); }
      prog.set("Cargando bajadas de la zona…", ++hechas / pend.length);
    }));
    actualizarMapa();
    guardarBajadasLocal();
    const msg = fallos
      ? `No se han podido cargar ${fallos} trozo${fallos === 1 ? "" : "s"} del mapa. Vuelve a intentarlo.`
      : `${features.length.toLocaleString("es-ES")} bajadas disponibles en la zona.`;
    setEstado(msg);
    if (manual || fallos) toast(fallos ? "Error al cargar parte de la zona" : `✓ ${msg}`);
  } catch (e) {
    console.error("[zona] error", e);
    setEstado("Error: " + (e && e.message ? e.message : e));
    if (manual) toast("Error al cargar la zona");
  } finally {
    if (prog) prog.fin();
    cargandoZona = false;
  }
}
(function () {
  const chk = document.getElementById("modoAmplio");
  if (!chk) return;
  try { chk.checked = localStorage.getItem("incluirInferidas_v1") === "1"; } catch (e) {}
  chk.addEventListener("change", () => {
    try { localStorage.setItem("incluirInferidas_v1", chk.checked ? "1" : "0"); } catch (e) {}
    if (!chk.checked && seleccionada) {
      const f = porId.get(seleccionada);
      if (f && f.properties.origen === "inferida" && !miRuta.includes(seleccionada)) deseleccionar();
    }
    actualizarMapa();
    if (chk.checked) cargarZona(false);   // por si faltan celdas de la vista actual
    const n = [...porId.values()].filter(f => f.properties.origen === "inferida").length;
    if (chk.checked && !n) {
      // Sin ninguno: se explica qué se ha descargado para localizar el problema
      const celdas = [...diagCeldas.entries()];
      const totalDesc = celdas.reduce((a, [, d]) => a + d.total, 0);
      const ej = celdas.length ? celdas[0][1].url : `${DATOS_BASE}/…`;
      const m = celdas.length
        ? `No hay senderos sin etiqueta: se descargaron ${celdas.length} celda${celdas.length === 1 ? "" : "s"} con ${totalDesc} bajadas y ninguna es «inferida». Ejemplo de celda leída: ${ej}`
        : `No hay senderos sin etiqueta: en esta sesión no se ha descargado ninguna celda (mueve o acerca el mapa a una zona con datos). Ruta de datos: ${DATOS_BASE}/`;
      console.warn("[datos]", m, Object.fromEntries(diagCeldas));
      setEstado(m); toast("No hay senderos sin etiqueta en los datos descargados", 4000);
    } else
    toast(chk.checked ? `Mostrando también ${n} sendero${n === 1 ? "" : "s"} sin etiqueta MTB`
                      : "Solo bajadas con etiqueta MTB");
  });
})();
// Carga automática al mover el mapa (con pausa, para no lanzar una carga por cada gesto)
let zonaTimer = null;
function programarCargaZona() {
  clearTimeout(zonaTimer);
  zonaTimer = setTimeout(() => { if (cargaLocalTerminada) cargarZona(false); }, 500);
}

