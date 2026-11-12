/**
 * KONG GYM · Servidor de la app (Cloudflare Worker + base D1)
 * -----------------------------------------------------------
 * Reemplaza al Google Sheet: guarda socios, pagos, entradas, ventas,
 * inventario, caja y préstamos, y hace los mismos cálculos que hacían
 * las fórmulas del Sheet (vencimientos, estados, panel, existencias…).
 *
 *  POST /api            → app de administración (con PIN de dueño o recepción)
 *  GET  /api/socio      → app de socios (ID + últimos 4 dígitos de WhatsApp)
 *  Todo lo demás        → archivos de la app (index.html, íconos…)
 */

const TZ = 'America/Mexico_City';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const METODOS = ['Efectivo', 'Transferencia', 'Tarjeta'];
const CATEGORIAS = ['Compras', 'Servicios', 'Nómina', 'Obra y mejoras', 'Pago de préstamo', 'Retiro del dueño'];
const ORIGENES = ['Caja', 'Cuenta / tarjeta'];
const PERIODOS = ['Visita', 'Semana', 'Mensual', 'Trimestral', 'Semestral', 'Anual'];
const MAX_FALLOS = 8, BLOQUEO_MIN = 10;
const SOCIO_INTENTOS = 5, SOCIO_BLOQUEO_MIN = 15;

