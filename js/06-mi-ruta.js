// 06-mi-ruta.js (líneas 871-1062 del index.html original)
function cargarMiRutaGuardado() {
  try {
    const rd = localStorage.getItem(STORAGE_DESCARTADAS);
    if (rd) descartadas = new Set(JSON.parse(rd));
    // Las bajadas de la ruta se guardan enteras (con su perfil): sobreviven a un refresco sin volver a descargar la zona
    const rb = localStorage.getItem(STORAGE_BAJADAS);
    if (rb) {
      for (const [id, b] of Object.entries(JSON.parse(rb))) {
        if (b && b.f && b.f.properties && b.f.properties.perfil_cargado) { marcarPerfilObsoleto(b.f); porId.set(id, b.f); tramosPorId.set(id, b.tramos || []); }
      }
    }
    const rp = localStorage.getItem(STORAGE_INTER);
    if (rp) for (const [id, pt] of JSON.parse(rp)) puntosInter.set(id, pt);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { const ids = JSON.parse(raw); if (Array.isArray(ids)) miRuta = ids.filter(id => porId.has(id) || puntosInter.has(id)); }
    localStorage.removeItem(STORAGE_INICIO); localStorage.removeItem(STORAGE_FIN);
  } catch (e) {}
}
function guardarMiRuta() {
  invalidarRuta();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(miRuta));
    const o = {};
    for (const id of miRuta) { const f = porId.get(id); if (f) o[id] = { f, tramos: tramosPorId.get(id) || [] }; }
    localStorage.setItem(STORAGE_BAJADAS, JSON.stringify(o));
    for (const id of [...puntosInter.keys()]) if (!miRuta.includes(id)) puntosInter.delete(id);
    localStorage.setItem(STORAGE_INTER, JSON.stringify([...puntosInter]));
  } catch (e) {}
}
function guardarPuntos() {
  invalidarRuta();
  try {
    if (puntoInicio) localStorage.setItem(STORAGE_INICIO, JSON.stringify(puntoInicio)); else localStorage.removeItem(STORAGE_INICIO);
    if (puntoFin) localStorage.setItem(STORAGE_FIN, JSON.stringify(puntoFin)); else localStorage.removeItem(STORAGE_FIN);
  } catch (e) {}
}
function estaEnRuta(id) { return miRuta.includes(id); }
async function toggleRuta(id) {
  let anadida = false;
  const i = miRuta.indexOf(id);
  if (i >= 0) {
    miRuta.splice(i, 1);
  } else {
    const f = porId.get(id); if (!f) return;
    if (!f.properties.perfil_cargado) {   // el perfil hace falta para la ruta: se pide al añadir
      const btn = document.getElementById("popupAdd");
      if (btn && btn.dataset.id === id) { btn.disabled = true; btn.textContent = "Calculando perfil…"; }
      setEstado(`Calculando el perfil de «${f.properties.nombre || "bajada"}»…`);
      let ok = false;
      try { ok = await asegurarPerfil(id); }
      catch (e) { setEstado("No se pudo calcular el perfil: " + e.message); actualizarPopupBoton(); return; }
      if (!ok) { actualizarPopupBoton(); return; }   // retirada: asegurarPerfil ya avisó
      setEstado("");
    }
    if (!miRuta.includes(id)) miRuta.push(id);
    anadida = true;
  }
  guardarMiRuta(); renderMiRuta(); actualizarBotonesRuta(); actualizarPopupBoton(); actualizarBotonGenerar();
  if (anadida) { deseleccionar(); const nb = miRuta.filter(x => !esPunto(x)).length; toast(`✓ Añadida · ${nb} bajada${nb === 1 ? "" : "s"} en tu ruta`); mostrarAnadido(id); }
}

// Ordenar la lista arrastrando el asa ⋮⋮ (ratón o dedo)
function arrastrarItem(ev, asa, cont, el, i) {
  if (ev.button !== undefined && ev.button !== 0) return;
  ev.preventDefault(); ev.stopPropagation();
  const items = [...cont.querySelectorAll(".item")];
  const scroller = document.getElementById("detalle");
  const mids = items.map(x => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; });
  const paso = el.getBoundingClientRect().height + 6;
  const y0 = ev.clientY, s0 = scroller.scrollTop;
  let destino = i, yAct = y0;
  try { asa.setPointerCapture(ev.pointerId); } catch (e) {}
  el.classList.add("arrastrando");
  const pinta = () => {
    const desp = (yAct - y0) + (scroller.scrollTop - s0);
    el.style.transform = `translateY(${desp}px)`;
    const centro = mids[i] + desp;
    let d = 0;
    mids.forEach((m, j) => { if (j !== i && m < centro) d++; });
    destino = d;
    items.forEach((x, j) => {
      if (j === i) return;
      x.style.transform = (j > i && j <= destino) ? `translateY(${-paso}px)` : (j < i && j >= destino) ? `translateY(${paso}px)` : "";
    });
  };
  let auto = null;
  const mueve = (e) => {
    yAct = e.clientY; pinta();
    const r = scroller.getBoundingClientRect();
    clearInterval(auto);
    if (yAct < r.top + 36) auto = setInterval(() => { scroller.scrollTop -= 8; pinta(); }, 16);
    else if (yAct > r.bottom - 36) auto = setInterval(() => { scroller.scrollTop += 8; pinta(); }, 16);
  };
  const suelta = () => {
    clearInterval(auto);
    asa.removeEventListener("pointermove", mueve);
    asa.removeEventListener("pointerup", suelta);
    asa.removeEventListener("pointercancel", suelta);
    if (destino !== i) {
      const [x] = miRuta.splice(i, 1); miRuta.splice(destino, 0, x);
      guardarMiRuta(); renderMiRuta();
    } else {
      el.classList.remove("arrastrando"); el.style.transform = "";
      items.forEach(x => { x.style.transform = ""; });
    }
  };
  asa.addEventListener("pointermove", mueve);
  asa.addEventListener("pointerup", suelta);
  asa.addEventListener("pointercancel", suelta);
}

