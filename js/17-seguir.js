// 17-seguir.js (líneas 2400-2539 del index.html original)
// ---- Seguir ruta: tu posición en el mapa y en el perfil de altimetría ----
let siguiendo = false, seguirPts = null, seguirUlt = null, textoSeguir = "", wakeLock = null;
const btnSeguir = document.getElementById("btnSeguir");

function mostrarBotonSeguir(ver) {
  btnSeguir.hidden = !ver;
  document.getElementById("botonesRuta").classList.toggle("dos", ver);
}

// Recorrido completo (sin reducir) con distancia acumulada, para situarte con precisión
function construirSeguirPts(segmentos) {
  const pts = []; let d = 0, prev = null, eleAnt = null;
  for (const sg of segmentos) for (const p of sg.puntos) {
    if (prev) d += haversine([prev[0], prev[1]], [p[0], p[1]]);
    prev = p;
    const ele = (p[2] === null || p[2] === undefined) ? eleAnt : p[2];
    if (ele !== null) eleAnt = ele;
    pts.push({ d, ele, lat: p[0], lon: p[1] });
  }
  const primero = pts.find(q => q.ele !== null);
  pts.forEach(q => { if (q.ele === null) q.ele = primero ? primero.ele : null; });
  return pts;
}

function idxPorDist(d) {   // último punto con distancia acumulada <= d
  const P = seguirPts; let a = 0, b = P.length - 1;
  while (b - a > 1) { const m = (a + b) >> 1; if (P[m].d <= d) a = m; else b = m; }
  return a;
}

// Proyecta tu posición sobre la ruta: devuelve distancia recorrida, cota y a cuántos metros estás de la línea
function snapRuta(lat, lon) {
  const P = seguirPts, kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
  const evaluar = (i0, i1) => {
    let best = null;
    for (let i = i0; i < i1; i++) {
      const a = P[i], b = P[i + 1];
      const ax = (a.lon - lon) * kx, ay = (a.lat - lat) * ky, bx = (b.lon - lon) * kx, by = (b.lat - lat) * ky;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      const dist = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || dist < best.dist - 5) best = { dist, i, t };   // a igualdad (±5 m) se queda el primer paso
    }
    return best;
  };
  let r = null;
  if (seguirUlt) {   // se busca cerca de donde ibas (no salta a otro tramo que pase por el mismo sitio)
    const i0 = idxPorDist(Math.max(0, seguirUlt.d - 250)), i1 = Math.min(P.length - 1, idxPorDist(seguirUlt.d + 1000) + 1);
    if (i1 > i0) r = evaluar(i0, i1);
  }
  if (!r || r.dist > 60) {
    const g = evaluar(0, P.length - 1);
    if (g && (!r || g.dist < r.dist - 40)) r = g;
  }
  const a = P[r.i], b = P[r.i + 1];
  return { d: a.d + r.t * (b.d - a.d), ele: (a.ele === null || b.ele === null) ? null : a.ele + r.t * (b.ele - a.ele), dist: r.dist, i: r.i };
}

function seguirActualizar() {
  if (!siguiendo || !seguirPts || seguirPts.length < 2 || !ubic.pos) return;
  const s = snapRuta(ubic.pos.lat, ubic.pos.lon);
  seguirUlt = s;
  const total = seguirPts[seguirPts.length - 1].d, P = seguirPts;
  let i0 = s.i, i1 = s.i + 1;
  while (i0 > 0 && s.d - P[i0].d < 30) i0--;
  while (i1 < P.length - 1 && P[i1].d - s.d < 30) i1++;
  const dd = P[i1].d - P[i0].d;
  const pend = (dd > 5 && P[i1].ele !== null && P[i0].ele !== null) ? (P[i1].ele - P[i0].ele) / dd * 100 : null;
  const km = m => (m / 1000).toFixed(2).replace(".", ",");
  let t = `Tú · km ${km(s.d)}` + (s.ele !== null ? ` · ${Math.round(s.ele)} m` : "")
        + (pend !== null ? ` · ${pend > 0 ? "+" : pend < 0 ? "−" : ""}${Math.abs(pend).toFixed(0)} %` : "")
        + ` · faltan ${km(Math.max(0, total - s.d))} km`;
  if (s.dist > 40) t += ` · ⚠ a ${Math.round(s.dist)} m de la ruta`;
  textoSeguir = t;
  const info = document.getElementById("perfilInfo");
  if (info) info.textContent = t;
  if (dd > 5) ubic.rumboRuta = rumboEntre(P[i0].lat, P[i0].lon, P[i1].lat, P[i1].lon);   // sentido de la ruta en tu punto (para orientar el mapa)
  // con zoom, la ventana del perfil te acompaña (se redibuja cuando te has movido un poco)
  if (perfilZoom > 1 && perfilDatos && perfilGeom && !perfilScrub && Math.abs(s.d - perfilCentroDib) > Math.max(5, perfilGeom.span * 0.01)) dibujarPerfil();
  else actualizarYoPerfil();
}