const DEFAULTS = {
  gym: 'Kong Gym', lada: '52', dias_anticipacion: '1', tolerancia: '1', hora_gracias: '8:00 PM',
  aviso_minimo: '5', umbral_asistencia: '7', personal: 'Jennifer, Ariadna, Dueño',
  meses_periodo: JSON.stringify({ Visita: 0, Semana: 0, Mensual: 1, Trimestral: 3, Semestral: 6, Anual: 12 }),
  tarifas: JSON.stringify({
    Individual: { Visita: 50, Semana: 200, Mensual: 450, Trimestral: 1200, Semestral: 2300, Anual: 4450 },
    Pareja: { Visita: 50, Semana: 200, Mensual: 400, Trimestral: 1200, Semestral: 2300, Anual: 4450 },
    Estudiante: { Visita: 50, Semana: 200, Mensual: 350, Trimestral: 1200, Semestral: 2300, Anual: 4450 }
  }),
  msg_recordatorio: 'Qué hay {nombre}! Te recordamos que tu membresía {membresia} en {gym} vence el {fecha}. El monto de renovación es de ${monto}.',
  msg_vencido: 'Hola {nombre}, te queremos de vuelta en {gym}. ¿Te vemos pronto?',
  msg_visita: 'Hola {nombre}, ¡gracias por visitarnos hoy en {gym}!',
  msg_nuevo: '¡Bienvenido a {gym}, {nombre}! Gracias por activar tu membresía {membresia}.'
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT)`,
  `CREATE TABLE IF NOT EXISTS socios (num INTEGER PRIMARY KEY, id TEXT UNIQUE, nombre TEXT, wa TEXT, membresia TEXT, plan TEXT,
     inscripcion TEXT, nacimiento TEXT, correo TEXT, emergencia TEXT, activo INTEGER DEFAULT 1, notas TEXT, creado TEXT)`,
  `CREATE TABLE IF NOT EXISTS pagos (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, socio_id TEXT, periodo TEXT, monto REAL, metodo TEXT,
     recibio TEXT, notas TEXT, lista REAL, inicia TEXT, vence TEXT, turno TEXT, creado TEXT)`,
  `CREATE INDEX IF NOT EXISTS pagos_socio ON pagos(socio_id)`,
  `CREATE TABLE IF NOT EXISTS asistencias (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, socio_id TEXT, hora TEXT, registro TEXT, UNIQUE(fecha, socio_id))`,
  `CREATE TABLE IF NOT EXISTS productos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT UNIQUE, precio REAL, recibidas INTEGER DEFAULT 0, minimo INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ventas (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, hora TEXT, socio_id TEXT, producto TEXT, cantidad INTEGER,
     precio REAL, total REAL, metodo TEXT, notas TEXT, turno TEXT)`,
  `CREATE TABLE IF NOT EXISTS turnos (id TEXT PRIMARY KEY, persona TEXT, fecha TEXT, hora TEXT, dejo REAL, inicial REAL, dif_apertura REAL,
     cobros REAL, ventas REAL, salidas REAL, esperado REAL, contado REAL, diferencia REAL, motivo TEXT, transferencias REAL, tarjeta REAL,
     fecha_cierre TEXT, hora_cierre TEXT, estado TEXT)`,
  `CREATE TABLE IF NOT EXISTS salidas (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, hora TEXT, categoria TEXT, concepto TEXT, pagado_a TEXT,
     monto REAL, origen TEXT, prestamo TEXT, turno TEXT, registro TEXT, notas TEXT)`,
  `CREATE TABLE IF NOT EXISTS prestamos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT UNIQUE, monto REAL, previo REAL, abono REAL, notas TEXT)`,
  `CREATE TABLE IF NOT EXISTS bloqueos (clave TEXT PRIMARY KEY, n INTEGER, hasta INTEGER)`
];

/* ------------------------------------------------------------------ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/socio') return cors(await safe(() => apiSocio(env, url)));
    if (url.pathname === '/api' || url.pathname === '/api/') {
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      if (request.method !== 'POST') return json({ ok: false, error: 'metodo' }, 405);
      let req;
      try { req = JSON.parse(await request.text() || '{}'); } catch (e) { return json({ ok: false, error: 'formato' }); }
      return safe(() => apiAdmin(env, req));
    }
    return env.ASSETS.fetch(request);
  }
};

async function safe(fn) {
  try { const r = await fn(); return r instanceof Response ? r : json(r); }
  catch (err) { console.error(err && err.stack || err); return json({ ok: false, error: 'servidor', detalle: String(err && err.message || err) }); }
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set('access-control-allow-origin', '*'); h.set('access-control-allow-methods', 'GET, POST, OPTIONS'); h.set('access-control-allow-headers', 'content-type');
  return new Response(res.body, { status: res.status, headers: h });
}

/* ---------------------------- Fechas ------------------------------ */
function ahoraMX(fecha) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(fecha || new Date()).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${Number(p.hour)}:${p.minute}` };
}
const d2n = ymd => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 864e5;
const n2d = n => new Date(n * 864e5).toISOString().slice(0, 10);
const addDays = (ymd, k) => n2d(d2n(ymd) + k);
function addMonths(ymd, k) { // como EDATE: conserva el día o usa el último del mes
  let y = +ymd.slice(0, 4), m = +ymd.slice(5, 7) - 1 + k; const d = +ymd.slice(8, 10);
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
const dmy = ymd => ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}` : '';
const eom = ymd => n2d(d2n(addMonths(ymd.slice(0, 7) + '-01', 1)) - 1);
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function finPeriodo(cfg, desde, periodo) {
  if (periodo === 'Visita') return desde;
  if (periodo === 'Semana') return addDays(desde, 7);
  const m = cfg.meses_periodo[periodo];
  return m === undefined ? '' : addMonths(desde, m);
}

/* ---------------------------- Base -------------------------------- */
let esquemaListo = false;
async function db(env) {
  if (!esquemaListo) {
    await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
    // Columnas agregadas después (fondo que se deja al cerrar y retiro del corte)
    const cols = (await all(env.DB, 'PRAGMA table_info(turnos)')).map(c => c.name);
    for (const [c, t] of [['fondo', 'REAL'], ['retiro', 'REAL'], ['retiro_a', 'TEXT']])
      if (!cols.includes(c)) await env.DB.prepare(`ALTER TABLE turnos ADD COLUMN ${c} ${t}`).run();
    esquemaListo = true;
  }
  return env.DB;
}
const all = async (D, q, ...b) => (await D.prepare(q).bind(...b).all()).results || [];
const one = async (D, q, ...b) => await D.prepare(q).bind(...b).first();
const run = (D, q, ...b) => D.prepare(q).bind(...b).run();

async function leerConfig(D) {
  const rows = await all(D, 'SELECT clave, valor FROM config');
  const c = Object.assign({}, DEFAULTS); rows.forEach(r => { c[r.clave] = r.valor; });
  c.tarifas = JSON.parse(c.tarifas); c.meses_periodo = JSON.parse(c.meses_periodo);
  c.dias_anticipacion = Number(c.dias_anticipacion) || 0; c.tolerancia = Number(c.tolerancia) || 0;
  c.aviso_minimo = Number(c.aviso_minimo) || 5; c.umbral_asistencia = Number(c.umbral_asistencia) || 7;
  c.personalList = String(c.personal || '').split(',').map(x => x.trim()).filter(Boolean);
  return c;
}
const setConfig = (D, k, v) => run(D, 'INSERT INTO config(clave, valor) VALUES(?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor', k, String(v));

async function hash(texto) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kong-gym::' + texto));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* --------------------------- Acceso ------------------------------- */
async function bloqueo(D, clave) {
  const r = await one(D, 'SELECT n, hasta FROM bloqueos WHERE clave = ?', clave);
  if (!r) return { n: 0, bloqueado: false };
  if (r.hasta && r.hasta < Date.now()) { await run(D, 'DELETE FROM bloqueos WHERE clave = ?', clave); return { n: 0, bloqueado: false }; }
  return { n: r.n, hasta: r.hasta };
}
async function fallo(D, clave, max, min) {
  const b = await bloqueo(D, clave);
  const n = b.n + 1;
  await run(D, 'INSERT INTO bloqueos(clave, n, hasta) VALUES(?, ?, ?) ON CONFLICT(clave) DO UPDATE SET n = excluded.n, hasta = excluded.hasta', clave, n, Date.now() + min * 60000);
  return Math.max(0, max - n);
}

async function auth(D, pinRaw) {
  const pin = String(pinRaw || '').replace(/\D/g, '');
  const b = await bloqueo(D, 'pin');
  if (b.n >= MAX_FALLOS) return { ok: false, error: 'bloqueado', minutos: BLOQUEO_MIN };
  const cfg = await all(D, "SELECT clave, valor FROM config WHERE clave IN ('pin_dueno', 'pin_recepcion')");
  const h = Object.fromEntries(cfg.map(r => [r.clave, r.valor]));
  if (!h.pin_dueno) return { ok: false, error: 'sin_configurar' };
  const x = await hash(pin);
  if (pin && x === h.pin_dueno) return { ok: true, rol: 'dueno' };
  if (pin && x === h.pin_recepcion) return { ok: true, rol: 'recepcion' };
  const restantes = await fallo(D, 'pin', MAX_FALLOS, BLOQUEO_MIN);
  return { ok: false, error: 'pin', restantes };
}

/* -------------------------- API admin ----------------------------- */
async function apiAdmin(env, req) {
  const D = await db(env);
  if (req.accion === 'importar') return importar(D, req);
  const a = await auth(D, req.pin);
  if (!a.ok) return a;
  const rol = a.rol;
  const write = async fn => { const r = await fn(); if (!r || !r.ok) return r; r.datos = await datos(D, rol); return r; };
  switch (req.accion) {
    case 'login': return { ok: true, rol };
    case 'datos': return datos(D, rol);
    case 'socio_guardar': return write(() => socioGuardar(D, rol, req.socio || {}));
    case 'pago': return write(() => pago(D, rol, req.pago || {}));
    case 'asistencia': return write(() => asistencia(D, rol, req));
    case 'venta': return write(() => venta(D, rol, req.venta || {}));
    case 'recibir': return write(() => recibir(D, req));
    case 'producto_guardar': if (rol !== 'dueno') return { ok: false, error: 'permiso' }; return write(() => productoGuardar(D, req.producto || {}));
    case 'turno_abrir': return write(() => turnoAbrir(D, req));
    case 'turno_cerrar': return write(() => turnoCerrar(D, req));
    case 'corte_detalle': return corteDetalle(D, rol, req.id);
    case 'salida': return write(() => salida(D, rol, req.salida || {}));
    case 'ajustes_leer': if (rol !== 'dueno') return { ok: false, error: 'permiso' }; return ajustesLeer(D);
    case 'ajustes_guardar': if (rol !== 'dueno') return { ok: false, error: 'permiso' }; return write(() => ajustesGuardar(D, req.ajustes || {}));
    case 'exportar': if (rol !== 'dueno') return { ok: false, error: 'permiso' }; return exportar(D);
    default: return { ok: false, error: 'accion' };
  }
}

/* --------------------- Cálculo de cada socio ---------------------- */
function primerNombre(n) { const w = String(n || '').trim().split(/\s+/)[0] || ''; return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }
function waUrl(cfg, wa, plantilla, s, extra) {
  const n = String(wa || '').replace(/\D/g, '').slice(-10);
  if (!n) return '';
  const txt = String(plantilla || '').replace(/\{nombre\}/g, primerNombre(s.nombre)).replace(/\{membresia\}/g, s.membresia || '')
    .replace(/\{gym\}/g, cfg.gym).replace(/\{fecha\}/g, extra.fecha || '').replace(/\{monto\}/g, extra.monto || '');
  return `https://wa.me/${cfg.lada}${n}?text=${encodeURIComponent(txt)}`;
}
function calcularSocios(cfg, socios, pagos, hoy) {
  const porSocio = {};
  pagos.forEach(p => { const k = p.socio_id; (porSocio[k] = porSocio[k] || []).push(p); });
  return socios.map(s => {
    const ps = porSocio[s.id] || [];
    const maxVence = ps.reduce((m, p) => (p.vence && p.vence > m ? p.vence : m), '');
    const maxFecha = ps.reduce((m, p) => (p.fecha && p.fecha > m ? p.fecha : m), '');
    let vence = maxVence;
    if (!vence && s.inscripcion && s.plan) vence = finPeriodo(cfg, s.inscripcion, s.plan);
    const ultimo = maxFecha || (s.inscripcion && s.plan ? s.inscripcion : '');
    const dias = vence ? d2n(vence) - d2n(hoy) : null;
    const monto = ((cfg.tarifas[s.membresia] || {})[s.plan]) || 0;
    const estado = !s.activo ? 'Baja' : !vence ? 'Sin pagos' : dias < 0 ? 'Vencido' : dias === 0 ? 'Vence hoy' : dias <= cfg.dias_anticipacion ? 'Por vencer' : 'Al corriente';
    const graciasVisita = !!(s.activo && s.plan === 'Visita' && (s.inscripcion === hoy || ultimo === hoy));
    const graciasNuevo = !!(s.activo && s.plan && s.plan !== 'Visita' && s.inscripcion === hoy);
    return {
      fila: s.num, id: s.id, nombre: s.nombre, wa: s.wa || '', membresia: s.membresia || '', plan: s.plan || '',
      inscripcion: dmy(s.inscripcion), nacimiento: dmy(s.nacimiento), correo: s.correo || '', emergencia: s.emergencia || '',
      activo: s.activo ? 'Sí' : 'No', notas: s.notas || '', monto, ultimoPago: dmy(ultimo), vence: dmy(vence), dias, estado,
      url: s.wa && vence && estado !== 'Baja' ? waUrl(cfg, s.wa, estado === 'Vencido' ? cfg.msg_vencido : cfg.msg_recordatorio, s,
        { fecha: dmy(vence), monto: Math.round(monto).toLocaleString('en-US') }) : '',
      graciasVisita, graciasNuevo,
      urlVisita: graciasVisita ? waUrl(cfg, s.wa, cfg.msg_visita, s, { fecha: dmy(hoy) }) : '',
      urlNuevo: graciasNuevo ? waUrl(cfg, s.wa, cfg.msg_nuevo, s, { fecha: dmy(hoy) }) : '',
      _vence: vence, _ins: s.inscripcion
    };
  });
}

