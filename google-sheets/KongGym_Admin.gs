/**
 * KONG GYM · ADMINISTRACIÓN (app de dueño y recepción)
 * ----------------------------------------------------
 * Conecta la app "Kong Gym Admin" con esta hoja: lee socios, pagos,
 * asistencias, ventas e inventario, y registra nuevos movimientos
 * escribiendo SOLO en las columnas de captura (las verdes/amarillas).
 * Las fórmulas de la hoja siguen haciendo todos los cálculos.
 *
 * Acceso con PIN:
 *   - Dueño: ve todo, incluidos ingresos; puede dar de baja socios y
 *     crear/editar productos.
 *   - Recepción: registra socios, pagos, entradas, ventas y mercancía
 *     recibida. No ve los ingresos totales.
 *
 * Instalación (una sola vez):
 *  1. En el proyecto de Apps Script "Kong Gym App", junto al archivo que
 *     ya tienes, crea uno nuevo (+ → Secuencia de comandos) llamado
 *     KongGym_Admin y pega este código.
 *  2. Cambia los dos PIN de abajo (6 dígitos, distintos entre sí).
 *  3. Implementar → Nueva implementación → Aplicación web →
 *     Ejecutar como: Yo · Quién tiene acceso: Cualquier persona →
 *     Implementar. Copia la URL que termina en /exec.
 *  (No modifica la implementación que ya usa la app de socios.)
 */

const ADM = {
  PIN_DUENO: '000000',      // ← CAMBIA este PIN (dueño)
  PIN_RECEPCION: '111111',  // ← CAMBIA este PIN (recepción)
  MAX_FALLOS: 8,            // intentos fallidos antes de bloquear
  BLOQUEO_MIN: 10,          // minutos de bloqueo
  PRIMERA_FILA_SOCIOS: 4, ULTIMA_FILA_SOCIOS: 503,
  PRIMERA_FILA_PAGOS: 4,  ULTIMA_FILA_PAGOS: 3003,
  PRIMERA_FILA_VENTAS: 5, ULTIMA_FILA_VENTAS: 2004,
  PRIMERA_FILA_INV: 5,    ULTIMA_FILA_INV: 34,
  DESFASE_ASISTENCIA: 4,  // fila en «Asistencias» = fila en «Socios» + 4
  METODOS: ['Efectivo', 'Transferencia', 'Tarjeta']
};
// ID del Sheet KongGym_Control_de_Pagos (por si el script no está ligado a la hoja)
const ADM_SHEET_ID = '1msl-gFuLVfZ7RhCG9brJLqyAhaxYrR3xLMWAJsJVNj8';
function adm_ss_() { return SpreadsheetApp.getActive() || SpreadsheetApp.openById(ADM_SHEET_ID); }
const ADM_MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (x) { return adm_json_({ ok: false, error: 'formato' }); }
  try {
    const auth = adm_auth_(req.pin);
    if (!auth.ok) return adm_json_(auth);
    const rol = auth.rol;
    switch (req.accion) {
      case 'login': return adm_json_({ ok: true, rol: rol });
      case 'datos': return adm_json_(adm_datos_(rol));
      case 'socio_guardar': return adm_json_(adm_escribir_(rol, () => adm_socioGuardar_(rol, req.socio || {})));
      case 'pago': return adm_json_(adm_escribir_(rol, () => adm_pago_(rol, req.pago || {})));
      case 'asistencia': return adm_json_(adm_escribir_(rol, () => adm_asistencia_(req)));
      case 'venta': return adm_json_(adm_escribir_(rol, () => adm_venta_(req.venta || {})));
      case 'recibir': return adm_json_(adm_escribir_(rol, () => adm_recibir_(req)));
      case 'producto_guardar':
        if (rol !== 'dueno') return adm_json_({ ok: false, error: 'permiso' });
        return adm_json_(adm_escribir_(rol, () => adm_productoGuardar_(req.producto || {})));
      default: return adm_json_({ ok: false, error: 'accion' });
    }
  } catch (err) {
    console.error(err);
    return adm_json_({ ok: false, error: 'servidor', detalle: String(err && err.message || err) });
  }
}

