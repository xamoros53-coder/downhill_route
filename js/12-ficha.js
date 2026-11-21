// 12-ficha.js (líneas 1601-1779 del index.html original)
// ---- Perfil de altimetría dentro de la ficha de una bajada ----
let fichaPerfil = null;   // datos y escalas del gráfico abierto: { pts, X, Y, ML, MR, W, total }

function ponerMarcadorPerfil(lat, lon) {   // la misma bola amarilla que usa el perfil de la ruta
  if (!markerPerfil) {
    const el = document.createElement("div");
    el.style.cssText = "width:18px;height:18px;border-radius:50%;background:#ffd400;border:3px solid #1a1a1a;box-shadow:0 0 0 2px #fff;pointer-events:none;z-index:5";
    markerPerfil = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
  }
  markerPerfil.setLngLat([lon, lat]);
  markerPerfil.getElement().style.display = "";
}

function dibujarPerfilFicha(f) {
  fichaPerfil = null;
  const cont = document.getElementById("fichaPerfil"), info = document.getElementById("fichaPerfilInfo");
  if (!cont) return;
  const ocultar = () => { cont.style.display = "none"; if (info) info.style.display = "none"; };
  // geometría 3D de la bajada: [lon, lat, ele]. Se acumula la distancia a lo largo de la línea.
  const c = f.geometry.coordinates, pts = [], R = 6371000, rad = Math.PI / 180;
  let d = 0;
  for (let i = 0; i < c.length; i++) {
    if (i > 0) {
      const p1 = c[i - 1][1] * rad, p2 = c[i][1] * rad, dp = p2 - p1, dl = (c[i][0] - c[i - 1][0]) * rad;
      const hv = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
      d += 2 * R * Math.asin(Math.sqrt(hv));
    }
    if (c[i].length > 2 && Number.isFinite(c[i][2])) pts.push({ d, ele: c[i][2], lon: c[i][0], lat: c[i][1] });
  }
  const W = cont.clientWidth, H = cont.clientHeight;
  if (pts.length < 2 || !W || !H) { ocultar(); return; }
  const total = pts[pts.length - 1].d || 1;
  const ML = 30, MR = 6, MT = 6, MB = 14;
  let lo = Infinity, hi = -Infinity;
  pts.forEach(q => { if (q.ele < lo) lo = q.ele; if (q.ele > hi) hi = q.ele; });
  let emin = lo, emax = hi;
  if (emax - emin < 20) { const m = (emax + emin) / 2; emin = m - 10; emax = m + 10; }
  const pad = (emax - emin) * 0.08; emin -= pad; emax += pad;
  const X = dd => ML + dd / total * (W - ML - MR);
  const Y = e => MT + (1 - (e - emin) / (emax - emin)) * (H - MT - MB);
  const color = colorDe(f.properties);
  const fmtKm = v => v.toFixed(2).replace(/\.?0+$/, "").replace(".", ",");

  let s = `<svg width="${W}" height="${H}" style="display:block">`;
  for (const e of [lo, hi]) {   // cota mínima y máxima
    s += `<line x1="${ML}" x2="${W - MR}" y1="${Y(e).toFixed(1)}" y2="${Y(e).toFixed(1)}" stroke="#e3e3e3"/>`
       + `<text x="${ML - 4}" y="${(Y(e) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#777">${Math.round(e)}</text>`;
  }
  const km = total / 1000; let paso = 0.1;
  for (const cand of [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10]) { paso = cand; if (km / cand <= 5) break; }
  for (let k = 0; k * paso * 1000 <= total; k++) {
    const x = X(k * paso * 1000).toFixed(1);
    s += `<line x1="${x}" x2="${x}" y1="${MT}" y2="${H - MB}" stroke="#f0f0f0"/>`
       + `<text x="${x}" y="${H - 3}" text-anchor="middle" font-size="9" fill="#777">${fmtKm(k * paso)}${k === 0 ? " km" : ""}</text>`;
  }
  const linea = pts.map(q => `${X(q.d).toFixed(1)},${Y(q.ele).toFixed(1)}`);
  s += `<polygon points="${X(0).toFixed(1)},${H - MB} ${linea.join(" ")} ${X(total).toFixed(1)},${H - MB}" fill="${color}" fill-opacity=".15"/>`
     + `<polyline points="${linea.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
     + `<line id="fpLinea" y1="${MT}" y2="${H - MB}" stroke="#555" stroke-dasharray="3 3" style="display:none"/>`
     + `<circle id="fpPunto" r="4.5" fill="#fff" stroke="#1a1a1a" stroke-width="2" style="display:none"/></svg>`;
  cont.innerHTML = s;
  fichaPerfil = { pts, X, Y, ML, MR, W, total };

  cont.addEventListener("pointerdown", (ev) => {
    try { cont.setPointerCapture(ev.pointerId); } catch (e) {}   // sigue el dedo aunque se salga del gráfico
    hoverFichaPerfil(ev);
  });
  cont.addEventListener("pointermove", hoverFichaPerfil);
  cont.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") salirFichaPerfil(); });
}

function hoverFichaPerfil(ev) {
  const g = fichaPerfil; if (!g) return;
  const cont = document.getElementById("fichaPerfil"); if (!cont) return;
  const r = cont.getBoundingClientRect(), pts = g.pts;
  let d = (ev.clientX - r.left - g.ML) / (g.W - g.ML - g.MR) * g.total;
  d = Math.max(0, Math.min(g.total, d));
  let a = 0, b = pts.length - 1;
  while (b - a > 1) { const m = (a + b) >> 1; if (pts[m].d < d) a = m; else b = m; }
  const i = (d - pts[a].d < pts[b].d - d) ? a : b, q = pts[i];
  let i0 = i, i1 = i;   // pendiente local: ±30 m alrededor del punto
  while (i0 > 0 && q.d - pts[i0].d < 30) i0--;
  while (i1 < pts.length - 1 && pts[i1].d - q.d < 30) i1++;
  const dd = pts[i1].d - pts[i0].d;
  const pend = dd > 5 ? (pts[i1].ele - pts[i0].ele) / dd * 100 : null;
  const linea = document.getElementById("fpLinea"), punto = document.getElementById("fpPunto");
  if (linea && punto) {
    const x = g.X(q.d).toFixed(1);
    linea.setAttribute("x1", x); linea.setAttribute("x2", x); linea.style.display = "";
    punto.setAttribute("cx", x); punto.setAttribute("cy", g.Y(q.ele).toFixed(1)); punto.style.display = "";
  }
  const info = document.getElementById("fichaPerfilInfo");
  if (info) info.textContent = `km ${(q.d / 1000).toFixed(2).replace(".", ",")} · ${Math.round(q.ele)} m`
    + (pend !== null ? ` · ${pend > 0 ? "+" : pend < 0 ? "−" : ""}${Math.abs(pend).toFixed(0)} %` : "");
  ponerMarcadorPerfil(q.lat, q.lon);
}

function salirFichaPerfil() {
  const linea = document.getElementById("fpLinea"), punto = document.getElementById("fpPunto");
  if (linea) linea.style.display = "none";
  if (punto) punto.style.display = "none";
  const info = document.getElementById("fichaPerfilInfo");
  if (info) info.textContent = "Desliza sobre el perfil para ver cota y pendiente";
  if (markerPerfil) markerPerfil.getElement().style.display = "none";
}

function mostrarPopup(f, lngLat, aviso) {
  const p = f.properties; const color = colorDe(p);
  let dif = p.dificultad_color ? `<span style="color:${color};font-weight:600">${esc(p.dificultad_color)}</span>` : `<span style="color:#95a5a6">sin dificultad en OSM</span>`;
  const det = p.dificultad_detalle_m || {};
  if (Object.keys(det).length > 1) {
    const partes = Object.entries(det).sort((a, b) => b[1] - a[1]).map(([c, m]) => `${esc(c)} ${m} m`).join(" · ");
    dif += `<br><span style="color:#777;font-size:12px">${partes}</span>`;
  }
  const fila = (k, v) => (v === null || v === undefined || v === "") ? "" : `<tr><td>${k}</td><td>${v}</td></tr>`;
  const id = idDe(f);
  const dentro = estaEnRuta(id);
  const cargado = !!p.perfil_cargado;
  const asc = cargado ? Math.round(Number(p.ascenso_m) || 0) : 0;
  let resumen = `${fmtLong(Math.round(Number(p.longitud_m) || 0))} · ↓${Math.round(Number(p.caida_m) || 0)} m${asc > 0 ? ` · ↑${asc} m` : ""} · ${p.pendiente_media_pct} %`;
  resumen += `<br>Inicio ${p.elev_inicio_m} m → fin ${p.elev_final_m} m`;
  if (aviso) resumen += `<br><span style="color:#b3261e">${esc(aviso)}</span>`;
  else if (!cargado) resumen += `<br><span style="color:#8a939b">Calculando perfil…</span>`;

  const ficha = document.getElementById("ficha");
  ficha.innerHTML = `
      <button class="cerrar" title="Cerrar">×</button>
      <h3>${esc(p.nombre || "(sin nombre)")} ${badgeFiab(p)}</h3>
      <div class="ficha-resumen">${resumen}</div>
      ${cargado ? `<div id="fichaPerfil" title="Pasa el cursor o desliza el dedo para ver cota y pendiente"></div><div id="fichaPerfilInfo">Desliza sobre el perfil para ver cota y pendiente</div>` : ""}
      <table>
        ${fila("Dificultad", dif)}
        ${fila("Longitud", fmtLong(p.longitud_m))}
        ${fila("Caída", p.caida_m + " m")}
        ${fila("Pend. media", p.pendiente_media_pct + " %")}
        ${fila("Pend. máx 100 m", cargado ? p.pendiente_max_100m_pct + " %" : null)}
        ${fila("Tipo", esc(p.mtb_type))}
        ${fila("Superficie", esc(p.surface))}
        ${fila("Tramos OSM", p.n_tramos)}
      </table>
      <button class="popup-add ${dentro ? "in" : ""}" id="popupAdd" data-id="${id}">
        ${dentro ? "Quitar de mi ruta" : "Añadir a mi ruta"}
      </button>`;
  ficha.style.display = "block"; document.getElementById("mapwrap").classList.add("conFicha");
  ficha.scrollTop = 0;
  if (cargado) dibujarPerfilFicha(f);
  ficha.querySelector(".cerrar").addEventListener("click", deseleccionar);
  document.getElementById("popupAdd").addEventListener("click", (ev) => { ev.stopPropagation(); toggleRuta(id); });
}

function deseleccionar() {
  seleccionada = null;
  salirFichaPerfil();
  document.getElementById("ficha").style.display = "none"; document.getElementById("mapwrap").classList.remove("conFicha");
  if (map.getLayer("tramos-sel")) map.setFilter("tramos-sel", ["==", ["get", "bajada_id"], ""]);
  const src = map.getSource("sel-flechas");
  if (src) src.setData({ type: "FeatureCollection", features: [] });
  document.querySelectorAll(".card.sel").forEach(c => c.classList.remove("sel"));
}

function ajustarVista() {
  const b = new maplibregl.LngLatBounds();
  const ptsInter = miRuta.filter(esPunto).map(id => puntosInter.get(id)).filter(Boolean);
  if (ptsInter.length && !miRuta.some(id => !esPunto(id))) {   // ruta solo con puntos: se encuadran ellos
    ptsInter.forEach(pt => b.extend([pt[1], pt[0]]));
    map.fitBounds(b, { padding: 80, duration: 0, maxZoom: 15 });
    return;
  }
  // Con la caché local puede haber bajadas de varias zonas: se encuadra la ruta o, si no hay, la última zona cargada
  let lista = miRuta.filter(id => !esPunto(id)).map(id => porId.get(id)).filter(Boolean);
  if (!lista.length) {
    const ultimo = Math.max(0, ...features.map(f => tiempoCarga.get(idDe(f)) || 0));
    lista = features.filter(f => ultimo - (tiempoCarga.get(idDe(f)) || 0) < 2 * 3600 * 1000);
  }
  if (!lista.length) lista = features;
  lista.forEach(f => f.geometry.coordinates.forEach(c => b.extend([c[0], c[1]])));
  if (!b.isEmpty()) map.fitBounds(b, { padding: 60, duration: 0 });
}