/* ----------------------------- Datos ------------------------------ */
async function datos(D, rol) {
  const cfg = await leerConfig(D);
  const { ymd: hoy, hm } = ahoraMX();
  const mes = hoy.slice(0, 7), mesIni = mes + '-01', mesFin = eom(hoy);
  const [socRows, pagRows, venRows, proRows, asiRows, turRows, salRows, preRows] = await Promise.all([
    all(D, 'SELECT * FROM socios ORDER BY num'),
    all(D, 'SELECT * FROM pagos ORDER BY id'),
    all(D, 'SELECT * FROM ventas ORDER BY id'),
    all(D, 'SELECT * FROM productos ORDER BY id'),
    all(D, 'SELECT socio_id, fecha, hora FROM asistencias WHERE fecha >= ? AND fecha <= ?', mesIni, mesFin),
    all(D, 'SELECT * FROM turnos ORDER BY fecha, hora'),
    all(D, 'SELECT * FROM salidas ORDER BY id'),
    all(D, 'SELECT * FROM prestamos ORDER BY id')
  ]);
  const socios = calcularSocios(cfg, socRows, pagRows, hoy);
  const nombreDe = Object.fromEntries(socRows.map(s => [s.id, s.nombre]));
  const out = {
    ok: true, rol, hoy, hora: hm, gym: cfg.gym, horaGracias: cfg.hora_gracias,
    periodos: PERIODOS, tarifas: cfg.tarifas, membresias: Object.keys(cfg.tarifas), planes: PERIODOS
  };
  out.socios = socios.map(({ _vence, _ins, ...s }) => s);

  // Asistencia del mes
  const nDias = +mesFin.slice(8, 10);
  const porDia = Array.from({ length: 31 }, (_, i) => (i < nDias ? 0 : null));
  const asis = {};
  asiRows.forEach(r => {
    const a = asis[r.socio_id] = asis[r.socio_id] || { dias: 0, ultima: '', hoy: '' };
    a.dias++; if (r.fecha > a.ultima) a.ultima = r.fecha;
    if (r.fecha === hoy) a.hoy = r.hora || '✓';
    porDia[+r.fecha.slice(8, 10) - 1]++;
  });
  const asistencia = { mes, mesActual: mes, umbral: cfg.umbral_asistencia, socios: {}, porDia };
  const tope = d2n(hoy < mesFin ? hoy : mesFin);
  socios.forEach(s => {
    const a = asis[s.id] || { dias: 0, ultima: '', hoy: '' };
    let sinVenir = null, aviso = '';
    if (s.estado !== 'Baja') {
      const base = a.dias ? a.ultima : (s._ins && s._ins > mesIni ? s._ins : mesIni);
      sinVenir = Math.max(0, tope - d2n(base));
      if (sinVenir > cfg.umbral_asistencia) aviso = a.dias ? `⚠ ${sinVenir} días sin venir` : '⚠ Aún no viene este mes';
    }
    asistencia.socios[s.id] = { hoy: a.hoy, dias: a.dias, ultima: dmy(a.ultima), sinVenir, aviso };
  });
  out.asistencia = asistencia;

  // Pagos y ventas
  out.pagos = pagRows.slice(-400).map(p => ({
    fila: p.id, fecha: p.fecha, socio: `${p.socio_id} - ${nombreDe[p.socio_id] || ''}`, id: p.socio_id, nombre: nombreDe[p.socio_id] || '',
    periodo: p.periodo, monto: p.monto, metodo: p.metodo, recibio: p.recibio, notas: p.notas || '', lista: p.lista || 0,
    inicia: p.inicia || '', vence: p.vence || '', turno: p.turno || ''
  }));
  out.ventas = venRows.slice(-300).map(v => ({
    fila: v.id, fecha: v.fecha, socio: v.socio_id ? `${v.socio_id} - ${nombreDe[v.socio_id] || ''}` : '', producto: v.producto,
    cantidad: v.cantidad, precio: v.precio, total: v.total, metodo: v.metodo, notas: v.notas || '', turno: v.turno || ''
  }));

  // Inventario
  out.avisoMinimo = cfg.aviso_minimo;
  const vend = {}, acum = {};
  venRows.forEach(v => { vend[v.producto] = (vend[v.producto] || 0) + v.cantidad; acum[v.producto] = (acum[v.producto] || 0) + v.total; });
  out.productos = proRows.map(p => {
    const vendidas = vend[p.nombre] || 0, existencia = (p.recibidas || 0) - vendidas;
    const min = p.minimo === null || p.minimo === undefined ? cfg.aviso_minimo : p.minimo;
    return { fila: p.id, nombre: p.nombre, precio: p.precio, recibidas: p.recibidas || 0, vendidas, existencia,
      minimo: p.minimo === undefined ? null : p.minimo, estado: existencia <= 0 ? 'Agotado' : existencia <= min ? 'Pocas piezas' : 'OK', acumulado: acum[p.nombre] || 0 };
  });

  // Panel
  const cuenta = e => socios.filter(s => s.estado === e).length;
  const activosL = socios.filter(s => ['Al corriente', 'Por vencer', 'Vence hoy'].includes(s.estado));
  const enMes = (f, ini, fin) => f >= ini && f <= fin;
  const pagMes = pagRows.filter(p => enMes(p.fecha, mesIni, mesFin)), venMes = venRows.filter(v => enMes(v.fecha, mesIni, mesFin));
  const activos = activosL.length, vencidos = cuenta('Vencido');
  const porMembresia = {}; Object.keys(cfg.tarifas).forEach(m => { porMembresia[m] = activosL.filter(s => s.membresia === m).length; });
  out.panel = {
    activos, porVencer: cuenta('Por vencer') + cuenta('Vence hoy'), vencidos, sinPagos: cuenta('Sin pagos'), bajas: cuenta('Baja'),
    pagosMes: pagMes.length, porMembresia, porAgotarse: out.productos.filter(p => p.estado !== 'OK').length
  };
  if (rol === 'dueno') {
    const mens = pagMes.reduce((a, p) => a + p.monto, 0), vts = venMes.reduce((a, v) => a + v.total, 0);
    Object.assign(out.panel, {
      ingresoMes: mens + vts, mensualidadesMes: mens, ventasMes: vts, renovacion: activos + vencidos ? activos / (activos + vencidos) : 0,
      metodos: METODOS.map(m => ({ metodo: m, monto: pagMes.filter(p => p.metodo === m).reduce((a, p) => a + p.monto, 0) + venMes.filter(v => v.metodo === m).reduce((a, v) => a + v.total, 0) })),
      meses: Array.from({ length: 12 }, (_, i) => {
        const ini = addMonths(mesIni, i - 11), fin = eom(ini);
        const pm = pagRows.filter(p => enMes(p.fecha, ini, fin)), vm = venRows.filter(v => enMes(v.fecha, ini, fin));
        const a = pm.reduce((x, p) => x + p.monto, 0), b = vm.reduce((x, v) => x + v.total, 0);
        return { mes: `${MESES[+ini.slice(5, 7) - 1]} ${ini.slice(2, 4)}`, mensualidades: a, pagos: pm.length, ventas: b, total: a + b };
      })
    });
    // ARPU: ingreso por mensualidades (sin ventas) entre socios activos ahora, del último mes ya cerrado
    const mesArpuIni = addMonths(mesIni, -1), mesArpuFin = eom(mesArpuIni);
    const pagArpu = pagRows.filter(p => enMes(p.fecha, mesArpuIni, mesArpuFin));
    const socioMem = Object.fromEntries(socios.map(s => [s.id, s.membresia]));
    const ingArpuPorTipo = {};
    pagArpu.forEach(p => { const t = socioMem[p.socio_id]; if (t) ingArpuPorTipo[t] = (ingArpuPorTipo[t] || 0) + p.monto; });
    const ingArpu = pagArpu.reduce((a, p) => a + p.monto, 0);
    const pagadores = new Set(pagArpu.map(p => p.socio_id)).size;
    const porTipoArpu = {};
    Object.keys(cfg.tarifas).forEach(t => {
      const n = porMembresia[t] || 0, ing = ingArpuPorTipo[t] || 0;
      porTipoArpu[t] = { activos: n, ingreso: ing, arpu: n ? Math.round(ing / n) : 0, tarifa: cfg.tarifas[t] && cfg.tarifas[t].Mensual || 0 };
    });
    out.panel.arpu = {
      mes: `${MESES[+mesArpuIni.slice(5, 7) - 1]} ${mesArpuIni.slice(2, 4)}`,
      activos, ingreso: ingArpu, arpu: activos ? Math.round(ingArpu / activos) : 0,
      pagadores, arppu: pagadores ? Math.round(ingArpu / pagadores) : 0,
      porTipo: porTipoArpu,
      tendencia: Array.from({ length: 6 }, (_, i) => {
        const ini = addMonths(mesArpuIni, i - 5), fin = eom(ini);
        const pm = pagRows.filter(p => enMes(p.fecha, ini, fin));
        const ing = pm.reduce((a, p) => a + p.monto, 0);
        return { mes: `${MESES[+ini.slice(5, 7) - 1]} ${ini.slice(2, 4)}`, arpu: activos ? Math.round(ing / activos) : 0, ingreso: ing };
      })
    };
  }

  // Caja
  out.caja = caja(cfg, rol, turRows, salRows, preRows, pagRows, venRows, nombreDe);
  return out;
}