/* ---------- Acceso ---------- */
function adm_auth_(pinRaw) {
  const pin = String(pinRaw || '').replace(/\D/g, '');
  const cache = CacheService.getScriptCache();
  const fallos = Number(cache.get('adm_fallos') || 0);
  if (fallos >= ADM.MAX_FALLOS) return { ok: false, error: 'bloqueado', minutos: ADM.BLOQUEO_MIN };
  if (pin && pin === ADM.PIN_DUENO) return { ok: true, rol: 'dueno' };
  if (pin && pin === ADM.PIN_RECEPCION) return { ok: true, rol: 'recepcion' };
  cache.put('adm_fallos', String(fallos + 1), ADM.BLOQUEO_MIN * 60);
  return { ok: false, error: 'pin', restantes: Math.max(0, ADM.MAX_FALLOS - fallos - 1) };
}

/* Toda escritura: un movimiento a la vez, y devuelve los datos ya recalculados */
function adm_escribir_(rol, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'ocupado' };
  let res;
  try {
    res = fn();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  if (!res || !res.ok) return res;
  res.datos = adm_datos_(rol);
  return res;
}

/* ---------- Lectura ---------- */
function adm_datos_(rol) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const hoy = new Date();
  const out = {
    ok: true, rol: rol,
    hoy: Utilities.formatDate(hoy, tz, 'yyyy-MM-dd'),
    hora: Utilities.formatDate(hoy, tz, 'HH:mm'),
    gym: adm_txt_(ss, 'Configuración', 'B4') || 'Kong Gym',
    horaGracias: adm_txt_(ss, 'Configuración', 'B28') || '8:00 PM'
  };

  // Tarifas y periodos
  const tar = ss.getSheetByName('Tarifas');
  const tv = tar.getRange('A3:G6').getValues();
  out.periodos = tv[0].slice(1).map(String);
  out.tarifas = {};
  for (let i = 1; i < tv.length; i++) {
    if (!tv[i][0]) continue;
    const m = String(tv[i][0]); out.tarifas[m] = {};
    out.periodos.forEach((p, j) => { out.tarifas[m][p] = Number(tv[i][j + 1]) || 0; });
  }
  out.membresias = Object.keys(out.tarifas);
  out.planes = ss.getSheetByName('Configuración').getRange('A16:A21').getDisplayValues().map(r => r[0]).filter(String);

  // Socios
  const sh = ss.getSheetByName('Socios');
  const n = ADM.ULTIMA_FILA_SOCIOS - ADM.PRIMERA_FILA_SOCIOS + 1;
  const sv = sh.getRange(ADM.PRIMERA_FILA_SOCIOS, 1, n, 25).getDisplayValues();
  out.socios = [];
  sv.forEach((r, i) => {
    if (!String(r[1]).trim()) return;
    out.socios.push({
      fila: ADM.PRIMERA_FILA_SOCIOS + i, id: r[0], nombre: String(r[1]).trim(), wa: r[2],
      membresia: r[3], plan: r[4], inscripcion: r[5], nacimiento: r[6], correo: r[7],
      emergencia: r[8], activo: r[9], notas: r[10], monto: adm_num_(r[11]),
      ultimoPago: r[12], vence: r[13], dias: r[14] === '' ? null : Number(r[14]),
      estado: r[15], url: r[20], graciasVisita: !!r[21], graciasNuevo: !!r[22],
      urlVisita: r[23], urlNuevo: r[24]
    });
  });

  // Asistencias del mes
  out.asistencia = adm_leerAsistencia_(ss, tz, hoy);

  // Pagos (últimos 400)
  const pg = ss.getSheetByName('Pagos');
  const pLast = adm_ultimaFila_(pg, ADM.PRIMERA_FILA_PAGOS, ADM.ULTIMA_FILA_PAGOS, [1, 4]);
  out.pagos = [];
  if (pLast >= ADM.PRIMERA_FILA_PAGOS) {
    const desde = Math.max(ADM.PRIMERA_FILA_PAGOS, pLast - 399);
    const pv = pg.getRange(desde, 1, pLast - desde + 1, 12).getValues();
    pv.forEach((r, i) => {
      if (!(r[0] instanceof Date) || !r[1]) return;
      out.pagos.push({
        fila: desde + i, fecha: adm_ymd_(r[0], tz), socio: String(r[1]).trim(), id: String(r[7]),
        nombre: String(r[8]).trim(), periodo: String(r[2]), monto: Number(r[3]) || 0, metodo: String(r[4]),
        recibio: String(r[5]), notas: String(r[6]), lista: Number(r[9]) || 0,
        inicia: adm_ymd_(r[10], tz), vence: adm_ymd_(r[11], tz)
      });
    });
  }

  // Ventas (últimas 300)
  const vt = ss.getSheetByName('Ventas');
  const vLast = adm_ultimaFila_(vt, ADM.PRIMERA_FILA_VENTAS, ADM.ULTIMA_FILA_VENTAS, [1, 4]);
  out.ventas = [];
  if (vLast >= ADM.PRIMERA_FILA_VENTAS) {
    const desde = Math.max(ADM.PRIMERA_FILA_VENTAS, vLast - 299);
    const vv = vt.getRange(desde, 1, vLast - desde + 1, 10).getValues();
    vv.forEach((r, i) => {
      if (!(r[0] instanceof Date) || !r[2]) return;
      out.ventas.push({
        fila: desde + i, fecha: adm_ymd_(r[0], tz), socio: String(r[1]).trim(), producto: String(r[2]),
        cantidad: Number(r[3]) || 0, precio: Number(r[4]) || 0, total: Number(r[5]) || 0,
        metodo: String(r[6]), notas: String(r[7])
      });
    });
  }

  // Inventario
  const inv = ss.getSheetByName('Inventario');
  out.avisoMinimo = Number(inv.getRange('B3').getValue()) || 5;
  const iv = inv.getRange(ADM.PRIMERA_FILA_INV, 1, ADM.ULTIMA_FILA_INV - ADM.PRIMERA_FILA_INV + 1, 8).getValues();
  out.productos = [];
  iv.forEach((r, i) => {
    if (!String(r[0]).trim()) return;
    out.productos.push({
      fila: ADM.PRIMERA_FILA_INV + i, nombre: String(r[0]).trim(), precio: Number(r[1]) || 0,
      recibidas: Number(r[2]) || 0, vendidas: Number(r[3]) || 0, existencia: Number(r[4]) || 0,
      minimo: r[5] === '' ? null : Number(r[5]), estado: String(r[6]), acumulado: Number(r[7]) || 0
    });
  });

  // Panel
  const pa = ss.getSheetByName('Panel');
  const pv = pa.getRange('B4:B16').getValues().map(r => r[0]);
  out.panel = {
    activos: Number(pv[0]) || 0, porVencer: Number(pv[1]) || 0, vencidos: Number(pv[2]) || 0,
    sinPagos: Number(pv[3]) || 0, bajas: Number(pv[4]) || 0, pagosMes: Number(pv[6]) || 0,
    porMembresia: { Individual: Number(pv[10]) || 0, Pareja: Number(pv[11]) || 0, Estudiante: Number(pv[12]) || 0 },
    porAgotarse: Number(pa.getRange('B27').getValue()) || 0
  };
  if (rol === 'dueno') {
    out.panel.ingresoMes = Number(pv[5]) || 0;
    out.panel.renovacion = Number(pv[7]) || 0;
    const meses = pa.getRange('D5:H16').getValues();
    out.panel.meses = meses.map(r => ({
      mes: r[0] instanceof Date ? ADM_MESES[Number(Utilities.formatDate(r[0], tz, 'M')) - 1] + ' ' + Utilities.formatDate(r[0], tz, 'yy') : String(r[0]),
      mensualidades: Number(r[1]) || 0, pagos: Number(r[2]) || 0, ventas: Number(r[3]) || 0, total: Number(r[4]) || 0
    }));
    const met = pa.getRange('A19:B21').getValues();
    out.panel.metodos = met.map(r => ({ metodo: String(r[0]), monto: Number(r[1]) || 0 }));
    const des = pa.getRange('B24:B25').getValues();
    out.panel.mensualidadesMes = Number(des[0][0]) || 0;
    out.panel.ventasMes = Number(des[1][0]) || 0;
  }
  return out;
}