// Marca tu posición en el gráfico de altimetría
function actualizarYoPerfil() {
  const cont = document.getElementById("perfilGraf"), svg = cont && cont.querySelector("svg");
  if (!svg) return;
  let g = svg.querySelector("#pfYo");
  if (!siguiendo || !seguirUlt || seguirUlt.ele === null || !perfilGeom || !perfilGeom.X) { if (g) g.remove(); return; }
  const NS = "http://www.w3.org/2000/svg";
  if (!g) {
    g = document.createElementNS(NS, "g"); g.setAttribute("id", "pfYo"); g.setAttribute("pointer-events", "none");
    const l = document.createElementNS(NS, "line"); l.setAttribute("stroke", "#1a73e8"); l.setAttribute("stroke-width", "2");
    const c = document.createElementNS(NS, "circle"); c.setAttribute("r", "7"); c.setAttribute("stroke", "#fff"); c.setAttribute("stroke-width", "2.5");
    g.appendChild(l); g.appendChild(c); svg.appendChild(g);
  }
  const x = perfilGeom.X(seguirUlt.d), y = perfilGeom.Y(seguirUlt.ele), H = cont.clientHeight;
  g.style.display = (x < perfilGeom.ML - 1 || x > perfilGeom.W - perfilGeom.MR + 1) ? "none" : "";
  const l = g.firstChild, c = g.lastChild;
  l.setAttribute("x1", x); l.setAttribute("x2", x); l.setAttribute("y1", 8); l.setAttribute("y2", H - 18);
  c.setAttribute("cx", x); c.setAttribute("cy", y);
  c.setAttribute("fill", seguirUlt.dist > 40 ? "#e65100" : "#1a73e8");
}

async function pedirWakeLock() {   // mantiene la pantalla encendida mientras sigues la ruta
  try { if (navigator.wakeLock && siguiendo && document.visibilityState === "visible") wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
document.addEventListener("visibilitychange", () => { if (siguiendo) pedirWakeLock(); });

function iniciarSeguir() {
  if (!rutaGenerada) return;
  seguirPts = construirSeguirPts(rutaGenerada.segmentos);
  if (seguirPts.length < 2) return;
  siguiendo = true; seguirUlt = null; textoSeguir = "";
  document.body.classList.add("modo-seguir");   // oculta la casilla de zona y los pasos, y estrecha la barra del panel
  btnSeguir.classList.add("activo"); btnSeguir.textContent = "■ Parar";
  document.getElementById("mapwrap").classList.add("conPerfil", "hayPerfil");   // por si habías cerrado el perfil
  dibujarPerfil();
  setPanel(false);
  ubic.activar(16);
  if (ubic.pos) seguirActualizar(); else { document.getElementById("perfilInfo").textContent = "Buscando tu posición GPS…"; }
  pedirWakeLock();
}

function detenerSeguir() {
  if (!siguiendo && !btnSeguir.classList.contains("activo")) return;
  siguiendo = false; seguirUlt = null; seguirPts = null; textoSeguir = "";
  try { clearTimeout(ubic.pausaT); } catch (e) {}
  document.body.classList.remove("modo-seguir");
  btnSeguir.classList.remove("activo"); btnSeguir.textContent = "▶ Seguir ruta";   // se restaura el botón antes que nada
  try { ubic.detener(); } catch (e) { console.error(e); }
  try { if (map.getBearing() !== 0 || map.getPitch() !== 0) map.easeTo({ bearing: 0, pitch: 0, duration: 300 }); } catch (e) {}   // vuelve a norte arriba
  try { actualizarYoPerfil(); actualizarBotonesPerfil(); } catch (e) { console.error(e); }
  const info = document.getElementById("perfilInfo"); if (info) info.textContent = "";
  try { if (wakeLock) wakeLock.release(); } catch (e) {}
  wakeLock = null;
  [0, 260].forEach(ms => setTimeout(() => map.resize(), ms));   // la barra del panel cambia de alto al salir del modo seguir
}

btnSeguir.addEventListener("click", () => { if (siguiendo) { detenerSeguir(); setPanel(false); } else iniciarSeguir(); });   // al parar: mismo estado que justo después de generar la ruta