function horaPago(p) {
  const d = new Date(p.creado || '');
  return isNaN(d) ? { fecha: p.fecha, hora: '' } : (x => ({ fecha: x.ymd, hora: x.hm }))(ahoraMX(d));
}
function sumasTurno(id, pagRows, venRows, salRows, nombreDe) {
  const s = { cobros: 0, ventas: 0, salidas: 0, transferencias: 0, tarjeta: 0, movs: [] };
  const met = (m, x) => { if (m === 'Transferencia') s.transferencias += x; else if (m === 'Tarjeta') s.tarjeta += x; };
  pagRows.filter(p => p.turno === id).forEach(p => {
    if (p.metodo === 'Efectivo') s.cobros += p.monto; else met(p.metodo, p.monto);
    const h = horaPago(p);
    s.movs.push({ tipo: 'pago', texto: `${nombreDe[p.socio_id] || p.socio_id} · ${p.periodo}`, detalle: p.notas || '', metodo: p.metodo, monto: p.monto,
      fecha: h.fecha, hora: h.hora, quien: p.recibio || '', orden: p.id || 0 });
  });
  venRows.filter(v => v.turno === id).forEach(v => {
    if (v.metodo === 'Efectivo') s.ventas += v.total; else met(v.metodo, v.total);
    s.movs.push({ tipo: 'venta', texto: `${v.cantidad} × ${v.producto}`, detalle: (v.socio_id ? (nombreDe[v.socio_id] || v.socio_id) : '') + (v.notas ? (v.socio_id ? ' · ' : '') + v.notas : ''),
      metodo: v.metodo, monto: v.total, fecha: v.fecha, hora: v.hora || '', quien: '', orden: v.id || 0 });
  });
  salRows.filter(x => x.turno === id && x.origen === 'Caja').forEach(x => {
    s.salidas += x.monto;
    s.movs.push({ tipo: 'salida', texto: `${x.categoria} · ${x.concepto}`, detalle: [x.pagado_a, x.notas].filter(Boolean).join(' · '), metodo: 'Caja', monto: -x.monto,
      fecha: x.fecha, hora: x.hora || '', quien: x.registro || '', orden: x.id || 0 });
  });
  // Orden cronológico (los movimientos sin hora, de antes de la base nueva, quedan en su orden de registro)
  const k = m => m.hora ? m.fecha + ' ' + pad(m.hora) : '';
  s.movs.sort((a, b) => (k(a) && k(b)) ? k(a).localeCompare(k(b)) : 0);
  return s;
}
function prestamosCalc(preRows, salRows) {
  return preRows.map(p => {
    const pagado = (p.previo || 0) + salRows.filter(s => s.categoria === 'Pago de préstamo' && s.prestamo === p.nombre).reduce((a, s) => a + s.monto, 0);
    return { nombre: p.nombre, monto: p.monto, previo: p.previo || 0, abono: p.abono || 0, notas: p.notas || '', pagado, restante: p.monto - pagado };
  });
}
function caja(cfg, rol, turRows, salRows, preRows, pagRows, venRows, nombreDe) {
  const c = { personal: cfg.personalList, categorias: CATEGORIAS, origenes: ORIGENES, prestamos: prestamosCalc(preRows, salRows), turno: null };
  const abierto = turRows.filter(t => t.estado === 'Abierto').pop();
  if (abierto) {
    const s = sumasTurno(abierto.id, pagRows, venRows, salRows, nombreDe);
    c.turno = Object.assign({ id: abierto.id, persona: abierto.persona, fecha: abierto.fecha, hora: abierto.hora, inicial: abierto.inicial,
      esperado: abierto.inicial + s.cobros + s.ventas - s.salidas }, s);
  }
  const cerrados = turRows.filter(t => t.estado === 'Cerrado').sort((a, b) => (a.fecha_cierre + pad(a.hora_cierre)).localeCompare(b.fecha_cierre + pad(b.hora_cierre)));
  const u = cerrados[cerrados.length - 1];
  c.ultimoCierre = u ? { persona: u.persona, contado: u.contado, deja: dejaTurno(u), retiro: u.retiro || 0, retiroA: u.retiro_a || '', fecha: u.fecha_cierre, hora: u.hora_cierre } : null;
  const ultFondo = cerrados.slice().reverse().find(t => t.fondo !== null && t.fondo !== undefined);
  c.fondoSugerido = Number(cfg.fondo_caja) > 0 ? Number(cfg.fondo_caja) : (ultFondo ? ultFondo.fondo : null);
  c.destinosRetiro = DESTINOS_RETIRO;
  const mapS = x => ({ fecha: x.fecha, hora: x.hora, categoria: x.categoria, concepto: x.concepto, pagadoA: x.pagado_a || '', monto: x.monto,
    origen: x.origen, prestamo: x.prestamo || '', turno: x.turno || '', registro: x.registro || '', notas: x.notas || '' });
  c.salidas = salRows.slice(-200).map(mapS);
  if (rol !== 'dueno') { c.salidas = c.salidas.filter(x => x.origen === 'Caja' && x.categoria !== 'Retiro del dueño'); return c; }
  const gm = {};
  salRows.forEach(x => { const k = x.fecha.slice(0, 7); gm[k] = gm[k] || {}; gm[k][x.categoria] = (gm[k][x.categoria] || 0) + x.monto; });
  c.gastosMes = gm;
  const rm = {}; cerrados.forEach(t => { if (t.retiro) { const k = String(t.fecha_cierre || t.fecha).slice(0, 7); rm[k] = (rm[k] || 0) + t.retiro; } });
  c.retirosCorte = rm;
  c.cortes = cerrados.slice(-60).reverse().map(t => ({
    id: t.id, persona: t.persona, fecha: t.fecha, hora: t.hora, inicial: t.inicial, difApertura: t.dif_apertura || 0, cobros: t.cobros || 0,
    ventas: t.ventas || 0, salidas: t.salidas || 0, esperado: t.esperado || 0, contado: t.contado || 0, diferencia: t.diferencia || 0,
    motivo: t.motivo || '', transferencias: t.transferencias || 0, tarjeta: t.tarjeta || 0, fechaCierre: t.fecha_cierre, horaCierre: t.hora_cierre,
    dejo: t.dejo, retiro: t.retiro || 0, retiroA: t.retiro_a || '', deja: dejaTurno(t)
  }));
  return c;
}
const pad = hm => String(hm || '').padStart(5, '0');
// Lo que un turno cerrado le deja al siguiente: el fondo si se retiró el resto, si no todo lo contado
const dejaTurno = t => (t.fondo !== null && t.fondo !== undefined) ? t.fondo : t.contado;
const DESTINOS_RETIRO = ['Dueño', 'Caja fuerte', 'Depósito al banco'];