function adm_leerAsistencia_(ss, tz, hoy) {
  const sh = ss.getSheetByName('Asistencias');
  const mesHoja = sh.getRange('C3').getValue();
  const res = {
    mes: mesHoja instanceof Date ? Utilities.formatDate(mesHoja, tz, 'yyyy-MM') : '',
    mesActual: Utilities.formatDate(hoy, tz, 'yyyy-MM'),
    umbral: Number(sh.getRange('C4').getValue()) || 7,
    socios: {}, porDia: []
  };
  const vals = sh.getRange(8, 1, 500, 38).getDisplayValues(); // A..AL
  const dia = Number(Utilities.formatDate(hoy, tz, 'd'));
  const mismoMes = res.mes === res.mesActual;
  vals.forEach((r) => {
    const id = String(r[0]).trim();
    if (!id) return;
    res.socios[id] = {
      hoy: mismoMes ? r[2 + dia] : '',
      dias: Number(r[34]) || 0, ultima: r[35], sinVenir: r[36] === '' ? null : Number(r[36]), aviso: r[37]
    };
  });
  res.porDia = sh.getRange('D5:AH5').getValues()[0].map(v => (v === '' ? null : Number(v) || 0));
  return res;
}

/* ---------- Socios ---------- */
function adm_socioGuardar_(rol, s) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const sh = ss.getSheetByName('Socios');
  const nombre = String(s.nombre || '').trim().replace(/\s+/g, ' ');
  if (!nombre) return { ok: false, error: 'falta', campo: 'nombre' };
  const wa = String(s.wa || '').replace(/\D/g, '').slice(-10);
  if (wa && wa.length !== 10) return { ok: false, error: 'falta', campo: 'wa' };
  const datos = adm_datosTarifa_(ss);
  if (datos.membresias.indexOf(s.membresia) < 0) return { ok: false, error: 'falta', campo: 'membresia' };
  if (datos.planes.indexOf(s.plan) < 0) return { ok: false, error: 'falta', campo: 'plan' };

  let fila = Number(s.fila) || 0;
  let activo = 'Sí';
  if (fila) {
    const actual = sh.getRange(fila, 1, 1, 10).getDisplayValues()[0];
    if (actual[0] !== s.id) return { ok: false, error: 'no_coincide' };
    activo = actual[9] || 'Sí';
    if (rol === 'dueno' && (s.activo === 'Sí' || s.activo === 'No')) activo = s.activo;
  } else {
    const col = sh.getRange(ADM.PRIMERA_FILA_SOCIOS, 2, ADM.ULTIMA_FILA_SOCIOS - ADM.PRIMERA_FILA_SOCIOS + 1, 1).getValues();
    for (let i = 0; i < col.length; i++) {
      if (!String(col[i][0]).trim()) { fila = ADM.PRIMERA_FILA_SOCIOS + i; break; }
    }
    if (!fila) return { ok: false, error: 'lleno' };
  }
  const fila10 = [
    nombre, wa, s.membresia, s.plan,
    adm_fecha_(s.inscripcion, tz) || (fila && s.fila ? '' : adm_fecha_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), tz)),
    adm_fecha_(s.nacimiento, tz) || '',
    String(s.correo || '').trim(), String(s.emergencia || '').trim(), activo, String(s.notas || '').trim()
  ];
  sh.getRange(fila, 2, 1, 10).setValues([fila10]);
  if (wa) sh.getRange(fila, 3).setNumberFormat('@').setValue(wa);
  const id = sh.getRange(fila, 1).getDisplayValue();
  return { ok: true, id: id, fila: fila, nuevo: !s.fila };
}

