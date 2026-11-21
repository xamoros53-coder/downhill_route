// 13-busqueda.js (líneas 1780-1899 del index.html original)
// ---- Búsqueda rápida por nombre (mapa) ----
const busquedaWrap = document.getElementById("busquedaWrap");
const btnBuscarToggle = document.getElementById("btnBuscarToggle");
const busquedaPanel = document.getElementById("busquedaPanel");
const busquedaInput = document.getElementById("busquedaInput");
const busquedaResultados = document.getElementById("busquedaResultados");
let textoBusqueda = "";
btnBuscarToggle.addEventListener("click", () => {
  const abrir = !busquedaPanel.classList.contains("abierto");
  busquedaPanel.classList.toggle("abierto", abrir);
  btnBuscarToggle.setAttribute("aria-label", abrir ? "Cerrar búsqueda" : "Buscar bajada o lugar");
  if (abrir) setTimeout(() => busquedaInput.focus(), 30);
  else { busquedaInput.value = ""; textoBusqueda = ""; actualizarBusqueda(); }
});
const norm = t => String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");   // sin tildes ni mayúsculas
let seqLugares = 0, marcadorLugar = null;
function cerrarBusqueda() { busquedaPanel.classList.remove("abierto"); busquedaInput.blur(); }
function actualizarBusqueda() {
  seqLugares++;                                   // invalida una búsqueda de lugares que estuviera en curso
  const texto = busquedaInput.value.trim();
  textoBusqueda = norm(texto);
  busquedaResultados.innerHTML = "";
  if (!textoBusqueda) return;
  const coincidencias = features.filter(f => norm(f.properties.nombre).includes(textoBusqueda));
  // La búsqueda no oculta el resto de las bajadas: solo muestra resultados aquí.
  if (coincidencias.length) {
    const h = document.createElement("div"); h.className = "res-grupo"; h.textContent = "Bajadas"; busquedaResultados.appendChild(h);
    coincidencias.slice(0, 8).forEach(f => {
      const b = document.createElement("button"); b.type = "button"; b.className = "resultado-busqueda";
      b.textContent = f.properties.nombre || "Bajada sin nombre";
      b.addEventListener("click", () => { seleccionar(idDe(f), { fit: true }); cerrarBusqueda(); });
      busquedaResultados.appendChild(b);
    });
  }
  // Los lugares se buscan al pulsar Intro o este botón (una petición por búsqueda, no por cada letra)
  const zona = document.createElement("div");
  const bl = document.createElement("button"); bl.type = "button"; bl.className = "resultado-busqueda btn-lugar";
  bl.textContent = `🔎 Buscar «${texto}» como lugar`;
  bl.addEventListener("click", () => buscarLugares(texto, zona));
  zona.appendChild(bl);
  busquedaResultados.appendChild(zona);
  if (!coincidencias.length) {
    const v = document.createElement("div"); v.className = "resultado-vacio"; v.textContent = "Ninguna bajada con ese nombre."; busquedaResultados.insertBefore(v, zona);
  }
}
// ---- Búsqueda de lugares: geocodificador de CartoCiudad (IGN/CNIG). Uso libre y gratuito, también comercial, citando la fuente (CC BY 4.0) ----
const CARTO_URL = "https://www.cartociudad.es/geocoder/api/geocoder/";
let cartoModo = null;   // "fetch" (llamada directa) o "jsonp" (respaldo si el navegador bloquea la llamada directa)
function cartoJsonp(metodo, params) {
  return new Promise((ok, ko) => {
    const cb = "cc_" + Math.random().toString(36).slice(2), sc = document.createElement("script");
    const fin = () => { clearTimeout(tm); delete window[cb]; sc.remove(); };
    const tm = setTimeout(() => { fin(); ko(new Error("tiempo agotado")); }, 7000);
    window[cb] = (d) => { fin(); ok(d); };
    sc.onerror = () => { fin(); ko(new Error("no se pudo conectar")); };
    sc.src = CARTO_URL + metodo + "Jsonp?" + new URLSearchParams({ ...params, callback: cb });
    document.head.appendChild(sc);
  });
}
async function cartoPedir(metodo, params, signal) {
  if (cartoModo !== "jsonp") {
    try {
      const r = await fetch(CARTO_URL + metodo + "?" + new URLSearchParams(params), { signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(); cartoModo = "fetch"; return j;
    } catch (e) {
      if (e.name === "AbortError" || cartoModo === "fetch") throw e;   // si ya sabemos que la llamada directa funciona, el fallo es otro
    }
  }
  const j = await cartoJsonp(metodo, params); cartoModo = "jsonp"; return j;
}
const CARTO_TIPOS = {   // tipo de CartoCiudad → etiqueta y zoom al ir allí
  ngbe: ["Montaña o paraje", 14], toponimo: ["Lugar", 14], poblacion: ["Población", 13], municipio: ["Municipio", 12],
  callejero: ["Calle", 16], carreteras: ["Carretera", 15], portal: ["Dirección", 17], provincia: ["Provincia", 9], "comunidad autonoma": ["Comunidad", 8]
};
async function buscarLugares(texto, zona) {
  const mi = ++seqLugares;
  zona.innerHTML = '<div class="resultado-vacio">Buscando lugares…</div>';
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const lista = (await cartoPedir("candidates", { q: texto, limit: 12, no_process: "expendeduria,punto_recarga_electrica" }, ctrl.signal))
      .filter(p => CARTO_TIPOS[p.type]);   // se descartan códigos postales, referencias catastrales, etc.
    if (mi !== seqLugares) return;
    zona.innerHTML = "";
    const h = document.createElement("div"); h.className = "res-grupo"; h.textContent = "Lugares"; zona.appendChild(h);
    if (!lista.length) { zona.insertAdjacentHTML("beforeend", '<div class="resultado-vacio">No se ha encontrado ningún lugar.</div>'); return; }
    lista.forEach(p => {
      const [etiqueta, zoom] = CARTO_TIPOS[p.type];
      const donde = [p.muni, p.province].filter((x, i, a) => x && a.indexOf(x) === i && x !== p.address).join(", ");
      const b = document.createElement("button"); b.type = "button"; b.className = "resultado-busqueda";
      b.innerHTML = `${esc(p.address || "Lugar")}<small>${esc([etiqueta, donde].filter(Boolean).join(" · "))}</small>`;
      b.addEventListener("click", async () => {
        let lat = Number(p.lat), lng = Number(p.lng);
        if (!(isFinite(lat) && isFinite(lng) && (lat || lng))) {   // poblaciones, municipios…: «candidates» no da coordenadas, «find» sí
          try {
            const d = await cartoPedir("find", { q: p.address, type: p.type, id: p.id }, undefined);
            lat = Number(d.lat); lng = Number(d.lng);
          } catch (e) {}
        }
        if (!(isFinite(lat) && isFinite(lng)) || (!lat && !lng)) { toast("No se pudo situar ese lugar"); return; }
        cerrarBusqueda();
        map.flyTo({ center: [lng, lat], zoom, duration: 700 });
        if (marcadorLugar) marcadorLugar.remove();
        const mk = marcadorLugar = new maplibregl.Marker({ color: "#d62f2f" }).setLngLat([lng, lat]).addTo(map);
        setTimeout(() => { mk.remove(); if (marcadorLugar === mk) marcadorLugar = null; }, 20000);
      });
      zona.appendChild(b);
    });
  } catch (e) {
    console.error("[búsqueda]", e);
    if (mi === seqLugares) zona.innerHTML = '<div class="resultado-vacio">No se pudo buscar el lugar. Revisa la conexión.</div>';
  } finally { clearTimeout(t); }
}
busquedaInput.addEventListener("input", actualizarBusqueda);
busquedaInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const bl = busquedaResultados.querySelector(".btn-lugar"); if (bl) bl.click();
});