/* --------------------------- Escrituras --------------------------- */
async function socioPorFila(D, fila, id) {
  const s = await one(D, 'SELECT * FROM socios WHERE num = ?', Number(fila) || 0);
  return s && s.id === String(id || '').trim() ? s : null;
}
async function turnoAbierto(D) { return one(D, "SELECT * FROM turnos WHERE estado = 'Abierto' ORDER BY fecha DESC, hora DESC LIMIT 1"); }

async function socioGuardar(D, rol, s) {
  const cfg = await leerConfig(D);
  const nombre = String(s.nombre || '').trim().replace(/\s+/g, ' ');
  if (!nombre) return { ok: false, error: 'falta', campo: 'nombre' };
  const wa = String(s.wa || '').replace(/\D/g, '').slice(-10);
  if (s.wa && wa.length !== 10) return { ok: false, error: 'falta', campo: 'wa' };
  if (!cfg.tarifas[s.membresia]) return { ok: false, error: 'falta', campo: 'membresia' };
  if (!PERIODOS.includes(s.plan)) return { ok: false, error: 'falta', campo: 'plan' };
  const ins = isYmd(s.inscripcion) ? s.inscripcion : '', nac = isYmd(s.nacimiento) ? s.nacimiento : '';
  const campos = [nombre, wa, s.membresia, s.plan, ins, nac, String(s.correo || '').trim(), String(s.emergencia || '').trim(), String(s.notas || '').trim()];
  if (Number(s.fila)) {
    const act = await socioPorFila(D, s.fila, s.id);
    if (!act) return { ok: false, error: 'no_coincide' };
    let activo = act.activo;
    if (rol === 'dueno' && (s.activo === 'Sí' || s.activo === 'No')) activo = s.activo === 'Sí' ? 1 : 0;
    await run(D, 'UPDATE socios SET nombre=?, wa=?, membresia=?, plan=?, inscripcion=?, nacimiento=?, correo=?, emergencia=?, notas=?, activo=? WHERE num=?', ...campos, activo, act.num);
    return { ok: true, id: act.id, fila: act.num, nuevo: false };
  }
  const max = await one(D, 'SELECT MAX(num) AS m FROM socios');
  const num = (max && max.m || 0) + 1, id = 'KG-' + String(num).padStart(3, '0');
  if (!campos[4]) campos[4] = ahoraMX().ymd;
  await run(D, 'INSERT INTO socios(num, id, nombre, wa, membresia, plan, inscripcion, nacimiento, correo, emergencia, notas, activo, creado) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)',
    num, id, ...campos, new Date().toISOString());
  return { ok: true, id, fila: num, nuevo: true };
}

async function calcularPeriodo(D, cfg, socio, fecha, periodo) {
  const prev = await one(D, 'SELECT MAX(vence) AS v FROM pagos WHERE socio_id = ?', socio.id);
  const pv = prev && prev.v || '';
  let inicia = fecha;
  if (periodo !== 'Visita' && pv) {
    if (pv >= fecha) inicia = pv;
    else if (d2n(fecha) - d2n(pv) <= cfg.tolerancia) inicia = pv;
  }
  return { inicia, vence: finPeriodo(cfg, inicia, periodo) };
}