/* ---------- Pagos ---------- */
function adm_pago_(rol, p) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const socio = adm_socioPorFila_(ss, p.fila, p.id);
  if (!socio) return { ok: false, error: 'socio' };
  const datos = adm_datosTarifa_(ss);
  if (datos.planes.indexOf(p.periodo) < 0) return { ok: false, error: 'falta', campo: 'periodo' };
  const monto = Number(p.monto);
  if (!(monto >= 0)) return { ok: false, error: 'falta', campo: 'monto' };
  if (ADM.METODOS.indexOf(p.metodo) < 0) return { ok: false, error: 'falta', campo: 'metodo' };
  const fecha = adm_fecha_(p.fecha, tz) || adm_fecha_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), tz);

  const sh = ss.getSheetByName('Pagos');
  const fila = adm_ultimaFila_(sh, ADM.PRIMERA_FILA_PAGOS, ADM.ULTIMA_FILA_PAGOS, [1, 4]) + 1;
  if (fila > ADM.ULTIMA_FILA_PAGOS) return { ok: false, error: 'lleno' };
  sh.getRange(fila, 1, 1, 7).setValues([[fecha, socio.etiqueta, p.periodo, monto, p.metodo,
    rol === 'dueno' ? 'Dueño' : 'Recepción', String(p.notas || '').trim()]]);
  SpreadsheetApp.flush();
  const r = sh.getRange(fila, 10, 1, 3).getValues()[0];
  return { ok: true, fila: fila, lista: Number(r[0]) || 0, inicia: adm_ymd_(r[1], tz), vence: adm_ymd_(r[2], tz) };
}