function actualizarMarcadoresInter() {
  markersInter.forEach(m => m.remove()); markersInter = [];
  let n = 0;
  for (const id of miRuta) {
    if (!esPunto(id)) continue;
    const pt = puntosInter.get(id); if (!pt) continue;
    n++;
    const el = document.createElement("div");
    el.textContent = n;
    el.style.cssText = "width:24px;height:24px;border-radius:50%;background:#7b1fa2;color:#fff;font:700 12px/20px system-ui,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.4)";
    markersInter.push(new maplibregl.Marker({ element: el }).setLngLat([pt[1], pt[0]]).addTo(map));
  }
}

function renderMiRuta() {
  const cont = document.getElementById("miRutaLista");
  cont.innerHTML = "";
  let nPun = 0;
  if (miRuta.length === 0) {
    const v = document.createElement("div"); v.className = "vacio"; v.textContent = "Aún no hay nada en tu ruta. Descarga las bajadas, toca una en el mapa y pulsa «Añadir a mi ruta». También puedes añadir puntos tocando un hueco del mapa o importar un archivo GPX."; cont.appendChild(v);
  } else {
    miRuta.forEach((id, i) => {
      const esP = esPunto(id);
      const f = esP ? null : porId.get(id);
      if (!esP && !f) return;
      const el = document.createElement("div"); el.className = "item" + (esP ? " punto-inter" : ""); el.dataset.id = id;
      let marca, nombre;
      if (esP) { nPun++; marca = `<span class="pin">📍</span>`; const pt = puntosInter.get(id); nombre = (pt && pt[2]) ? `Punto ${nPun} · ${pt[2]}` : `Punto ${nPun}`; }
      else {
        const p = f.properties;
        marca = `<span class="punto" style="background:${colorDe(p)}"></span>`; nombre = p.nombre || "(sin nombre)";
      }
      el.innerHTML = `<span class="asa" title="Arrastra para ordenar" aria-label="Arrastrar para ordenar"><svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor"><circle cx="4" cy="3" r="1.6"/><circle cx="10" cy="3" r="1.6"/><circle cx="4" cy="8" r="1.6"/><circle cx="10" cy="8" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="10" cy="13" r="1.6"/></svg></span><span class="num">${i + 1}</span>${marca}<span class="nom">${esc(nombre)}</span>`
        + `<button class="x" title="Quitar" aria-label="Quitar">×</button>`;
      const asa = el.querySelector(".asa");
      asa.addEventListener("click", (ev) => ev.stopPropagation());
      asa.addEventListener("pointerdown", (ev) => arrastrarItem(ev, asa, cont, el, i));
      el.querySelector(".x").addEventListener("click", (ev) => { ev.stopPropagation(); toggleRuta(id); });
      el.addEventListener("click", () => {
        setPanel(false);
        if (esP) { const pt = puntosInter.get(id); if (pt) map.easeTo({ center: [pt[1], pt[0]], zoom: Math.max(map.getZoom(), 14), duration: 500 }); }
        else seleccionar(id, { fit: true });
      });
      cont.appendChild(el);
    });
  }
  actualizarMarcadoresInter();
  actualizarContornoRuta();
  actualizarPasos();
}

function actualizarBotonesRuta() {
  document.querySelectorAll(".btn-add").forEach(btn => {
    const dentro = estaEnRuta(btn.dataset.id);
    btn.classList.toggle("in", dentro);
    btn.textContent = dentro ? "✓" : "＋";
    btn.title = dentro ? "Quitar de mi ruta" : "Añadir a mi ruta";
  });
}
function actualizarPopupBoton() {
  const btn = document.getElementById("popupAdd"); if (!btn) return;
  const dentro = estaEnRuta(btn.dataset.id);
  btn.disabled = false;
  btn.classList.toggle("in", dentro);
  btn.textContent = dentro ? "Quitar de mi ruta" : "Añadir a mi ruta";
}
function actualizarUIPuntos() { actualizarBotonGenerar(); }
// Se puede generar con al menos una bajada, o solo con puntos si hay dos o más
function puedeGenerar() {
  if (rutaGenerada) return true;   // ruta ya lista (generada o importada): el botón descarga el GPX
  const nPun = miRuta.filter(esPunto).length;
  return nPun >= 2 || miRuta.length - nPun >= 1;
}
function actualizarBotonGenerar() { document.getElementById("btnGenerar").disabled = !puedeGenerar(); actualizarPasos(); }
document.getElementById("volverInicio").addEventListener("change", () => { invalidarRuta(); actualizarUIPuntos(); });
document.getElementById("perfil").addEventListener("change", () => invalidarRuta());
document.getElementById("btnInfoPerfil").addEventListener("click", () => {
  const b = document.getElementById("btnInfoPerfil"), i = document.getElementById("infoPerfil");
  i.hidden = !i.hidden; b.setAttribute("aria-expanded", String(!i.hidden));
});