async function pago(D, rol, p) {
  const cfg = await leerConfig(D);
  const socio = await socioPorFila(D, p.fila, p.id);
  if (!socio) return { ok: false, error: 'socio' };
  if (!PERIODOS.includes(p.periodo)) return { ok: false, error: 'falta', campo: 'periodo' };
  const monto = Number(p.monto);
  if (!(monto >= 0)) return { ok: false, error: 'falta', campo: 'monto' };
  if (!METODOS.includes(p.metodo)) return { ok: false, error: 'falta', campo: 'metodo' };
  const turno = await turnoAbierto(D);
  if (p.metodo === 'Efectivo' && !turno) return { ok: false, error: 'sin_turno' };
  const fecha = isYmd(p.fecha) ? p.fecha : ahoraMX().ymd;
  const { inicia, vence } = await calcularPeriodo(D, cfg, socio, fecha, p.periodo);
  const lista = ((cfg.tarifas[socio.membresia] || {})[p.periodo]) || 0;
  const r = await run(D, 'INSERT INTO pagos(fecha, socio_id, periodo, monto, metodo, recibio, notas, lista, inicia, vence, turno, creado) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    fecha, socio.id, p.periodo, monto, p.metodo, rol === 'dueno' ? 'Dueño' : 'Recepción', String(p.notas || '').trim(), lista, inicia, vence, turno ? turno.id : '', new Date().toISOString());
  return { ok: true, fila: r.meta.last_row_id, lista, inicia, vence };
}

async function asistencia(D, rol, req) {
  const socio = await socioPorFila(D, req.fila, req.id);
  if (!socio) return { ok: false, error: 'socio' };
  const { ymd, hm } = ahoraMX();
  if (req.borrar) { await run(D, 'DELETE FROM asistencias WHERE fecha = ? AND socio_id = ?', ymd, socio.id); return { ok: true, borrado: true }; }
  const ya = await one(D, 'SELECT hora FROM asistencias WHERE fecha = ? AND socio_id = ?', ymd, socio.id);
  if (ya) return { ok: true, ya: true, hora: ya.hora || '' };
  await run(D, 'INSERT INTO asistencias(fecha, socio_id, hora, registro) VALUES(?,?,?,?)', ymd, socio.id, hm, rol === 'dueno' ? 'Dueño' : 'Recepción');
  return { ok: true, hora: hm };
}

async function venta(D, rol, v) {
  const socio = Number(v.fila) ? await socioPorFila(D, v.fila, v.id) : null;
  if (Number(v.fila) && !socio) return { ok: false, error: 'socio' };
  const prod = await one(D, 'SELECT * FROM productos WHERE nombre = ?', String(v.producto || '').trim());
  if (!prod) return { ok: false, error: 'falta', campo: 'producto' };
  const cant = Math.floor(Number(v.cantidad));
  if (!(cant >= 1)) return { ok: false, error: 'falta', campo: 'cantidad' };
  if (!METODOS.includes(v.metodo)) return { ok: false, error: 'falta', campo: 'metodo' };
  const turno = await turnoAbierto(D);
  if (v.metodo === 'Efectivo' && !turno) return { ok: false, error: 'sin_turno' };
  const { ymd, hm } = ahoraMX(), total = prod.precio * cant;
  const r = await run(D, 'INSERT INTO ventas(fecha, hora, socio_id, producto, cantidad, precio, total, metodo, notas, turno) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ymd, hm, socio ? socio.id : '', prod.nombre, cant, prod.precio, total, v.metodo, String(v.notas || '').trim(), turno ? turno.id : '');
  const vend = await one(D, 'SELECT COALESCE(SUM(cantidad), 0) AS n FROM ventas WHERE producto = ?', prod.nombre);
  const exist = (prod.recibidas || 0) - vend.n;
  return { ok: true, fila: r.meta.last_row_id, total, aviso: exist < 0 ? '⚠ Sin piezas suficientes: registra la mercancía recibida en Inventario' : '' };
}

async function recibir(D, req) {
  const piezas = Math.floor(Number(req.piezas));
  if (!(piezas >= 1) || piezas > 5000) return { ok: false, error: 'falta', campo: 'piezas' };
  const r = await run(D, 'UPDATE productos SET recibidas = COALESCE(recibidas, 0) + ? WHERE nombre = ?', piezas, String(req.producto || '').trim());
  return r.meta.changes ? { ok: true } : { ok: false, error: 'falta', campo: 'producto' };
}

async function productoGuardar(D, p) {
  const nombre = String(p.nombre || '').trim(), precio = Number(p.precio);
  if (!nombre) return { ok: false, error: 'falta', campo: 'nombre' };
  if (!(precio >= 0)) return { ok: false, error: 'falta', campo: 'precio' };
  const minimo = p.minimo === '' || p.minimo === null || p.minimo === undefined ? null : Math.max(0, Math.floor(Number(p.minimo)) || 0);
  if (Number(p.fila)) {
    const r = await run(D, 'UPDATE productos SET precio = ?, minimo = ? WHERE id = ?', precio, minimo, Number(p.fila));
    return r.meta.changes ? { ok: true, fila: Number(p.fila) } : { ok: false, error: 'falta', campo: 'producto' };
  }
  const dup = await one(D, 'SELECT id FROM productos WHERE lower(nombre) = lower(?)', nombre);
  if (dup) return { ok: false, error: 'duplicado' };
  const r = await run(D, 'INSERT INTO productos(nombre, precio, recibidas, minimo) VALUES(?,?,?,?)', nombre, precio, Math.max(0, Math.floor(Number(p.piezas) || 0)), minimo);
  return { ok: true, fila: r.meta.last_row_id };
}

async function turnoAbrir(D, req) {
  const cfg = await leerConfig(D);
  if (await turnoAbierto(D)) return { ok: false, error: 'turno_abierto' };
  const persona = String(req.persona || '').trim();
  if (!cfg.personalList.includes(persona)) return { ok: false, error: 'falta', campo: 'persona' };
  const contado = Number(req.contado);
  if (!(contado >= 0)) return { ok: false, error: 'falta', campo: 'contado' };
  const u = await one(D, "SELECT contado, fondo FROM turnos WHERE estado = 'Cerrado' ORDER BY fecha_cierre DESC, length(hora_cierre) DESC, hora_cierre DESC LIMIT 1");
  const dejo = u ? dejaTurno(u) : contado;
  const { ymd, hm } = ahoraMX();
  const id = 'T-' + ymd.slice(2).replace(/-/g, '') + '-' + pad(hm).replace(':', '') + '-' + Math.random().toString(36).slice(2, 5);
  await run(D, 'INSERT INTO turnos(id, persona, fecha, hora, dejo, inicial, dif_apertura, motivo, estado) VALUES(?,?,?,?,?,?,?,?,?)',
    id, persona, ymd, hm, dejo, contado, contado - dejo, String(req.motivo || '').trim(), 'Abierto');
  return { ok: true, id, diferencia: contado - dejo };
}

async function turnoCerrar(D, req) {
  const t = await turnoAbierto(D);
  if (!t || t.id !== String(req.id || '')) return { ok: false, error: 'sin_turno' };
  const contado = Number(req.contado);
  if (!(contado >= 0)) return { ok: false, error: 'falta', campo: 'contado' };
  const [pagRows, venRows, salRows, socRows] = await Promise.all([
    all(D, 'SELECT * FROM pagos WHERE turno = ?', t.id), all(D, 'SELECT * FROM ventas WHERE turno = ?', t.id),
    all(D, 'SELECT * FROM salidas WHERE turno = ?', t.id), all(D, 'SELECT id, nombre FROM socios')]);
  const s = sumasTurno(t.id, pagRows, venRows, salRows, Object.fromEntries(socRows.map(x => [x.id, x.nombre])));
  const esperado = t.inicial + s.cobros + s.ventas - s.salidas;
  const dif = Math.round((contado - esperado) * 100) / 100;
  let motivo = String(req.motivo || '').trim();
  if (dif !== 0 && !motivo) return { ok: false, error: 'falta', campo: 'motivo' };
  if (t.motivo) motivo = 'Apertura: ' + t.motivo + (motivo ? ' · Cierre: ' + motivo : '');
  // Dejar solo el fondo: lo demás se retira y el siguiente turno recibe exactamente el fondo
  let fondo = null, retiro = 0, retiroA = '';
  if (req.fondo !== undefined && req.fondo !== null && req.fondo !== '') {
    fondo = Math.round(Number(req.fondo) * 100) / 100;
    if (!(fondo >= 0) || fondo > contado) return { ok: false, error: 'falta', campo: 'fondo' };
    retiro = Math.round((contado - fondo) * 100) / 100;
    retiroA = retiro > 0 ? String(req.retiroA || 'Dueño') : '';
    if (retiro > 0 && !DESTINOS_RETIRO.includes(retiroA)) return { ok: false, error: 'falta', campo: 'retiroA' };
  }
  const { ymd, hm } = ahoraMX();
  await run(D, `UPDATE turnos SET cobros=?, ventas=?, salidas=?, esperado=?, contado=?, diferencia=?, motivo=?, transferencias=?, tarjeta=?,
    fecha_cierre=?, hora_cierre=?, fondo=?, retiro=?, retiro_a=?, estado='Cerrado' WHERE id=?`,
    s.cobros, s.ventas, s.salidas, esperado, contado, dif, motivo, s.transferencias, s.tarjeta, ymd, hm, fondo, retiro, retiroA, t.id);
  return { ok: true, esperado, contado, diferencia: dif, fondo, retiro, retiroA, deja: fondo !== null ? fondo : contado };
}

async function corteDetalle(D, rol, id) {
  const t = await one(D, 'SELECT * FROM turnos WHERE id = ?', String(id || ''));
  if (!t) return { ok: false, error: 'no_existe' };
  if (rol !== 'dueno' && t.estado !== 'Abierto') return { ok: false, error: 'permiso' };
  const [pagRows, venRows, salRows, socRows] = await Promise.all([
    all(D, 'SELECT * FROM pagos WHERE turno = ? ORDER BY id', t.id), all(D, 'SELECT * FROM ventas WHERE turno = ? ORDER BY id', t.id),
    all(D, 'SELECT * FROM salidas WHERE turno = ? ORDER BY id', t.id), all(D, 'SELECT id, nombre FROM socios')]);
  const s = sumasTurno(t.id, pagRows, venRows, salRows, Object.fromEntries(socRows.map(x => [x.id, x.nombre])));
  const abierto = t.estado === 'Abierto';
  return { ok: true, corte: {
    id: t.id, persona: t.persona, estado: t.estado, fecha: t.fecha, hora: t.hora, dejo: t.dejo, inicial: t.inicial, difApertura: t.dif_apertura || 0,
    cobros: s.cobros, ventas: s.ventas, salidas: s.salidas, transferencias: s.transferencias, tarjeta: s.tarjeta,
    esperado: abierto ? t.inicial + s.cobros + s.ventas - s.salidas : t.esperado, contado: abierto ? null : t.contado, diferencia: abierto ? null : (t.diferencia || 0),
    motivo: t.motivo || '', fechaCierre: t.fecha_cierre || '', horaCierre: t.hora_cierre || '', fondo: t.fondo, retiro: t.retiro || 0, retiroA: t.retiro_a || '',
    deja: abierto ? null : dejaTurno(t), movs: s.movs } };
}

async function salida(D, rol, x) {
  const cat = String(x.categoria || '');
  if (!CATEGORIAS.includes(cat)) return { ok: false, error: 'falta', campo: 'categoria' };
  if (cat === 'Retiro del dueño' && rol !== 'dueno') return { ok: false, error: 'permiso' };
  const origen = rol === 'dueno' ? String(x.origen || 'Caja') : 'Caja';
  if (!ORIGENES.includes(origen)) return { ok: false, error: 'falta', campo: 'origen' };
  const monto = Math.round(Number(x.monto) * 100) / 100;
  if (!(monto > 0)) return { ok: false, error: 'falta', campo: 'monto' };
  const concepto = String(x.concepto || '').trim();
  if (!concepto) return { ok: false, error: 'falta', campo: 'concepto' };
  let prestamo = '';
  if (cat === 'Pago de préstamo') {
    prestamo = String(x.prestamo || '').trim();
    if (!await one(D, 'SELECT id FROM prestamos WHERE nombre = ?', prestamo)) return { ok: false, error: 'falta', campo: 'prestamo' };
  }
  const turno = await turnoAbierto(D);
  if (origen === 'Caja' && !turno) return { ok: false, error: 'sin_turno' };
  const { ymd, hm } = ahoraMX();
  await run(D, 'INSERT INTO salidas(fecha, hora, categoria, concepto, pagado_a, monto, origen, prestamo, turno, registro, notas) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ymd, hm, cat, concepto, String(x.pagadoA || '').trim(), monto, origen, prestamo, origen === 'Caja' && turno ? turno.id : '',
    rol === 'dueno' ? 'Dueño' : (turno ? turno.persona : 'Recepción'), String(x.notas || '').trim());
  return { ok: true };
}

/* ---------------------------- Ajustes ----------------------------- */
const AJUSTES_TEXTO = ['gym', 'lada', 'dias_anticipacion', 'tolerancia', 'hora_gracias', 'aviso_minimo', 'umbral_asistencia', 'personal', 'fondo_caja',
  'msg_recordatorio', 'msg_vencido', 'msg_visita', 'msg_nuevo'];
async function ajustesLeer(D) {
  const cfg = await leerConfig(D);
  const out = { ok: true, tarifas: cfg.tarifas, prestamos: await all(D, 'SELECT nombre, monto, previo, abono, notas FROM prestamos ORDER BY id') };
  AJUSTES_TEXTO.forEach(k => { out[k] = String(cfg[k] === undefined ? '' : (k === 'personal' ? cfg.personal : cfg[k])); });
  return out;
}
async function ajustesGuardar(D, a) {
  for (const k of AJUSTES_TEXTO) if (a[k] !== undefined) await setConfig(D, k, String(a[k]).slice(0, 2000));
  if (a.tarifas && typeof a.tarifas === 'object') {
    const t = {};
    Object.entries(a.tarifas).forEach(([m, v]) => { const n = String(m).trim(); if (n) { t[n] = {}; PERIODOS.forEach(p => { t[n][p] = Math.max(0, Number(v && v[p]) || 0); }); } });
    if (Object.keys(t).length) await setConfig(D, 'tarifas', JSON.stringify(t));
  }
  if (Array.isArray(a.prestamos)) {
    for (const p of a.prestamos) {
      const nombre = String(p.nombre || '').trim(); if (!nombre) continue;
      await run(D, `INSERT INTO prestamos(nombre, monto, previo, abono, notas) VALUES(?,?,?,?,?)
        ON CONFLICT(nombre) DO UPDATE SET monto = excluded.monto, previo = excluded.previo, abono = excluded.abono, notas = excluded.notas`,
        nombre, Number(p.monto) || 0, Number(p.previo) || 0, Number(p.abono) || 0, String(p.notas || ''));
    }
  }
  for (const k of ['pin_dueno', 'pin_recepcion']) {
    if (a[k] !== undefined && a[k] !== '') {
      const pin = String(a[k]).replace(/\D/g, '');
      if (pin.length !== 6) return { ok: false, error: 'falta', campo: 'pin' };
      await setConfig(D, k, await hash(pin));
    }
  }
  const h = Object.fromEntries((await all(D, "SELECT clave, valor FROM config WHERE clave IN ('pin_dueno', 'pin_recepcion')")).map(r => [r.clave, r.valor]));
  if (h.pin_dueno && h.pin_dueno === h.pin_recepcion) return { ok: false, error: 'pin_igual' };
  return { ok: true };
}

/* --------------------------- Exportar ----------------------------- */
async function exportar(D) {
  const [socios, pagos, asistencias, productos, ventas, turnos, salidas, prestamos, config] = await Promise.all(
    ['socios ORDER BY num', 'pagos ORDER BY id', 'asistencias ORDER BY fecha, hora', 'productos ORDER BY id', 'ventas ORDER BY id',
      'turnos ORDER BY fecha, hora', 'salidas ORDER BY id', 'prestamos ORDER BY id', "config WHERE clave NOT LIKE 'pin_%' ORDER BY clave"]
      .map(t => all(D, 'SELECT * FROM ' + t)));
  const cfg = await leerConfig(D), hoy = ahoraMX().ymd;
  const calc = calcularSocios(cfg, socios, pagos, hoy);
  return { ok: true, hoy, socios: calc.map(({ _vence, _ins, url, urlVisita, urlNuevo, graciasVisita, graciasNuevo, fila, ...s }) => s),
    pagos, asistencias, productos, ventas, turnos, salidas, prestamos, config };
}

/* ---------------------- Importación (una vez) --------------------- */
async function importar(D, req) {
  const conf = await one(D, "SELECT valor FROM config WHERE clave = 'pin_dueno'");
  if (conf) { // ya hay datos: solo el dueño puede volver a importar
    const a = await auth(D, req.pin);
    if (!a.ok || a.rol !== 'dueno') return { ok: false, error: 'permiso' };
  }
  const d = req.datos || {};
  const pinD = String(req.pin_dueno || '').replace(/\D/g, ''), pinR = String(req.pin_recepcion || '').replace(/\D/g, '');
  if (!conf && (pinD.length !== 6 || pinR.length !== 6 || pinD === pinR)) return { ok: false, error: 'falta', campo: 'pin' };
  const st = [];
  const P = (q, ...b) => st.push(D.prepare(q).bind(...b));
  ['socios', 'pagos', 'asistencias', 'productos', 'ventas', 'turnos', 'salidas', 'prestamos'].forEach(t => P('DELETE FROM ' + t));
  (d.socios || []).forEach(s => P('INSERT INTO socios(num, id, nombre, wa, membresia, plan, inscripcion, nacimiento, correo, emergencia, activo, notas, creado) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    s.num, s.id, s.nombre, s.wa || '', s.membresia || '', s.plan || '', s.inscripcion || '', s.nacimiento || '', s.correo || '', s.emergencia || '', s.activo ? 1 : 0, s.notas || '', 'importado'));
  (d.pagos || []).forEach(p => P('INSERT INTO pagos(fecha, socio_id, periodo, monto, metodo, recibio, notas, lista, inicia, vence, turno, creado) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    p.fecha, p.socio_id, p.periodo, Number(p.monto) || 0, p.metodo || '', p.recibio || '', p.notas || '', Number(p.lista) || 0, p.inicia || '', p.vence || '', p.turno || '', 'importado'));
  (d.asistencias || []).forEach(a => P('INSERT OR IGNORE INTO asistencias(fecha, socio_id, hora, registro) VALUES(?,?,?,?)', a.fecha, a.socio_id, a.hora || '', a.registro || 'Importado'));
  (d.productos || []).forEach(p => P('INSERT INTO productos(nombre, precio, recibidas, minimo) VALUES(?,?,?,?)', p.nombre, Number(p.precio) || 0, Number(p.recibidas) || 0, p.minimo === '' || p.minimo == null ? null : Number(p.minimo)));
  (d.ventas || []).forEach(v => P('INSERT INTO ventas(fecha, hora, socio_id, producto, cantidad, precio, total, metodo, notas, turno) VALUES(?,?,?,?,?,?,?,?,?,?)',
    v.fecha, v.hora || '', v.socio_id || '', v.producto, Number(v.cantidad) || 0, Number(v.precio) || 0, Number(v.total) || 0, v.metodo || '', v.notas || '', v.turno || ''));
  (d.turnos || []).forEach(t => P(`INSERT INTO turnos(id, persona, fecha, hora, dejo, inicial, dif_apertura, cobros, ventas, salidas, esperado, contado, diferencia, motivo,
      transferencias, tarjeta, fecha_cierre, hora_cierre, estado) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    t.id, t.persona, t.fecha, t.hora, t.dejo || 0, t.inicial || 0, t.dif_apertura || 0, t.cobros || 0, t.ventas || 0, t.salidas || 0, t.esperado || 0, t.contado || 0,
    t.diferencia || 0, t.motivo || '', t.transferencias || 0, t.tarjeta || 0, t.fecha_cierre || '', t.hora_cierre || '', t.estado));
  (d.salidas || []).forEach(x => P('INSERT INTO salidas(fecha, hora, categoria, concepto, pagado_a, monto, origen, prestamo, turno, registro, notas) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    x.fecha, x.hora || '', x.categoria, x.concepto || '', x.pagado_a || '', Number(x.monto) || 0, x.origen || 'Caja', x.prestamo || '', x.turno || '', x.registro || '', x.notas || ''));
  (d.prestamos || []).forEach(p => P('INSERT INTO prestamos(nombre, monto, previo, abono, notas) VALUES(?,?,?,?,?)', p.nombre, Number(p.monto) || 0, Number(p.previo) || 0, Number(p.abono) || 0, p.notas || ''));
  const cfg = d.config || {};
  Object.entries(cfg).forEach(([k, v]) => { if (k in DEFAULTS) P('INSERT INTO config(clave, valor) VALUES(?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor', k, typeof v === 'string' ? v : JSON.stringify(v)); });
  if (!conf) {
    P("INSERT INTO config(clave, valor) VALUES('pin_dueno', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", await hash(pinD));
    P("INSERT INTO config(clave, valor) VALUES('pin_recepcion', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", await hash(pinR));
  }
  for (let i = 0; i < st.length; i += 80) await D.batch(st.slice(i, i + 80));
  const n = async t => (await one(D, 'SELECT COUNT(*) AS n FROM ' + t)).n;
  return { ok: true, socios: await n('socios'), pagos: await n('pagos'), asistencias: await n('asistencias'), ventas: await n('ventas'),
    productos: await n('productos'), turnos: await n('turnos'), salidas: await n('salidas'), prestamos: await n('prestamos') };
}

/* ------------------------ API app de socios ----------------------- */
async function apiSocio(env, url) {
  const D = await db(env);
  const id = String(url.searchParams.get('id') || '').trim().toUpperCase();
  const tel = String(url.searchParams.get('tel') || '').replace(/\D/g, '');
  if (!/^KG-\d{1,5}$/.test(id) || tel.length !== 4) return { ok: false, error: 'datos' };
  const clave = 'socio_' + id;
  const b = await bloqueo(D, clave);
  if (b.n >= SOCIO_INTENTOS) return { ok: false, error: 'bloqueado', minutos: SOCIO_BLOQUEO_MIN };
  const s = await one(D, 'SELECT * FROM socios WHERE id = ?', id);
  const no = async () => ({ ok: false, error: 'no_coincide', restantes: await fallo(D, clave, SOCIO_INTENTOS, SOCIO_BLOQUEO_MIN) });
  if (!s || !s.nombre) return no();
  const wa = String(s.wa || '').replace(/\D/g, '');
  if (!wa) return { ok: false, error: 'sin_whatsapp' };
  if (wa.slice(-4) !== tel) return no();
  await run(D, 'DELETE FROM bloqueos WHERE clave = ?', clave);
  const cfg = await leerConfig(D), hoy = ahoraMX().ymd;
  const pagos = await all(D, 'SELECT socio_id, fecha, vence FROM pagos WHERE socio_id = ?', id);
  const c = calcularSocios(cfg, [s], pagos, hoy)[0];
  return { ok: true, actualizado: new Date().toISOString(), socio: { id, nombre: s.nombre, membresia: s.membresia || '', plan: s.plan || '',
    inscripcion: s.inscripcion || '', nacimiento: s.nacimiento || '', activo: !!s.activo, vence: c._vence || '', dias: c.dias, estado: c.estado } };
}