/* ---------- Asistencias ---------- */
function adm_asistencia_(req) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const socio = adm_socioPorFila_(ss, req.fila, req.id);
  if (!socio) return { ok: false, error: 'socio' };
  const sh = ss.getSheetByName('Asistencias');
  const ahora = new Date();
  const mes = adm_asegurarMes_(ss, sh, tz, ahora);
  if (!mes.ok) return mes;

  const filaA = socio.fila + ADM.DESFASE_ASISTENCIA;
  if (String(sh.getRange(filaA, 1).getDisplayValue()).trim() !== socio.id) return { ok: false, error: 'asistencia_fila' };
  const dia = Number(Utilities.formatDate(ahora, tz, 'd'));
  const celda = sh.getRange(filaA, 3 + dia);
  if (req.borrar) {
    celda.clearContent();
    return { ok: true, borrado: true };
  }
  const previa = celda.getDisplayValue();
  if (previa) return { ok: true, ya: true, hora: previa };
  const hhmm = String(req.hora || Utilities.formatDate(ahora, tz, 'HH:mm'));
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { ok: false, error: 'falta', campo: 'hora' };
  celda.setValue((Number(m[1]) * 60 + Number(m[2])) / 1440).setNumberFormat('H:mm');
  return { ok: true, hora: hhmm, mesNuevo: mes.nuevo || false };
}

/* Al empezar un mes nuevo: guarda una copia del mes anterior y deja la pestaña lista */
function adm_asegurarMes_(ss, sh, tz, ahora) {
  const c3 = sh.getRange('C3').getValue();
  const actual = Utilities.formatDate(ahora, tz, 'yyyy-MM');
  const hoja = c3 instanceof Date ? Utilities.formatDate(c3, tz, 'yyyy-MM') : '';
  if (hoja === actual) return { ok: true };
  if (hoja > actual) return { ok: false, error: 'mes_futuro' };
  if (hoja) {
    const y = hoja.slice(0, 4), mm = Number(hoja.slice(5, 7));
    let nombre = 'Asistencias ' + ADM_MESES[mm - 1] + ' ' + y, k = 2;
    while (ss.getSheetByName(nombre)) nombre = 'Asistencias ' + ADM_MESES[mm - 1] + ' ' + y + ' (' + (k++) + ')';
    const copia = sh.copyTo(ss).setName(nombre);
    // La copia queda como archivo: valores fijos para que no cambie con el tiempo
    const rango = copia.getRange(1, 1, copia.getMaxRows(), copia.getMaxColumns());
    rango.copyTo(rango, SpreadsheetApp.CopyPasteType.PASTE_VALUES, false);
  }
  sh.getRange('C3').setValue(adm_fecha_(actual + '-01', tz));
  sh.getRange(8, 4, 500, 31).clearContent();
  return { ok: true, nuevo: true };
}

/* ---------- Ventas e inventario ---------- */
function adm_venta_(v) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const socio = adm_socioPorFila_(ss, v.fila, v.id);
  if (!socio) return { ok: false, error: 'socio' };
  const prod = adm_producto_(ss, v.producto);
  if (!prod) return { ok: false, error: 'falta', campo: 'producto' };
  const cant = Math.floor(Number(v.cantidad));
  if (!(cant >= 1)) return { ok: false, error: 'falta', campo: 'cantidad' };
  if (ADM.METODOS.indexOf(v.metodo) < 0) return { ok: false, error: 'falta', campo: 'metodo' };
  const sh = ss.getSheetByName('Ventas');
  const fila = adm_ultimaFila_(sh, ADM.PRIMERA_FILA_VENTAS, ADM.ULTIMA_FILA_VENTAS, [1, 4]) + 1;
  if (fila > ADM.ULTIMA_FILA_VENTAS) return { ok: false, error: 'lleno' };
  const hoy = adm_fecha_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), tz);
  sh.getRange(fila, 1, 1, 4).setValues([[hoy, socio.etiqueta, prod.nombre, cant]]);
  sh.getRange(fila, 7, 1, 2).setValues([[v.metodo, String(v.notas || '').trim()]]);
  SpreadsheetApp.flush();
  const total = Number(sh.getRange(fila, 6).getValue()) || 0;
  const aviso = String(sh.getRange(fila, 10).getDisplayValue() || '');
  return { ok: true, fila: fila, total: total, aviso: aviso };
}

function adm_recibir_(req) {
  const ss = adm_ss_();
  const prod = adm_producto_(ss, req.producto);
  if (!prod) return { ok: false, error: 'falta', campo: 'producto' };
  const piezas = Math.floor(Number(req.piezas));
  if (!(piezas >= 1) || piezas > 5000) return { ok: false, error: 'falta', campo: 'piezas' };
  const c = ss.getSheetByName('Inventario').getRange(prod.fila, 3);
  c.setValue((Number(c.getValue()) || 0) + piezas);
  return { ok: true };
}

function adm_productoGuardar_(p) {
  const ss = adm_ss_();
  const sh = ss.getSheetByName('Inventario');
  const nombre = String(p.nombre || '').trim();
  const precio = Number(p.precio);
  if (!nombre) return { ok: false, error: 'falta', campo: 'nombre' };
  if (!(precio >= 0)) return { ok: false, error: 'falta', campo: 'precio' };
  const minimo = p.minimo === '' || p.minimo === null || p.minimo === undefined ? '' : Math.max(0, Math.floor(Number(p.minimo)) || 0);
  const col = sh.getRange(ADM.PRIMERA_FILA_INV, 1, ADM.ULTIMA_FILA_INV - ADM.PRIMERA_FILA_INV + 1, 1).getValues();
  let fila = Number(p.fila) || 0;
  for (let i = 0; i < col.length; i++) {
    const otra = ADM.PRIMERA_FILA_INV + i;
    if (otra !== fila && String(col[i][0]).trim().toLowerCase() === nombre.toLowerCase()) return { ok: false, error: 'duplicado' };
  }
  if (fila) {
    // Cambiar el nombre rompería el historial de ventas: solo precio y mínimo
    sh.getRange(fila, 2).setValue(precio);
    sh.getRange(fila, 6).setValue(minimo);
    return { ok: true, fila: fila };
  }
  for (let i = 0; i < col.length; i++) {
    if (!String(col[i][0]).trim()) { fila = ADM.PRIMERA_FILA_INV + i; break; }
  }
  if (!fila) return { ok: false, error: 'lleno' };
  sh.getRange(fila, 1, 1, 3).setValues([[nombre, precio, Math.max(0, Math.floor(Number(p.piezas) || 0))]]);
  sh.getRange(fila, 6).setValue(minimo);
  // Si esa fila no trae fórmulas, las copia de la fila de arriba
  if (!sh.getRange(fila, 4).getFormula() && fila > ADM.PRIMERA_FILA_INV) {
    [4, 5, 7, 8].forEach(c => sh.getRange(fila - 1, c).copyTo(sh.getRange(fila, c), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false));
  }
  return { ok: true, fila: fila };
}

/* ---------- Utilidades ---------- */
function adm_socioPorFila_(ss, filaRaw, idRaw) {
  const fila = Number(filaRaw);
  if (!(fila >= ADM.PRIMERA_FILA_SOCIOS && fila <= ADM.ULTIMA_FILA_SOCIOS)) return null;
  const r = ss.getSheetByName('Socios').getRange(fila, 1, 1, 2).getValues()[0];
  const id = String(r[0]).trim();
  if (!id || id !== String(idRaw || '').trim() || !String(r[1]).trim()) return null;
  return { fila: fila, id: id, etiqueta: id + ' - ' + r[1] }; // igual que la columna _etiqueta
}

function adm_producto_(ss, nombreRaw) {
  const nombre = String(nombreRaw || '').trim();
  if (!nombre) return null;
  const v = ss.getSheetByName('Inventario').getRange(ADM.PRIMERA_FILA_INV, 1, ADM.ULTIMA_FILA_INV - ADM.PRIMERA_FILA_INV + 1, 1).getValues();
  for (let i = 0; i < v.length; i++) {
    if (String(v[i][0]).trim() === nombre) return { fila: ADM.PRIMERA_FILA_INV + i, nombre: String(v[i][0]) };
  }
  return null;
}

function adm_datosTarifa_(ss) {
  return {
    membresias: ss.getSheetByName('Tarifas').getRange('A4:A6').getDisplayValues().map(r => r[0]).filter(String),
    planes: ss.getSheetByName('Configuración').getRange('A16:A21').getDisplayValues().map(r => r[0]).filter(String)
  };
}

/* Última fila con datos en alguna de las columnas indicadas (1 = A) */
function adm_ultimaFila_(sh, primera, ultima, cols) {
  const maxCol = Math.max.apply(null, cols);
  const v = sh.getRange(primera, 1, ultima - primera + 1, maxCol).getValues();
  for (let i = v.length - 1; i >= 0; i--) {
    for (let k = 0; k < cols.length; k++) {
      const x = v[i][cols[k] - 1];
      if (x !== '' && x !== null) return primera + i;
    }
  }
  return primera - 1;
}

function adm_fecha_(ymd, tz) {
  const s = String(ymd || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Utilities.parseDate(s, tz, 'yyyy-MM-dd'); // medianoche en la zona del Sheet
}
function adm_ymd_(v, tz) { return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : ''; }
function adm_num_(s) { const n = Number(String(s).replace(/[^\d.-]/g, '')); return isNaN(n) ? 0 : n; }
function adm_txt_(ss, hoja, a1) { const h = ss.getSheetByName(hoja); return h ? String(h.getRange(a1).getDisplayValue()) : ''; }
function adm_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* Prueba manual desde el editor: Ejecutar → adm_probar */
function adm_probar() {
  const d = adm_datos_('dueno');
  console.log('Socios: %s · Pagos: %s · Ventas: %s · Productos: %s · Mes asistencia: %s',
    d.socios.length, d.pagos.length, d.ventas.length, d.productos.length, d.asistencia.mes);
}
